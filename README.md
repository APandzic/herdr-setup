# herdr-setup

My [Herdr app](https://herdr.dev/) setup and the Claude Code skills that go with it, so every machine works the same.

## What's in it

| Path | What it is |
|---|---|
| `herdr-app/layouts/my-main.json` | My window layout: sidebar with Spaces / Agents tabs, tabs bar, Files and Changes panel. |
| `herdr-app/settings.json` | App settings (zoom, sounds, fonts). |
| `herdr-app/keys.add.json` | The keys this setup adds to Herdr's (`cmd-shift-r` for Review); merged into your keys.json, the rest of which stays yours. |
| `herdr-app/mods/my-sidebar` | The sidebar: spaces with their tabs and agents, an Agents list, footer, panel toggle. Forked from Better Sidebar. |
| `herdr-app/mods/my-config` | A settings dialog for every mod that has settings. Forked from Better Config. |
| `herdr-app/mods/my-usage` | Claude's plan limits (5-hour, weekly) above the sidebar's footer, Codex's too when you've used it. Modeled on Over9k Usage. |
| `herdr-app/mods/cockpit-panel` | Cockpit Panel: a read-only markdown panel per Herdr tab, filled by agents from templates. A doc's bar shows what the cockpit did with it (Approved, Merged, …), has Review diff on a worker's doc until it's merged, and Remove (click twice) to delete it. In a cockpit it also has an Inbox tab: the project's scripts (start, stop, run) and the tasks they find. |
| `herdr-app/mods/review` | Review: a read-only look through a repo's changes (uncommitted, a branch, one commit), as a tab or beside a terminal, with a Viewed check per file. See below. |
| `herdr-mods/cockpit-panel/templates/` | The Cockpit Panel kinds: PR review, PR summary, task ticket, ticket plan. |
| `claude/skills/cockpit-panel` | Skill + helper script for agents to create and fill Cockpit Panel. |
| `claude/skills/herdr-review-cockpit` | Review many PRs in parallel, each worker using the repo's own review method, results in the cockpit's panel. |
| `claude/skills/herdr-code-cockpit` | Work many tickets in parallel, following the repo's own workflow, plans in the cockpit's panel. |
| `claude/skills/_cockpit-engine` | Shared mechanics for both cockpits (not a skill on its own). |
| `bin/cockpit-task` | The inbox helper scripts call to add tasks; installed to `~/.local/bin`. |
| `bin/review` | Opens Review on a folder as a new tab; installed to `~/.local/bin`. |
| `bin/cockpit-rules` | Tells a running cockpit when its rule files changed (a Claude Code prompt hook); installed to `~/.local/bin`. |
| `examples/github-new-prs.sh` | Example watcher: puts open PRs (not yours, not drafts) into the inbox. |

## Install on a machine

Needs: the Herdr app (started once), `hc`, `jq`, `perl`, `rsync`; `gh` (GitHub) or `twg` (Bitbucket) for the review cockpit.

```sh
git clone <this repo> ~/Development/private-github/herdr-setup
~/Development/private-github/herdr-setup/install.sh
herdr-app do layout.switch '{"name":"my-main"}'
```

`install.sh` copies the mods, layouts, settings and templates into place, symlinks the skills into `~/.claude/skills/` and adds one prompt hook to `~/.claude/settings.json` (see below). Whatever it replaces goes to `~/.herdr-setup-backups/<time>/` first. Run it again after every `git pull`.

## Cockpit scripts and the inbox

Give a project scripts by adding `<project>/.herdr/cockpit.json` (or ask a cockpit to). Starting a cockpit there gives its panel an Inbox tab next to Docs.

```json
{
  "scripts": [
    { "id": "new-prs", "title": "New PRs", "run": "~/Development/private-github/herdr-setup/examples/github-new-prs.sh",
      "mode": "watch", "autostart": true, "cockpit": "review" },
    { "id": "stale", "title": "Stale tickets", "run": "~/scripts/stale.sh", "mode": "schedule", "every": "30m" },
    { "id": "pull", "title": "Pull open PRs now", "run": "~/Development/private-github/herdr-setup/examples/github-new-prs.sh",
      "args": ["--once"], "mode": "manual" }
  ],
  "inbox": { "decline_for": "48h" }
}
```

| Field | Meaning |
|---|---|
| `run`, `args` | The script, anywhere on disk (`~` works), and its arguments. It runs in the project folder. |
| `mode` | `watch`: long-running, Start/Stop (an `hc` terminal you can Peek at; it survives Herdr restarts). `schedule`: run every `every` while switched on. `manual`: a Run button. |
| `autostart` | Switch it on when the panel opens. |
| `cockpit` | `review` or `code`: which cockpit its tasks are for. |
| `inbox.decline_for` | How long a declined task stays hidden (`12h`, `48h`, `7d`; also set from the panel). |

A script reports work with `cockpit-task`, so it can be written in anything:

```sh
cockpit-task add --key pr-123 --title "PR #123: Add retry" --url https://… --task "Review PR #123"
```

`add` prints `added`, `exists` (already in the inbox) or `declined` (declined recently), so scripts can simply report everything they see each time. Optional `--author`, `--opened`, `--branch`, `--additions`, `--deletions`, `--files` and `--reviewers` group the inbox by author and show each PR's age, branch, size and reviewer count; reporting them again keeps them current. In the panel each task gets **Start worker** (the cockpit launches a worker with the repo's own method) and **Decline**. A task is closed for good, and leaves the panel, when the review cockpit sees its PR approved, when you Clear its finished worker, or when a watcher runs `cockpit-task close` on it (my Bitbucket watcher does for merged, declined or approved PRs); Declined lists only what you declined yourself. State lives in `~/.herdr/cockpits/<project>-<hash>/` (`cockpit-task where`), never in the project.

## Reviewing changes

Review shows a repo's changes, read-only: pick **Uncommitted**, **Branch** (a branch against its base) or **Commit** (a branch's commits) at the top. On the left are the files as a tree, grouped **Changed**, **Renamed**, **Deleted**, **New** with a count each, each file with a **Viewed** check, a bar of how many changed and renamed files you've viewed (**Hide viewed** hides them), and the commits: under Branch the branch's own (pick one to see just it, or All), under Commit the last 30. On the right is every file's diff in one scroll, in the same order; click a changed or renamed file's header to mark it viewed, which folds it and jumps to the next one. Where a line was edited, the removed line and the added line that replaces it are tinted faintly and the words that differ strongly. New and deleted files are one row each (a New or Deleted badge with the line count) until you click it or the file in the tree; a new file opens as plain code, a deleted one as its removed lines. Mark them viewed with their check in the tree. A check clears by itself when that file's diff changes. Checks are kept in `~/.herdr/reviews/` for 30 days. It refreshes when files in the repo change.

Open it:

- `cmd-shift-r` in a terminal: beside it, for that terminal's folder.
- `review [folder] [--base <branch>] [--scope uncommitted|branch|commit]`: as a new tab (default: the current folder).
- **Review diff** in a worker's doc in the Cockpit Panel: that worker's worktree and branch, as a tab. The code cockpit points you to it before it asks whether to merge.

Branch and Commit look at any branch, picked on the left of the header (**[branch ▾] → [base ▾]**), without checking it out: Review only reads with git and writes nothing to the repo. Both menus list the local branches, origin's and the repo's worktrees (each as its folder and branch, or *detached* and its commit), newest first, searchable by any of those names. The branch side starts on what the folder has checked out. A worktree picked there is looked at in its own folder, uncommitted edits included, as the checkout is; a branch (say `origin/feature/PD-7755`, pushed by an agent and checked out nowhere) shows its commits only, and the header says *committed only*. A worktree picked as the base means the commit it has checked out; the header says *base: committed only*. **↑**/**↓** count the commits the branch has that its base lacks, and the other way round. When it has none (it's been merged), Review says *All of <branch> is already in <base>*, and when the work tree still has edits, that only those are left. When a local branch you picked (as branch or base, or the branch of a worktree you picked) is behind its origin copy, a note under the header says how far, with **Use origin/<it>** to switch.

Branch compares with `--base`, else origin's default branch, else `main` or `master`; of a branch and `origin/<it>`, it takes the local one only when it holds everything origin's has (a stale local `main` would pull in every commit it's missing). Click the base or the branch in the header to pick another: the menu shows how long ago each was committed to, with the default (or, for the branch, the checkout) on top. Type to search (anywhere in the name, any case); Enter picks the top match. **Fetch** at its foot runs `git fetch --prune origin` and says when it's done, or what git said, then lists the branches again. Review keeps the branch, base and scope you pick for that folder. The header also shows the folder Review is looking at.

Review never sits on *Loading*: it says when there's nothing to show (*No uncommitted changes*), when the folder isn't a git repository, and what git said when it fails. A view over 100,000 changed lines shows only its counts; Branch lists its latest 200 commits. Feedback, approving and merging go through the cockpit's chat; Review never changes your work (Fetch only updates origin's branches, and only when you click it).

The key lives in `herdr-app/keys.add.json`. `install.sh` merges it into `~/.config/herdr-app/keys.json` (backed up first): its keys replace those same keys, everything else in the file stays as it is, and a run that has nothing to add leaves the file alone. `capture.sh` brings back only those keys' bindings, and `update.sh` stops only if you've bound one of them to something else in the app. One catch: Herdr gives a keys file its new default keys on upgrade only while nobody has edited it, and the merge is an edit, so after the first install, new default keys from a Herdr update have to be added by hand.

## Usage in the sidebar

My Usage shows a row per service: its logo (the program's icon from Herdr's program table, as the sidebar's agents have), then one line per limit (5-hour above 7-day), each with a bar and its used % (yellow from 50, red from 80) and the time until it resets. Click a row for the plan, the clock time each limit resets and when the numbers were saved; hover for a summary of the row. Claude Code hands its limits only to a status line, so they come from `~/.cache/claude-usage/rate-limits.json`, which the status line has to save. Mine (`~/.claude/statusline-command.sh`, not in this repo) does it with:

```sh
limits=$(echo "$input" | jq -c '.rate_limits // empty')
[ -n "$limits" ] && mkdir -p ~/.cache/claude-usage && printf '%s\n' "$limits" > ~/.cache/claude-usage/rate-limits.json
```

Without that file the row says *No limits yet*; without a Claude login, *Not logged in*. Nothing reads a token or goes online. Refresh rate and Codex are in My Config → My Usage.

## Updating

When something new is pushed, the sidebar footer's **Update** button (↓) gets a blue dot and you get a notification. A red dot means the last check failed; hover it for the reason. It checks GitHub every hour (`setup.check_every` in My Config → My Sidebar). Click it, or run:

```sh
./update.sh          # pull and install
./update.sh --check  # just print how many commits are new
```

It pulls only when that's safe, and otherwise stops without changing anything, telling you why:

| Stops when | Do this |
|---|---|
| The repo has uncommitted changes | Commit or stash them |
| Something changed in the Herdr app that isn't in the repo (a setting, a layout click) | `./capture.sh`, commit what you want to keep, update again |
| This machine has commits GitHub doesn't | Push them, then update |

Skills update the moment the repo is pulled (they're symlinks); mods, layouts, settings and templates once `install.sh` has run, which `update.sh` does for you.

## Cockpits pick up rule changes

A cockpit reads its rules (the cockpit skill, the cockpit engine, the panel skill) once, when it starts, and registers them with `cockpit-rules`. Before each prompt you send it, a hook checks whether any of them changed since (by content, so uncommitted edits count too). If so, that prompt tells the cockpit which files changed; it re-reads them, applies them to the current round, and tells you in one line what changed. Nothing is needed from you after an update or an edit to the skills. Other Claude sessions aren't affected.

## Changed something in Herdr?

Edits made in the app (dragging a panel, toggling a setting in My Config, editing a mod in place) land in `~/.config/herdr-app`. Copy them back and commit:

```sh
./capture.sh   # shows git status afterwards
git commit -am "…"
```

Skills are symlinks, so edits to them are already in the repo.

## Not in here, on purpose

Files Herdr writes itself (`shared.json`, `view.json`, `window.json`, `data/`, `layouts/.state/`, `frame/`), Herdr's shipped mods and layouts, `~/.claude/skills/synced/` (managed by Claude), the docs agents write (`~/.herdr/docs/`, tied to one machine's tabs) and Review's Viewed checks (`~/.herdr/reviews/`).

## License

My own files are mine. `my-sidebar` and `my-config` are modified copies of Apache-2.0 mods by Tawsif Aqib; see `NOTICE` and `third_party/herdr-mods/`. `my-usage` is modeled on the MIT-licensed Over9k Usage; see `NOTICE` and `third_party/herdr-over9k/`.
