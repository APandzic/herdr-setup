# Cockpit engine (Herdr app)

Shared mechanics for `herdr-review-cockpit` and `herdr-code-cockpit`. This file is not a skill. Those skills tell you to read it and say which parts they change.

**A cockpit drives; it never decides how work is done.** It runs in a repo, finds that repo's own method for the task (its skills, agents, commands and CLAUDE.md), sends workers to follow that method, and reports back to the owner in a short, manageable form. The cockpit's own rules cover only driving: launching, waiting, relaying and reporting.

`TD` below means `~/.claude/skills/cockpit-panel/scripts/cockpit-panel`.

## 1. Preconditions

```bash
test -n "${HC_TERMINAL_ID:-}" && ~/.claude/skills/cockpit-panel/scripts/cockpit-panel ids && pwd
```

If this fails, say you aren't running inside the Herdr app, and stop. Keep `space`, `tab` (the **cockpit tab**) and `terminal` from the output.

Never start a worker in the cockpit tab. Rename it once and open the **cockpit panel**, connected to this repo and to you. Always do this, whether or not the repo has scripts; it replaces a plain docs panel that's already open:

```bash
herdr-app do tab.rename "$(jq -nc --arg id "<cockpit tab>" --arg n "<cockpit name>" '{id:$id,name:$n}')"
~/.claude/skills/cockpit-panel/scripts/cockpit-panel open --project "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" --cockpit "$HC_TERMINAL_ID"
```

The panel has two top tabs: **Docs** (filled when workers write docs) and **Inbox** (tasks waiting for the owner's Start or Decline, the workers you're running, and the repo's scripts). If the repo has `.herdr/cockpit.json` (§10), tell the owner in one line which scripts are available and which are running (those marked `autostart` start by themselves).

**The inbox is the queue.** When the owner hasn't named tasks and the cockpit skill knows how to list candidates (e.g. open PRs), put them in the inbox with `cockpit-task add` (`--source cockpit`) instead of listing them in chat, and say how many are waiting. The owner starts them with the panel's Start worker, or by naming them in chat.

If a `herdr-app` or `hc` call fails with a socket or permission error, the Bash sandbox is blocking it. Tell the owner, point them to `/sandbox`, and don't retry blindly.

## 2. Discovery: find the repo's method

Before launching anything, find out how this repo wants the task done:

1. Read `CLAUDE.md` and `AGENTS.md` at the repo root (and any file they say to read first).
2. List what the repo offers, with names and descriptions only (don't read them in full):
   ```bash
   for f in .claude/skills/*/SKILL.md; do echo "skill $(dirname "$f" | xargs basename): $(grep -m1 '^description:' "$f" | cut -c14-)"; done 2>/dev/null
   for f in .claude/agents/*.md .claude/commands/*.md; do echo "$f: $(grep -m1 '^description:' "$f" | cut -c14-)"; done 2>/dev/null
   ```
3. Pick what the repo says to use for this kind of task (the cockpit skill says what it's looking for). Prefer what CLAUDE.md names explicitly over a skill whose description merely matches.
4. Tell the owner the method in one line before launching, e.g. `Method: /review command + code-reviewer agent (CLAUDE.md step 6)`.
5. **If the repo defines no method for this task, ask the owner and stop until they answer.** Never invent a checklist or a workflow.

Worktrees, branches, commits, tickets and test commands also follow the repo (CLAUDE.md). The cockpit adds nothing of its own there.

## 3. Intake

Parse the invocation into tasks and modifiers:

- Tasks are separated by commas or newlines. The cockpit skill says what a task looks like.
- `args="<native args>"` is appended to every worker's command line, e.g. `args="--model opus"`. It may not contain `--permission-mode` or `--dangerously-skip-permissions`.

If no tasks were given: fill the inbox as §1 says when the cockpit skill can list candidates, or say the inbox is ready; then wait for Start (§10) or tasks named in chat.

Give each task a worker name: a lowercased key or number (`pr-1234`, `rum-88`), or a two-word slug for free-form text. Names match `[a-z][a-z0-9-]{0,31}` and are unique in this round.

## 4. Launch one worker per task

Each worker gets its own tab in the cockpit's space, running Claude in **auto mode**, with the brief as its first message. Write the brief to the scratchpad first so quoting never breaks:

```bash
herdr-app do tab.new "$(jq -nc --arg s "<space>" --arg n "<name>" --arg f "<cwd>" --rawfile task "<scratchpad>/brief-<name>.md" \
  '{space:$s, name:$n, folder:$f, argv:["claude","--permission-mode","auto"], task:$task, focus:false}')"
```

Add `args` as extra `argv` entries after `"auto"`. The result is `{space, tab, terminal}`: keep `tab` and `terminal` (e.g. `t12`) in the roster. Always target workers by terminal address, never by focus or sidebar order.

If the repo's method needs a worktree, create it as CLAUDE.md describes before launching, and pass its path as `folder`.

Then wait for each worker in the background (Bash `run_in_background`, with a timeout of at least 3700 s), so all run concurrently and you're re-invoked as each one settles:

```bash
hc wait <terminal> --timeout 3600 --json
```

If the agent starts `blocked` (a trust or login dialog), report that dialog to the owner before anything else.

## 5. The brief

```
You are worker "<name>", started from a cockpit in Herdr. Work autonomously on this task.

TASK
<the task: PR / ticket key, title, description, acceptance criteria, any context the owner gave>

METHOD
Follow this repo's CLAUDE.md. Do this task with: <the method found in discovery: skill / agent / command, by name>.
Do not substitute your own process for it.

REPORT
<from the cockpit skill: which cockpit-panel kind, the exact `cockpit-panel new ... --into <cockpit tab> --worker <name>` line, and what goes in each tab>
Read ~/.claude/skills/cockpit-panel/SKILL.md, section "Writing for a cockpit".

RULES
- Working directory: <cwd>. <branch or worktree, as the repo's method says>
- Do not commit, push, post comments or change tickets unless this brief says so.
- Make ordinary judgment calls yourself. Ask only for decisions a human must make.
- When you are finished, or need a human decision, end your turn with this block as the very last thing you print:

COCKPIT-STATUS: done | needs-decision | failed
COCKPIT-SUMMARY: <one or two sentences; include your doc slug>
COCKPIT-DECISIONS:
- <question, the options you considered, your recommendation>

Keep the block under 15 lines. The cockpit reads only your last screenful.
```

## 6. Monitor

When a background wait returns:

```bash
hc get <terminal> --json        # status: working | blocked | idle | done
hc read <terminal> --lines 150  # the screen and recent history
```

Classify the worker:

- `blocked`: describe the dialog and its options in one or two lines and report now. Never answer it yourself.
- `needs-decision`: report now, with the worker's decisions.
- `done`: hold it until the others settle, then report all together (earlier if another worker triggers a report anyway).
- `failed`, or the wait timed out: report now with the last few lines. Don't resend the brief; a timeout doesn't prove it was lost.
- Settled without a block: treat it as needs-decision and quote its last two lines.

For more detail on a finished worker, read its doc in the cockpit's panel folder (`TD where`) rather than its transcript.

## 7. Report

1. The roster: one row per worker, with the columns the cockpit skill defines, each cell kept short.
2. Decisions, grouped by worker: header `**<name>** — <task>`, then `  N. <question> Rec: <x>.`, numbered across all workers.
3. A pre-filled reply line: `→ 1: <rec>, 2: <rec>, …`. The owner sends it as-is or edits numbers.
4. One line: "Details are in the panel on the right". Name a worker's tab only when its dialog needs the owner's eyes.
5. With an Inbox tab: `Inbox: N new` (from `cockpit-task list --state new`), never the tasks themselves.

Nothing else. Never paste worker output or doc contents into chat. Keep it under 30 lines.

When the owner asks for status mid-round, run `herdr-app ls` and show the roster.

## 8. Relay decisions

For each answer in the owner's reply line:

- Blocked worker: press only the keys that select the owner's choice, one dialog at a time, then reread the screen to confirm it closed:
  ```bash
  hc keys <terminal> down enter
  ```
- Idle worker with a decision: send it as a new prompt, in the background:
  ```bash
  hc send <terminal> "Decision for '<question>': <answer>. Continue, and end your turn with the COCKPIT block." --wait --timeout 3600
  ```
- A changed or new task: a new worker as in section 4. Reuse a worker only for follow-ups on its own task.

Then return to section 6. Repeat until every worker is done or the owner stops.

## 9. Finish

Show the final roster and point to the panel. Suggest next steps from the repo's own workflow (e.g. its ship or PR step), but don't run them. Close worker tabs or remove worktrees only when the owner asks:

```bash
herdr-app do tab.close "$(jq -nc --arg id "<tab>" '{id:$id,confirmed:true}')"
```

## 10. Scripts and the inbox

A repo can register helper scripts in `<repo>/.herdr/cockpit.json`. The scripts can live anywhere on disk; whatever they find goes into the inbox via `cockpit-task`, and the owner picks from the Inbox tab of the cockpit's panel:

```json
{
  "scripts": [
    { "id": "new-prs", "title": "New PRs", "run": "~/scripts/github-new-prs.sh", "args": ["--every", "120"],
      "mode": "watch", "autostart": false, "cockpit": "review" },
    { "id": "stale", "title": "Stale tickets", "run": "~/scripts/stale.sh", "mode": "schedule", "every": "30m" },
    { "id": "pull", "title": "Pull open PRs now", "run": "~/scripts/github-new-prs.sh", "args": ["--once"], "mode": "manual" }
  ],
  "inbox": { "decline_for": "48h" }
}
```

`mode`: `watch` runs until stopped, `schedule` runs every `every` while on, `manual` runs on the Run button. Scripts run in the repo folder with `COCKPIT_PROJECT`, `COCKPIT_SCRIPT` and `cockpit-task` on PATH. An example watcher is `~/Development/private-github/herdr-setup/examples/github-new-prs.sh`.

**Starting from the inbox.** When the owner presses Start worker, you receive the message `INBOX START <key> — <title>`. Then:

1. `cockpit-task list --key <key>` gives the task (`title`, `url`, `task`, `source`). The source script's `cockpit` field in `cockpit.json` says which kind of cockpit it's meant for. If it isn't yours, tell the owner and set it back with `cockpit-task undo --key <key>`.
2. Launch a worker for it as in §4–5, with the method found in §2. Name the worker after the key.
3. `cockpit-task update --key <key> --state running --worker <terminal>`. When the worker settles done: `--state done`. If it fails, report it as usual.

Never start work from the inbox on your own, and never decline tasks yourself; the owner's buttons do that.

**Adding scripts.** When the owner asks ("add ~/scripts/x.sh as a watcher"), edit `.herdr/cockpit.json` (create it, with `.herdr/` in the repo's `.gitignore` unless the owner wants it committed). Check that the script exists and is executable, pick a short unique `id`, and confirm in one line. The panel picks the change up by itself. Never edit or run the scripts themselves unless asked.

## Rules

- `focus: false` on every launch. The owner's focus stays on the cockpit.
- Workers always run with `--permission-mode auto`, never `--dangerously-skip-permissions`. A permission dialog is expected now and then: treat it as `blocked` and relay the owner's choice.
- Never answer a worker's dialog, kill a worker or close anything without the owner's instruction.
- Read at most 150 lines per check. The cockpit's context is for coordination, not transcripts.
- Inspect before resending. A stalled or timed-out wait isn't proof the prompt was lost.
