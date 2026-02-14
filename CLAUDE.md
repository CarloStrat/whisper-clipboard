# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Whisper Clipboard is a GNOME Shell extension (target: GNOME Shell 49) that records audio via a keyboard shortcut, transcribes it using `whisper.cpp`, and copies the result to the clipboard.

External runtime dependencies: `arecord` (ALSA) and `whisper-cli` (whisper.cpp).

## Installation & Development

There is no build step. The extension runs directly as JavaScript inside GNOME Shell.

**Install/reinstall:**
```bash
bash install.sh
```

The script compiles GSettings schemas and copies files to `~/.local/share/gnome-shell/extensions/whisper-clipboard@local/`.

**After installing on Wayland**, log out and back in. On X11: Alt+F2 → `r`.

**Enable the extension:**
```bash
gnome-extensions enable whisper-clipboard@local
```

**Reload after editing `extension.js` (X11 only):**
```bash
# Alt+F2, then type 'r' and press Enter
```
On Wayland, a full logout/login is required to reload extension code.

**View extension logs:**
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

**Change the keybinding** (default: Super+Shift+R):
```bash
dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-clipboard-toggle "['<Super><Shift>r']"
```

## Architecture

`extension.js` is the entire extension — a single class `WhisperClipboardExtension` with a three-state machine:

- `IDLE (0)` → `RECORDING (1)` → `TRANSCRIBING (2)` → back to `IDLE`

**State transitions** are driven by the keybinding handler `_toggle()`, which dispatches to `_startRecording()` or `_stopAndTranscribe()` based on current state. A `_locked` flag prevents re-entrant invocations.

**Audio recording**: spawns `arecord` as a subprocess writing to `/tmp/whisper_clip_recording.wav`. Stopped by sending SIGINT (which causes arecord to finalize the WAV header before exiting).

**Transcription**: spawns `whisper-cli` asynchronously via `Gio.Subprocess`. Output is read from stdout and pasted into the clipboard via `St.Clipboard`.

**Panel indicator**: an `St.Button` in the GNOME top bar with emoji labels that reflect current state (🎙️ / ⏺ red / ⏳ orange / ✓ green).

**Settings**: keybinding is stored in GSettings using the schema in `schemas/`. The schema must be compiled (`glib-compile-schemas`) before the extension can read it.

## Configurable Constants (top of `extension.js`)

```js
const WHISPER_MODEL = '/opt/whisper.cpp/models/ggml-small.bin';
const WHISPER_LANG = 'it';  // language code passed to whisper-cli
```
