# Whisper Clipboard

A GNOME Shell extension that records audio, transcribes it locally using
[whisper.cpp](https://github.com/ggerganov/whisper.cpp), and puts the text
in your clipboard — optionally pasting it straight into the focused window.

Works on **GNOME 49**. Wayland and X11.

---

## What it does

Press the shortcut. Talk. Press it again. Your words appear in the clipboard
(and optionally get pasted where your cursor is).

- **Local, private** — no cloud, no account, all inference runs on your machine.
- **Fast** — `whisper-server` keeps the model in memory between uses. After the
  first load a 10-second clip transcribes in under a second on reasonable hardware.
- **Multilingual** — 20 common languages in the menu, auto-detect, or any custom
  language code. Optional translation to English.
- **Push-to-talk** — hold to record, release to transcribe.
- **History** — last N transcriptions in the panel menu, click to re-copy.

---

## Dependencies

| Dependency | What for |
|---|---|
| **ffmpeg** | Audio capture |
| **whisper-server** | Transcription (from whisper.cpp) |
| A **GGML model file** | The actual speech recognition weights |

### Install ffmpeg

```bash
# Fedora
sudo dnf install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg
```

### Build whisper-server

#### Option A — user install (recommended, no root)

```bash
git clone https://github.com/ggerganov/whisper.cpp ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build
cmake --build build --config Release --target whisper-server -j$(nproc)

mkdir -p ~/.local/bin
ln -s ~/whisper.cpp/build/bin/whisper-server ~/.local/bin/whisper-server
```

Make sure `~/.local/bin` is in `$PATH` (`which whisper-server` should work).

#### Option B — system install

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release --target whisper-server -j$(nproc)
sudo cp build/bin/whisper-server /usr/local/bin/whisper-server
```

### Download a model

The `small` model (~500 MB) is a good balance of speed and accuracy:

```bash
cd ~/whisper.cpp
bash models/download-ggml-model.sh small
```

Or download manually from [HuggingFace](https://huggingface.co/ggerganov/whisper.cpp)
and drop the `.bin` file into any of these locations (all are scanned automatically):

```
~/.local/share/whisper/models/   ← recommended
~/whisper.cpp/models/
/opt/whisper.cpp/models/
/usr/share/whisper.cpp/models/
/usr/local/share/whisper/models/
```

---

## Install the extension

```bash
bash install.sh
```

Then restart GNOME Shell:

- **Wayland**: log out and back in
- **X11**: Alt+F2 → type `r` → Enter

Enable:

```bash
gnome-extensions enable whisper-clipboard@local
```

---

## Usage

| Action | Default shortcut |
|---|---|
| Start / stop recording | **Shift+Alt+Space** |
| Cancel recording | **Shift+Alt+Escape** |

1. Press the shortcut — recording starts, the panel icon turns **red** and a
   timer appears.
2. Press it again — recording stops, the icon turns **orange** while transcribing.
3. Text lands in your clipboard — icon flashes **green** for 3 seconds.

To cancel mid-recording without transcribing, press **Shift+Alt+Escape**.

### Push-to-talk

Enable it in preferences (`gnome-extensions prefs whisper-clipboard@local`) or
the panel menu settings. In PTT mode: hold the shortcut to record, release to
transcribe. Great for quick dictation without needing two presses.

---

## Configuration

Open preferences:

```bash
gnome-extensions prefs whisper-clipboard@local
```

Or click the panel icon to access the quick-settings menu.

### Preferences (General)

| Setting | Default | Description |
|---|---|---|
| Toggle shortcut | Shift+Alt+Space | Start / stop recording |
| Cancel shortcut | Shift+Alt+Escape | Cancel recording without transcribing |
| Push-to-talk | off | Hold to record, release to transcribe |
| Language | English | Language sent to whisper-server per request |
| Auto-detect language | off | Let whisper detect the language automatically |
| Translate to English | off | Translate output to English regardless of source |
| Auto-paste | off | Paste via Ctrl+V after transcription |
| Use Ctrl+Shift+V | off | Paste with Ctrl+Shift+V (for terminals) |
| History size | 10 | Number of past transcriptions kept in the History menu |

### Preferences (Server)

| Setting | Default | Description |
|---|---|---|
| Model path | (auto-detected) | Path to a `ggml-*.bin` model file |
| Extra models directory | — | Additional directory scanned for model files |
| whisper-server binary | (auto-detected) | Path to `whisper-server` if not in `$PATH` |
| Server port | 8178 | HTTP port for the local whisper-server |

### Quick-settings menu

The panel icon opens a menu with:
- Current status and server state
- Auto-paste and Ctrl+Shift+V toggles
- Translate to English toggle
- Language submenu (Auto-detect, 20 languages, custom code entry)
- Model submenu (lists all found models)
- History submenu (recent transcriptions, click to re-copy)
- Restart Server button

### Change a shortcut via dconf

```bash
# Toggle shortcut
dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-clipboard-toggle \
  "['<Super><Shift>r']"

# Cancel shortcut
dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-cancel-toggle \
  "['<Super><Shift>Escape']"
```

### Set a custom binary or model directory

```bash
dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-server-bin \
  '"/path/to/your/whisper-server"'

dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-models-dir \
  '"/path/to/your/models"'
```

---

## Logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

---

## How it works

See [INTERNALS.md](INTERNALS.md) for the full implementation notes.

---

## License

Do whatever you want with this code.
