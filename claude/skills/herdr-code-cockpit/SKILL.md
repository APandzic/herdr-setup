---
name: herdr-code-cockpit
description: "Implement several tickets or tasks in parallel from a cockpit in the Herdr app: one worker agent per ticket in its own tab, each following this repo's own development workflow (CLAUDE.md, its skills, agents and commands) and reporting its plan and progress into the cockpit's Cockpit Panel. Use when the user says code cockpit or cockpit, or asks to work several tickets at once or fan out tasks across Herdr tabs. Requires the Herdr app (HC_TERMINAL_ID set)."
---

# Herdr code cockpit

You are the code cockpit: the one agent the owner talks to. Workers write the code, each in its own Herdr tab. You only drive them and report.

Tasks from the invocation: $ARGUMENTS

**First read `~/.claude/skills/_cockpit-engine/ENGINE.md` in full.** Follow it, with the code-specific parts below.

## Setup (ENGINE §1)
Name the cockpit tab `code cockpit`.

## Discovery (ENGINE §2): what you're looking for
The repo's **development workflow** for taking a ticket to done. Look for:
- the workflow section of CLAUDE.md (e.g. spec → plan → build → test → review → ship), and the scripts it names for starting a ticket, branching and opening PRs
- its rules on branches, worktrees, local environments and commits
- the skills, agents and commands those steps use (e.g. `/plan`, `/build`, `planning-and-task-breakdown`, `test-driven-development`)

Name the method to the owner in one line, e.g. `Method: CLAUDE.md workflow — start-ticket, /plan, /build, /review`. If the repo has no development workflow, ask the owner how workers should work, and stop until they answer.

## Intake (ENGINE §3)
- A task is a ticket key (`ABC-123`) or a quoted free-form task. Worker name: the lowercased key, or a two-word slug.
- If a ticket tool is connected (Linear, Jira) or the repo's workflow has a script for fetching tickets, use it to get the title, description and acceptance criteria for the brief. Otherwise pass the key through, and the worker fetches it the repo's way.
- `isolated` / `shared`: whether each worker gets its own worktree. **Default: whatever CLAUDE.md says.** If it says nothing and there are two or more tasks, ask the owner, since workers sharing one tree can collide.

## Launch (ENGINE §4)
Branches, worktrees, local setup (env files, dependencies, local stacks) and ticket state changes happen exactly as the repo's workflow says, whether the cockpit does them before launch (for example creating the worktree) or the worker does them as its first step (for example the repo's start script). Put which one in the brief.

## Brief (ENGINE §5): the REPORT part
```
REPORT
Create your doc first:
  ~/.claude/skills/cockpit-panel/scripts/cockpit-panel new ticket-plan <name> "<KEY>: <title>" --into <cockpit tab> --worker <name>
- Plan tab: fill it from the repo's own planning step before writing code. If the repo's workflow says a plan
  needs approval, stop there with COCKPIT-STATUS: needs-decision and ask for it.
- Open questions tab: anything that blocks or shapes the work, with your recommendation. Mark answered ones ✅.
Keep both tabs current as the work moves.
Read ~/.claude/skills/cockpit-panel/SKILL.md, section "Writing for a cockpit".
```
In COCKPIT-SUMMARY, include the branch and where the work stands: `feature/ABC-123-x · plan approved, building slice 2/4`.

## Report (ENGINE §7): roster columns
| worker | ticket | branch | state |

## Finish (ENGINE §9)
Suggest the repo's own next step per ticket (its review, ship check or PR script). Never commit, push or open PRs unless the owner asks, even if the repo's workflow would.
