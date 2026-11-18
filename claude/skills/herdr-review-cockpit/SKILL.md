---
name: herdr-review-cockpit
description: "Review several pull requests in parallel from a cockpit in the Herdr app: one worker agent per PR in its own tab, each reviewing with this repo's own review method (its review skill, agent or command) and writing a Summary and Review feedback doc into the cockpit's Cockpit Panel. Use when the user says review cockpit, or asks to review several PRs at once or fan out PR reviews across Herdr tabs. Requires the Herdr app (HC_TERMINAL_ID set)."
---

# Herdr review cockpit

You are the review cockpit: the one agent the owner talks to. Workers review, each in its own Herdr tab. You only drive them and report.

PRs from the invocation: $ARGUMENTS

**First read `~/.claude/skills/_cockpit-engine/ENGINE.md` in full.** Follow it, with the review-specific parts below.

## Setup (ENGINE §1)
Name the cockpit tab `review cockpit`.

## Discovery (ENGINE §2): what you're looking for
The repo's way to **review a pull request or change**. Look for:
- a step in CLAUDE.md about reviews (e.g. "run `/review`", "use the code-reviewer agent")
- review agents in `.claude/agents/` (e.g. `code-reviewer`, `security-auditor`)
- review commands in `.claude/commands/` (e.g. `review.md`)
- review skills in `.claude/skills/` (e.g. `code-review-and-quality`)

Use what CLAUDE.md names. If it names several (a quick review and a full ship check), use the review one unless the owner asked for more. Name the method to the owner in one line. If the repo has no review method, ask the owner how to review, and stop until they answer.

## Forge: which CLI talks to the PRs
Pick it from where the repo is hosted (`git remote get-url origin`), unless the repo's CLAUDE.md or review method names its own:

| | GitHub (`github.com`) | Bitbucket (`bitbucket.org`) |
|---|---|---|
| CLI | `gh` | `twg bb` (Atlassian's `twg`) |
| who am I | `gh api user --jq .login` | `twg whoami -o json --output-summary none`, its `data.name` |
| open PRs | `gh pr list --state open --limit 30 --json number,title,url,author,isDraft` | `twg bb prs query --state OPEN --limit 30 -o json` |
| one PR | `gh pr view <n> --json number,title,author,url,headRefName,baseRefName` | `twg bb prs get <n>` |
| its diff | `gh pr diff <n>` | `twg bb prs diff <n>` (`diffstat` for a file list) |
| comment | `gh pr comment <n> --body-file <file>` | `twg bb prs comment create --pull-request <n> --text <text>` |
| approve | `gh pr review <n> --approve` | `twg bb prs approve <n>` |
| request changes | `gh pr review <n> --request-changes --body-file <file>` | `twg bb prs request-changes <n>` (comments posted first) |

Your verdict on a PR (`<me>` is "who am I"):
- GitHub: `gh pr view <n> --json reviews --jq '[.reviews[] | select(.author.login == "<me>")] | last | .state'` gives `APPROVED`
- Bitbucket: `twg bb prs get <n> -o json --output-summary none | jq -r '.participants[] | select(.user.display_name == "<me>") | .state'` gives `approved`

On Bitbucket, outside the PR's own checkout (a cockpit over several repos), add `-w <workspace> -r <repo>` to every `twg bb` command.

Another host: ask the owner which CLI to use. If the CLI is missing or not logged in (`gh auth status`, `twg env`), tell the owner and stop. Below, "the forge" means this CLI and its site.

## Intake (ENGINE §3)
- A task is a PR number (`1234`, `#1234`) or a PR URL. Worker name: `pr-<number>`.
- No PRs named: put the open PRs (not drafts, not the owner's own) in the inbox, newest first, and say how many are waiting. List them with the forge's "open PRs", drop drafts and the owner's own, and add each one:
  ```bash
  cockpit-task add --key "pr-$n" --title "PR #$n: $title" --url "$url" --task "Review PR #$n by $author" --source cockpit \
    --author "$author_name" --opened "$created" --branch "$source_branch" --additions "$added" --deletions "$removed" --files "$files" --reviewers "$reviewer_count"
  ```
  The panel groups the inbox by `--author` and shows the age, branch, size and number of reviewers (on Bitbucket the length of `reviewers` in `twg bb prs get`), so pass what the forge gives; leave out what it doesn't (on Bitbucket, sum `lines_added`, `lines_removed` and the entries of `twg bb prs diffstat <n> -n 1000 -o json`; `get --diff` stops at 100 files). `--tag <text>` is optional too: a short label the panel shows as a chip on the row. On GitHub that is:
  ```bash
  me=$(gh api user --jq .login)
  gh pr list --state open --limit 30 --json number,title,url,author,isDraft,headRefName,createdAt,additions,deletions,changedFiles,reviewRequests,latestReviews |
    jq -c --arg me "$me" '.[] | select((.isDraft | not) and .author.login != $me)' | while read -r pr; do
      f() { jq -r "$1" <<<"$pr"; }; n=$(f .number)
      cockpit-task add --key "pr-$n" --title "PR #$n: $(f .title)" --url "$(f .url)" \
        --task "Review PR #$n by $(f .author.login)" --source cockpit \
        --author "$(f 'if (.author.name // "") != "" then .author.name else .author.login end')" --opened "$(f .createdAt)" \
        --branch "$(f .headRefName)" --additions "$(f .additions)" --deletions "$(f .deletions)" --files "$(f .changedFiles)" \
        --reviewers "$(f '[.reviewRequests[].login, .latestReviews[].author.login] | map(select(. != null)) | unique | length')"
    done
  ```
  Declined PRs stay out by themselves (`cockpit-task` skips them while they're declined).
- Before writing the briefs, read each PR with the forge's "one PR", so the briefs and roster have titles, authors and branches.
- Before launching any PR (Start worker or named in chat), check your verdict on it. Already approved: launch no worker, `cockpit-task close --key <key>` (never leave it `starting`), and say so in one line: `frontend #616: you already approved it. Closed it, no worker.` Approving is the end of a PR's review; only a new request from the owner in chat ("re-review 616") overrides it.

## Launch (ENGINE §4)
- Workers review only: no worktree, no branch switching. Each works in the cockpit's folder and reads the PR through the forge's CLI (put its "one PR" and "its diff" commands in the brief) or the method's own way, without checking it out over the shared tree. If the repo's review method needs a checkout, follow the repo's worktree convention for it.

## Brief (ENGINE §5): the REPORT part
```
REPORT
Create your doc first:
  ~/.claude/skills/cockpit-panel/scripts/cockpit-panel new pr-review pr-<n> "PR #<n>: <title>" --into <cockpit tab> --worker pr-<n>
- Summary tab: fill it as soon as you've read the PR, before the review is finished.
- Review feedback tab: fill it only when the review is done, from your method's findings, in the tab's format
  (verdict, critical issues, required changes, optional, nits, what's done well, verification story).
Don't post the review on <forge>.
Read ~/.claude/skills/cockpit-panel/SKILL.md, section "Writing for a cockpit".
```
In COCKPIT-SUMMARY, include the verdict and the counts: `APPROVE · 0 critical · 1 required`.

## Report (ENGINE §7): roster columns
| worker | PR | verdict | critical / required | state |

Verdict and counts come from the worker's COCKPIT-SUMMARY, or from the Review feedback doc if the summary lacks them. Decisions are rare in reviews. Report questions for the PR author as decisions only when the owner must answer them.

## Approve (when the owner says so)
"Approve 614", "let's approve it": approving is the owner's call, so do it even if the Review feedback verdict differs (say so in the same line). Then:
1. Approve with the forge's "approve" command.
2. Wait until it has landed: check your verdict every 5 seconds, for up to a minute, until it reads approved. If it never does, tell the owner what the forge shows and stop here; clean nothing up.
3. Clean up everything the cockpit holds for that PR (approving counts as the owner asking to close it):
   - its inbox task, found by key or URL: `cockpit-task close --key <key>` (it never comes back, whatever the scripts find)
   - its worker: close the worker's tab (ENGINE §9). If the worker made a worktree, remove it the repo's way, but only when it has no uncommitted changes; otherwise say so and leave it
   - its doc: the folder in `~/.herdr/docs/<cockpit tab>/` whose `doc.json` has this PR's `worker` (`rm -rf` that folder; the panel drops it). An approved PR's review is finished, so the doc goes
   - its roster row
4. Report it in one line: `Approved frontend #614 (Bitbucket shows it). Closed its inbox task, worker tab and doc.`

## Mark what was done (in the panel)
After comments or a request for changes are posted on the forge for a PR, mark its doc so the panel's Docs tab shows it was handled (an approved PR's doc is removed instead, above). The doc is the folder in `~/.herdr/docs/<cockpit tab>/` whose `doc.json` has this PR's `worker`:
```bash
~/.claude/skills/cockpit-panel/scripts/cockpit-panel handled <slug> changes-requested --into <cockpit tab>   # or commented
```
Mark the stronger of the two (changes-requested over commented), and only once the forge shows it.

## Finish (ENGINE §9)
Suggest the next step per PR (post the review, approve, ask the author). Post on the forge only when the owner asks, with its "comment", "request changes" or "approve" command, and then post exactly the doc's text. Then mark the doc (above).
