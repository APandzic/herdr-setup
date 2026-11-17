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

## Intake (ENGINE §3)
- A task is a PR number (`1234`, `#1234`) or a PR URL. Worker name: `pr-<number>`.
- No PRs named: put the open PRs (not drafts, not the owner's own) in the inbox, newest first, and say how many are waiting:
  ```bash
  me=$(gh api user --jq .login)
  gh pr list --state open --limit 30 --json number,title,url,author,isDraft |
    jq -c --arg me "$me" '.[] | select((.isDraft | not) and .author.login != $me)' | while read -r pr; do
      n=$(jq -r .number <<<"$pr")
      cockpit-task add --key "pr-$n" --title "PR #$n: $(jq -r .title <<<"$pr")" --url "$(jq -r .url <<<"$pr")" \
        --task "Review PR #$n by $(jq -r .author.login <<<"$pr")" --source cockpit
    done
  ```
  Declined PRs stay out by themselves (`cockpit-task` skips them while they're declined).
- Before writing the briefs, run `gh pr view <n> --json number,title,author,url,headRefName,baseRefName` for each PR, so the briefs and roster have titles. If `gh` isn't authenticated, tell the owner and stop.

## Launch (ENGINE §4)
- Workers review only: no worktree, no branch switching. Each works in the cockpit's folder and reads the PR through `gh` (`gh pr diff`, `gh pr view`) or the method's own way, without checking it out over the shared tree. If the repo's review method needs a checkout, follow the repo's worktree convention for it.

## Brief (ENGINE §5): the REPORT part
```
REPORT
Create your doc first:
  ~/.claude/skills/cockpit-panel/scripts/cockpit-panel new pr-review pr-<n> "PR #<n>: <title>" --into <cockpit tab> --worker pr-<n>
- Summary tab: fill it as soon as you've read the PR, before the review is finished.
- Review feedback tab: fill it only when the review is done, from your method's findings, in the tab's format
  (verdict, critical issues, required changes, optional, nits, what's done well, verification story).
Don't post the review on GitHub.
Read ~/.claude/skills/cockpit-panel/SKILL.md, section "Writing for a cockpit".
```
In COCKPIT-SUMMARY, include the verdict and the counts: `APPROVE · 0 critical · 1 required`.

## Report (ENGINE §7): roster columns
| worker | PR | verdict | critical / required | state |

Verdict and counts come from the worker's COCKPIT-SUMMARY, or from the Review feedback doc if the summary lacks them. Decisions are rare in reviews. Report questions for the PR author as decisions only when the owner must answer them.

## Finish (ENGINE §9)
Suggest the next step per PR (post the review, approve, ask the author). Post on GitHub only when the owner asks, and then post exactly the doc's text.
