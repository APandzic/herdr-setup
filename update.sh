#!/bin/bash
# Brings this machine up to date with the repo on GitHub, safely.
#   ./update.sh          pull new commits and install them
#   ./update.sh --check  only fetch, and print how many commits are new (0 = up to date)
# It stops, changing nothing, when installing could lose something:
#   - the repo has uncommitted changes (commit or stash them)
#   - the live Herdr files differ from the repo: something changed in the app that
#     capture.sh hasn't brought back yet (run ./capture.sh, commit, then update)
# Exit codes: 0 updated or up to date, 2 uncommitted changes, 3 uncaptured app changes,
#             4 can't fast-forward (local commits not pushed), 1 anything else.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="$HOME/.config/herdr-mods"
cd "$REPO"

# Apps like Herdr run this without your SSH agent, so an ssh remote may not authenticate.
# Then fetch the same repo over HTTPS: anonymous for a public repo, gh's login for a private one.
fetch() {
  git fetch --quiet origin 2>/dev/null && return 0
  local url; url=$(git remote get-url origin)
  [[ "$url" =~ github\.com[:/](.+/.+)$ ]] || return 1
  local https="https://github.com/${BASH_REMATCH[1]%.git}.git" branch; branch=$(git rev-parse --abbrev-ref @{u}); branch=${branch#origin/}
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper='!gh auth git-credential' \
    fetch --quiet "$https" "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null
}
fetch || { echo "Couldn't reach GitHub (git fetch failed over SSH and HTTPS)."; exit 1; }
behind=$(git rev-list --count HEAD..@{u})

if [ "${1:-}" = --check ]; then echo "$behind"; exit 0; fi
if [ "$behind" = 0 ]; then echo "Up to date."; exit 0; fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Not updating: the repo has uncommitted changes. Commit or stash them first:"
  git status --short
  exit 2
fi

# What install.sh would overwrite that the repo doesn't have yet.
drift=()
same() { diff -rq -x gpui-kit.d.ts -x herdr.d.ts -x jsconfig.json -x .DS_Store "$1" "$2" >/dev/null 2>&1; }
for src in herdr-app/mods/*/; do
  name=$(basename "$src")
  [ -d "$APP/mods/$name" ] && ! same "$src" "$APP/mods/$name" && drift+=("mods/$name")
done
for f in herdr-app/layouts/*.json; do
  [ -f "$APP/layouts/$(basename "$f")" ] && ! same "$f" "$APP/layouts/$(basename "$f")" && drift+=("layouts/$(basename "$f")")
done
[ -f "$APP/settings.json" ] && ! same herdr-app/settings.json "$APP/settings.json" && drift+=("settings.json")
# keys.json: only the keys keys.add.json adds, and only when one is bound to something else here
# (install would overwrite that). A missing one isn't drift: install adds it back.
[ -f "$APP/keys.json" ] && jq empty "$APP/keys.json" 2>/dev/null && ! jq -e --slurpfile add herdr-app/keys.add.json '. as $live | [$add[0] | to_entries[] | .key as $s | .value | to_entries[]
  | .key as $k | .value as $v | ($live[$s] // {}) | (has($k) | not) or .[$k] == $v] | all' "$APP/keys.json" >/dev/null 2>&1 && drift+=("keys.json (keys from keys.add.json)")
for src in herdr-mods/*/; do
  name=$(basename "$src")
  [ -d "$DATA/$name/templates" ] && [ -d "$src/templates" ] && ! same "$src/templates" "$DATA/$name/templates" && drift+=("herdr-mods/$name/templates")
done
if [ ${#drift[@]} -gt 0 ]; then
  echo "Not updating: these changed in the Herdr app and aren't in the repo yet:"
  printf '  %s\n' "${drift[@]}"
  echo "Run ./capture.sh, commit what you want to keep, then update again."
  exit 3
fi

before=$(git rev-parse --short HEAD)
git merge --ff-only --quiet @{u} 2>/dev/null || {
  echo "Not updating: this machine has commits GitHub doesn't. Push them (or rebase) first."
  exit 4
}
echo "Updated $before → $(git rev-parse --short HEAD):"
git log --oneline --no-decorate "$before..HEAD" | sed 's/^/  /'
echo
"$REPO/install.sh" | grep -E 'check failed|Missing|Note' || true
echo "Installed."
