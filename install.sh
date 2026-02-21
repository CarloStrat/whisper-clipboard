#!/bin/bash
set -e

UUID="whisper-clipboard@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "═══ Whisper Clipboard – Installation ═══"

# Compile schemas
echo "→ Compiling schemas…"
glib-compile-schemas schemas/

# Copy to extensions directory
echo "→ Installing to $DEST"
mkdir -p "$DEST"
cp -r metadata.json extension.js prefs.js stylesheet.css schemas "$DEST/"

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
echo "To change the shortcut:"
echo "  dconf write /org/gnome/shell/extensions/whisper-clipboard/whisper-clipboard-toggle \"['<Shift><Alt>space']\""
