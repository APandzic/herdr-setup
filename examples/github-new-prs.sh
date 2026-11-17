#!/bin/bash
# Watcher: puts open PRs of this repo into the cockpit's inbox, skipping your own and drafts.
# Register it in <project>/.herdr/cockpit.json as
#   { "id": "new-prs", "title": "New PRs", "run": "<path to this file>", "mode": "watch", "cockpit": "review" }
# Optional args: --every <seconds> (default 120), --base <branch> (only PRs into this branch).
# Also works as "schedule" or "manual" with --once.
set -euo pipefail

every=120 base="" once=0
while [ $# -gt 0 ]; do
  case "$1" in
    --every) every=$2; shift 2 ;; --base) base=$2; shift 2 ;; --once) once=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
me=$(gh api user --jq .login)

check() {
  local args=(pr list --state open --limit 50
    --json number,title,url,author,isDraft,baseRefName,headRefName,createdAt,additions,deletions,changedFiles,reviewRequests,latestReviews)
  [ -n "$base" ] && args+=(--base "$base")
  gh "${args[@]}" | jq -c --arg me "$me" '.[] | select(.isDraft | not) | select(.author.login != $me)' |
    while read -r pr; do
      n=$(jq -r .number <<<"$pr")
      field() { jq -r "$1" <<<"$pr"; }
      result=$(cockpit-task add --key "pr-$n" --title "PR #$n: $(field .title)" --url "$(field .url)" \
        --task "Review PR #$n by $(field .author.login) into $(field .baseRefName)" \
        --author "$(field 'if (.author.name // "") != "" then .author.name else .author.login end')" \
        --opened "$(field .createdAt)" --branch "$(field .headRefName)" \
        --additions "$(field .additions)" --deletions "$(field .deletions)" --files "$(field .changedFiles)" \
        --reviewers "$(field '[.reviewRequests[].login, .latestReviews[].author.login] | map(select(. != null)) | unique | length')")
      [ "$result" = added ] && echo "$(date +%H:%M) added PR #$n"
    done
}

if [ $once = 1 ]; then check; exit 0; fi
echo "Watching open PRs every ${every}s (Ctrl-C to stop)"
while :; do check || echo "$(date +%H:%M) check failed, retrying"; sleep "$every"; done
