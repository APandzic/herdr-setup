#!/bin/bash
# Installs this repo into the Herdr app and Claude Code on this machine.
# Anything it replaces is copied to ~/.herdr-setup-backups/<time>/ first.
#   herdr-app/mods/<name>/      → ~/.config/herdr-app/mods/<name>/   (copied: Herdr won't load a symlinked mod's icons)
#   herdr-app/layouts/*.json    → ~/.config/herdr-app/layouts/
#   herdr-app/settings.json     → ~/.config/herdr-app/settings.json  (and keys.json, if the repo has one)
#   herdr-mods/<name>/          → ~/.config/herdr-mods/<name>/        (mod data such as cockpit-panel templates)
#   claude/skills/<name>/       → ~/.claude/skills/<name>             (symlinked, so a git pull updates them)
#   bin/<command>               → ~/.local/bin/<command>              (symlinked)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME/.config/herdr-mods"
SKILLS="$HOME/.claude/skills"
BACKUP="$HOME/.herdr-setup-backups/$(date +%Y%m%d-%H%M%S)"

missing=()
for cmd in herdr-app hc jq perl rsync; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
[ ${#missing[@]} -eq 0 ] || { echo "Missing: ${missing[*]}. Install them first."; exit 1; }
command -v gh >/dev/null || echo "Note: gh isn't installed; the review cockpit needs it."
[ -d "$APP" ] || { echo "No $APP: start the Herdr app once first."; exit 1; }

backup() { # backup <path>: keep a copy of what's about to be replaced
  [ -e "$1" ] || [ -L "$1" ] || return 0
  local rel="${1#$HOME/}"
  mkdir -p "$BACKUP/$(dirname "$rel")"
  cp -RP "$1" "$BACKUP/$rel"
}

echo "Mods"
for src in "$REPO"/herdr-app/mods/*/; do
  name=$(basename "$src")
  backup "$APP/mods/$name"
  mkdir -p "$APP/mods/$name"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json "$src" "$APP/mods/$name/"
  printf '  %-14s ' "$name"
  herdr-app check "$APP/mods/$name" 2>&1 | grep -E '^check (passed|failed)' || echo "(not checked)"
done

echo "Layouts and settings"
for f in "$REPO"/herdr-app/layouts/*.json; do
  backup "$APP/layouts/$(basename "$f")"; cp "$f" "$APP/layouts/"; echo "  layouts/$(basename "$f")"
done
for f in settings.json keys.json; do
  [ -f "$REPO/herdr-app/$f" ] || continue
  backup "$APP/$f"; cp "$REPO/herdr-app/$f" "$APP/$f"; echo "  $f"
done

echo "Mod data"
for src in "$REPO"/herdr-mods/*/; do
  name=$(basename "$src")
  backup "$DATA/$name"
  mkdir -p "$DATA/$name"
  rsync -a "$src" "$DATA/$name/"   # no --delete: keeps data the mods write here (e.g. my-config's copies)
  echo "  $name"
done

echo "Claude skills"
mkdir -p "$SKILLS"
for src in "$REPO"/claude/skills/*/; do
  name=$(basename "$src"); dest="$SKILLS/$name"; src="${src%/}"
  [ "$(readlink "$dest" 2>/dev/null)" = "$src" ] && { echo "  $name (linked)"; continue; }
  if [ -e "$dest" ] || [ -L "$dest" ]; then backup "$dest"; rm -rf "$dest"; fi
  ln -s "$src" "$dest"; echo "  $name → linked"
done

echo "Commands"
mkdir -p "$HOME/.local/bin"
for src in "$REPO"/bin/*; do
  name=$(basename "$src"); dest="$HOME/.local/bin/$name"
  [ "$(readlink "$dest" 2>/dev/null)" = "$src" ] && { echo "  $name (linked)"; continue; }
  if [ -e "$dest" ] || [ -L "$dest" ]; then backup "$dest"; rm -f "$dest"; fi
  ln -s "$src" "$dest"; echo "  $name → linked"
done
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  Note: add ~/.local/bin to your PATH" ;; esac

[ -d "$BACKUP" ] && echo "Replaced files were backed up to $BACKUP"
for old in better-sidebar better-config; do
  [ -d "$APP/mods/$old" ] && echo "Note: $APP/mods/$old is still installed; my-${old#better-} replaces it, so you can delete it."
done
# Where this repo lives, so My Sidebar can check it for updates (update.sh).
mkdir -p "$DATA"
jq -n --arg repo "$REPO" '{repo: $repo}' > "$DATA/herdr-setup.json"

echo "Done. To show the layout: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
