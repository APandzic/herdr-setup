# herdr-setup

My [Herdr app](https://herdr.dev/) setup and the Claude Code skills that go with it, so every machine works the same.

## What's in it

| Path | What it is |
|---|---|
| `herdr-app/layouts/my-main.json` | My window layout: sidebar with Spaces / Agents tabs, tabs bar, Files and Changes panel. |
| `herdr-app/settings.json` | App settings (zoom, sounds, fonts). |
| `herdr-app/mods/my-sidebar` | The sidebar: spaces with their tabs and agents, an Agents list, footer, panel toggle. Forked from Better Sidebar. |
| `herdr-app/mods/my-config` | A settings dialog for every mod that has settings. Forked from Better Config. |
| `herdr-app/mods/cockpit-panel` | Cockpit Panel: a read-only markdown panel per Herdr tab, filled by agents from templates. In a cockpit it also has an Inbox tab: the project's scripts (start, stop, run) and the tasks they find. |
| `herdr-mods/cockpit-panel/templates/` | The Cockpit Panel kinds: PR review, PR summary, task ticket, ticket plan. |
| `claude/skills/cockpit-panel` | Skill + helper script for agents to create and fill Cockpit Panel. |
| `claude/skills/herdr-review-cockpit` | Review many PRs in parallel, each worker using the repo's own review method, results in the cockpit's panel. |
| `claude/skills/herdr-code-cockpit` | Work many tickets in parallel, following the repo's own workflow, plans in the cockpit's panel. |
| `claude/skills/_cockpit-engine` | Shared mechanics for both cockpits (not a skill on its own). |
| `bin/cockpit-task` | The inbox helper scripts call to add tasks; installed to `~/.local/bin`. |
| `examples/github-new-prs.sh` | Example watcher: puts open PRs (not yours, not drafts) into the inbox. |

## Install on a machine

Needs: the Herdr app (started once), `hc`, `jq`, `perl`, `rsync`; `gh` for the review cockpit.

```sh
git clone <this repo> ~/Development/private-github/herdr-setup
~/Development/private-github/herdr-setup/install.sh
herdr-app do layout.switch '{"name":"my-main"}'
```

`install.sh` copies the mods, layouts, settings and templates into place and symlinks the skills into `~/.claude/skills/`. Whatever it replaces goes to `~/.herdr-setup-backups/<time>/` first. Run it again after every `git pull`.

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

`add` prints `added`, `exists` (already in the inbox) or `declined` (declined recently), so scripts can simply report everything they see each time. In the panel each task gets **Start worker** (the cockpit launches a worker with the repo's own method) and **Decline**. State lives in `~/.herdr/cockpits/<project>-<hash>/` (`cockpit-task where`), never in the project.

## Changed something in Herdr?

Edits made in the app (dragging a panel, toggling a setting in My Config, editing a mod in place) land in `~/.config/herdr-app`. Copy them back and commit:

```sh
./capture.sh   # shows git status afterwards
git commit -am "…"
```

Skills are symlinks, so edits to them are already in the repo.

## Not in here, on purpose

Files Herdr writes itself (`shared.json`, `view.json`, `window.json`, `data/`, `layouts/.state/`, `frame/`), Herdr's shipped mods and layouts, `~/.claude/skills/synced/` (managed by Claude), and the docs agents write (`~/.herdr/docs/`, tied to one machine's tabs).

## License

My own files are mine. `my-sidebar` and `my-config` are modified copies of Apache-2.0 mods by Tawsif Aqib; see `NOTICE` and `third_party/herdr-mods/`.
