---
name: cockpit-panel
description: "Write structured markdown docs (PR review, PR summary, task ticket, ticket plan) into the Cockpit Panel beside you in Herdr, one tab of the panel per section of the doc. Use when the user asks to summarize or review a PR, write up a ticket, or plan a ticket and wants it in the panel, or says cockpit-panel, docs panel or md panel. Requires running inside Herdr (HC_TERMINAL_ID set)."
---

# Cockpit Panel

The user reads your work in the **Cockpit Panel**: a read-only markdown pane beside your terminal in the same Herdr tab. Every Herdr tab has its own docs, kept in `~/.herdr/docs/<herdr-tab-id>/`. A doc is made from a **kind**, a template set whose sections each show as a pill in the panel (a PR review has *Summary* and *Review feedback*). The panel reloads within a second of any write, and puts a dot on tabs that changed since the user last looked.

Helper: `~/.claude/skills/cockpit-panel/scripts/cockpit-panel` (call it `TD` below).

## 1. Check you're in Herdr

```bash
test -n "${HC_TERMINAL_ID:-}" && ~/.claude/skills/cockpit-panel/scripts/cockpit-panel where
```

If this fails, say you aren't running inside Herdr, and stop.

## 2. Pick a kind

```bash
~/.claude/skills/cockpit-panel/scripts/cockpit-panel kinds
```

This prints `id  title  [tabs]  description`. Pick the kind that fits the request:

| Request | Kind |
|---|---|
| Review someone's PR | `pr-review` |
| Describe your own or the current branch's PR | `pr-summary` |
| Write up a task / bug as a ticket | `task-ticket` |
| Plan how to implement a ticket | `ticket-plan` |

Ask the user only when no kind fits or two fit equally well. Don't invent kinds on the fly: if none fits, offer to add one (see section 6).

## 3. Create the doc

If a doc for the same subject already exists in this tab (`ls "$(TD where)"`), fill that one instead of creating another.

```bash
~/.claude/skills/cockpit-panel/scripts/cockpit-panel new <kind> <slug> "<title>"
```

- `slug`: lowercase letters, digits and dashes, e.g. `pr-1234-review`, `abc-123-plan`.
- `title`: what the panel shows, e.g. `PR #1234: Add webhook retry`.

This copies the templates into the doc, opens the panel to the right of your pane (only if this tab doesn't have one yet), and prints each tab's title and file path. If the user says they closed the panel and want it back: `TD open --force`.

## 4. Fill it

Each tab file is a skeleton. Every `<!-- agent: ... -->` comment says what goes in that section. Replace the comment with the content and keep the headings. The panel hides comments and shows "N sections still to fill" while any `<!-- agent:` comments remain, so remove every comment you've dealt with. If a section doesn't apply, write `None` or `n/a` rather than leaving the comment.

- Write with your normal file tools (Edit/Write) to the paths that `new` printed.
- Write each tab as soon as its content is ready. The user watches it fill, so don't hold everything until the end.
- Order matters when a tab depends on finished work. **pr-review:** write *Summary* first, right after reading the PR. Write *Review feedback* only once the review is done, and leave its first comment in place until then.
- Use `path:line` for code references, and keep the tone direct and concise.
- These are notes for the user. Never post anything (PR comments, ticket updates) yourself unless the user asks you to.

## 5. Finish

Tell the user in one or two lines which doc and tabs you filled (they can read the details in the panel). Don't paste the doc into chat.

## 6. Add or change a kind (only when the user asks)

Kinds live in `~/.config/herdr-mods/cockpit-panel/templates/<kind>/`:

- `kind.json`: `{ "title": "...", "description": "...", "tabs": [{ "id": "summary", "title": "Summary" }, ...] }`. The tab order is the pill order.
- `<tab-id>.md`: one per tab, with headings and `<!-- agent: ... -->` instructions. `{{title}}` is replaced with the doc title.

Existing docs keep their own copy of the tabs in `doc.json`, so editing a kind affects only new docs.

## Writing for a cockpit

If a cockpit's brief tells you to write a doc with `--into <tab-id>`, the doc belongs in the **cockpit's** panel, not yours:

- Always pass the `--into` and `--worker` values from the brief exactly: `cockpit-panel new <kind> <slug> "<title>" --into <tab-id> --worker <name>`.
- `--into` never opens a panel. Don't run `cockpit-panel open` yourself; the cockpit owns its panel.
- The content comes from the method the brief names (the repo's skill, agent or command). The template is only the format the owner reads it in.
- Put the doc slug in your COCKPIT-SUMMARY, and end your turn with the status block the brief asks for.

## Rules

- Write only inside this tab's docs folder (`TD where`), or the cockpit's when a brief gives `--into`, apart from kinds when the user asks.
- Never delete or rename docs you didn't create in this session.
- The panel is read-only. If the user wants a change, you make it in the `.md` file.
