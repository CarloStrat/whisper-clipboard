/**
 * Whisper Clipboard – Shared constants and utilities
 *
 * Imported by both extension.js and prefs.js to avoid duplication.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ~20 most common languages for Whisper
export const LANGUAGES = [
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

// Pre-built set for O(1) lookups
export const KNOWN_LANG_CODES = new Set(LANGUAGES.map(l => l.code));

export const MODEL_SEARCH_DIRS = [
    `${GLib.get_home_dir()}/.local/share/whisper/models`,
    `${GLib.get_home_dir()}/whisper.cpp/models`,
    '/opt/whisper.cpp/models',
    '/usr/share/whisper.cpp/models',
    '/usr/local/share/whisper/models',
];

/**
 * Scan standard directories (plus an optional custom dir from settings) for
 * whisper model files.  Accepts both legacy `ggml-*.bin` files and the newer
 * `.gguf` format.
 *
 * @param {Gio.Settings} settings - GSettings object for the extension.
 * @returns {string[]} Sorted list of absolute model file paths.
 */
export function scanModels(settings) {
    const seen = new Set();
    const models = [];

    const customDir = settings.get_string('whisper-models-dir').trim();
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
                if ((name.startsWith('ggml-') && name.endsWith('.bin')) ||
                    name.endsWith('.gguf')) {
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
