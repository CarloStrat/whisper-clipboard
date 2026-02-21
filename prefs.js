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
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

/* ── History helpers ── */

function parseHistoryEntry(raw) {
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.text === 'string')
            return obj;
    } catch (_) {}
    return {text: raw, timestamp: 0, language: '', translated: false};
}

function formatRelativeTime(unixSeconds) {
    if (!unixSeconds)
        return '';
    const diff = Math.floor(Date.now() / 1000) - unixSeconds;
    if (diff < 60)
        return 'just now';
    if (diff < 3600)
        return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 7 * 86400)
        return `${Math.floor(diff / 86400)}d ago`;
    return new Date(unixSeconds * 1000).toLocaleDateString();
}

function languageLabel(code) {
    if (!code)
        return '';
    if (code === 'auto')
        return 'Auto-detected';
    const found = LANGUAGES.find(l => l.code === code);
    return found ? found.label : code;
}

/* ── Model scanner (mirrors extension.js logic, runs in prefs process) ── */

const MODEL_SEARCH_DIRS = [
    `${GLib.get_home_dir()}/.local/share/whisper/models`,
    `${GLib.get_home_dir()}/whisper.cpp/models`,
    '/opt/whisper.cpp/models',
    '/usr/share/whisper.cpp/models',
    '/usr/local/share/whisper/models',
];

function scanModels(settings) {
    const seen = new Set();
    const models = [];
    const customDir = settings.get_string('whisper-models-dir').trim();
    const searchDirs = [...(customDir ? [customDir] : []), ...MODEL_SEARCH_DIRS];
    for (const dirPath of searchDirs) {
        try {
            const dir = Gio.File.new_for_path(dirPath);
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null,
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
        } catch (_) { /* dir may not exist */ }
    }
    models.sort();
    return models;
}

/* ── Shortcut capture row ── */

/**
 * Adw.ActionRow that shows the current shortcut via Gtk.ShortcutLabel inside
 * a flat button. Clicking the button (or the row) opens a capture window where
 * the next key combination is recorded as the new shortcut.
 */
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(params, settings, key) {
        super._init(params);

        this._settings = settings;
        this._key = key;

        // Gtk.ShortcutLabel renders the accel nicely; wrap it in a flat button
        // so the row has a proper activatable widget that responds to clicks.
        this._accelLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });

        this._button = new Gtk.Button({
            child: this._accelLabel,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        this.add_suffix(this._button);
        this.set_activatable_widget(this._button);

        this._refresh();
        this._settings.connect(`changed::${this._key}`, () => this._refresh());
        this._button.connect('clicked', () => this._openCapture());
    }

    _refresh() {
        const accels = this._settings.get_strv(this._key);
        this._accelLabel.set_accelerator(
            accels[0] ?? '',
        );
    }

    _openCapture() {
        const win = new Gtk.Window({
            title: `Set shortcut – ${this.get_title()}`,
            transient_for: this.get_root(),
            modal: true,
            default_width: 400,
            default_height: 200,
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 20,
            margin_top: 30,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        win.set_child(box);

        box.append(new Gtk.Label({
            label: '<b>Press a key combination…</b>\n<small>Escape to cancel</small>',
            use_markup: true,
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
        }));

        // Live preview of the current shortcut
        const preview = new Gtk.ShortcutLabel({
            accelerator: this._settings.get_strv(this._key)[0] ?? '',
            disabled_text: '(none)',
            halign: Gtk.Align.CENTER,
        });
        box.append(preview);

        const disableBtn = new Gtk.Button({
            label: 'Disable shortcut',
            halign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        disableBtn.connect('clicked', () => {
            this._settings.set_strv(this._key, []);
            win.destroy();
        });
        box.append(disableBtn);

        // Key capture
        const controller = new Gtk.EventControllerKey();
        win.add_controller(controller);

        controller.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            // Escape = cancel
            if (keyval === Gdk.KEY_Escape) {
                win.destroy();
                return true;
            }

            // Ignore bare modifier presses
            const modOnly = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L,   Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L,     Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L,   Gdk.KEY_Super_R,
                Gdk.KEY_ISO_Level3_Shift,
                Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
            ];
            if (modOnly.includes(keyval))
                return false;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel) {
                this._settings.set_strv(this._key, [accel]);
                win.destroy();
            }
            return true;
        });

        win.present();
    }
});

/* ── Main preferences class ── */

export default class WhisperClipboardPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 720);

        /* ════════════════════════════════ General page ══ */
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        /* ── Shortcuts ── */
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click a row to set a new key combination',
        });
        generalPage.add(shortcutsGroup);

        shortcutsGroup.add(new ShortcutRow(
            {title: 'Toggle recording', subtitle: 'Start or stop recording'},
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

        /* ── Transcription ── */
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
            subtitle: 'Language sent to whisper-server per transcription request',
            model: langModel,
        });

        const syncLangCombo = () => {
            const idx = langCodes.indexOf(settings.get_string('whisper-language'));
            if (idx >= 0) langRow.set_selected(idx);
        };
        syncLangCombo();

        langRow.connect('notify::selected', () => {
            const idx = langRow.get_selected();
            if (idx >= 0)
                settings.set_string('whisper-language', langCodes[idx]);
        });
        settings.connect('changed::whisper-language', syncLangCombo);
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

        /* ── Clipboard ── */
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

        /* ── History ── */
        const historyGroup = new Adw.PreferencesGroup({title: 'History'});
        generalPage.add(historyGroup);

        const historyRow = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Number of past transcriptions kept in the History menu (1–50)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 50,
                step_increment: 1,
                value: settings.get_int('history-size'),
            }),
        });
        // Use notify::value to safely bridge gdouble ↔ gint
        historyRow.connect('notify::value', () => {
            settings.set_int('history-size', Math.round(historyRow.get_value()));
        });
        settings.connect('changed::history-size', () => {
            historyRow.set_value(settings.get_int('history-size'));
        });
        historyGroup.add(historyRow);

        /* ════════════════════════════════ Server page ══ */
        const serverPage = new Adw.PreferencesPage({
            title: 'Server',
            icon_name: 'network-server-symbolic',
        });
        window.add(serverPage);

        const serverGroup = new Adw.PreferencesGroup({
            title: 'whisper-server',
            description: 'Changes take effect after restarting the server from the panel menu',
        });
        serverPage.add(serverGroup);

        // ── Model selection ──
        const discoveredModels = scanModels(settings);
        let modelComboRow = null;

        // Model path text entry (with file picker)
        const modelRow = new Adw.EntryRow({
            title: 'Model path',
            text: settings.get_string('whisper-model'),
            show_apply_button: true,
        });

        const modelFileBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Browse for model file',
        });
        modelFileBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select Model File', modal: true});
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.bin');
            filter.set_name('Whisper models (*.bin)');
            dialog.set_default_filter(filter);
            const current = settings.get_string('whisper-model');
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(GLib.path_get_dirname(current)));
            dialog.open(window, null, (d, res) => {
                try { settings.set_string('whisper-model', d.open_finish(res).get_path()); }
                catch (_) {}
            });
        });
        modelRow.add_suffix(modelFileBtn);

        modelRow.connect('apply', () => {
            settings.set_string('whisper-model', modelRow.get_text());
        });

        settings.connect('changed::whisper-model', () => {
            const path = settings.get_string('whisper-model');
            if (modelRow.get_text() !== path)
                modelRow.set_text(path);
            if (modelComboRow) {
                const idx = discoveredModels.indexOf(path);
                if (idx >= 0 && modelComboRow.get_selected() !== idx)
                    modelComboRow.set_selected(idx);
            }
        });

        // Discovered models combo (quick picker shown above the text entry)
        if (discoveredModels.length > 0) {
            const namesList = new Gtk.StringList();
            discoveredModels.forEach(p => namesList.append(GLib.path_get_basename(p)));

            modelComboRow = new Adw.ComboRow({
                title: 'Select model',
                subtitle: 'Models discovered in standard locations',
                model: namesList,
            });

            const initIdx = discoveredModels.indexOf(settings.get_string('whisper-model'));
            if (initIdx >= 0)
                modelComboRow.set_selected(initIdx);

            modelComboRow.connect('notify::selected', () => {
                const i = modelComboRow.get_selected();
                if (i >= 0 && i < discoveredModels.length)
                    settings.set_string('whisper-model', discoveredModels[i]);
            });

            serverGroup.add(modelComboRow);
        }

        serverGroup.add(modelRow);

        // Extra models directory (with folder picker)
        const modelsDirRow = new Adw.EntryRow({
            title: 'Extra models directory',
            text: settings.get_string('whisper-models-dir'),
            show_apply_button: true,
        });

        const modelsDirBtn = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Browse for models directory',
        });
        modelsDirBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select Models Directory', modal: true});
            const current = settings.get_string('whisper-models-dir');
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (d, res) => {
                try { settings.set_string('whisper-models-dir', d.select_folder_finish(res).get_path()); }
                catch (_) {}
            });
        });
        modelsDirRow.add_suffix(modelsDirBtn);

        modelsDirRow.connect('apply', () => {
            settings.set_string('whisper-models-dir', modelsDirRow.get_text());
        });
        settings.connect('changed::whisper-models-dir', () => {
            if (modelsDirRow.get_text() !== settings.get_string('whisper-models-dir'))
                modelsDirRow.set_text(settings.get_string('whisper-models-dir'));
        });
        serverGroup.add(modelsDirRow);

        // whisper-server binary override (with file picker)
        const binRow = new Adw.EntryRow({
            title: 'whisper-server binary',
            text: settings.get_string('whisper-server-bin'),
            show_apply_button: true,
        });

        const binFileBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Browse for whisper-server binary',
        });
        binFileBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select whisper-server Binary', modal: true});
            const current = settings.get_string('whisper-server-bin');
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(GLib.path_get_dirname(current)));
            dialog.open(window, null, (d, res) => {
                try { settings.set_string('whisper-server-bin', d.open_finish(res).get_path()); }
                catch (_) {}
            });
        });
        binRow.add_suffix(binFileBtn);

        binRow.connect('apply', () => {
            settings.set_string('whisper-server-bin', binRow.get_text());
        });
        settings.connect('changed::whisper-server-bin', () => {
            if (binRow.get_text() !== settings.get_string('whisper-server-bin'))
                binRow.set_text(settings.get_string('whisper-server-bin'));
        });
        serverGroup.add(binRow);

        // Server host
        const hostRow = new Adw.EntryRow({
            title: 'Server host',
            text: settings.get_string('server-host'),
            show_apply_button: true,
        });
        hostRow.connect('apply', () => {
            settings.set_string('server-host', hostRow.get_text().trim() || '127.0.0.1');
        });
        settings.connect('changed::server-host', () => {
            if (hostRow.get_text() !== settings.get_string('server-host'))
                hostRow.set_text(settings.get_string('server-host'));
        });
        serverGroup.add(hostRow);

        // Server port
        const portRow = new Adw.SpinRow({
            title: 'Server port',
            subtitle: 'HTTP port for the local whisper-server (default 8178)',
            adjustment: new Gtk.Adjustment({
                lower: 1024,
                upper: 65535,
                step_increment: 1,
                value: settings.get_int('server-port'),
            }),
        });
        portRow.connect('notify::value', () => {
            settings.set_int('server-port', Math.round(portRow.get_value()));
        });
        settings.connect('changed::server-port', () => {
            portRow.set_value(settings.get_int('server-port'));
        });
        serverGroup.add(portRow);

        /* ════════════════════════════════ History page ══ */
        const historyPage = new Adw.PreferencesPage({
            title: 'History',
            icon_name: 'document-open-recent-symbolic',
        });
        window.add(historyPage);

        let currentHistoryGroup = null;

        const buildHistoryPage = () => {
            if (currentHistoryGroup)
                historyPage.remove(currentHistoryGroup);

            const rawEntries = settings.get_strv('history').slice().reverse(); // most-recent first

            currentHistoryGroup = new Adw.PreferencesGroup();

            if (rawEntries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: 'No transcriptions yet',
                    sensitive: false,
                });
                currentHistoryGroup.add(emptyRow);
            } else {
                const clearBtn = new Gtk.Button({
                    label: 'Clear All',
                    css_classes: ['destructive-action'],
                    valign: Gtk.Align.CENTER,
                });
                clearBtn.connect('clicked', () => settings.set_strv('history', []));
                currentHistoryGroup.set_header_suffix(clearBtn);

                rawEntries.forEach((raw, reversedIndex) => {
                    const entry = parseHistoryEntry(raw);
                    const {text, timestamp, language, translated} = entry;

                    const preview = text.length > 100
                        ? `${text.substring(0, 100)}…`
                        : text;

                    const expander = new Adw.ExpanderRow({
                        title: GLib.markup_escape_text(preview, -1),
                        subtitle: formatRelativeTime(timestamp),
                    });

                    // Copy button
                    const copyBtn = new Gtk.Button({
                        icon_name: 'edit-copy-symbolic',
                        tooltip_text: 'Copy to clipboard',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                    });
                    copyBtn.connect('clicked', () => {
                        Gdk.Display.get_default().get_clipboard().set_content(
                            Gdk.ContentProvider.new_for_value(text));
                        window.add_toast(new Adw.Toast({title: 'Copied to clipboard'}));
                    });
                    expander.add_suffix(copyBtn);

                    // Delete button
                    const deleteBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        tooltip_text: 'Delete entry',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                    });
                    deleteBtn.connect('clicked', () => {
                        // reversedIndex 0 = last element in original array
                        const all = settings.get_strv('history');
                        const originalIndex = all.length - 1 - reversedIndex;
                        all.splice(originalIndex, 1);
                        settings.set_strv('history', all);
                    });
                    expander.add_suffix(deleteBtn);

                    // Full text row
                    const fullTextRow = new Adw.ActionRow({
                        subtitle: GLib.markup_escape_text(text, -1),
                        subtitle_lines: 0,
                    });
                    expander.add_row(fullTextRow);

                    // Metadata row
                    const metaParts = [];
                    const lang = languageLabel(language);
                    if (lang)
                        metaParts.push(lang);
                    if (translated)
                        metaParts.push('Translated to English');
                    if (timestamp) {
                        metaParts.push(new Date(timestamp * 1000).toLocaleString());
                    }
                    if (metaParts.length > 0) {
                        const metaRow = new Adw.ActionRow({
                            subtitle: GLib.markup_escape_text(metaParts.join(' · '), -1),
                            subtitle_lines: 0,
                            css_classes: ['caption'],
                        });
                        expander.add_row(metaRow);
                    }

                    currentHistoryGroup.add(expander);
                });
            }

            historyPage.add(currentHistoryGroup);
        };

        buildHistoryPage();
        settings.connect('changed::history', buildHistoryPage);
    }
}
