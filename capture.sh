#!/bin/bash
# Copies what you changed in the Herdr app on this machine back into the repo, so you can commit it.
# Only things the repo already tracks: its mods, layouts, settings.json / keys.json and mod data templates.
# Skills need nothing: they're symlinks into the repo.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME/.config/herdr-mods"

for dest in "$REPO"/herdr-app/mods/*/; do
  name=$(basename "$dest")
  [ -d "$APP/mods/$name" ] && rsync -a --delete --exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json "$APP/mods/$name/" "$dest"
done
for f in "$REPO"/herdr-app/layouts/*.json; do
  [ -f "$APP/layouts/$(basename "$f")" ] && cp "$APP/layouts/$(basename "$f")" "$f"
done
for f in settings.json keys.json; do
  [ -f "$REPO/herdr-app/$f" ] && [ -f "$APP/$f" ] && cp "$APP/$f" "$REPO/herdr-app/$f"
done
[ -d "$DATA/cockpit-panel/templates" ] && rsync -a --delete "$DATA/cockpit-panel/templates/" "$REPO/herdr-mods/cockpit-panel/templates/"

cd "$REPO" && git status --short
