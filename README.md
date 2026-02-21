# Whisper Clipboard

A GNOME Shell extension that records audio, transcribes it locally using
whisper.cpp, and puts the text in your clipboard. Optionally pastes it
into the focused window.

Works on GNOME 49. Wayland and X11.

## What it does

Press a keyboard shortcut. Talk. Press it again. Your words appear in
the clipboard (and optionally get pasted where your cursor is).

Transcription runs locally via `whisper-server` — the model stays in
memory between uses, so after the first load there is no startup cost.
A 10-second recording transcribes in under a second on reasonable
hardware.

---

## Dependencies

- **ffmpeg** — audio capture
- **whisper-server** — from [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- A **GGML model file** (downloaded separately)

Install `ffmpeg` from your distro:

    # Fedora
    sudo dnf install ffmpeg

    # Ubuntu/Debian
    sudo apt install ffmpeg

---

## Install whisper.cpp

You need to build `whisper-server` from source. Choose one of these approaches:

### Option A — user install (no root required, recommended)

Build into your home directory and symlink the binary to `~/.local/bin/`:

    git clone https://github.com/ggerganov/whisper.cpp ~/whisper.cpp
    cd ~/whisper.cpp
    cmake -B build
    cmake --build build --config Release --target whisper-server -j$(nproc)

    mkdir -p ~/.local/bin
    ln -s ~/whisper.cpp/build/bin/whisper-server ~/.local/bin/whisper-server

Make sure `~/.local/bin` is in your `$PATH` (it usually is by default on
Fedora/Ubuntu). You can verify with:

    which whisper-server

### Option B — system install

    git clone https://github.com/ggerganov/whisper.cpp
    cd whisper.cpp
    cmake -B build
    cmake --build build --config Release --target whisper-server -j$(nproc)
    sudo cp build/bin/whisper-server /usr/local/bin/whisper-server

### Option C — existing `/opt/whisper.cpp` install

If you already built whisper.cpp in `/opt/whisper.cpp` (or similar) and own
the files, add a symlink instead of chowning the directory:

    mkdir -p ~/.local/bin
    ln -s /opt/whisper.cpp/build/bin/whisper-server ~/.local/bin/whisper-server

---

## Download a model

whisper.cpp ships a download helper. The `small` model is a good balance
of speed and accuracy (~500 MB):

    cd ~/whisper.cpp          # or wherever you cloned it
    bash models/download-ggml-model.sh small

Or download manually from
[HuggingFace](https://huggingface.co/ggerganov/whisper.cpp) and place the
`.bin` file in any of these locations (the extension scans them all):

    ~/.local/share/whisper/models/   ← recommended for user installs
    ~/whisper.cpp/models/
    /opt/whisper.cpp/models/
    /usr/share/whisper.cpp/models/
    /usr/local/share/whisper/models/

To use the recommended path:

    mkdir -p ~/.local/share/whisper/models
    cp ~/whisper.cpp/models/ggml-small.bin ~/.local/share/whisper/models/

---

## Install the extension

    bash install.sh

Then restart GNOME Shell:

- **Wayland**: log out and back in
- **X11**: Alt+F2 → type `r` → Enter

Enable the extension:

    gnome-extensions enable whisper-clipboard@local

---

## Usage

Default shortcut: **Shift+Alt+Space**

1. Press the shortcut — recording starts, panel icon turns red.
2. Press it again — recording stops, icon turns orange while transcribing.
3. Text lands in your clipboard — icon flashes green for 3 seconds.

If auto-paste is on, the text is also typed into whatever window has focus.

---

## Configuration

Click the panel icon to open the menu:

| Setting | Default | Description |
|---|---|---|
| Language | Italian | Language passed to whisper |
| Model | auto-detected | Any `ggml-*.bin` file from the search paths |
| Auto-paste | off | Paste via Ctrl+V after transcription |
| Ctrl+Shift+V mode | off | Use Ctrl+Shift+V (for terminals) |
| Restart Server | — | Restart the whisper-server process |

Changing language or model automatically restarts the server.

### Change the keyboard shortcut

    dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-clipboard-toggle \
      "['<Super><Shift>r']"

### Set a custom binary path

If `whisper-server` is not in your `$PATH` and not in a standard location:

    dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-server-bin \
      '"/path/to/your/whisper-server"'

Leave it empty (default) to let the extension auto-detect.

### Set a custom models directory

    dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-models-dir \
      '"/path/to/your/models"'

The extension always scans this directory in addition to the standard locations.

---

## Logs

    journalctl -f -o cat /usr/bin/gnome-shell

---

## How it works

See [INTERNALS.md](INTERNALS.md) for the full implementation notes.

---

## License

Do whatever you want with this code.
