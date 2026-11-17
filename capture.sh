#!/bin/bash
# Copies what you changed in the Herdr app on this machine back into the repo, so you can commit it.
# Only things the repo already tracks: its mods, layouts, settings.json, the keys it adds to keys.json
# (keys.add.json: only those keys' bindings come back, never the rest of keys.json) and mod data templates.
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
[ -f "$APP/settings.json" ] && cp "$APP/settings.json" "$REPO/herdr-app/settings.json"
ADD="$REPO/herdr-app/keys.add.json"
if [ -f "$ADD" ] && jq empty "$APP/keys.json" 2>/dev/null; then
  jq --slurpfile live "$APP/keys.json" 'with_entries(.key as $s | .value |= with_entries(.value = ($live[0][$s][.key] // .value)))' \
    "$ADD" > "$ADD.tmp"
  if cmp -s "$ADD.tmp" "$ADD"; then rm "$ADD.tmp"; else mv "$ADD.tmp" "$ADD"; fi
fi
[ -d "$DATA/cockpit-panel/templates" ] && rsync -a --delete "$DATA/cockpit-panel/templates/" "$REPO/herdr-mods/cockpit-panel/templates/"

cd "$REPO" && git status --short
