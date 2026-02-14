/**
 * Whisper Clipboard - GNOME 49 Extension
 *
 * Press Super+Shift+R to toggle recording.
 *   - First press  -> starts ffmpeg recording
 *   - Second press -> stops ffmpeg, runs whisper-cli, copies text to clipboard
 *
 * A panel indicator shows the current state with symbolic icons.
 * Click the indicator to access language and model settings.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

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

export default class WhisperClipboardExtension extends Extension {

    enable() {
        this._state = State.IDLE;
        this._recordSubprocess = null;
        this._wavPath = GLib.build_filenamev([GLib.get_tmp_dir(), 'whisper_clip_recording.wav']);
        this._successTimeoutId = null;

        /* ── settings ── */
        this._settings = this._getKeybindingSettings();

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
    }

    disable() {
        this._killRecording();

        if (this._successTimeoutId) {
            GLib.source_remove(this._successTimeoutId);
            this._successTimeoutId = null;
        }

        Main.wm.removeKeybinding('whisper-clipboard-toggle');

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._keybindingSettings) {
            this._keybindingSettings.run_dispose?.();
            this._keybindingSettings = null;
        }

        this._settings = null;

        // Clean up temp file
        try {
            GLib.unlink(this._wavPath);
        } catch (_) { /* ignore */ }
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
    }

    _updateStatusLabel() {
        if (this._statusItem)
            this._statusItem.label.set_text(`Status: ${STATE_LABELS[this._state]}`);
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
            });
            this._langSubmenu.menu.addMenuItem(item);
        }
    }

    _populateModelMenu() {
        this._modelSubmenu.menu.removeAll();
        const currentModel = this._settings.get_string('whisper-model');

        // Scan models directory
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
            // ignore presses while busy
            Main.notify('Whisper Clipboard', 'Transcription in progress, please wait…');
            break;
        }
    }

    /* ── recording ── */

    _startRecording() {
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

    /* ── stop + transcribe ── */

    _stopAndTranscribe() {
        this._killRecording();
        this._state = State.TRANSCRIBING;
        this._icon.icon_name = 'screen-reader-symbolic';
        this._icon.remove_style_class_name('whisper-icon-recording');
        this._icon.remove_style_class_name('whisper-icon-success');
        this._icon.add_style_class_name('whisper-icon-transcribing');
        this._updateStatusLabel();
        Main.notify('Whisper Clipboard', 'Transcribing…');

        const whisperModel = this._settings.get_string('whisper-model');
        const whisperLang = this._settings.get_string('whisper-language');

        // Run whisper asynchronously
        const cmd = [
            'whisper-cli',
            '-m', whisperModel,
            '-l', whisperLang,
            '-nt',               // no timestamps
            '-f', this._wavPath,
        ];

        try {
            const proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );

            proc.communicate_utf8_async(null, null, (source, res) => {
                try {
                    const [_ok, stdout, stderr] = source.communicate_utf8_finish(res);
                    const text = (stdout ?? '').trim();

                    if (text.length === 0) {
                        Main.notify('Whisper Clipboard',
                            `No text recognized.\n${(stderr ?? '').trim()}`);
                        this._resetIndicator();
                        return;
                    }

                    // Copy to clipboard
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

                    Main.notify('Whisper Clipboard',
                        `Copied to clipboard:\n"${text.substring(0, 120)}${text.length > 120 ? '…' : ''}"`);

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
        } catch (e) {
            Main.notify('Whisper Clipboard', `Failed to launch whisper: ${e.message}`);
            this._resetIndicator();
        }
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
