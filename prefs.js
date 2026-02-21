/**
 * Whisper Clipboard – Preferences
 *
 * Opens via: gnome-extensions prefs whisper-clipboard@local
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

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

/* ── Shortcut capture row ── */

/**
 * An Adw.ActionRow that shows the current shortcut and opens a capture dialog
 * when activated.
 */
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(params, settings, key) {
        super._init(params);

        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            accelerator: this._getAccel(),
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);
        this.set_activatable_widget(this._label);

        this._settings.connect(`changed::${key}`, () => {
            this._label.set_accelerator(this._getAccel());
        });

        this.connect('activated', () => this._startCapture());
    }

    _getAccel() {
        const accels = this._settings.get_strv(this._key);
        return (accels.length > 0 && accels[0]) ? accels[0] : '';
    }

    _startCapture() {
        const dialog = new Gtk.Window({
            title: `Set shortcut – ${this.get_title()}`,
            modal: true,
            transient_for: this.get_root(),
            default_width: 360,
            default_height: 180,
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        dialog.set_child(box);

        box.append(new Gtk.Label({
            label: '<b>Press a key combination…</b>',
            use_markup: true,
            halign: Gtk.Align.CENTER,
        }));

        const currentLabel = new Gtk.ShortcutLabel({
            accelerator: this._getAccel(),
            disabled_text: '(none)',
            halign: Gtk.Align.CENTER,
        });
        box.append(currentLabel);

        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });
        box.append(btnBox);

        const disableBtn = new Gtk.Button({label: 'Disable'});
        disableBtn.connect('clicked', () => {
            this._settings.set_strv(this._key, []);
            dialog.destroy();
        });
        btnBox.append(disableBtn);

        const cancelBtn = new Gtk.Button({label: 'Cancel'});
        cancelBtn.connect('clicked', () => dialog.destroy());
        btnBox.append(cancelBtn);

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);

        controller.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            // Skip bare modifier presses
            const modOnly = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L,   Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L,     Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L,   Gdk.KEY_Super_R,
                Gdk.KEY_ISO_Level3_Shift,
                Gdk.KEY_Caps_Lock,
            ];
            if (modOnly.includes(keyval))
                return false;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel) {
                this._settings.set_strv(this._key, [accel]);
                dialog.destroy();
            }
            return true;
        });

        dialog.present();
    }
});

/* ── Main preferences class ── */

export default class WhisperClipboardPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 700);

        /* ── General page ── */
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        /* Shortcuts group */
        const shortcutsGroup = new Adw.PreferencesGroup({title: 'Shortcuts'});
        generalPage.add(shortcutsGroup);

        shortcutsGroup.add(new ShortcutRow(
            {title: 'Toggle recording', subtitle: 'Start / stop recording'},
            settings, 'whisper-clipboard-toggle',
        ));

        shortcutsGroup.add(new ShortcutRow(
            {title: 'Cancel recording', subtitle: 'Abort recording without transcribing'},
            settings, 'whisper-cancel-toggle',
        ));

        const pttRow = new Adw.SwitchRow({
            title: 'Push-to-talk',
            subtitle: 'Hold the shortcut to record; release to transcribe',
        });
        settings.bind('push-to-talk', pttRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        shortcutsGroup.add(pttRow);

        /* Transcription group */
        const transcriptionGroup = new Adw.PreferencesGroup({title: 'Transcription'});
        generalPage.add(transcriptionGroup);

        // Language combo
        const langModel = new Gtk.StringList();
        const langCodes = [];
        for (const {code, label} of LANGUAGES) {
            langModel.append(label);
            langCodes.push(code);
        }

        const langRow = new Adw.ComboRow({
            title: 'Language',
            subtitle: 'Language code sent to whisper-server per request',
            model: langModel,
        });

        const currentLang = settings.get_string('whisper-language');
        const langIdx = langCodes.indexOf(currentLang);
        langRow.set_selected(langIdx >= 0 ? langIdx : 0);

        langRow.connect('notify::selected', () => {
            const idx = langRow.get_selected();
            if (idx >= 0 && idx < langCodes.length)
                settings.set_string('whisper-language', langCodes[idx]);
        });

        settings.connect('changed::whisper-language', () => {
            const code = settings.get_string('whisper-language');
            const idx = langCodes.indexOf(code);
            if (idx >= 0)
                langRow.set_selected(idx);
        });

        transcriptionGroup.add(langRow);

        const autoDetectRow = new Adw.SwitchRow({
            title: 'Auto-detect language',
            subtitle: 'Let whisper-server detect the spoken language automatically',
        });
        settings.bind('auto-detect-language', autoDetectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        transcriptionGroup.add(autoDetectRow);

        const translateRow = new Adw.SwitchRow({
            title: 'Translate to English',
            subtitle: 'Translate the transcription to English regardless of source language',
        });
        settings.bind('translate-to-english', translateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        transcriptionGroup.add(translateRow);

        /* Clipboard group */
        const clipboardGroup = new Adw.PreferencesGroup({title: 'Clipboard'});
        generalPage.add(clipboardGroup);

        const autoPasteRow = new Adw.SwitchRow({
            title: 'Auto-paste',
            subtitle: 'Automatically paste transcribed text into the active window',
        });
        settings.bind('auto-paste', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        clipboardGroup.add(autoPasteRow);

        const ctrlShiftVRow = new Adw.SwitchRow({
            title: 'Use Ctrl+Shift+V',
            subtitle: 'Paste with Ctrl+Shift+V instead of Ctrl+V (for terminal apps)',
        });
        settings.bind('paste-use-ctrl-shift-v', ctrlShiftVRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        clipboardGroup.add(ctrlShiftVRow);

        /* History group */
        const historyGroup = new Adw.PreferencesGroup({title: 'History'});
        generalPage.add(historyGroup);

        const historyRow = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Number of past transcriptions kept in the History menu',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 50,
                step_increment: 1,
                value: settings.get_int('history-size'),
            }),
        });
        settings.bind('history-size', historyRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(historyRow);

        /* ── Server page ── */
        const serverPage = new Adw.PreferencesPage({
            title: 'Server',
            icon_name: 'network-server-symbolic',
        });
        window.add(serverPage);

        const serverGroup = new Adw.PreferencesGroup({title: 'whisper-server'});
        serverPage.add(serverGroup);

        const modelRow = new Adw.EntryRow({
            title: 'Model path',
            text: settings.get_string('whisper-model'),
        });
        modelRow.connect('changed', () => {
            settings.set_string('whisper-model', modelRow.get_text());
        });
        settings.connect('changed::whisper-model', () => {
            if (modelRow.get_text() !== settings.get_string('whisper-model'))
                modelRow.set_text(settings.get_string('whisper-model'));
        });
        serverGroup.add(modelRow);

        const modelsDirRow = new Adw.EntryRow({
            title: 'Extra models directory',
            text: settings.get_string('whisper-models-dir'),
        });
        modelsDirRow.connect('changed', () => {
            settings.set_string('whisper-models-dir', modelsDirRow.get_text());
        });
        serverGroup.add(modelsDirRow);

        const binRow = new Adw.EntryRow({
            title: 'whisper-server binary',
            text: settings.get_string('whisper-server-bin'),
        });
        binRow.set_show_apply_button(true);
        binRow.connect('apply', () => {
            settings.set_string('whisper-server-bin', binRow.get_text());
        });
        serverGroup.add(binRow);

        const portRow = new Adw.SpinRow({
            title: 'Server port',
            subtitle: 'HTTP port for the whisper-server backend',
            adjustment: new Gtk.Adjustment({
                lower: 1024,
                upper: 65535,
                step_increment: 1,
                value: settings.get_int('server-port'),
            }),
        });
        settings.bind('server-port', portRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        serverGroup.add(portRow);
    }
}
