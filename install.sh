#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/DanGreinke/pi-command-center.git"
INSTALL_DIR="${PI_CC_DIR:-$HOME/pi-command-center}"
DEST="$HOME/.pi/agent/extensions"

# When piped through curl, BASH_SOURCE[0] is unset or "bash" — detect by checking
# whether the expected source files exist next to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)"

if [ -f "$SCRIPT_DIR/cc-reporter.ts" ] && [ -f "$SCRIPT_DIR/command-center.ts" ]; then
  REPO_DIR="$SCRIPT_DIR"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating existing repo at $INSTALL_DIR ..."
    git -C "$INSTALL_DIR" pull
  else
    echo "Cloning into $INSTALL_DIR ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  REPO_DIR="$INSTALL_DIR"
fi

mkdir -p "$DEST"

for file in cc-reporter.ts command-center.ts cc-supervisor.ts; do
  target="$DEST/$file"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "Backing up existing $target to $target.bak"
    mv "$target" "$target.bak"
  fi
  ln -sf "$REPO_DIR/$file" "$target"
  echo "Linked $file"
done

echo ""
echo "Done. Restart pi for the extensions to load."
echo "To update: cd $REPO_DIR && git pull"
