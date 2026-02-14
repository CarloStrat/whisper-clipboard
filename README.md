# Whisper Clipboard

A GNOME Shell extension that records audio, transcribes it locally using
whisper.cpp, and puts the text in your clipboard. Optionally pastes it
into the focused window.

Works on GNOME 49. Wayland and X11.

## What it does

Press a keyboard shortcut. Talk. Press it again. Your words appear in
the clipboard (and optionally get pasted where your cursor is).

Transcription runs locally via `whisper-server` -- the model stays in
memory between uses, so after the first load there is no startup cost.
A 10-second recording transcribes in under a second on reasonable
hardware.

## Dependencies

You need these installed and in PATH:

- `ffmpeg` -- for audio recording
- `whisper-server` -- from whisper.cpp, built at `/opt/whisper.cpp/build/bin/whisper-server`
- A GGML model file in `/opt/whisper.cpp/models/`

Build whisper.cpp if you haven't:

    git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
    cd /opt/whisper.cpp
    cmake -B build
    cmake --build build --config Release
    bash models/download-ggml-model.sh small

## Install

    bash install.sh

Then log out and back in (Wayland), or Alt+F2 then `r` (X11).

Enable the extension:

    gnome-extensions enable whisper-clipboard@local

## Usage

Default shortcut: **Shift+Alt+Space**

1. Press the shortcut. Recording starts. The panel icon turns red.
2. Press it again. Recording stops. The icon turns orange while
   transcribing.
3. Text lands in your clipboard. Icon flashes green for 3 seconds.

If auto-paste is on, the text also gets typed into whatever window
has focus.

## Configuration

Click the panel icon to open the menu. You can change:

- **Language** -- Italian, English, Spanish, French, German, Portuguese
- **Model** -- picks up any `ggml-*.bin` file in `/opt/whisper.cpp/models/`
- **Auto-paste** -- off by default; pastes transcribed text via Ctrl+V
- **Ctrl+Shift+V mode** -- for terminal emulators that use Ctrl+Shift+V
- **Restart Server** -- restarts the whisper-server process

Changing the language or model automatically restarts the server.

To change the shortcut:

    dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-clipboard-toggle \
      "['<Super><Shift>r']"

## Logs

    journalctl -f -o cat /usr/bin/gnome-shell

## How it works

See [INTERNALS.md](INTERNALS.md) for the full implementation guide.

## License

Do whatever you want with this code.
