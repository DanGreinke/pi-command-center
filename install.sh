#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.pi/agent/extensions"

mkdir -p "$DEST"

for file in cc-reporter.ts command-center.ts; do
  target="$DEST/$file"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "Backing up existing $target to $target.bak"
    mv "$target" "$target.bak"
  fi
  ln -sf "$REPO_DIR/$file" "$target"
  echo "Linked $file → $target"
done

echo ""
echo "Done. Restart pi for the extensions to load."
echo "To update: git pull in $REPO_DIR (symlinks pick up changes automatically)."
