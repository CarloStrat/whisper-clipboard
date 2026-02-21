# Internals

How Whisper Clipboard works, and why it's built the way it is.

## The problem

You want to talk and have the text show up where you're typing. This
means: record audio, transcribe it, put the result in the clipboard,
and optionally paste it. All of this has to happen inside a GNOME Shell
extension, which is a constrained environment — single-threaded, no Node,
no Python, just GJS and whatever GObject Introspection gives you.

## Architecture

Two files: `extension.js` (the extension itself) and `prefs.js` (the
preferences UI). One class per file. Three states:

    IDLE → RECORDING → TRANSCRIBING → IDLE

A keyboard shortcut toggles between them. `_toggle()` is the dispatcher.
In push-to-talk mode, the shortcut key-press starts recording and the
key-release stops it — same states, different trigger.

## The server approach

The first version spawned `whisper-cli` on every transcription. This
works but it's slow — a 500 MB model takes 1-2 seconds to load before
inference even starts.

The fix is `whisper-server`. It's an HTTP server that comes with
whisper.cpp. Start it once, the model loads once, then POST audio files
to it as needed. The model stays in memory between requests.

On `enable()`, the extension spawns:

    whisper-server -m <model> -l <lang> --host 127.0.0.1 --port 8178

On `disable()`, it kills the process. The server is fully managed by the
extension lifecycle. The port and binary path are configurable via GSettings.

### Health checking

The server takes a few seconds to load the model. During this time,
recording is blocked — pressing the shortcut shows "Server is still
starting" rather than silently failing.

The extension polls `GET /health` every second after spawning the server.
When it gets a 200, it sets `_serverReady = true` and updates the panel
menu to show "Server: Ready".

### Transcription

When recording stops, the WAV file gets POSTed to `/inference` as
multipart form data:

    POST /inference
    Content-Type: multipart/form-data

    file=<recording.wav>
    response_format=text
    language=en          (or 'auto' for auto-detect)
    translate=true       (optional, when translate-to-english is on)
    temperature=0.0
    temperature_inc=0.2
    no_timestamps=true

`response_format=text` returns a plain text body with no JSON parsing
needed. The HTTP client is libsoup 3.0 (`Soup.Session`), already
available inside GNOME Shell. One session is created on `enable()` and
reused for health checks and transcriptions.

*(Note: In GJS, `bytes.get_data()` occasionally returns a `[Uint8Array, size]` tuple depending on the GNOME version. The code safely checks for this to prevent decoding errors).*

### Language handling

Language is a per-request parameter. The server's `-l` flag sets its
default, but the `language` form field in each request overrides it.
This means:

- **Specific language**: sends `language=<code>` and restarts the server
  so its default matches (cosmetic consistency).
- **Auto-detect**: sends `language=auto`, no server restart needed.
- **Custom code**: same as specific language, type any whisper-supported code.

### Server restart

When the user changes language or model from the panel menu, the server
restarts with new flags. `_restartServer()` calls `force_exit()` on the
subprocess, then spawns a new one, and the health poll kicks in again.

## Recording

Recording uses ffmpeg via `Gio.Subprocess`:

    ffmpeg -y -f alsa -i default -ar 16000 -ac 1 /tmp/whisper_clip_recording.wav

16 kHz mono is what Whisper expects. `-y` overwrites without asking.

### Stopping cleanly

To stop recording, the extension sends SIGINT (signal 2) to ffmpeg. SIGINT
makes ffmpeg finalize the WAV header before exiting — SIGTERM or SIGKILL
would leave the file truncated and unreadable.

The stop sequence is async (`wait_async`) so it doesn't block the main
GNOME Shell thread:

1. The UI flips to TRANSCRIBING immediately (icon + notification).
2. SIGINT is sent to ffmpeg.
3. `wait_async` callback fires when ffmpeg exits.
4. The WAV is read and POSTed to whisper-server.

### Cancel

`_cancelRecording()` is bound to the cancel shortcut (default
`Shift+Alt+Escape`). It sends SIGINT, calls `force_exit()` for good
measure, deletes the WAV file, and resets to IDLE — no transcription
happens.

## Push-to-talk

Push-to-talk replaces `Main.wm.addKeybinding` with raw key events on
`global.stage`. When enabled:

- `key-press-event` → `_startRecording()` (guarded against key-repeat
  with a `_pttActive` flag)
- `key-release-event` → `_stopAndTranscribe()`

`_parseAccelerator()` manually parses GSettings accel strings like
`<Shift><Alt>space` into a keyval + modifier bitmask for comparison
against Clutter events. Switching between PTT and normal mode is live
(no restart needed), driven by the `changed::push-to-talk` signal.

## Waveform overlay

During recording a 350×64 px overlay appears just below the panel.
A **second ffmpeg process** is spawned purely for visualization:

    ffmpeg -nostdin -f alsa -i default -ar 16000 -ac 1 -f s16le pipe:1

It writes raw signed-16-bit PCM to stdout. The extension reads it in ~100 ms chunks
via `read_bytes_async`. The first 10 chunks (~1 s) are discarded as warmup to
avoid the initial ALSA buffer noise.

### Fluid animation & Color Mapping

Each chunk is RMS-averaged over its samples, providing a `_targetRms`.
To create a fluid, "Siri" or "Super Whisper" aesthetic, the renderer uses a stateless ~60fps loop without scrolling history arrays:

1. **Smooth Interpolation**: `_currentRms` glides towards `_targetRms` rather than snapping instantly.
2. **Noise Gate**: A noise floor of `0.02` is subtracted before amplitude scaling.
3. **Static Envelope**: A sine curve forces the outer edges to height zero and the center to be tallest.
4. **Wiggle / Ripple**: `_vizPhase` is fed into trigonometric functions (`sin` and `cos`) per bar, causing overlapping ripples to flow horizontally within the fixed envelope.
5. **Color Reactivity**: The color of each individual bar maps dynamically from dark gray (`0.4`) to pure white (`1.0`) based on its instantaneous peak height. The louder you speak, the taller and brighter the bars become.

### Transcribing animation

When the user stops recording, the audio-capture ffmpeg is killed but the
overlay stays visible. `_switchWaveformToTranscribing()` sets `_vizMode =
'transcribing'`. The repaint timer keeps firing and `_drawWaveform()` switches
to a smooth, **3-peak sliding wave**.

Instead of real audio data, it computes:

    envelope = sin(normI × π)
    spatial  = sin²((normI × 3 × π) - (phase × 0.6))
    temporal = 0.8 + 0.2 × sin(phase × 0.5)

This math creates exactly 3 symmetric peaks that continuously and gracefully slide from left to right, fading in at the left edge and shrinking out of existence on the right edge. The overlay is removed as soon as transcription completes.

### Repaint loop

A `GLib.timeout_add(16, …)` (~60 fps) calls `queue_repaint()` on the
`St.DrawingArea`. Cairo is used for the background rounded-rect and the bars.
The draw function is completely stateless except for `_vizPhase`, `_targetRms`, and `_currentRms` — no retained Cairo surfaces or history arrays are kept.

## Recording timer

The panel indicator is an `St.BoxLayout` containing an `St.Icon` and an
`St.Label`. The label is hidden at idle. When recording starts,
`GLib.timeout_add_seconds` fires every second and updates the label
with `M:SS` elapsed time. The timeout is removed on stop, cancel, or
disable.

## Transcription history

`this._history` is an in-memory array of `{text, timestamp}` objects,
capped at `history-size` (GSettings, default 10). After each successful
transcription the text is pushed to the array. The History submenu
rebuilds itself on open (most-recent first). Clicking an entry
re-copies the text to the clipboard.

## Auto-paste

After the text lands in the clipboard, the user would normally Ctrl+V
manually. Auto-paste removes that step using Clutter's virtual input
device API:

```js
const seat = Clutter.get_default_backend().get_default_seat();
this._virtualDevice = seat.create_virtual_device(
    Clutter.InputDeviceType.KEYBOARD_DEVICE
);
```

This gives you a virtual keyboard that injects key events into the
compositor. Same API that GNOME's on-screen keyboard uses. Works on
Wayland and X11 — no xdotool, no ydotool, no DBus hacks.

To paste, the extension simulates Ctrl+V (or Ctrl+Shift+V for terminals):

```js
this._virtualDevice.notify_keyval(t,        Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
this._virtualDevice.notify_keyval(t + 1000, Clutter.KEY_v,         Clutter.KeyState.PRESSED);
this._virtualDevice.notify_keyval(t + 2000, Clutter.KEY_v,         Clutter.KeyState.RELEASED);
this._virtualDevice.notify_keyval(t + 4000, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
```

Timestamps are in microseconds, monotonically increasing.
There's a 100 ms delay between setting the clipboard and sending
keystrokes — without it some apps read a stale clipboard value.

## Preferences

`prefs.js` exports `ExtensionPreferences` and is loaded by GNOME Shell
in a separate process when the user opens preferences. It uses
libadwaita (Adw) and GTK4.

The `ShortcutRow` widget shows the current keybinding as a
`Gtk.ShortcutLabel`. Clicking it opens a floating `Gtk.Window` that
captures the next key combination via `Gtk.EventControllerKey`.

## Settings

Everything in GSettings under `org.gnome.shell.extensions.whisper-clipboard`:

| Key | Type | Default |
|---|---|---|
| `whisper-clipboard-toggle` | `as` | `['<Shift><Alt>space']` |
| `whisper-cancel-toggle` | `as` | `['<Shift><Alt>Escape']` |
| `whisper-language` | `s` | `'en'` |
| `auto-detect-language` | `b` | `false` |
| `translate-to-english` | `b` | `false` |
| `whisper-model` | `s` | `'/opt/whisper.cpp/models/ggml-small.bin'` |
| `whisper-models-dir` | `s` | `''` |
| `whisper-server-bin` | `s` | `''` |
| `server-port` | `i` | `8178` |
| `auto-paste` | `b` | `false` |
| `paste-use-ctrl-shift-v` | `b` | `false` |
| `history-size` | `i` | `10` |
| `push-to-talk` | `b` | `false` |

## Panel indicator

`St.BoxLayout` → `St.Icon` + `St.Label` (timer), inside a
`PanelMenu.Button`. The icon name and CSS class change to reflect state:

| State | Icon | Inline style |
|---|---|---|
| Idle | `audio-input-microphone-symbolic` | — |
| Recording | `media-record-symbolic` | `color: #ff4444` (red) |
| Transcribing | `view-refresh-symbolic` | `color: #ffaa00` (orange) |
| Success | `object-select-symbolic` | `color: #44ff44` (green) |

The success state lasts 3 seconds, then resets to idle. If a new
recording is started while the success indicator is still showing,
the pending timeout is cancelled immediately.

## File layout

    extension.js     — the extension: state machine, recording, server, menu
    prefs.js         — preferences UI (Adw/GTK4, separate process)
    metadata.json    — GNOME Shell extension metadata
    stylesheet.css   — icon colors + timer label style
    install.sh       — compiles schemas, copies files to the extensions dir
    schemas/         — GSettings schema XML + compiled binary
