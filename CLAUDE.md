# herdr-setup

The owner's Herdr app setup (mods, layout, settings, cockpit templates) and the Claude Code skills that drive cockpits in it. `README.md` says what each folder is; read it first.

## Where a change goes live

| Path | Live after |
|---|---|
| `claude/skills/*` | Saving: they're symlinked into `~/.claude/skills/`. Running cockpits keep what they read until told to re-read it. |
| `bin/*` | Saving: symlinked into `~/.local/bin/`. |
| `herdr-app/mods/*`, `herdr-app/layouts/`, `herdr-app/settings.json`, `herdr-mods/*` | `./install.sh` (copies them; Herdr reloads a mod when its files change). |

Long-running watcher scripts keep the code they started with; the owner restarts them (Stop, Start in the panel's Scripts).

## Development workflow

Tasks are free-form (no ticket tool). For each one:

1. **Read** the code it touches and what feeds it. Mods are plain JS on gpui-kit (types in `~/.config/herdr-app/gpui-kit.d.ts` and `herdr.d.ts`); check a method exists there before using it.
2. **Change** it in the style around it: chained gpui builders, theme tokens from `theme()` (never fixed colors, except the avatar palette), short comments only for constraints.
3. **Check**, all that apply:
   - JS: `node --check <file>` and `herdr-app check herdr-app/mods/<mod>` (must say `check passed`)
   - shell: `bash -n <file>`; Python: `python3 -I -m py_compile <file>`
   - `bin/cockpit-task` and the `cockpit-panel` script: run the changed commands against a scratch inbox or home (`COCKPIT_STATE=$TMPDIR/x COCKPIT_PROJECT=$PWD`, or `HOME=$TMPDIR/home`), never the owner's real cockpits
4. **Try it live** (main checkout only, see below): `./install.sh`, then `herdr-app status` must show no errors. To see a mod, open it on scratch data beside your own terminal (`herdr-app do pane.split` with `mod` and `props`) and `herdr-app shot`; the shot shows only the tab on screen, so if yours isn't, ask the owner to look. Close what you opened and delete scratch data afterwards.
5. **Docs**: update `README.md` when what the owner does or sees changes; update the skills when a cockpit should behave differently.
6. **Commit** on `main`, one commit per change, message in the style of `git log` (a plain sentence saying what changed, no prefix). **Push only when the owner says so.**

## Several workers at once (code cockpit)

Each worker gets its own worktree on a branch (`isolated`):

```bash
git worktree add ../herdr-setup-<slug> -b cockpit/<slug>
```

- In a worktree, do steps 1–3, 5 and commit on the branch. **Never run `./install.sh` from a worktree**: it would link the skills and commands to that worktree and point the update check at it.
- When a worker is done, the cockpit rebases its branch onto `main` and fast-forwards `main` (stopping on conflicts for the owner), runs `./install.sh` from the main checkout, does step 4, and removes the worktree and branch.
- A worker that changes `claude/skills/*` changes nothing live until merged; say so in its report.

## Never

- Commit `.herdr/`, editor files Herdr writes into mods (`.gitignore` lists them), or anything under `~/.config/herdr-app` that `capture.sh` didn't bring in.
- Edit the owner's work projects or their scripts unless the task says so.
- Escape `|` inside a markdown table cell that holds a shell command; agents copy the backslash. Put such commands in a list instead.
