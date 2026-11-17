#!/bin/bash
# Installs this repo into the Herdr app and Claude Code on this machine.
# Anything it replaces is copied to ~/.herdr-setup-backups/<time>/ first.
#   herdr-app/mods/<name>/      → ~/.config/herdr-app/mods/<name>/   (copied: Herdr won't load a symlinked mod's icons)
#   herdr-app/layouts/*.json    → ~/.config/herdr-app/layouts/
#   herdr-app/settings.json     → ~/.config/herdr-app/settings.json
#   herdr-app/keys.add.json     → merged into ~/.config/herdr-app/keys.json (its keys win; the rest stays)
#   herdr-mods/<name>/          → ~/.config/herdr-mods/<name>/        (mod data such as cockpit-panel templates)
#   claude/skills/<name>/       → ~/.claude/skills/<name>             (symlinked, so a git pull updates them)
#   bin/<command>               → ~/.local/bin/<command>              (symlinked)
#   cockpit-rules check         → ~/.claude/settings.json             (UserPromptSubmit hook, added once)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME/.config/herdr-mods"
SKILLS="$HOME/.claude/skills"
BACKUP="$HOME/.herdr-setup-backups/$(date +%Y%m%d-%H%M%S)"

missing=()
for cmd in herdr-app hc jq perl rsync; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
[ ${#missing[@]} -eq 0 ] || { echo "Missing: ${missing[*]}. Install them first."; exit 1; }
command -v gh >/dev/null || command -v twg >/dev/null || echo "Note: neither gh nor twg is installed; the review cockpit needs one (gh for GitHub, twg for Bitbucket)."
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
backup "$APP/settings.json"; cp "$REPO/herdr-app/settings.json" "$APP/settings.json"; echo "  settings.json"
# keys.json is Herdr's and yours: only the keys this setup adds are written into it, per section.
ADD="$REPO/herdr-app/keys.add.json" KEYS="$APP/keys.json"
if [ -f "$KEYS" ] && ! jq empty "$KEYS" 2>/dev/null; then
  echo "  Note: $KEYS isn't valid JSON; add the keys in herdr-app/keys.add.json yourself."
else
  merged=$( { cat "$KEYS" 2>/dev/null || echo '{}'; } | jq --slurpfile add "$ADD" \
    'reduce ($add[0] | to_entries[]) as $s (.; .[$s.key] = ((.[$s.key] // {}) + $s.value))')
  if [ -f "$KEYS" ] && [ "$merged" = "$(jq . "$KEYS")" ]; then
    echo "  keys.json (has keys.add.json)"
  else
    backup "$KEYS"; printf '%s\n' "$merged" > "$KEYS"; echo "  keys.json ← keys.add.json"
  fi
fi

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

echo "Claude Code hook"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
HOOK="$HOME/.local/bin/cockpit-rules check"
if [ -f "$CLAUDE_SETTINGS" ] && ! jq empty "$CLAUDE_SETTINGS" 2>/dev/null; then
  echo "  Note: $CLAUDE_SETTINGS isn't valid JSON; add the UserPromptSubmit hook '$HOOK' yourself."
elif [ -f "$CLAUDE_SETTINGS" ] && jq -e --arg c "$HOOK" '[.hooks.UserPromptSubmit[]?.hooks[]?.command] | any(. == $c)' "$CLAUDE_SETTINGS" >/dev/null; then
  echo "  cockpit-rules (in settings)"
else
  backup "$CLAUDE_SETTINGS"
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
  [ -f "$CLAUDE_SETTINGS" ] || echo '{}' > "$CLAUDE_SETTINGS"
  # Written in place, so a symlinked settings.json stays a symlink.
  jq --arg c "$HOOK" '.hooks.UserPromptSubmit += [{hooks: [{type: "command", command: $c, timeout: 5}]}]' \
    "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp"
  cat "$CLAUDE_SETTINGS.tmp" > "$CLAUDE_SETTINGS"; rm -f "$CLAUDE_SETTINGS.tmp"
  echo "  cockpit-rules → added to $CLAUDE_SETTINGS"
fi

[ -d "$BACKUP" ] && echo "Replaced files were backed up to $BACKUP"
for old in better-sidebar better-config; do
  [ -d "$APP/mods/$old" ] && echo "Note: $APP/mods/$old is still installed; my-${old#better-} replaces it, so you can delete it."
done
# Where this repo lives, so My Sidebar can check it for updates (update.sh).
mkdir -p "$DATA"
jq -n --arg repo "$REPO" '{repo: $repo}' > "$DATA/herdr-setup.json"

echo "Done. To show the layout: herdr-app do layout.switch '{\"name\":\"my-main\"}'"
