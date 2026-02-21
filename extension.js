/**
 * Whisper Clipboard - GNOME Shell Extension
 *
 * Press the shortcut (default: Shift+Alt+Space) to toggle recording.
 *   - First press  → starts ffmpeg recording
 *   - Second press → stops ffmpeg, sends audio to whisper-server, copies text to clipboard
 *
 * Additional features:
 *   - Auto-detect language (per-request, no server restart)
 *   - Translate to English
 *   - Cancel recording (Shift+Alt+Escape)
 *   - Recording timer in panel
 *   - Transcription history
 *   - Push-to-talk mode (hold to record, release to transcribe)
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const State = {IDLE: 0, RECORDING: 1, TRANSCRIBING: 2};

const STATE_LABELS = {
    [State.IDLE]: 'Idle',
    [State.RECORDING]: 'Recording…',
    [State.TRANSCRIBING]: 'Transcribing…',
};

// ~20 most common languages for Whisper
const LANGUAGES = [
    {code: 'en', label: 'English'},
    {code: 'zh', label: 'Chinese'},
    {code: 'de', label: 'Deutsch'},
    {code: 'es', label: 'Español'},
    {code: 'fr', label: 'Français'},
    {code: 'it', label: 'Italiano'},
    {code: 'ja', label: 'Japanese'},
    {code: 'ko', label: 'Korean'},
    {code: 'pt', label: 'Português'},
    {code: 'ru', label: 'Russian'},
    {code: 'nl', label: 'Dutch'},
    {code: 'pl', label: 'Polish'},
    {code: 'ar', label: 'Arabic'},
    {code: 'tr', label: 'Turkish'},
    {code: 'sv', label: 'Swedish'},
    {code: 'hi', label: 'Hindi'},
    {code: 'uk', label: 'Ukrainian'},
    {code: 'cs', label: 'Czech'},
    {code: 'fi', label: 'Finnish'},
    {code: 'ro', label: 'Romanian'},
];

// Pre-built set for O(1) lookups in _populateLanguageMenu
const KNOWN_LANG_CODES = new Set(LANGUAGES.map(l => l.code));

const WHISPER_SERVER_CANDIDATES = [
    `${GLib.get_home_dir()}/.local/bin/whisper-server`,
    `${GLib.get_home_dir()}/whisper.cpp/build/bin/whisper-server`,
    '/opt/whisper.cpp/build/bin/whisper-server',
    '/usr/local/bin/whisper-server',
    '/usr/bin/whisper-server',
];

const MODEL_SEARCH_DIRS = [
    `${GLib.get_home_dir()}/.local/share/whisper/models`,
    `${GLib.get_home_dir()}/whisper.cpp/models`,
    '/opt/whisper.cpp/models',
    '/usr/share/whisper.cpp/models',
    '/usr/local/share/whisper/models',
];

// Modifier bits we care about when matching PTT keystrokes
const RELEVANT_MODS =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK   |
    Clutter.ModifierType.MOD1_MASK    |
    Clutter.ModifierType.SUPER_MASK;

// Waveform overlay dimensions
const WAVEFORM_BARS = 140;  // number of amplitude bars
const WAVEFORM_W    = 350;  // overlay width in px
const WAVEFORM_H    = 64;   // overlay height in px

export default class WhisperClipboardExtension extends Extension {

    enable() {
        this._state = State.IDLE;
        this._recordSubprocess = null;
        this._serverSubprocess = null;
        this._serverReady = false;
        this._healthCheckId = null;
        this._successTimeoutId = null;
        this._timerSourceId = null;
        this._recordingStartTime = 0;
        this._history = [];

        // Waveform overlay state
        this._vizProc = null;
        this._vizInputStream = null;
        this._vizCancellable = null;
        this._targetRms = 0;
        this._currentRms = 0;
        this._vizDrawId = null;
        this._vizWarmupChunks = 0;
        this._vizMode = 'recording'; // 'recording' | 'transcribing'
        this._vizPhase = 0;
        this._waveformOverlay = null;
        this._waveformArea = null;

        // Push-to-talk state
        this._pttPressId = null;
        this._pttReleaseId = null;
        this._pttActive = false;
        this._pttKeyval = null;
        this._pttMods = null;
        this._pttChangedId = null;

        this._wavPath = GLib.build_filenamev([GLib.get_tmp_dir(), 'whisper_clip_recording.wav']);

        /* ── settings ── */
        this._settings = this._getKeybindingSettings();

        /* ── HTTP session ── */
        this._session = new Soup.Session();

        /* ── virtual keyboard for auto-paste ── */
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        /* ── panel button ── */
        this._indicator = new PanelMenu.Button(0.0, 'WhisperClipboard', false);
        const box = new St.BoxLayout({vertical: false});
        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon',
        });
        this._timerLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'whisper-timer-label',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._timerLabel);
        this._indicator.add_child(box);
        Main.panel.addToStatusArea('whisper-clipboard', this._indicator);

        /* ── popup menu ── */
        this._buildMenu();

        /* ── cancel recording keybinding (always registered) ── */
        Main.wm.addKeybinding(
            'whisper-cancel-toggle',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._cancelRecording(),
        );

        /* ── toggle keybinding (normal or push-to-talk) ── */
        this._pttChangedId = this._settings.connect('changed::push-to-talk', () => {
            this._updateKeybindingMode();
        });
        this._initKeybinding();

        /* ── start whisper-server ── */
        this._startServer();
    }

    disable() {
        /* ── keybinding cleanup ── */
        if (this._pttChangedId && this._settings) {
            this._settings.disconnect(this._pttChangedId);
            this._pttChangedId = null;
        }

        if (this._settings && this._settings.get_boolean('push-to-talk')) {
            this._teardownPushToTalk();
        } else {
            try { Main.wm.removeKeybinding('whisper-clipboard-toggle'); } catch (_) {}
        }

        try { Main.wm.removeKeybinding('whisper-cancel-toggle'); } catch (_) {}

        /* ── timers ── */
        this._stopTimer();

        if (this._healthCheckId) {
            GLib.source_remove(this._healthCheckId);
            this._healthCheckId = null;
        }

        if (this._successTimeoutId) {
            GLib.source_remove(this._successTimeoutId);
            this._successTimeoutId = null;
        }

        /* ── subprocesses ── */
        this._stopWaveformOverlay();
        this._killRecording();
        this._stopServer();

        /* ── virtual device ── */
        this._virtualDevice = null;

        /* ── HTTP session ── */
        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        /* ── UI ── */
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._icon = null;
        this._timerLabel = null;

        /* ── settings ── */
        if (this._keybindingSettings) {
            this._keybindingSettings.run_dispose?.();
            this._keybindingSettings = null;
        }
        this._settings = null;

        /* ── misc ── */
        this._history = [];

        try {
            GLib.unlink(this._wavPath);
        } catch (_) { /* ignore */ }
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Keybinding mode: normal toggle vs push-to-talk            */
    /* ────────────────────────────────────────────────────────── */

    _initKeybinding() {
        if (this._settings.get_boolean('push-to-talk'))
            this._setupPushToTalk();
        else
            this._addWmKeybinding();
    }

    _addWmKeybinding() {
        Main.wm.addKeybinding(
            'whisper-clipboard-toggle',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle(),
        );
    }

    _updateKeybindingMode() {
        const isPtt = this._settings.get_boolean('push-to-talk');
        if (isPtt) {
            try { Main.wm.removeKeybinding('whisper-clipboard-toggle'); } catch (_) {}
            this._setupPushToTalk();
        } else {
            this._teardownPushToTalk();
            this._addWmKeybinding();
        }
    }

    /* ── Push-to-talk ── */

    /**
     * Parse a GSettings accelerator string (e.g. "<Shift><Alt>space")
     * into [keyval, modifierMask].
     */
    _parseAccelerator(accelStr) {
        let mods = 0;
        let str = accelStr;

        while (str.startsWith('<')) {
            const end = str.indexOf('>');
            if (end === -1) break;
            const mod = str.substring(1, end).toLowerCase();
            str = str.substring(end + 1);

            switch (mod) {
            case 'super':   mods |= Clutter.ModifierType.SUPER_MASK;   break;
            case 'ctrl':
            case 'control': mods |= Clutter.ModifierType.CONTROL_MASK; break;
            case 'shift':   mods |= Clutter.ModifierType.SHIFT_MASK;   break;
            case 'alt':
            case 'mod1':    mods |= Clutter.ModifierType.MOD1_MASK;    break;
            }
        }

        const keyval = Clutter.keyval_from_name(str);
        return [keyval, mods];
    }

    _setupPushToTalk() {
        const bindings = this._settings.get_strv('whisper-clipboard-toggle');
        if (!bindings.length) return;

        const [keyval, mods] = this._parseAccelerator(bindings[0]);
        if (keyval === Clutter.KEY_VoidSymbol) return;

        this._pttKeyval = keyval;
        this._pttMods = mods;
        this._pttActive = false;

        this._pttPressId = global.stage.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== this._pttKeyval)
                return Clutter.EVENT_PROPAGATE;
            if ((event.get_state() & RELEVANT_MODS) !== this._pttMods)
                return Clutter.EVENT_PROPAGATE;
            if (this._pttActive)        // suppress key-repeat
                return Clutter.EVENT_STOP;

            this._pttActive = true;
            if (this._state === State.IDLE)
                this._startRecording();
            return Clutter.EVENT_STOP;
        });

        this._pttReleaseId = global.stage.connect('key-release-event', (_actor, event) => {
            if (event.get_key_symbol() !== this._pttKeyval)
                return Clutter.EVENT_PROPAGATE;
            if (!this._pttActive)
                return Clutter.EVENT_PROPAGATE;

            this._pttActive = false;
            if (this._state === State.RECORDING)
                this._stopAndTranscribe();
            return Clutter.EVENT_STOP;
        });
    }

    _teardownPushToTalk() {
        if (this._pttPressId) {
            global.stage.disconnect(this._pttPressId);
            this._pttPressId = null;
        }
        if (this._pttReleaseId) {
            global.stage.disconnect(this._pttReleaseId);
            this._pttReleaseId = null;
        }
        this._pttActive = false;
        this._pttKeyval = null;
        this._pttMods = null;
    }

    /* ────────────────────────────────────────────────────────── */
    /*  whisper-server management                                 */
    /* ────────────────────────────────────────────────────────── */

    _getServerPort() {
        return this._settings.get_int('server-port');
    }

    _getServerUrl(path) {
        return `http://127.0.0.1:${this._getServerPort()}${path}`;
    }

    _resolveWhisperBin() {
        const fromSetting = this._settings.get_string('whisper-server-bin').trim();
        if (fromSetting && GLib.file_test(fromSetting, GLib.FileTest.IS_EXECUTABLE))
            return fromSetting;

        const fromPath = GLib.find_program_in_path('whisper-server');
        if (fromPath)
            return fromPath;

        for (const candidate of WHISPER_SERVER_CANDIDATES) {
            if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
                return candidate;
        }

        return null;
    }

    _startServer() {
        if (this._serverSubprocess)
            return;

        const whisperBin = this._resolveWhisperBin();
        if (!whisperBin) {
            log('[WhisperClipboard] whisper-server not found.');
            Main.notify('Whisper Clipboard',
                'whisper-server not found. Install it or set the path via:\n' +
                'dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-server-bin ' +
                '\'"/path/to/whisper-server"\'');
            return;
        }

        let whisperModel = this._settings.get_string('whisper-model');

        if (!whisperModel || !GLib.file_test(whisperModel, GLib.FileTest.EXISTS)) {
            const models = this._scanModels();
            if (models.length > 0) {
                whisperModel = models[0];
                this._settings.set_string('whisper-model', whisperModel);
                log(`[WhisperClipboard] Auto-selected model: ${whisperModel}`);
            }
        }

        if (!whisperModel) {
            Main.notify('Whisper Clipboard',
                'No whisper model found. Download a model and place it in ' +
                '~/.local/share/whisper/models/ or ~/whisper.cpp/models/');
            return;
        }

        const whisperLang = this._settings.get_string('whisper-language');
        const port = this._getServerPort().toString();

        const cmd = [
            whisperBin,
            '-m', whisperModel,
            '-l', whisperLang,
            '--host', '127.0.0.1',
            '--port', port,
        ];

        try {
            this._serverSubprocess = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDERR_SILENCE | Gio.SubprocessFlags.STDOUT_SILENCE,
            );
            this._serverReady = false;
            this._pollHealth();
        } catch (e) {
            log(`[WhisperClipboard] Failed to start whisper-server: ${e.message}`);
            Main.notify('Whisper Clipboard', `Failed to start whisper-server: ${e.message}`);
        }
    }

    _stopServer() {
        if (this._serverSubprocess) {
            try {
                this._serverSubprocess.force_exit();
                this._serverSubprocess.wait(null);
            } catch (_) { /* already exited */ }
            this._serverSubprocess = null;
            this._serverReady = false;
            this._updateServerStatusLabel();
        }
    }

    _restartServer() {
        this._stopServer();
        this._startServer();
    }

    _pollHealth() {
        if (this._healthCheckId) {
            GLib.source_remove(this._healthCheckId);
            this._healthCheckId = null;
        }

        this._healthCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._healthCheckId = null;
            this._checkHealth();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkHealth() {
        if (!this._session)
            return;

        const msg = Soup.Message.new('GET', this._getServerUrl('/health'));
        if (!msg) {
            this._pollHealth();
            return;
        }

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                session.send_and_read_finish(res);
                if (msg.get_status() === Soup.Status.OK) {
                    this._serverReady = true;
                    this._updateServerStatusLabel();
                    return;
                }
            } catch (_) { /* server not ready yet */ }

            if (this._serverSubprocess)
                this._pollHealth();
        });
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Panel menu                                                */
    /* ────────────────────────────────────────────────────────── */

    _buildMenu() {
        const menu = this._indicator.menu;

        // Header
        const header = new PopupMenu.PopupMenuItem('Whisper Clipboard', {reactive: false});
        header.label.set_style('font-weight: bold;');
        menu.addMenuItem(header);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Status row
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this._statusItem);
        this._updateStatusLabel();

        // Server status row
        this._serverStatusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this._serverStatusItem);
        this._updateServerStatusLabel();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Auto-paste toggle
        this._autoPasteItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto-paste',
            this._settings.get_boolean('auto-paste'),
        );
        this._autoPasteItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('auto-paste', state);
        });
        menu.addMenuItem(this._autoPasteItem);

        // Ctrl+Shift+V toggle
        this._ctrlShiftVItem = new PopupMenu.PopupSwitchMenuItem(
            'Use Ctrl+Shift+V (terminals)',
            this._settings.get_boolean('paste-use-ctrl-shift-v'),
        );
        this._ctrlShiftVItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('paste-use-ctrl-shift-v', state);
        });
        menu.addMenuItem(this._ctrlShiftVItem);

        // Translate to English toggle
        this._translateItem = new PopupMenu.PopupSwitchMenuItem(
            'Translate to English',
            this._settings.get_boolean('translate-to-english'),
        );
        this._translateItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('translate-to-english', state);
        });
        menu.addMenuItem(this._translateItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Language submenu
        this._langSubmenu = new PopupMenu.PopupSubMenuMenuItem('Language');
        menu.addMenuItem(this._langSubmenu);
        this._populateLanguageMenu();

        // Rebuild language list each time the submenu opens
        this._langSubmenu.menu.connect('open-state-changed', (_, open) => {
            if (open)
                this._populateLanguageMenu();
        });

        // Model submenu
        this._modelSubmenu = new PopupMenu.PopupSubMenuMenuItem('Model');
        menu.addMenuItem(this._modelSubmenu);
        this._populateModelMenu();

        this._modelSubmenu.menu.connect('open-state-changed', (_, open) => {
            if (open)
                this._populateModelMenu();
        });

        // History submenu
        this._historySubmenu = new PopupMenu.PopupSubMenuMenuItem('History');
        menu.addMenuItem(this._historySubmenu);

        this._historySubmenu.menu.connect('open-state-changed', (_, open) => {
            if (open)
                this._populateHistoryMenu();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Restart server button
        const restartItem = new PopupMenu.PopupMenuItem('Restart Server');
        restartItem.connect('activate', () => {
            this._restartServer();
        });
        menu.addMenuItem(restartItem);
    }

    _updateStatusLabel() {
        if (this._statusItem)
            this._statusItem.label.set_text(`Status: ${STATE_LABELS[this._state]}`);
    }

    _updateServerStatusLabel() {
        if (this._serverStatusItem) {
            const status = this._serverReady ? 'Ready' : 'Starting…';
            this._serverStatusItem.label.set_text(`Server: ${status}`);
        }
    }

    _populateLanguageMenu() {
        this._langSubmenu.menu.removeAll();

        const autoDetect = this._settings.get_boolean('auto-detect-language');
        const currentLang = this._settings.get_string('whisper-language');

        // Auto-detect item (at top)
        const autoItem = new PopupMenu.PopupMenuItem('Auto-detect');
        autoItem.setOrnament(autoDetect
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE);
        autoItem.connect('activate', () => {
            this._settings.set_boolean('auto-detect-language', true);
            this._populateLanguageMenu();
            // No server restart needed — language is per-request
        });
        this._langSubmenu.menu.addMenuItem(autoItem);

        this._langSubmenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Known languages
        for (const {code, label} of LANGUAGES) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(!autoDetect && code === currentLang
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);

            item.connect('activate', () => {
                this._settings.set_boolean('auto-detect-language', false);
                this._settings.set_string('whisper-language', code);
                this._populateLanguageMenu();
                this._restartServer();
            });
            this._langSubmenu.menu.addMenuItem(item);
        }

        this._langSubmenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Custom language code entry
        const customItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        const customEntry = new St.Entry({
            hint_text: 'Custom code…',
            can_focus: true,
            x_expand: true,
        });
        // Pre-fill if current language is non-standard
        if (!autoDetect && !KNOWN_LANG_CODES.has(currentLang) && currentLang)
            customEntry.set_text(currentLang);

        customEntry.get_clutter_text().connect('activate', () => {
            const code = customEntry.get_text().trim();
            if (!code) return;
            this._settings.set_boolean('auto-detect-language', false);
            this._settings.set_string('whisper-language', code);
            this._populateLanguageMenu();
            this._restartServer();
        });
        customItem.add_child(customEntry);
        this._langSubmenu.menu.addMenuItem(customItem);
    }

    _populateModelMenu() {
        this._modelSubmenu.menu.removeAll();
        const currentModel = this._settings.get_string('whisper-model');

        const models = this._scanModels();
        if (models.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No models found', {reactive: false});
            this._modelSubmenu.menu.addMenuItem(empty);
            return;
        }

        for (const modelPath of models) {
            const basename = GLib.path_get_basename(modelPath);
            const item = new PopupMenu.PopupMenuItem(basename);
            item.setOrnament(modelPath === currentModel
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);

            item.connect('activate', () => {
                this._settings.set_string('whisper-model', modelPath);
                this._populateModelMenu();
                this._restartServer();
            });
            this._modelSubmenu.menu.addMenuItem(item);
        }
    }

    _populateHistoryMenu() {
        this._historySubmenu.menu.removeAll();

        if (this._history.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No history yet', {reactive: false});
            this._historySubmenu.menu.addMenuItem(empty);
            return;
        }

        // Show most-recent first
        for (const text of [...this._history].reverse()) {
            const preview = text.length > 60
                ? `${text.substring(0, 60)}…`
                : text;
            const item = new PopupMenu.PopupMenuItem(preview);
            item.connect('activate', () => {
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            });
            this._historySubmenu.menu.addMenuItem(item);
        }

        this._historySubmenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Clear History');
        clearItem.connect('activate', () => {
            this._history = [];
            this._populateHistoryMenu();
        });
        this._historySubmenu.menu.addMenuItem(clearItem);
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Model scanner                                             */
    /* ────────────────────────────────────────────────────────── */

    _scanModels() {
        const seen = new Set();
        const models = [];

        const customDir = this._settings.get_string('whisper-models-dir').trim();
        const searchDirs = [
            ...(customDir ? [customDir] : []),
            ...MODEL_SEARCH_DIRS,
        ];

        for (const dirPath of searchDirs) {
            try {
                const dir = Gio.File.new_for_path(dirPath);
                const enumerator = dir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null,
                );
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (name.startsWith('ggml-') && name.endsWith('.bin')) {
                        const fullPath = GLib.build_filenamev([dirPath, name]);
                        if (!seen.has(fullPath)) {
                            seen.add(fullPath);
                            models.push(fullPath);
                        }
                    }
                }
                enumerator.close(null);
            } catch (_) { /* directory may not exist */ }
        }

        models.sort();
        return models;
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Settings helper                                           */
    /* ────────────────────────────────────────────────────────── */

    _getKeybindingSettings() {
        if (!this._keybindingSettings) {
            const schema = 'org.gnome.shell.extensions.whisper-clipboard';
            const schemaDir = this.dir.get_child('schemas');
            let schemaSource;
            if (schemaDir.query_exists(null))
                schemaSource = Gio.SettingsSchemaSource.new_from_directory(
                    schemaDir.get_path(),
                    Gio.SettingsSchemaSource.get_default(),
                    false,
                );
            else
                schemaSource = Gio.SettingsSchemaSource.get_default();

            this._keybindingSettings = new Gio.Settings({
                settings_schema: schemaSource.lookup(schema, true),
            });
        }
        return this._keybindingSettings;
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Toggle logic                                              */
    /* ────────────────────────────────────────────────────────── */

    _toggle() {
        switch (this._state) {
        case State.IDLE:
            this._startRecording();
            break;
        case State.RECORDING:
            this._stopAndTranscribe();
            break;
        case State.TRANSCRIBING:
            // Intentionally no notification here to keep UI quiet
            break;
        }
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Recording                                                 */
    /* ────────────────────────────────────────────────────────── */

    _startRecording() {
        // Cancel any lingering success indicator from a previous transcription
        if (this._successTimeoutId) {
            GLib.source_remove(this._successTimeoutId);
            this._successTimeoutId = null;
        }

        if (!this._serverReady) {
            Main.notify('Whisper Clipboard', 'Server is still starting, please wait…');
            return;
        }

        try { GLib.unlink(this._wavPath); } catch (_) { /* ok */ }

        try {
            this._recordSubprocess = Gio.Subprocess.new(
                ['ffmpeg', '-y', '-f', 'alsa', '-i', 'default',
                 '-ar', '16000', '-ac', '1', this._wavPath],
                Gio.SubprocessFlags.STDERR_SILENCE,
            );

            this._state = State.RECORDING;
            this._icon.icon_name = 'media-record-symbolic';
            this._icon.set_style('color: #ff4444;');
            this._updateStatusLabel();

            // Start the recording timer
            this._startTimer();
            this._startWaveformOverlay();

        } catch (e) {
            Main.notify('Whisper Clipboard', `Failed to start recording: ${e.message}`);
            this._resetIndicator();
        }
    }

    _cancelRecording() {
        if (this._state !== State.RECORDING)
            return;

        this._stopWaveformOverlay();
        this._killRecording();
        this._resetIndicator();

        try { GLib.unlink(this._wavPath); } catch (_) {}
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Recording timer                                            */
    /* ────────────────────────────────────────────────────────── */

    _startTimer() {
        this._recordingStartTime = GLib.get_monotonic_time();

        if (this._timerLabel) {
            this._timerLabel.set_text('0:00');
            this._timerLabel.show();
        }

        this._timerSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const elapsed = Math.floor(
                (GLib.get_monotonic_time() - this._recordingStartTime) / 1_000_000,
            );
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            if (this._timerLabel)
                this._timerLabel.set_text(`${minutes}:${seconds.toString().padStart(2, '0')}`);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerSourceId) {
            GLib.source_remove(this._timerSourceId);
            this._timerSourceId = null;
        }
        if (this._timerLabel) {
            this._timerLabel.hide();
            this._timerLabel.set_text('');
        }
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Stop + transcribe via whisper-server                      */
    /* ────────────────────────────────────────────────────────── */

    _stopAndTranscribe() {
        this._stopTimer();
        this._switchWaveformToTranscribing();

        // Switch to TRANSCRIBING state but keep the default microphone icon appearance
        this._state = State.TRANSCRIBING;
        this._icon.icon_name = 'audio-input-microphone-symbolic';
        this._icon.set_style('');
        this._updateStatusLabel();

        const proc = this._recordSubprocess;
        this._recordSubprocess = null;

        if (!proc) {
            this._readAndTranscribe();
            return;
        }

        // Send SIGINT so ffmpeg writes a valid WAV header before exiting,
        // then wait asynchronously so we don't block the main thread
        try { proc.send_signal(2); } catch (_) {}

        proc.wait_async(null, (_proc, res) => {
            try { _proc.wait_finish(res); } catch (_) {}
            if (this._state === State.TRANSCRIBING)
                this._readAndTranscribe();
        });
    }

    _readAndTranscribe() {
        const file = Gio.File.new_for_path(this._wavPath);
        file.load_contents_async(null, (source, res) => {
            try {
                const [ok, contents] = source.load_contents_finish(res);
                if (!ok) {
                    Main.notify('Whisper Clipboard', 'Failed to read recording file');
                    this._resetIndicator();
                    return;
                }
                this._sendToServer(contents);
            } catch (e) {
                Main.notify('Whisper Clipboard', `Failed to read recording: ${e.message}`);
                this._resetIndicator();
            }
        });
    }

    _sendToServer(wavContents) {
        const wavBytes = GLib.Bytes.new(wavContents);
        const autoDetect = this._settings.get_boolean('auto-detect-language');

        const multipart = new Soup.Multipart('multipart/form-data');
        multipart.append_form_file('file', 'recording.wav', 'audio/wav', wavBytes);
        multipart.append_form_string('response_format', 'text');

        if (autoDetect)
            multipart.append_form_string('language', 'auto');
        else
            multipart.append_form_string('language', this._settings.get_string('whisper-language'));

        if (this._settings.get_boolean('translate-to-english'))
            multipart.append_form_string('translate', 'true');

        multipart.append_form_string('temperature', '0.0');
        multipart.append_form_string('temperature_inc', '0.2');
        multipart.append_form_string('no_timestamps', 'true');

        const msg = Soup.Message.new_from_multipart(this._getServerUrl('/inference'), multipart);

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const status = msg.get_status();

                const data = this._unpackBytes(bytes);

                if (status !== Soup.Status.OK) {
                    const body = new TextDecoder('utf-8').decode(data);
                    Main.notify('Whisper Clipboard', `Server error (${status}): ${body.substring(0, 120)}`);
                    this._resetIndicator();
                    return;
                }

                const text = new TextDecoder('utf-8').decode(data).trim();

                if (text.length === 0) {
                    Main.notify('Whisper Clipboard', 'No text recognized.');
                    this._resetIndicator();
                    return;
                }

                // Copy to clipboard
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                // Save to history
                const maxHistory = this._settings.get_int('history-size');
                this._history.push(text);
                if (this._history.length > maxHistory)
                    this._history.shift();

                if (this._settings.get_boolean('auto-paste'))
                    this._pasteFromClipboard();

                // Flash success color briefly
                this._icon.icon_name = 'object-select-symbolic';
                this._icon.set_style('color: #44ff44;');
                this._stopWaveformOverlay();

                this._successTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                    this._successTimeoutId = null;
                    this._resetIndicator();
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                Main.notify('Whisper Clipboard', `Transcription error: ${e.message}`);
                this._resetIndicator();
            }
        });
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Auto-paste                                                */
    /* ────────────────────────────────────────────────────────── */

    _pasteFromClipboard() {
        if (!this._virtualDevice)
            return;

        const useCtrlShiftV = this._settings.get_boolean('paste-use-ctrl-shift-v');

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const t = GLib.get_monotonic_time();

            this._virtualDevice.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            if (useCtrlShiftV)
                this._virtualDevice.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);

            this._virtualDevice.notify_keyval(t + 1000, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._virtualDevice.notify_keyval(t + 2000, Clutter.KEY_v, Clutter.KeyState.RELEASED);

            if (useCtrlShiftV)
                this._virtualDevice.notify_keyval(t + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._virtualDevice.notify_keyval(t + 4000, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);

            return GLib.SOURCE_REMOVE;
        });
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Waveform overlay                                          */
    /* ────────────────────────────────────────────────────────── */

    _startWaveformOverlay() {
        // Spawn a lightweight ffmpeg for audio visualization only
        try {
            this._vizCancellable = new Gio.Cancellable();
            this._vizProc = Gio.Subprocess.new(
                ['ffmpeg', '-nostdin', '-f', 'alsa', '-i', 'default',
                 '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
            this._vizInputStream = this._vizProc.get_stdout_pipe();
        } catch (e) {
            log(`[WhisperClipboard] Viz ffmpeg failed: ${e.message}`);
            this._vizProc = null;
            this._vizInputStream = null;
            this._vizCancellable = null;
            // Continue — show overlay without animation
        }

        this._targetRms = 0;
        this._currentRms = 0;
        this._vizWarmupChunks = 10; // discard first ~1 s of ffmpeg startup noise
        this._vizMode = 'recording';
        this._vizPhase = 0;

        // Container
        this._waveformOverlay = new St.BoxLayout({vertical: true, reactive: false});

        // Drawing area
        this._waveformArea = new St.DrawingArea({
            width: WAVEFORM_W,
            height: WAVEFORM_H,
            reactive: false,
        });
        this._waveformArea.connect('repaint', area => {
            const cr = area.get_context();
            this._drawWaveform(cr, WAVEFORM_W, WAVEFORM_H);
            cr.$dispose();
        });
        this._waveformOverlay.add_child(this._waveformArea);

        Main.uiGroup.add_child(this._waveformOverlay);
        this._positionWaveformOverlay();

        if (this._vizInputStream)
            this._readVizChunk();

        // ~60 fps repaint timer
        this._vizDrawId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._waveformArea)
                this._waveformArea.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _positionWaveformOverlay() {
        if (!this._waveformOverlay)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const x = monitor.x + 8;
        const y = monitor.y + Main.panel.height + 4;
        this._waveformOverlay.set_position(x, y);
    }

    _stopWaveformOverlay() {
        if (this._vizCancellable) {
            this._vizCancellable.cancel();
            this._vizCancellable = null;
        }
        if (this._vizProc) {
            try { this._vizProc.force_exit(); } catch (_) {}
            this._vizProc = null;
        }
        this._vizInputStream = null;

        if (this._vizDrawId) {
            GLib.source_remove(this._vizDrawId);
            this._vizDrawId = null;
        }
        if (this._waveformOverlay) {
            Main.uiGroup.remove_child(this._waveformOverlay);
            this._waveformOverlay.destroy();
            this._waveformOverlay = null;
        }
        this._waveformArea = null;
    }

    // Stop audio capture but keep the overlay visible with an animated wave.
    // Called when transitioning from RECORDING → TRANSCRIBING.
    _switchWaveformToTranscribing() {
        if (!this._waveformOverlay)
            return;

        // Stop the audio capture subprocess
        if (this._vizCancellable) {
            this._vizCancellable.cancel();
            this._vizCancellable = null;
        }
        if (this._vizProc) {
            try { this._vizProc.force_exit(); } catch (_) {}
            this._vizProc = null;
        }
        this._vizInputStream = null;

        this._targetRms = 0;
        this._currentRms = 0;
        this._vizPhase = 0;
        this._vizMode = 'transcribing';
        // The repaint timer (_vizDrawId) keeps running — the draw function
        // will render the animation instead of the real waveform.
    }

    _readVizChunk() {
        if (!this._vizInputStream || !this._vizCancellable)
            return;

        // 3200 bytes = 1600 samples × 2 bytes (s16le at 16 kHz ≈ 100 ms per bar)
        this._vizInputStream.read_bytes_async(
            3200, GLib.PRIORITY_DEFAULT, this._vizCancellable, (stream, res) => {
                try {
                    const bytes = stream.read_bytes_finish(res);
                    if (!bytes || bytes.get_size() === 0)
                        return;

                    if (this._vizWarmupChunks > 0) {
                        this._vizWarmupChunks--;
                    } else {
                        // Capture target RMS; the 60fps draw loop will interpolate smoothly towards it.
                        this._targetRms = this._computeRms(this._unpackBytes(bytes));
                    }

                    this._readVizChunk();
                } catch (_) {
                    // Cancelled or stream ended — stop gracefully
                }
            });
    }

    _computeRms(u8) {
        if (!u8 || u8.length < 2)
            return 0;
        let sum = 0;
        const n = Math.floor(u8.length / 2);
        for (let i = 0; i < n; i++) {
            let s = (u8[i * 2 + 1] << 8) | u8[i * 2];
            if (s > 32767)
                s -= 65536;
            sum += s * s;
        }
        return Math.sqrt(sum / n) / 32768;
    }

    // GJS GLib.Bytes.get_data() can return a [Uint8Array, size] tuple
    _unpackBytes(bytes) {
        let data = bytes.get_data();
        if (Array.isArray(data))
            data = data[0];
        return data;
    }

    _drawWaveform(cr, width, height) {
        // Clear to transparent
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        // Rounded-rect background
        const r = 12;
        cr.newPath();
        cr.arc(r,         r,          r, Math.PI,       1.5 * Math.PI);
        cr.arc(width - r, r,          r, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(width - r, height - r, r, 0,             0.5 * Math.PI);
        cr.arc(r,         height - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
        cr.setSourceRGBA(0.02, 0.02, 0.02, 0.95);
        cr.fill();

        const barW     = 2;
        const gap      = 1;
        const step     = barW + gap;
        const maxHalfH = Math.floor(height / 2) - 4;
        const centerY  = height / 2;
        const nBars    = Math.min(WAVEFORM_BARS, Math.floor((width - 8) / step));
        const startX   = Math.floor((width - nBars * step + gap) / 2);

        this._vizPhase += 0.05;

        const denom = Math.max(1, nBars - 1);

        if (this._vizMode === 'transcribing') {
            for (let i = 0; i < nBars; i++) {
                const x = startX + i * step;

                // Normalized coordinate across the container [0.0 to 1.0]
                const normI = i / denom;
                
                // Static envelope keeps the left/right edges forced to height 0
                const envelope = Math.sin(normI * Math.PI);
                
                // Create exactly 3 peaks across the entire width (normI * 3 * PI).
                // Subtracting a faster portion of _vizPhase smoothly shifts the peaks left-to-right rapidly.
                const spatial = Math.pow(Math.sin((normI * 3 * Math.PI) - (this._vizPhase * 1.0)), 2);
                
                // Subtle breathing effect on the overall height so it feels organic
                const temporal = 0.8 + 0.2 * Math.sin(this._vizPhase * 0.5);
                
                // Combine into final height, capped at 0.8 amplitude
                const wave = 0.8 * spatial * temporal * envelope;
                const halfH = Math.max(1, Math.round(wave * maxHalfH));

                cr.setSourceRGBA(0.9, 0.9, 0.95, 0.9);
                cr.rectangle(x, centerY - halfH, barW, halfH * 2);
                cr.fill();
            }
        } else {
            // Smoothly interpolate current RMS towards the latest target RMS from ffmpeg
            this._currentRms += (this._targetRms - this._currentRms) * 0.2;

            const NOISE_FLOOR = 0.02;
            const gated = Math.max(0, this._currentRms - NOISE_FLOOR);
            const globalAmp = Math.min(1, 1.5 * Math.sqrt(gated / (1 - NOISE_FLOOR)));

            for (let i = 0; i < nBars; i++) {
                const x = startX + i * step;
                // Envelope makes bars in the center tallest, tapering out at edges
                const envelope = Math.sin((i / denom) * Math.PI);
                
                // Add this._vizPhase to the spatial components so the waveform wiggles horizontally.
                // It creates overlapping ripples that travel continuously right and left inside the fixed envelope.
                const spatial = 0.5 
                              + 0.25 * Math.sin(i * 0.25 - this._vizPhase * 1.2) 
                              + 0.25 * Math.cos(i * 0.43 + this._vizPhase * 0.8);
                
                // Final amplitude for this individual bar
                const barAmp = globalAmp * spatial * envelope;
                const halfH = Math.max(1, Math.round(barAmp * maxHalfH));

                // Mapping amplitude to color brightness: lower amplitude -> darker gray, higher -> white
                // By multiplying by 2.0, peaks become brightly white faster
                const intensity = Math.min(1, barAmp * 2.0);
                const cVal = 0.4 + 0.6 * intensity; // 0.4 is dark gray, 1.0 is pure white

                cr.setSourceRGBA(cVal, cVal, cVal, 0.9);
                cr.rectangle(x, centerY - halfH, barW, halfH * 2);
                cr.fill();
            }
        }
    }

    /* ────────────────────────────────────────────────────────── */
    /*  Helpers                                                   */
    /* ────────────────────────────────────────────────────────── */

    _killRecording() {
        if (this._recordSubprocess) {
            try { this._recordSubprocess.send_signal(2); } catch (_) {}
            try { this._recordSubprocess.force_exit(); } catch (_) {}
            this._recordSubprocess = null;
        }
    }

    _resetIndicator() {
        this._state = State.IDLE;
        this._stopTimer();
        this._stopWaveformOverlay();
        if (this._icon) {
            this._icon.icon_name = 'audio-input-microphone-symbolic';
            this._icon.set_style('');
        }
        this._updateStatusLabel();
    }
}
