// Review: a read-only look through a repo's git changes, as a tab, beside a terminal or as a dialog.
// props: {folder?, base?, scope?, overlay?}. Without a folder (the cmd-shift-r split, or the cmd-r
// dialog, mod.open with mod.json's overlay, which leaves focus on the terminal) it takes the focused
// terminal's when it starts, and keeps it; the scope and base picked are kept per folder, the
// branch picked only while it's open, so it opens on the checkout.
// Scopes: Uncommitted, Branch (a branch against its base; the header picks both, the checkout by
// default; a branch, origin's or local, or a worktree, whose uncommitted edits are included like the
// checkout's) and Commit (a branch's commits). Left: progress, the
// file tree grouped by status (GROUPS) with a Viewed check per file, and the commits (picking one shows just that commit).
// Right: every file's diff in one scroll; a viewed file folds to its header. Viewed marks are
// kept in ~/.herdr/reviews/, keyed by a hash of each file's diff, so a file whose diff changes
// comes back unviewed.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popover, InputState, Input } from "gpui-base";
import { spaces, panes, focused, props, exec, readTextFile, writeTextFile, watchFolder, theme, settings, home, checking, closeOverlay } from "herdr";
import { READ, CAP, WORKTREE, info, branches, worktrees, menuList, commits, changes, tree, hash, rows as fileRows } from "./git.js";

const TEXT = { badge: 10, label: 11.5, small: 12, body: 13 };
const ROW = 20;
const TREE_ROW = 26;
const MENU_ROW = 26;
const MENU_ROWS = 12; // a branch menu's height in rows
const HEADER = 32;
const LIST_MAX = 10000; // sizes a virtual list takes at most
const LEFT = 260;
const SCOPES = { uncommitted: "Uncommitted", branch: "Branch", commit: "Commit" };
const KEEP_DAYS = 30;
const STUCK = 45000; // a load running this long was ended by Herdr (see parsePatch)
const FETCH_TIMEOUT = 120000;
// The order files are listed and drawn in, by status: edits first, then what was only removed or added.
const GROUPS = [
  { status: "M", title: "Changed" },
  { status: "R", title: "Renamed" },
  { status: "D", title: "Deleted" },
  { status: "A", title: "New" },
];

const expand = (path) => (path?.startsWith("~/") ? `${home()}${path.slice(1)}` : path);
const basename = (path) => path.split("/").filter(Boolean).at(-1) ?? path;
const tilde = (path) => (path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path);
const markKey = (file) => `${file.path}\n${file.hash}`;
// New and deleted files: one row in the diff until opened, so hundreds of them don't bury the edits.
const folded = (file) => file.status === "A" || file.status === "D";
const clock = (ms) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const gitIn = (root, on) => (args) => exec("git", [...READ, ...args], { cwd: root, on });
// How long ago a branch was committed to, in the branch menus.
const age = (at) => {
  if (!at) return "";
  const s = Date.now() / 1000 - at;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 604800)}w`;
  return `${Math.floor(s / 31536000)}y`;
};

function parseStore(raw) {
  try {
    const data = JSON.parse(raw ?? "null");
    if (data && typeof data.viewed === "object") return data;
  } catch {
    // Mid-write or hand-edited: start over; the next save rewrites it.
  }
  return { viewed: {} };
}

export default class Review extends View {
  init(_props, cx) {
    this.list = VirtualListScrollHandle.new();
    this.files = [];
    this.treeRows = [];
    this.rows = [];
    this.sizes = [];
    this.index = {}; // path → its header's row
    this.commits = [];
    this.viewed = {};
    this.pending = new Map(); // marks not saved yet: key → time, or null to unmark
    this.open = new Set(); // paths of folded files opened in the diff
    this.commit = null;
    this.hide = localStorage.getItem("hide") === "1";
    // The open branch menu ("branch" or "base"): its search, every branch (read when it opens) and the ones matching.
    this.menu = null;
    this.branches = null;
    this.matches = [];
    this.menuList = VirtualListScrollHandle.new();
    this.search = InputState.new({ placeholder: "Search branches" });
    this.search.on("change", (_e, cx) => {
      this.filter();
      this.menuList.scroll_to_item(0, "top");
      cx.notify();
    });
    this.search.on("submit", (_e, cx) => {
      if (this.matches[0]) this.pick(this.menu, this.matches[0].key, cx);
    });
    if (checking()) return;
    this.origin = this.findOrigin();
    this.scope = this.remembered("scope") ?? props()?.scope;
    this.base = this.remembered("base"); // picked in the header; else props.base or the default
    this.target = null; // picked in the header (a ref or WORKTREE + folder); else the checkout
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  async close() {
    this.watched = null;
    this.watch?.cancel();
  }

  // localStorage is one per mod, not per copy: keyed by folder, so copies on other folders keep theirs.
  remembered(name) {
    return this.origin ? localStorage.getItem(`${name}:${this.origin.on ?? ""}:${this.origin.folder}`) : null;
  }

  remember(name, value) {
    if (this.origin) localStorage.setItem(`${name}:${this.origin.on ?? ""}:${this.origin.folder}`, value);
  }

  // props.folder, else the focused terminal's folder when this copy starts, or the tab's
  // terminal's when focus has already moved to this pane.
  findOrigin() {
    const p = props() ?? {};
    if (p.folder) return { folder: expand(p.folder), on: p.on ?? null };
    const f = focused();
    const all = panes();
    const own = all.find((x) => x.pane === f?.pane);
    const pane = own?.terminal ? own : all.find((x) => x.tab === f?.tab && x.terminal && x.cwd);
    const space = spaces().find((s) => s.active);
    const folder = pane?.cwd || f?.cwd || space?.folder;
    return folder ? { folder, on: space?.machine ?? null } : null;
  }

  watchRoot(root, cx) {
    if (this.origin.on || this.watched === root) return;
    this.watched = root;
    this.watch?.cancel();
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          this.watch = watchFolder(root);
          await this.watch;
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  }

  // One load at a time; a refresh asked for meanwhile runs once it's done. Loading shows only
  // until a view's first load ends (this.shown), so loads in the background never hide it.
  // A task Herdr ends runs neither catch nor finally: past STUCK, the next refresh starts over.
  refresh(cx) {
    if (this.loading && Date.now() - this.loading < STUCK) {
      this.again = true;
      return;
    }
    if (this.loading) this.fail("Review stopped loading", "Herdr ended the last load before it finished; trying again.");
    const run = (this.run ?? 0) + 1;
    Object.assign(this, { run, loading: Date.now(), again: false });
    const view = this.view();
    cx.spawn(async (cx) => {
      try {
        await this.load(cx);
      } catch (e) {
        if (view === this.view()) this.fail("Git failed", String(e?.message ?? e));
      } finally {
        if (run !== this.run) return;
        this.loading = false;
        this.layout();
        cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  view() {
    return `${this.scope}:${this.commit ?? ""}:${this.base ?? ""}:${this.target ?? ""}`;
  }

  fail(title, ...lines) {
    Object.assign(this, { error: { title, lines }, files: [], big: null, shown: this.view() });
  }

  async load(cx) {
    const origin = this.origin;
    if (!origin) return;
    const view = this.view();
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: origin.folder, on: origin.on }).catch((e) => ({ code: null, stderr: String(e?.message ?? e) }));
    if (top.code !== 0) {
      const why = (top.stderr || top.stdout || "").trim();
      this.root = null;
      if (top.code === null) this.fail("Can't open this folder", why);
      else if (/not a git repository/i.test(why)) this.fail("Not a git repository", "Review shows a git repository's changes; open it in a terminal inside one.", why);
      else this.fail("Git failed", why || `git rev-parse failed (exit ${top.code})`);
      return;
    }
    const root = top.stdout.trim();
    const on = origin.on;
    const git = gitIn(root, on);
    const read = (path) => readTextFile(`${root}/${path}`, { on });
    const pause = () => cx.sleep(0);
    const repo = await info(git, root, props()?.base, this.base, this.target);
    const scope = this.scope in SCOPES ? this.scope : repo.target && repo.base && (repo.ahead > 0 || repo.target.branch !== repo.base.name.replace(/^origin\//, "")) ? "branch" : "uncommitted";
    // The work tree reviewed: a picked worktree's, else the checkout's. Commits are read here,
    // in the one object store every worktree shares.
    const dir = repo.target?.dir ?? root;
    const work = gitIn(dir, on);
    const readWork = (path) => readTextFile(`${dir}/${path}`, { on });
    const tip = repo.target?.rev;

    let list = [];
    if (scope === "branch" && repo.mergeBase) list = await commits(git, [`${repo.mergeBase}..${tip}`]);
    if (scope === "commit" && tip) list = await commits(git, ["-n", "30", tip]);
    let sha = list.some((c) => c.sha === this.commit) ? this.commit : null;
    if (scope === "commit") sha ??= list[0]?.sha ?? null;
    let result = { files: [], limited: false, big: null };
    if (sha) result = await changes(git, read, { sha }, pause);
    else if (scope === "uncommitted") result = await changes(work, readWork, { from: repo.live ? tip : repo.head }, pause);
    // A branch checked out in no folder picked: its committed tree only, nothing checked out or written.
    else if (scope === "branch" && repo.mergeBase) result = repo.live ? await changes(work, readWork, { from: repo.mergeBase }, pause) : await changes(git, read, { from: repo.mergeBase, to: tip }, pause);

    const store = `${home()}/.herdr/reviews/${basename(root)}-${hash(`${on ?? ""}:${root}`)}.json`;
    const marks = parseStore(await readTextFile(store).catch(() => null)).viewed;
    for (const [k, at] of this.pending) at ? (marks[k] = at) : delete marks[k];

    if (view !== this.view()) {
      this.again = true; // the scope or commit changed meanwhile
      return;
    }
    Object.assign(this, { root, dir, repo, scope, commit: sha, store, error: null, limited: result.limited, big: result.big, commits: list, viewed: marks });
    const ordered = tree(result.files)
      .filter((r) => r.kind === "file")
      .map((r) => r.file);
    this.files = GROUPS.flatMap((g) => ordered.filter((f) => f.status === g.status));
    this.shown = this.view();
    this.watchRoot(dir, cx);
  }

  seen(file) {
    return Boolean(this.viewed[markKey(file)]);
  }

  // The files the progress counts and Viewed jumps through: the changed and renamed ones, or all when there are none.
  counted() {
    const edits = this.files.filter((f) => f.status === "M" || f.status === "R");
    return edits.length ? edits : this.files;
  }

  // The rows the diff list draws and their heights, the tree, and the width the longest line needs.
  // Past LIST_MAX rows, lines go in chunks of `per`, one list item each; a file's last chunk
  // may be partial, so the budget leaves one item per file for it besides its header.
  layout() {
    const rows = [];
    const sizes = [];
    let widest = 0;
    this.index = {};
    const shown = this.files.filter((f) => !(this.hide && this.seen(f)));
    const bodies = shown.map((file) => {
      if (folded(file) ? !this.open.has(file.path) : this.seen(file)) return null;
      // A new or deleted file's hunk header only repeats its line count.
      const lines = fileRows(file).map((row, i) => ({ key: `${file.path}:${i}`, ...row, quiet: file.status === "A" })).filter((r) => !(folded(file) && r.kind === "@"));
      if (file.note) lines.push({ key: `${file.path}:note`, kind: "note", text: file.note });
      if (file.more) lines.push({ key: `${file.path}:more`, kind: "note", text: `… ${file.more} more lines not shown` });
      return lines;
    });
    const total = bodies.reduce((n, lines) => n + (lines?.length ?? 0), 0);
    const per = Math.max(1, Math.ceil(total / (LIST_MAX - 2 * shown.length)));
    for (const [n, file] of shown.entries()) {
      this.index[file.path] = rows.length;
      rows.push({ key: `f:${file.path}`, file, seen: this.seen(file), open: Boolean(bodies[n]) });
      sizes.push(HEADER);
      const lines = bodies[n];
      if (!lines) continue;
      for (let i = 0; i < lines.length; i += per) {
        rows.push(per === 1 ? lines[i] : { key: `${lines[i].key}+`, lines: lines.slice(i, i + per) });
        sizes.push(ROW * Math.min(per, lines.length - i));
      }
      widest = Math.max(widest, file.width);
    }
    this.rows = rows;
    this.sizes = sizes;
    this.diffWidth = Math.max(300, Math.ceil((widest + 1) * 7.3) + 110);
    const listed = this.hide ? this.files.filter((f) => !this.seen(f)) : this.files;
    this.treeRows = GROUPS.flatMap((g) => {
      const files = listed.filter((f) => f.status === g.status);
      const count = this.files.filter((f) => f.status === g.status).length;
      return files.length ? [{ kind: "group", name: g.title, count }, ...tree(files)] : [];
    }).map((r, i) => ({ ...r, key: r.kind === "file" ? `f:${r.file.path}` : `${r.kind}:${i}` }));
  }

  // From a file's header (jump: on to the next unviewed file) or from its check in the tree.
  toggle(file, jump, cx) {
    const key = markKey(file);
    const on = !this.viewed[key];
    const at = on ? new Date().toISOString() : null;
    if (on) this.viewed[key] = at;
    else delete this.viewed[key];
    if (on) this.open.delete(file.path);
    this.pending.set(key, at);
    this.layout();
    if (jump) {
      const list = this.counted();
      const i = list.indexOf(file);
      const next = on ? [...list.slice(i + 1), ...list.slice(0, i)].find((f) => !this.seen(f)) : file;
      if (next && this.index[next.path] !== undefined) this.list.scroll_to_item(this.index[next.path], "top");
    }
    this.save(cx);
    cx.notify();
  }

  // Merged into what's on disk, so two Reviews of one repo don't undo each other's marks.
  save(cx) {
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    const path = this.store;
    if (!path) return;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", path.slice(0, path.lastIndexOf("/"))]);
        for (let tries = 0; tries < 3 && this.pending.size; tries++) {
          const raw = await readTextFile(path).catch(() => null);
          const data = parseStore(raw);
          const sent = new Map(this.pending);
          for (const [k, at] of sent) at ? (data.viewed[k] = at) : delete data.viewed[k];
          const cutoff = Date.now() - KEEP_DAYS * 86400000;
          for (const [k, at] of Object.entries(data.viewed)) if (!(Date.parse(at) > cutoff)) delete data.viewed[k];
          const ok = await writeTextFile(path, `${JSON.stringify(data, null, 1)}\n`, raw).then(
            () => true,
            () => false,
          );
          if (ok) for (const [k, at] of sent) if (this.pending.get(k) === at) this.pending.delete(k);
        }
      } finally {
        this.saving = false;
        if (this.saveAgain) {
          this.saveAgain = false;
          this.save(cx);
        }
      }
    });
  }

  pickScope(scope, cx) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.commit = null;
    this.remember("scope", scope);
    this.reset(cx);
  }

  // Opening reads the branches afresh and puts the keyboard in the search; closing clears it.
  // One menu's close can come after the other's open, so it only closes its own.
  setMenu(kind, open, cx) {
    if (!open && this.menu !== kind) return;
    this.menu = open ? kind : null;
    this.search.set_value("");
    this.branches = null;
    this.filter();
    if (open) {
      this.search.focus();
      this.loadBranches(kind, cx);
    }
    cx.notify();
  }

  // Refs first, then worktrees (slow to read in a repo with many). The branch menu tops the list
  // with the checkout and the pick; the base menu with the default and the base, leaving out the
  // branch under review.
  loadBranches(kind, cx) {
    const { root, repo } = this;
    if (!root || !repo) return;
    const run = (this.branchRun ?? 0) + 1;
    this.branchRun = run;
    const [first, skip] = kind === "branch" ? [[`${WORKTREE}${root}`, repo.branch, repo.target?.key], null] : [[repo.fallback, repo.base?.key], repo.target?.key ?? repo.branch];
    const git = gitIn(root, this.origin.on);
    cx.spawn(async (cx) => {
      const refs = await branches(git).catch(() => []);
      if (run !== this.branchRun) return;
      Object.assign(this, { branches: menuList([refs], first, skip), readingTrees: true });
      this.filter();
      cx.notify();
      const trees = await worktrees(git).catch(() => []);
      if (run !== this.branchRun) return;
      Object.assign(this, { branches: menuList([refs, trees], first, skip), readingTrees: false });
      this.filter();
      cx.notify();
    });
  }

  // Case-insensitive, anywhere in the name; at most LIST_MAX, what a virtual list takes.
  filter() {
    const q = this.search.value().trim().toLowerCase();
    const all = this.branches ?? [];
    const found = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
    this.matchCount = found.length;
    this.matches = found.slice(0, LIST_MAX);
  }

  // git fetch --prune origin, then the menu's list and the diff again (the base may have moved).
  fetch(cx) {
    const root = this.root;
    if (!root || this.fetching?.state === "running") return;
    this.fetching = { state: "running" };
    cx.notify();
    cx.spawn(async (cx) => {
      // No terminal to answer a password prompt in: fail with git's message instead of waiting.
      const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "git", "fetch", "--prune", "origin"], { cwd: root, on: this.origin.on, timeout: FETCH_TIMEOUT }).catch((e) => ({ code: null, stderr: String(e?.message ?? e) }));
      const why = (r.stderr || r.stdout || "").trim();
      this.fetching = r.code === 0 ? { state: "done", at: Date.now() } : { state: "failed", text: why || `git fetch failed (exit ${r.code})` };
      if (this.menu) this.loadBranches(this.menu, cx);
      this.refresh(cx);
      cx.notify();
    });
  }

  pick(kind, name, cx) {
    if (kind === "branch") this.pickBranch(name, cx);
    else this.pickBase(name, cx);
  }

  pickBase(base, cx) {
    this.setMenu("base", false, cx);
    if (base === this.repo?.base?.key) return;
    this.base = base;
    this.commit = null;
    this.remember("base", base);
    this.reset(cx);
  }

  // The checkout is kept as no pick, so the view follows it when the folder checks out another branch.
  pickBranch(key, cx) {
    this.setMenu("branch", false, cx);
    const own = key === `${WORKTREE}${this.root}` || key === this.repo?.branch;
    const target = own ? null : key;
    if (target === this.target) return;
    this.target = target;
    this.commit = null;
    this.reset(cx);
  }

  pickCommit(sha, cx) {
    if (sha === this.commit) return;
    this.commit = sha;
    this.reset(cx);
  }

  reset(cx) {
    this.files = [];
    this.big = null;
    this.commits = this.scope === "uncommitted" ? [] : this.commits;
    this.layout();
    this.list.scroll_to_item(0, "top");
    this.refresh(cx);
    cx.notify();
  }

  checkbox(on, t) {
    return div()
      .flex_none()
      .size(14)
      .rounded(4)
      .flex()
      .items_center()
      .justify_center()
      .text_size(TEXT.badge)
      .when(on, (el) => el.bg(t.ansi2).text_color(t.background).child("✓"))
      .when(!on, (el) => el.border_1().border_color(t.input));
  }

  stat(file, t) {
    return h_flex()
      .flex_none()
      .gap(6)
      .text_size(TEXT.label)
      .when(file.add > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${file.del}`)));
  }

  // In place of a new or deleted file's +/− count: what it is and how long.
  badge(file, t) {
    const color = file.status === "A" ? t.ansi2 : t.ansi1;
    const n = file.status === "A" ? file.add : file.del;
    const label = file.status === "A" ? "New" : "Deleted";
    return div()
      .flex_none()
      .px(6)
      .rounded(4)
      .bg(`${color}20`)
      .text_size(TEXT.badge)
      .font_semibold()
      .text_color(color)
      .child(file.note ? label : `${label} · ${n} line${n === 1 ? "" : "s"}`);
  }

  statusColor(status, t) {
    return { A: t.ansi2, D: t.ansi1, R: t.accent }[status] ?? t.working;
  }

  // The branch under review or its base, and a menu of every branch to pick from: a search, the
  // matches, and Fetch. The list is virtual (a repo can have thousands), so a click comes
  // through on_item_click.
  picker(kind, repo, t) {
    const checkout = (b) => b.key === `${WORKTREE}${this.root}` || b.key === repo.branch;
    const [current, label, tagged, tag] =
      kind === "branch"
        ? [(b) => (repo.target.key ? b.key === repo.target.key : checkout(b)), repo.target.name, checkout, "checked out"]
        : [(b) => b.key === repo.base.key, repo.base.name, (b) => b.key === repo.fallback, "default"];
    const option = (b, i) =>
      h_flex()
        .h(MENU_ROW)
        .flex_none()
        .pl(8)
        .pr(14) // clear of the scrollbar
        .gap(8)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(current(b), (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!current(b), (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .child(div().flex_1().min_w(0).truncate().child(b.name))
        .when(i === 0 && Boolean(this.search.value().trim()), (el) => el.child(div().flex_none().text_size(TEXT.badge).text_color(t.dim).child("↵")))
        .when(tagged(b) || Boolean(b.tree), (el) => el.child(div().flex_none().text_size(TEXT.badge).text_color(t.dim).child(tagged(b) ? tag : "worktree")))
        .child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child(age(b.at)));
    const matches = this.matches;
    const note = (text) => div().px(8).py(6).text_color(t.dim).child(text);
    const list = !this.branches
      ? note("Loading branches…")
      : !matches.length
        ? note(this.branches.length ? "No branch matches" : "No branches")
        : div()
            .flex_none()
            .h(Math.min(matches.length, MENU_ROWS) * MENU_ROW)
            .relative()
            .child(
              v_virtual_list(
                `review-${kind}-list`,
                matches.length,
                matches.map(() => MENU_ROW),
                (i) => `b:${matches[i].key}`,
                (range) => matches.slice(range.start, range.end).map((b, k) => option(b, range.start + k)),
              )
                .track_scroll(this.menuList)
                .on_item_click((key, cx) => this.pick(kind, key.slice(2), cx))
                .size_full(),
            )
            .child(Scrollbar.vertical(`review-${kind}-list`).viewport_from_layout().absolute().inset_0());
    const f = this.fetching;
    const fetched = !f ? null : f.state === "running" ? "Fetching origin…" : f.state === "done" ? `Fetched at ${clock(f.at)}` : null;
    const reading = this.branches && this.readingTrees ? "Reading worktrees…" : null;
    const footer = v_flex()
      .gap(4)
      .pt(5)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .id(`${kind}-fetch`)
              .flex_none()
              .h(24)
              .px(8)
              .flex()
              .items_center()
              .rounded(6)
              .when(f?.state === "running", (el) => el.text_color(t.dim))
              .when(f?.state !== "running", (el) => el.cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.fetch(cx)))
              .tooltip("git fetch --prune origin")
              .child("Fetch"),
          )
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).text_color(t.dim).child(fetched ?? reading ?? (matches.length < this.matchCount ? `First ${matches.length} of ${this.matchCount}` : ""))),
      )
      .when(f?.state === "failed", (el) =>
        el.child(
          v_flex()
            .px(8)
            .pb(3)
            .text_size(TEXT.label)
            .text_color(t.ansi1)
            .children(f.text.split("\n").filter((l) => l.trim()).map((l) => div().child(l))),
        ),
      );
    const trigger = h_flex()
      .id(`${kind}-trigger`)
      .min_w(0)
      .h(22)
      .px(6)
      .gap(4)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .text_size(TEXT.small)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(kind === "branch", (el) => el.text_color(t.foreground))
      .child(div().min_w(0).truncate().child(label))
      .child(div().flex_none().text_size(TEXT.badge).text_color(t.dim).child("▾"));
    return Popover.new(`review-${kind}`)
      .open(this.menu === kind)
      .on_open_change((open, cx) => this.setMenu(kind, open, cx))
      .trigger(trigger)
      .content(
        v_flex()
          .w(340)
          .p(5)
          .gap(5)
          .rounded(7)
          .border_1()
          .border_color(t.border)
          .bg(t.popover)
          .text_size(TEXT.small)
          .child(div().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).child(Input.new(this.search).h(26).w_full().text_color(t.foreground)))
          .child(list)
          .child(footer),
      );
  }

  header(t) {
    const repo = this.repo;
    const add = this.big?.add ?? this.files.reduce((n, f) => n + f.add, 0);
    const del = this.big?.del ?? this.files.reduce((n, f) => n + f.del, 0);
    const count = this.big?.files ?? this.files.length;
    const folder = this.dir ?? this.root ?? this.origin?.folder;
    const pill = (scope) => {
      const picked = this.scope === scope;
      const off = scope === "branch" ? !repo?.base : scope === "commit" ? !repo?.target : false;
      return div()
        .id(`scope-${scope}`)
        .px(10)
        .h(24)
        .flex()
        .items_center()
        .rounded(6)
        .text_size(TEXT.small)
        .font_medium()
        .when(picked, (el) => el.bg(t.background).border_1().border_color(t.border).text_color(t.foreground))
        .when(!picked && !off, (el) => el.cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .when(off, (el) => el.text_color(t.dim).tooltip(scope === "branch" ? "No base branch here (main, master or origin/HEAD); open it with review --base <branch>" : "No commits yet"))
        .when(!off, (el) => el.on_click((_e, cx) => this.pickScope(scope, cx)))
        .child(SCOPES[scope]);
    };
    return h_flex()
      .flex_none()
      .h(42)
      .px(14)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().font_semibold().child(this.root ? basename(this.root) : "Review"))
      .when(Boolean(repo), (el) =>
        el
          .when(this.scope === "uncommitted" || !repo.target, (row) =>
            row.child(div().min_w(0).truncate().text_size(TEXT.small).text_color(t.foreground).child(repo.live ? repo.target.name : (repo.branch ?? repo.head?.slice(0, 7) ?? "no commits"))),
          )
          .when(this.scope !== "uncommitted" && Boolean(repo.target), (row) => row.child(this.picker("branch", repo, t)))
          .when(this.scope === "branch" && Boolean(repo.base), (row) =>
            row
              .child(div().text_size(TEXT.small).text_color(t.dim).child("→"))
              .child(this.picker("base", repo, t))
              .child(div().flex_none().text_size(TEXT.label).text_color(repo.ahead ? t.ansi2 : t.dim).child(`↑${repo.ahead}`))
              .child(div().flex_none().text_size(TEXT.label).text_color(repo.behind ? t.working : t.dim).child(`↓${repo.behind}`))
              .when(!repo.live, (r) => r.child(this.hint("review-committed", "committed only", `${repo.target.name} isn't checked out here, so uncommitted edits aren't included; pick its worktree to include them`, t)))
              .when(Boolean(repo.base.dir), (r) => r.child(this.hint("review-base-committed", "base: committed only", `Compares with the commit ${repo.base.name} has checked out; uncommitted edits there aren't included`, t))),
          ),
      )
      .child(div().id("review-folder").flex_1().min_w(0).truncate().text_size(TEXT.label).text_color(t.dim).when(Boolean(folder), (el) => el.tooltip(folder).child(tilde(folder))))
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised).children(Object.keys(SCOPES).map(pill)))
      .child(
        h_flex()
          .flex_none()
          .gap(6)
          .text_size(TEXT.label)
          .child(div().text_color(t.ansi2).child(`+${add}`))
          .child(div().text_color(t.ansi1).child(`−${del}`))
          .child(div().text_color(t.dim).child(`· ${count} file${count === 1 ? "" : "s"}`)),
      )
      .when(Boolean(props()?.overlay), (el) =>
        el.child(
          div()
            .id("review-close")
            .flex_none()
            .size(24)
            .flex()
            .items_center()
            .justify_center()
            .rounded(6)
            .cursor_pointer()
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Close (Esc)")
            .on_click(() => closeOverlay(props().overlay))
            .child("✕"),
        ),
      );
  }

  hint(id, text, tip, t) {
    return div().id(id).flex_none().text_size(TEXT.label).text_color(t.dim).tooltip(tip).child(text);
  }

  // Under the header: when the branch adds nothing to its base, and when a local branch picked
  // is behind origin's copy (a stale base drags in what it's missing), with the switch to origin's.
  notices(t) {
    const repo = this.repo;
    if (!repo || this.scope === "uncommitted" || this.shown !== this.view() || this.error) return null;
    const notes = [];
    const button = (id, text, tip, onClick) =>
      div()
        .id(id)
        .flex_none()
        .px(8)
        .h(20)
        .flex()
        .items_center()
        .rounded(5)
        .border_1()
        .border_color(t.border)
        .cursor_pointer()
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_click(onClick)
        .child(text);
    const note = (key, color, text, action) => notes.push(h_flex().id(key).gap(10).items_center().child(div().min_w(0).truncate().text_color(color).child(text)).when(Boolean(action), (el) => el.child(action)));
    const branch = this.scope === "branch";
    if (branch && repo.mergeBase && !repo.ahead && !this.commit && (this.files.length || this.big))
      note("note-merged", t.foreground, `All of ${repo.target.name} is already in ${repo.base.name}; only uncommitted changes are left.`);
    const behind = ({ branch, n }) => `Local ${branch} is ${n} commit${n === 1 ? "" : "s"} behind origin.`;
    if (branch && repo.stale.base) {
      const to = `origin/${repo.stale.base.branch}`;
      note("note-base", t.working, behind(repo.stale.base), button("use-origin-base", `Use ${to}`, `Compare with ${to} instead`, (_e, cx) => this.pickBase(to, cx)));
    }
    if (repo.stale.target) {
      const to = `origin/${repo.stale.target.branch}`;
      const tip = repo.live ? `Review ${to}: its commits only, without the uncommitted edits in ${basename(this.dir)}` : `Review ${to} instead`;
      note("note-branch", t.working, behind(repo.stale.target), button("use-origin-branch", `Use ${to}`, tip, (_e, cx) => this.pickBranch(to, cx)));
    }
    if (!notes.length) return null;
    return v_flex().flex_none().px(14).py(6).gap(4).border_b(1).border_color(t.border).bg(t.raised).text_size(TEXT.small).children(notes);
  }

  progress(t) {
    const counted = this.counted();
    const done = counted.filter((f) => this.seen(f)).length;
    const total = counted.length;
    return v_flex()
      .flex_none()
      .px(12)
      .pt(12)
      .pb(10)
      .gap(7)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(4)
              .child(div().font_medium().child(`${done} / ${total}`))
              .child(div().text_size(TEXT.label).text_color(t.dim).child("viewed")),
          )
          .child(
            h_flex()
              .id("hide-viewed")
              .gap(6)
              .items_center()
              .cursor_pointer()
              .text_size(TEXT.label)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                this.hide = !this.hide;
                localStorage.setItem("hide", this.hide ? "1" : "0");
                this.layout();
                cx.notify();
              })
              .child("Hide viewed")
              .child(this.checkbox(this.hide, t)),
          ),
      )
      .child(
        div()
          .h(4)
          .rounded(2)
          .bg(t.raised)
          .child(div().h_full().w(total ? ((LEFT - 24) * done) / total : 0).rounded(2).bg(t.ansi2)),
      );
  }

  // A virtual list: a branch's tree runs to well over a thousand rows, more than one render
  // gets done in before Herdr ends it. Its rows can't hold handlers, so where the press landed
  // (pressX) tells a click on a file's check from one on the rest of its row.
  treeView(t) {
    const row = (r) => {
      if (r.kind === "group")
        return h_flex()
          .h(TREE_ROW)
          .flex_none()
          .px(6)
          .pt(4)
          .items_center()
          .justify_between()
          .text_size(TEXT.badge)
          .font_medium()
          .text_color(t.dim)
          .child(r.name.toUpperCase())
          .child(String(r.count));
      const indent = h_flex().h(TREE_ROW).flex_none().gap(7).items_center().pl(6 + r.depth * 14).pr(6).rounded(6);
      if (r.kind === "dir") return indent.text_color(t.muted).child(div().min_w(0).truncate().child(r.name));
      const f = r.file;
      const seen = this.seen(f);
      return indent
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .child(this.checkbox(seen, t))
        .child(div().flex_none().w(10).text_size(TEXT.label).text_color(this.statusColor(f.status, t)).child(f.status))
        .child(div().flex_1().min_w(0).truncate().text_color(seen ? t.muted : t.foreground).child(r.name))
        .child(this.stat(f, t));
    };
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            div()
              .id("review-tree-area")
              .size_full()
              .px(6)
              .text_size(TEXT.small)
              .on_mouse_down("left", (e) => {
                this.pressX = e.local_position?.x ?? null;
              })
              .child(
                v_virtual_list(
                  "review-tree",
                  this.treeRows.length,
                  this.treeRows.map(() => TREE_ROW),
                  (i) => this.treeRows[i].key,
                  (range) => this.treeRows.slice(range.start, range.end).map(row),
                )
                  .on_item_click((key, cx) => this.clickTree(key, cx))
                  .size_full(),
              ),
          )
          .child(Scrollbar.vertical("review-tree").viewport_from_layout().absolute().inset_0()),
      )
      .when(Boolean(this.limited), (el) => el.child(div().flex_none().p(12).text_size(TEXT.label).text_color(t.dim).child("Showing the first 1,000 changed files")));
  }

  // A file's check (6 px of list padding and 6 of row padding in, 14 wide, a little slack) toggles
  // Viewed; the rest of its row jumps to its diff, opening a new or deleted one.
  clickTree(key, cx) {
    const r = this.treeRows.find((x) => x.key === key);
    if (r?.kind !== "file") return;
    const f = r.file;
    const x = (this.pressX ?? -100) - 12 - r.depth * 14;
    if (x >= -4 && x <= 18) return this.toggle(f, false, cx);
    if (folded(f) && !this.open.has(f.path)) {
      this.open.add(f.path);
      this.layout();
    }
    if (this.index[f.path] !== undefined) this.list.scroll_to_item(this.index[f.path], "top");
    cx.notify();
  }

  commitList(t) {
    if (this.scope === "uncommitted" || !this.commits.length) return null;
    const row = (id, sha, picked, children) =>
      h_flex()
        .id(id)
        .flex_none()
        .h(26)
        .px(6)
        .gap(8)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(picked, (el) => el.bg(t.selected))
        .when(!picked, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pickCommit(sha, cx))
        .child(
          div()
            .flex_none()
            .size(10)
            .rounded(5)
            .when(picked, (el) => el.border(3).border_color(t.accent))
            .when(!picked, (el) => el.border_1().border_color(t.input)),
        )
        .children(children);
    const rows = this.commits.map((c) =>
      row(`commit-${c.sha}`, c.sha, this.commit === c.sha, [
        div().flex_none().text_size(TEXT.label).text_color(t.dim).child(c.short),
        div().flex_1().min_w(0).truncate().text_color(this.commit === c.sha ? t.foreground : t.muted).child(c.subject),
      ]),
    );
    if (this.scope === "branch")
      rows.unshift(
        row("commit-all", null, !this.commit, [
          div().flex_1().text_color(this.commit ? t.muted : t.foreground).child(this.repo.live ? "All, with uncommitted" : "All"),
          div().flex_none().text_size(TEXT.label).text_color(t.dim).child(String(this.commits.length)),
        ]),
      );
    return v_flex()
      .flex_none()
      .max_h(240)
      .border_t(1)
      .border_color(t.border)
      .child(
        div()
          .flex_none()
          .px(12)
          .pt(10)
          .pb(4)
          .text_size(TEXT.badge)
          .font_medium()
          .text_color(t.dim)
          .child(this.scope !== "branch" ? "RECENT COMMITS" : this.repo.ahead > this.commits.length ? `COMMITS · LATEST ${this.commits.length} OF ${this.repo.ahead}` : "COMMITS"),
      )
      .child(v_flex().id("review-commits").flex_1().min_h(0).px(6).pb(8).overflow_y_scrollbar().text_size(TEXT.small).children(rows));
  }

  // One row of the diff list. No handlers in here (gpui runs it during layout): clicks go
  // through the list's on_item_click, so a file header is one target.
  diffRow(row, t, mono) {
    if (row.file) {
      const f = row.file;
      const parts = f.path.split("/");
      const name = parts.pop();
      return h_flex()
        .w_full()
        .h(HEADER)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .bg(t.chrome)
        .border_t(1)
        .border_b(1)
        .border_color(t.border)
        .text_size(TEXT.small)
        .child(div().flex_none().w(10).text_size(TEXT.badge).text_color(t.dim).child(row.open ? "▾" : "▸"))
        .when(!folded(f), (el) => el.child(this.checkbox(row.seen, t)))
        .child(div().flex_none().w(10).text_size(TEXT.label).text_color(this.statusColor(f.status, t)).child(f.status))
        .child(
          h_flex()
            .flex_none()
            .when(f.status === "D", (el) => el.line_through())
            .child(div().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
            .child(div().font_medium().text_color(row.seen || f.status === "D" ? t.muted : t.foreground).child(name)),
        )
        .when(Boolean(f.from), (el) => el.child(div().flex_none().text_color(t.dim).child(`← ${f.from}`)))
        .child(folded(f) ? this.badge(f, t) : this.stat(f, t))
        .when(row.seen, (el) => el.child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child("Viewed")))
        .when(folded(f), (el) => el.child(div().flex_1()).child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child(row.open ? "Hide" : "Show")));
    }
    if (row.lines) return v_flex().w_full().flex_none().children(row.lines.map((l) => this.diffRow(l, t, mono)));
    const line = h_flex().w_full().h(ROW).flex_none().font_family(mono).text_size(TEXT.small);
    if (row.kind === "@") return line.px(12).bg(t.raised).text_color(t.dim).child(div().truncate().child(row.text));
    if (row.kind === "note" || row.kind === "") return line.px(12).text_color(t.dim).child(row.text);
    const number = (n) => div().w(44).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    if (row.quiet) return line.child(number(row.new)).child(div().flex_1().min_w(0).truncate().pl(8).child(row.text));
    const tint = row.words ? "0c" : "18"; // a line paired with its replacement leaves the color to its changed words
    return line
      .when(row.kind === "+", (el) => el.bg(`${t.ansi2}${tint}`))
      .when(row.kind === "-", (el) => el.bg(`${t.ansi1}${tint}`))
      .child(number(row.old))
      .child(number(row.new))
      .child(div().w(16).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
      .child(row.words ? this.words(row, t) : div().flex_1().min_w(0).truncate().child(row.text));
  }

  // A paired line's text in spans, the words that differ from its pair strongly tinted.
  words(row, t) {
    const strong = `${row.kind === "+" ? t.ansi2 : t.ansi1}50`;
    const span = (from, to) => div().flex_none().whitespace_nowrap().child(row.text.slice(from, to));
    const spans = [];
    let at = 0;
    for (const [from, to] of row.words) {
      if (from > at) spans.push(span(at, from));
      spans.push(span(from, to).rounded(2).bg(strong));
      at = to;
    }
    if (at < row.text.length) spans.push(span(at));
    return h_flex().flex_1().min_w(0).overflow_hidden().children(spans);
  }

  // A changed or renamed file's header marks it viewed; a new or deleted one's opens or closes it.
  clickRow(key, cx) {
    if (!key.startsWith("f:")) return;
    const file = this.files.find((f) => f.path === key.slice(2));
    if (!file) return;
    if (!folded(file)) return this.toggle(file, true, cx);
    if (!this.open.delete(file.path)) this.open.add(file.path);
    this.layout();
    cx.notify();
  }

  empty(t, title, ...lines) {
    return v_flex()
      .flex_1()
      .min_w(0)
      .items_center()
      .justify_center()
      .gap(6)
      .p(24)
      .child(div().text_size(TEXT.body).text_color(t.foreground).text_center().child(title))
      .children(lines.filter(Boolean).map((line) => div().max_w_full().text_size(TEXT.small).text_color(t.dim).text_center().child(line)));
  }

  // A view too big to load: its counts, and what to look at instead.
  tooBig(t) {
    const { files, add, del } = this.big;
    const what = `${files} files, +${add} −${del}`;
    if (this.scope === "branch" && !this.commit) return this.empty(t, `Too big to show: ${what}`, `Against ${this.repo.base.name}, ${this.repo.ahead} commits. Pick another branch or base above, or one commit on the left.`);
    if (this.scope === "uncommitted") return this.empty(t, `Too many uncommitted changes to show: ${what}`, `Review loads up to ${CAP.changed} changed lines.`);
    return this.empty(t, `This commit is too big to show: ${what}`, "Pick another commit on the left.");
  }

  diffView(t) {
    const repo = this.repo;
    if (!this.origin) return this.empty(t, "No folder", "Open Review from a terminal, or with props { folder }.");
    if (this.shown !== this.view()) return this.empty(t, "Loading changes…");
    if (this.error) return this.empty(t, this.error.title, ...this.error.lines);
    if (this.scope === "branch" && !repo?.base) return this.empty(t, "No base branch", "Neither origin/HEAD, main nor master is here. Open it with: review --base <branch>");
    if (this.scope === "branch" && repo.target && !repo.mergeBase) return this.empty(t, `No history in common with ${repo.base.name}`, "Pick another branch or base above, or open it with: review --base <branch>");
    if (this.big) return this.tooBig(t);
    if (!this.files.length) {
      if (this.scope === "uncommitted") return this.empty(t, "No uncommitted changes", "Try Branch or Commit above.");
      if (this.scope === "branch" && !repo.ahead && !this.commit) return this.empty(t, `All of ${repo.target.name} is already in ${repo.base.name}`, repo.live ? "Nothing uncommitted either." : "Pick another branch or base above.");
      if (this.scope === "branch") return this.empty(t, `Nothing on ${repo.target.name} against ${repo.base.name} yet`, "Pick another branch or base above.");
      return this.empty(t, this.commit ? "No changes in this commit" : "No commits yet");
    }
    if (!this.rows.length) return this.empty(t, "Every file is viewed", "Turn off Hide viewed to see them again.");
    const mono = settings().font_family ?? "JetBrains Mono";
    return div()
      .flex_1()
      .min_w(0)
      .h_full()
      .relative()
      .child(
        div()
          .id("review-diff-x")
          .size_full()
          .overflow_x_scrollbar()
          .child(
            div()
              .w_full()
              .min_w(this.diffWidth)
              .h_full()
              .child(
                v_virtual_list(
                  "review-diff",
                  this.rows.length,
                  this.sizes,
                  (i) => this.rows[i].key,
                  (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, mono)),
                )
                  .track_scroll(this.list)
                  .on_item_click((key, cx) => this.clickRow(key, cx))
                  .size_full(),
              ),
          ),
      )
      .child(Scrollbar.vertical("review-diff").viewport_from_layout().absolute().inset_0());
  }

  render() {
    const t = theme();
    const commits = this.commitList(t);
    const notices = this.notices(t);
    return v_flex()
      .id("review")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(TEXT.body)
      .child(this.header(t))
      .when(Boolean(notices), (el) => el.child(notices))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .flex_none()
              .w(LEFT)
              .h_full()
              .min_h(0)
              .border_r(1)
              .border_color(t.border)
              .child(this.progress(t))
              .child(this.treeView(t))
              .when(Boolean(commits), (el) => el.child(commits)),
          )
          .child(this.diffView(t)),
      );
  }
}
