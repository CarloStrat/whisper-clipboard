/**
 * Whisper Clipboard - GNOME 49 Extension
 *
 * Press Shift+Alt+Space to toggle recording.
 *   - First press  -> starts ffmpeg recording
 *   - Second press -> stops ffmpeg, sends audio to whisper-server, copies text to clipboard
 *
 * Uses whisper-server as a persistent backend to avoid model reload overhead.
 * A panel indicator shows the current state with symbolic icons.
 * Click the indicator to access language, model, and feature settings.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

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

const LANGUAGES = [
    {code: 'it', label: 'Italiano'},
    {code: 'en', label: 'English'},
    {code: 'es', label: 'Español'},
    {code: 'fr', label: 'Français'},
    {code: 'de', label: 'Deutsch'},
    {code: 'pt', label: 'Português'},
];

const MODELS_DIR = '/opt/whisper.cpp/models';
const WHISPER_SERVER_BIN = '/opt/whisper.cpp/build/bin/whisper-server';

export default class WhisperClipboardExtension extends Extension {

    enable() {
        this._state = State.IDLE;
        this._recordSubprocess = null;
        this._serverSubprocess = null;
        this._serverReady = false;
        this._healthCheckId = null;
        this._wavPath = GLib.build_filenamev([GLib.get_tmp_dir(), 'whisper_clip_recording.wav']);
        this._successTimeoutId = null;

        /* ── settings ── */
        this._settings = this._getKeybindingSettings();

        /* ── HTTP session ── */
        this._session = new Soup.Session();

        /* ── virtual keyboard for auto-paste ── */
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        /* ── panel button ── */
        this._indicator = new PanelMenu.Button(0.0, 'WhisperClipboard', false);
        this._icon = new St.Icon({
            icon_name: 'org.gnome.Settings-accessibility-hearing-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);
        Main.panel.addToStatusArea('whisper-clipboard', this._indicator);

        /* ── popup menu ── */
        this._buildMenu();

        /* ── keyboard shortcut ── */
        Main.wm.addKeybinding(
            'whisper-clipboard-toggle',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle(),
        );

        /* ── start whisper-server ── */
        this._startServer();
    }

    disable() {
        this._killRecording();
        this._stopServer();

        if (this._healthCheckId) {
            GLib.source_remove(this._healthCheckId);
            this._healthCheckId = null;
        }

        if (this._successTimeoutId) {
            GLib.source_remove(this._successTimeoutId);
            this._successTimeoutId = null;
        }

        Main.wm.removeKeybinding('whisper-clipboard-toggle');

        if (this._virtualDevice) {
            this._virtualDevice = null;
        }

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._keybindingSettings) {
            this._keybindingSettings.run_dispose?.();
            this._keybindingSettings = null;
        }

        this._settings = null;

        try {
            GLib.unlink(this._wavPath);
        } catch (_) { /* ignore */ }
    }

    /* ── whisper-server management ── */

    _getServerPort() {
        return this._settings.get_int('server-port');
    }

    _getServerUrl(path) {
        return `http://127.0.0.1:${this._getServerPort()}${path}`;
    }

    _startServer() {
        if (this._serverSubprocess)
            return;

        const whisperModel = this._settings.get_string('whisper-model');
        const whisperLang = this._settings.get_string('whisper-language');
        const port = this._getServerPort().toString();

        const cmd = [
            WHISPER_SERVER_BIN,
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
                const status = msg.get_status();
                if (status === Soup.Status.OK) {
                    this._serverReady = true;
                    this._updateServerStatusLabel();
                    return;
                }
            } catch (_) { /* server not ready yet */ }

            // Check if subprocess is still alive
            if (this._serverSubprocess) {
                this._pollHealth();
            }
        });
    }

    /* ── menu ── */

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

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Language submenu
        this._langSubmenu = new PopupMenu.PopupSubMenuMenuItem('Language');
        menu.addMenuItem(this._langSubmenu);
        this._populateLanguageMenu();

        // Model submenu
        this._modelSubmenu = new PopupMenu.PopupSubMenuMenuItem('Model');
        menu.addMenuItem(this._modelSubmenu);
        this._populateModelMenu();

        // Rebuild model list each time the submenu opens
        this._modelSubmenu.menu.connect('open-state-changed', (_, open) => {
            if (open)
                this._populateModelMenu();
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
        const currentLang = this._settings.get_string('whisper-language');

        for (const {code, label} of LANGUAGES) {
            const item = new PopupMenu.PopupMenuItem(label);
            if (code === currentLang)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            else
                item.setOrnament(PopupMenu.Ornament.NONE);

            item.connect('activate', () => {
                this._settings.set_string('whisper-language', code);
                this._populateLanguageMenu();
                this._restartServer();
            });
            this._langSubmenu.menu.addMenuItem(item);
        }
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
            if (modelPath === currentModel)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            else
                item.setOrnament(PopupMenu.Ornament.NONE);

            item.connect('activate', () => {
                this._settings.set_string('whisper-model', modelPath);
                this._populateModelMenu();
                this._restartServer();
            });
            this._modelSubmenu.menu.addMenuItem(item);
        }
    }

    _scanModels() {
        const models = [];
        try {
            const dir = Gio.File.new_for_path(MODELS_DIR);
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('ggml-') && name.endsWith('.bin'))
                    models.push(GLib.build_filenamev([MODELS_DIR, name]));
            }
            enumerator.close(null);
        } catch (_) { /* directory may not exist */ }

        models.sort();
        return models;
    }

    /* ── keybinding helper ── */

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

    /* ── toggle logic ── */

    _toggle() {
        switch (this._state) {
        case State.IDLE:
            this._startRecording();
            break;
        case State.RECORDING:
            this._stopAndTranscribe();
            break;
        case State.TRANSCRIBING:
            Main.notify('Whisper Clipboard', 'Transcription in progress, please wait…');
            break;
        }
    }

    /* ── recording ── */

    _startRecording() {
        if (!this._serverReady) {
            Main.notify('Whisper Clipboard', 'Server is still starting, please wait…');
            return;
        }

        // Remove old file
        try { GLib.unlink(this._wavPath); } catch (_) { /* ok */ }

        try {
            this._recordSubprocess = Gio.Subprocess.new(
                ['ffmpeg', '-y', '-f', 'alsa', '-i', 'default',
                 '-ar', '16000', '-ac', '1', this._wavPath],
                Gio.SubprocessFlags.STDERR_SILENCE,
            );

            this._state = State.RECORDING;
            this._icon.icon_name = 'media-record-symbolic';
            this._icon.remove_style_class_name('whisper-icon-transcribing');
            this._icon.remove_style_class_name('whisper-icon-success');
            this._icon.add_style_class_name('whisper-icon-recording');
            this._updateStatusLabel();
            Main.notify('Whisper Clipboard', 'Recording started…');
        } catch (e) {
            Main.notify('Whisper Clipboard', `Failed to start recording: ${e.message}`);
            this._state = State.IDLE;
            this._resetIndicator();
        }
    }

    /* ── stop + transcribe via whisper-server ── */

    _stopAndTranscribe() {
        this._killRecording();
        this._state = State.TRANSCRIBING;
        this._icon.icon_name = 'screen-reader-symbolic';
        this._icon.remove_style_class_name('whisper-icon-recording');
        this._icon.remove_style_class_name('whisper-icon-success');
        this._icon.add_style_class_name('whisper-icon-transcribing');
        this._updateStatusLabel();
        Main.notify('Whisper Clipboard', 'Transcribing…');

        // Read the WAV file
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
        const whisperLang = this._settings.get_string('whisper-language');

        const multipart = new Soup.Multipart('multipart/form-data');
        multipart.append_form_file('file', 'recording.wav', 'audio/wav', wavBytes);
        multipart.append_form_string('response_format', 'text');
        multipart.append_form_string('language', whisperLang);
        multipart.append_form_string('temperature', '0.0');
        multipart.append_form_string('temperature_inc', '0.2');
        multipart.append_form_string('no_timestamps', 'true');

        const msg = Soup.Message.new_from_multipart(this._getServerUrl('/inference'), multipart);

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const status = msg.get_status();

                if (status !== Soup.Status.OK) {
                    const decoder = new TextDecoder('utf-8');
                    const body = decoder.decode(bytes.get_data());
                    Main.notify('Whisper Clipboard', `Server error (${status}): ${body.substring(0, 120)}`);
                    this._resetIndicator();
                    return;
                }

                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(bytes.get_data()).trim();

                if (text.length === 0) {
                    Main.notify('Whisper Clipboard', 'No text recognized.');
                    this._resetIndicator();
                    return;
                }

                // Copy to clipboard
                const clipboard = St.Clipboard.get_default();
                clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                Main.notify('Whisper Clipboard',
                    `Copied to clipboard:\n"${text.substring(0, 120)}${text.length > 120 ? '…' : ''}"`);

                // Auto-paste if enabled
                if (this._settings.get_boolean('auto-paste'))
                    this._pasteFromClipboard();

                this._icon.icon_name = 'object-select-symbolic';
                this._icon.remove_style_class_name('whisper-icon-recording');
                this._icon.remove_style_class_name('whisper-icon-transcribing');
                this._icon.add_style_class_name('whisper-icon-success');

                // Reset icon after 3 s
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

    /* ── auto-paste ── */

    _pasteFromClipboard() {
        if (!this._virtualDevice)
            return;

        const useCtrlShiftV = this._settings.get_boolean('paste-use-ctrl-shift-v');

        // Small delay to ensure clipboard is set before pasting
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const t = GLib.get_monotonic_time();

            // Press modifier keys
            this._virtualDevice.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            if (useCtrlShiftV)
                this._virtualDevice.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);

            // Press and release V
            this._virtualDevice.notify_keyval(t + 1000, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._virtualDevice.notify_keyval(t + 2000, Clutter.KEY_v, Clutter.KeyState.RELEASED);

            // Release modifier keys
            if (useCtrlShiftV)
                this._virtualDevice.notify_keyval(t + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._virtualDevice.notify_keyval(t + 4000, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);

            return GLib.SOURCE_REMOVE;
        });
    }

    /* ── helpers ── */

    _killRecording() {
        if (this._recordSubprocess) {
            try {
                this._recordSubprocess.send_signal(2); // SIGINT
                this._recordSubprocess.wait(null);      // wait for clean exit
            } catch (_) { /* process may have already exited */ }
            this._recordSubprocess = null;
        }
    }

    _resetIndicator() {
        this._state = State.IDLE;
        if (this._icon) {
            this._icon.icon_name = 'org.gnome.Settings-accessibility-hearing-symbolic';
            this._icon.remove_style_class_name('whisper-icon-recording');
            this._icon.remove_style_class_name('whisper-icon-transcribing');
            this._icon.remove_style_class_name('whisper-icon-success');
        }
        this._updateStatusLabel();
    }
}
