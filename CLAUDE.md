# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Whisper Clipboard is a GNOME Shell extension (target: GNOME Shell 49) that records audio via a keyboard shortcut, transcribes it using a persistent `whisper-server` (whisper.cpp HTTP backend), and copies the result to the clipboard.

External runtime dependencies: `ffmpeg` (audio recording), `whisper-server` (whisper.cpp HTTP server, auto-detected or configurable).

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

**Open preferences:**
```bash
gnome-extensions prefs whisper-clipboard@local
```

**View extension logs:**
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Architecture

### Files

| File | Purpose |
|------|---------|
| `extension.js` | Entire extension — `WhisperClipboardExtension` class with state machine, recording, transcription, waveform overlay, panel indicator, menus |
| `prefs.js` | Adw-based preferences window (General + Server pages) with custom `ShortcutRow` GObject |
| `stylesheet.css` | Timer label styling (`.whisper-timer-label`) |
| `schemas/org.gnome.shell.extensions.whisper-clipboard.gschema.xml` | GSettings schema (all keys) |
| `metadata.json` | Extension metadata including `settings-schema` for GNOME 49 |
| `install.sh` | Compiles schemas and copies files to extension directory |

### State Machine

Three-state machine in `extension.js`:

`IDLE (0)` → `RECORDING (1)` → `TRANSCRIBING (2)` → back to `IDLE`

State transitions are driven by `_toggle()`, which dispatches to `_startRecording()` or `_stopAndTranscribe()`. A `_locked` flag prevents re-entrant invocations.

### Key Subsystems

**Whisper server**: a persistent `whisper-server` process is managed by the extension (auto-started, health-checked). Transcription requests are multipart POSTs to `http://127.0.0.1:{port}/inference` via `Soup`. The server is auto-detected from PATH or common install locations, configurable via GSettings.

**Audio recording**: spawns `ffmpeg` writing to `/tmp/whisper_clip_recording.wav`. Stopped by sending SIGINT.

**Waveform overlay**: a floating 350×64px dark pill rendered with Cairo while recording. A second `ffmpeg` process streams raw PCM to stdout; RMS amplitude is computed and fed into a 140-bar waveform drawn at ~60fps. During transcription, the overlay shows a sliding 3-peak sine wave animation. Includes noise gate and warmup chunk discarding.

**Panel indicator**: `PanelMenu.Button` with icon + timer label (`St.BoxLayout`). Recording shows elapsed time (M:SS). Icon color set via inline `set_style()` for reliable rendering across icon themes.

**Push-to-talk**: when enabled, uses `global.stage` key-press/release events instead of `Main.wm` keybinding. Includes manual accelerator parser (`_parseAccelerator()`). Switches live via `changed::push-to-talk` signal.

**Auto-paste**: optionally types transcribed text into the focused window via Clutter virtual keyboard (Ctrl+V or Ctrl+Shift+V).

**History**: in-memory array with configurable size (1–50). History submenu in panel menu with click-to-copy and Clear.

**Settings**: stored in GSettings (`schemas/`). The schema must be compiled (`glib-compile-schemas`) before use. Preferences UI in `prefs.js` with shortcut capture dialogs, language selection, toggles, and server configuration.

## Key GSettings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `whisper-clipboard-toggle` | `as` | `<Shift><Alt>space` | Toggle shortcut |
| `whisper-cancel-toggle` | `as` | `<Shift><Alt>Escape` | Cancel shortcut |
| `whisper-language` | `s` | `en` | Language code |
| `auto-detect-language` | `b` | `false` | Send `language=auto` |
| `translate-to-english` | `b` | `false` | Add `translate=true` to request |
| `whisper-model` | `s` | | Model file path |
| `whisper-models-dir` | `s` | | Extra model scan directory |
| `whisper-server-bin` | `s` | | Server binary path override |
| `server-port` | `i` | `8178` | Server port |
| `auto-paste` | `b` | `false` | Auto-paste after transcription |
| `paste-use-ctrl-shift-v` | `b` | `false` | Use Ctrl+Shift+V for paste |
| `history-size` | `i` | `10` | Max history entries (1–50) |
| `push-to-talk` | `b` | `false` | Hold-to-record mode |
