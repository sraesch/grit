#!/usr/bin/env bash
# Shows the grit icon in the GNOME dock/taskbar while running `npm run tauri dev`.
#
# On Wayland, GNOME ignores icons set by a window and only uses the .desktop file
# whose name matches the window's app ID. grit's app ID is its binary name, "grit".
# Installed packages (.deb/.rpm) ship grit.desktop; the dev build does not, so this
# script installs a user-level one pointing at the repository's icon.
#
# Usage:   scripts/install-linux-dev-desktop-entry.sh
# Remove:  scripts/install-linux-dev-desktop-entry.sh --uninstall
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${XDG_DATA_HOME:-$HOME/.local/share}/applications/grit.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$target"
  echo "Removed $target"
  exit 0
fi

mkdir -p "$(dirname "$target")"
cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Name=grit (dev)
Comment=grit development build
Exec=$repo/src-tauri/target/debug/grit
Icon=$repo/src-tauri/icons/128x128@2x.png
StartupWMClass=grit
Terminal=false
NoDisplay=true
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$target")" 2>/dev/null || true
echo "Installed $target"
echo "Restart the app (npm run tauri dev) to see the icon in the dock."
