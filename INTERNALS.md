# Internals

How Whisper Clipboard works, and why it's built the way it is.

## The problem

You want to talk and have the text show up where you're typing. This
means: record audio, transcribe it, put the result in the clipboard,
and optionally paste it. All of this has to happen inside a GNOME Shell
extension, which is a constrained environment -- single-threaded,
no Node, no Python, just GJS and whatever GObject Introspection gives
you.

## Architecture

One file: `extension.js`. One class: `WhisperClipboardExtension`. Three
states:

    IDLE -> RECORDING -> TRANSCRIBING -> IDLE

A keyboard shortcut toggles between them. The `_toggle()` method is the
dispatcher. That's the whole control flow.

## The server approach

The first version spawned `whisper-cli` on every transcription. This
works, but it's slow -- the model has to load from disk every time.
A 500MB model takes 1-2 seconds just to load before it even starts
inference.

The fix is `whisper-server`. It's an HTTP server that comes with
whisper.cpp. You start it once, the model loads once, and then you POST
audio files to it. The model sits in memory between requests.

On `enable()`, the extension spawns:

    whisper-server -m <model> -l <lang> --host 127.0.0.1 --port 8178

On `disable()`, it kills the process. The server is fully managed by the
extension lifecycle.

### Health checking

The server takes a few seconds to load the model. During this time,
recording is blocked -- pressing the shortcut shows "Server is still
starting" instead of silently failing.

The extension polls `GET /health` every second after spawning the
server. When it gets a 200, it sets `_serverReady = true` and updates
the panel menu to show "Server: Ready".

### Transcription

When recording stops, the WAV file gets POSTed to `/inference` as
multipart form data:

    POST /inference
    Content-Type: multipart/form-data

    file=<recording.wav>
    response_format=text
    language=it
    temperature=0.0
    no_timestamps=true

The response body is the transcribed text, plain. No JSON parsing
needed when you use `response_format=text`.

The HTTP client is libsoup 3.0 (`Soup.Session`), which is already
available in GNOME Shell. A single session is created on `enable()` and
reused for health checks and transcriptions.

### Server restart

When the user changes language or model from the panel menu, the server
needs to restart with different flags. `_restartServer()` calls
`force_exit()` on the subprocess, then spawns a new one. The health
poll kicks in again.

## Recording

Recording uses ffmpeg via `Gio.Subprocess`:

    ffmpeg -y -f alsa -i default -ar 16000 -ac 1 /tmp/whisper_clip_recording.wav

16kHz mono is what whisper expects. The `-y` flag overwrites without
asking.

To stop recording, the extension sends SIGINT (signal 2) to the ffmpeg
process, then waits for it to exit. SIGINT makes ffmpeg finalize the WAV
header properly -- SIGTERM or SIGKILL would leave a corrupt file.

## Auto-paste

After the text lands in the clipboard, the user still has to Ctrl+V
manually. Auto-paste removes that step.

The mechanism is Clutter's virtual input device API. On `enable()`:

```js
const seat = Clutter.get_default_backend().get_default_seat();
this._virtualDevice = seat.create_virtual_device(
    Clutter.InputDeviceType.KEYBOARD_DEVICE
);
```

This gives you a virtual keyboard that can inject key events into the
compositor. It's the same API that GNOME's on-screen keyboard uses.
Works on both Wayland and X11 -- no xdotool, no ydotool, no DBus hacks.

To paste, the extension simulates Ctrl+V:

```js
this._virtualDevice.notify_keyval(t,        Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
this._virtualDevice.notify_keyval(t + 1000, Clutter.KEY_v,         Clutter.KeyState.PRESSED);
this._virtualDevice.notify_keyval(t + 2000, Clutter.KEY_v,         Clutter.KeyState.RELEASED);
this._virtualDevice.notify_keyval(t + 4000, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
```

The timestamps are in microseconds and must be monotonically increasing.
We use `GLib.get_monotonic_time()` as the base and add small offsets.

There's a 100ms delay between setting the clipboard and sending the
keystrokes. Without it, some apps read the clipboard before it's
actually been updated.

### Terminal support

Terminals use Ctrl+Shift+V instead of Ctrl+V. A toggle in the menu
switches between the two. When enabled, a Shift press/release gets
inserted around the V key events. This is a manual toggle, not
auto-detection -- detecting whether the focused window is a terminal is
unreliable and not worth the complexity.

## Settings

Everything lives in GSettings under
`org.gnome.shell.extensions.whisper-clipboard`:

| Key                        | Type     | Default                              |
|----------------------------|----------|--------------------------------------|
| `whisper-clipboard-toggle` | `as`     | `['<Shift><Alt>space']`              |
| `whisper-language`         | `s`      | `it`                                 |
| `whisper-model`            | `s`      | `/opt/whisper.cpp/models/ggml-small.bin` |
| `auto-paste`               | `b`      | `false`                              |
| `paste-use-ctrl-shift-v`   | `b`      | `false`                              |
| `server-port`              | `i`      | `8178`                               |

The schema is compiled by `install.sh` and loaded from the extension
directory at runtime.

## Panel indicator

An `St.Icon` in a `PanelMenu.Button`. The icon changes to reflect state:

| State        | Icon                          | CSS class               |
|--------------|-------------------------------|-------------------------|
| Idle         | hearing-symbolic              | (none)                  |
| Recording    | media-record-symbolic         | whisper-icon-recording  |
| Transcribing | screen-reader-symbolic        | whisper-icon-transcribing |
| Success      | object-select-symbolic        | whisper-icon-success    |

The success state lasts 3 seconds, then resets to idle.

## What about real-time transcription?

whisper.cpp has a `whisper-stream` binary that does continuous
transcription from a microphone. It's not used here because:

1. It requires SDL2 and a separate build flag (`-DWHISPER_SDL2=ON`).
2. It's described in the whisper.cpp repo as a "naive proof of concept".
3. It hallucates during silence.
4. The architecture would be completely different -- a long-running
   process with continuous output instead of a request/response cycle.

The server approach is fast enough. Once the model is loaded, a
10-second clip transcribes in well under a second. The bottleneck was
always model loading, and the server eliminates that.

## File layout

    extension.js     -- the entire extension
    metadata.json    -- GNOME Shell extension metadata
    stylesheet.css   -- icon colors for recording/transcribing/success states
    install.sh       -- compiles schemas and copies files to the extensions dir
    schemas/         -- GSettings schema XML + compiled binary
