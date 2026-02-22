#!/bin/bash
set -e

# Ensure we run relative to the script's directory regardless of where it is invoked from
cd "$(dirname "$0")"

UUID="whisper-clipboard@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "═══ Whisper Clipboard – Installation ═══"

# Check for required tool
if ! command -v glib-compile-schemas &>/dev/null; then
    echo "Error: glib-compile-schemas not found. Install glib2-devel (Fedora) or libglib2.0-dev (Debian/Ubuntu)." >&2
    exit 1
fi

# Compile schemas
echo "→ Compiling schemas…"
glib-compile-schemas schemas/

# Copy to extensions directory
echo "→ Installing to $DEST"
mkdir -p "$DEST"
cp -r metadata.json extension.js prefs.js constants.js stylesheet.css schemas "$DEST/"

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell:"
echo "     • Wayland: log out and back in"
echo "     • X11:     Alt+F2 → type 'r' → Enter"
echo "  2. Enable the extension:"
echo "     gnome-extensions enable $UUID"
echo "  3. Shortcut: Shift+Alt+Space"
echo ""
echo "To change preferences:"
echo "  gnome-extensions prefs $UUID"
