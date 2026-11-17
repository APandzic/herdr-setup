// Review: a read-only look through a repo's git changes, as a tab or beside a terminal.
// props: {folder?, base?, scope?}. Without a folder (the cmd-shift-r split) it takes the focused
// terminal's when it starts, and keeps it. Scopes: Uncommitted, Branch (against its base,
// uncommitted edits included) and Commit. Left: progress, the file tree with a Viewed check per
// file, and the commits (picking one shows just that commit). Right: every file's diff in one
// scroll; a viewed file folds to its header. Viewed marks are kept in ~/.herdr/reviews/, keyed
// by a hash of each file's diff, so a file whose diff changes comes back unviewed.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, props, exec, readTextFile, writeTextFile, watchFolder, theme, settings, home, checking } from "herdr";
import { READ, info, commits, changes, tree, hash } from "./git.js";

const TEXT = { badge: 10, label: 11.5, small: 12, body: 13 };
const ROW = 20;
const HEADER = 32;
const LEFT = 260;
const SCOPES = { uncommitted: "Uncommitted", branch: "Branch", commit: "Commit" };
const KEEP_DAYS = 30;

const expand = (path) => (path?.startsWith("~/") ? `${home()}${path.slice(1)}` : path);
const basename = (path) => path.split("/").filter(Boolean).at(-1) ?? path;
const markKey = (file) => `${file.path}\n${file.hash}`;

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
    this.scope = localStorage.getItem("scope") ?? props()?.scope;
    this.commit = null;
    this.hide = localStorage.getItem("hide") === "1";
    if (checking()) return;
    this.origin = this.findOrigin();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  async close() {
    this.watched = null;
    this.watch?.cancel();
  }

  // props.folder, else what this copy took when it started: the focused terminal's folder, or
  // the tab's terminal's when focus has already moved to this pane.
  findOrigin() {
    const p = props() ?? {};
    if (p.folder) return { folder: expand(p.folder), on: p.on ?? null };
    try {
      const saved = JSON.parse(localStorage.getItem("origin") ?? "null");
      if (saved?.folder) return saved;
    } catch {
      // Not ours; take it again below.
    }
    const f = focused();
    const all = panes();
    const own = all.find((x) => x.pane === f?.pane);
    const pane = own?.terminal ? own : all.find((x) => x.tab === f?.tab && x.terminal && x.cwd);
    const space = spaces().find((s) => s.active);
    const folder = pane?.cwd || f?.cwd || space?.folder;
    if (!folder) return null;
    const origin = { folder, on: space?.machine ?? null };
    localStorage.setItem("origin", JSON.stringify(origin));
    return origin;
  }

  watchRoot(root, cx) {
    if (this.origin.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          this.watch = watchFolder(root);
          await this.watch;
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  // One load at a time; a refresh asked for meanwhile runs once it's done.
  refresh(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        await this.load(cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        this.loaded = true;
        this.layout();
        cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  view() {
    return `${this.scope}:${this.commit ?? ""}`;
  }

  async load(cx) {
    const origin = this.origin;
    if (!origin) return;
    const view = this.view();
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: origin.folder, on: origin.on }).catch(() => null);
    if (top?.code !== 0) {
      this.root = null;
      this.files = [];
      this.error = top ? "Not a git repository" : "Folder not found";
      return;
    }
    const root = top.stdout.trim();
    const on = origin.on;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const read = (path) => readTextFile(`${root}/${path}`, { on });
    const repo = await info(git, props()?.base);
    const scope = this.scope in SCOPES ? this.scope : repo.head && repo.base && (repo.ahead > 0 || repo.branch !== repo.base) ? "branch" : "uncommitted";

    let list = [];
    if (scope === "branch" && repo.mergeBase) list = await commits(git, [`${repo.mergeBase}..HEAD`]);
    if (scope === "commit" && repo.head) list = await commits(git, ["-n", "30", "HEAD"]);
    let sha = list.some((c) => c.sha === this.commit) ? this.commit : null;
    if (scope === "commit") sha ??= list[0]?.sha ?? null;
    let result = { files: [], limited: false };
    if (sha) result = await changes(git, read, { sha });
    else if (scope === "uncommitted") result = await changes(git, read, { from: repo.head });
    else if (scope === "branch" && repo.mergeBase) result = await changes(git, read, { from: repo.mergeBase });

    const store = `${home()}/.herdr/reviews/${basename(root)}-${hash(`${on ?? ""}:${root}`)}.json`;
    const marks = parseStore(await readTextFile(store).catch(() => null)).viewed;
    for (const [k, at] of this.pending) at ? (marks[k] = at) : delete marks[k];

    if (view !== this.view()) {
      this.again = true; // the scope or commit changed meanwhile
      return;
    }
    Object.assign(this, { root, repo, scope, commit: sha, store, error: null, limited: result.limited, commits: list, viewed: marks });
    this.files = tree(result.files)
      .filter((r) => r.kind === "file")
      .map((r) => r.file);
    this.watchRoot(root, cx);
  }

  seen(file) {
    return Boolean(this.viewed[markKey(file)]);
  }

  // The rows the diff list draws and their heights, the tree, and the width the longest line needs.
  layout() {
    const rows = [];
    const sizes = [];
    let widest = 0;
    this.index = {};
    for (const file of this.files) {
      const seen = this.seen(file);
      if (this.hide && seen) continue;
      this.index[file.path] = rows.length;
      rows.push({ key: `f:${file.path}`, file, seen });
      sizes.push(HEADER);
      if (seen) continue;
      const lines = file.rows.map((row, i) => ({ key: `${file.path}:${i}`, ...row }));
      if (file.note) lines.push({ key: `${file.path}:note`, kind: "note", text: file.note });
      if (file.more) lines.push({ key: `${file.path}:more`, kind: "note", text: `… ${file.more} more lines not shown` });
      for (const line of lines) {
        rows.push(line);
        sizes.push(ROW);
      }
      widest = Math.max(widest, file.width);
    }
    this.rows = rows;
    this.sizes = sizes;
    this.diffWidth = Math.max(300, Math.ceil((widest + 1) * 7.3) + 110);
    this.treeRows = tree(this.hide ? this.files.filter((f) => !this.seen(f)) : this.files);
  }

  // From a file's header (jump: on to the next unviewed file) or from its check in the tree.
  toggle(file, jump, cx) {
    const key = markKey(file);
    const on = !this.viewed[key];
    const at = on ? new Date().toISOString() : null;
    if (on) this.viewed[key] = at;
    else delete this.viewed[key];
    this.pending.set(key, at);
    this.layout();
    if (jump) {
      const i = this.files.indexOf(file);
      const next = on ? [...this.files.slice(i + 1), ...this.files.slice(0, i)].find((f) => !this.seen(f)) : file;
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
    localStorage.setItem("scope", scope);
    this.reset(cx);
  }

  pickCommit(sha, cx) {
    if (sha === this.commit) return;
    this.commit = sha;
    this.reset(cx);
  }

  reset(cx) {
    this.files = [];
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

  statusColor(status, t) {
    return { A: t.ansi2, D: t.ansi1, R: t.accent }[status] ?? t.working;
  }

  header(t) {
    const repo = this.repo;
    const add = this.files.reduce((n, f) => n + f.add, 0);
    const del = this.files.reduce((n, f) => n + f.del, 0);
    const pill = (scope) => {
      const picked = this.scope === scope;
      const off = scope === "branch" ? !repo?.base : scope === "commit" ? !repo?.head : false;
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
          .child(div().min_w(0).truncate().text_size(TEXT.small).text_color(t.foreground).child(repo.branch ?? repo.head?.slice(0, 7) ?? "no commits"))
          .when(this.scope === "branch" && Boolean(repo.base), (row) =>
            row
              .child(div().text_size(TEXT.small).text_color(t.dim).child("→"))
              .child(div().flex_none().text_size(TEXT.small).text_color(t.muted).child(repo.base))
              .child(div().flex_none().text_size(TEXT.label).text_color(repo.ahead ? t.ansi2 : t.dim).child(`↑${repo.ahead}`))
              .child(div().flex_none().text_size(TEXT.label).text_color(repo.behind ? t.working : t.dim).child(`↓${repo.behind}`)),
          ),
      )
      .child(div().flex_1())
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised).children(Object.keys(SCOPES).map(pill)))
      .child(
        h_flex()
          .flex_none()
          .gap(6)
          .text_size(TEXT.label)
          .child(div().text_color(t.ansi2).child(`+${add}`))
          .child(div().text_color(t.ansi1).child(`−${del}`))
          .child(div().text_color(t.dim).child(`· ${this.files.length} file${this.files.length === 1 ? "" : "s"}`)),
      );
  }

  progress(t) {
    const done = this.files.filter((f) => this.seen(f)).length;
    const total = this.files.length;
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

  treeView(t) {
    const row = (r, i) => {
      const indent = h_flex().h(26).flex_none().gap(7).items_center().pl(6 + r.depth * 14).pr(6).rounded(6);
      if (r.kind === "dir") return indent.id(`dir-${i}`).text_color(t.muted).child(div().min_w(0).truncate().child(r.name));
      const f = r.file;
      const seen = this.seen(f);
      return indent
        .id(`file-${f.path}`)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (this.index[f.path] !== undefined) this.list.scroll_to_item(this.index[f.path], "top");
          cx.notify();
        })
        .child(
          div()
            .id(`view-${f.path}`)
            .flex_none()
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.toggle(f, false, cx);
            })
            .child(this.checkbox(seen, t)),
        )
        .child(div().flex_none().w(10).text_size(TEXT.label).text_color(this.statusColor(f.status, t)).child(f.status))
        .child(div().flex_1().min_w(0).truncate().text_color(seen ? t.muted : t.foreground).child(r.name))
        .child(this.stat(f, t));
    };
    return v_flex()
      .id("review-tree")
      .flex_1()
      .min_h(0)
      .p(6)
      .overflow_y_scrollbar()
      .text_size(TEXT.small)
      .children(this.treeRows.map(row))
      .when(this.limited, (el) => el.child(div().p(6).text_size(TEXT.label).text_color(t.dim).child("Showing the first 1,000 changed files")));
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
          div().flex_1().text_color(this.commit ? t.muted : t.foreground).child("All, with uncommitted"),
          div().flex_none().text_size(TEXT.label).text_color(t.dim).child(String(this.commits.length)),
        ]),
      );
    return v_flex()
      .flex_none()
      .max_h(240)
      .border_t(1)
      .border_color(t.border)
      .child(div().flex_none().px(12).pt(10).pb(4).text_size(TEXT.badge).font_medium().text_color(t.dim).child(this.scope === "branch" ? "COMMITS" : "RECENT COMMITS"))
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
        .child(div().flex_none().w(10).text_size(TEXT.badge).text_color(t.dim).child(row.seen ? "▸" : "▾"))
        .child(this.checkbox(row.seen, t))
        .child(div().flex_none().w(10).text_size(TEXT.label).text_color(this.statusColor(f.status, t)).child(f.status))
        .child(
          h_flex()
            .flex_none()
            .child(div().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
            .child(div().font_medium().text_color(row.seen ? t.muted : t.foreground).child(name)),
        )
        .when(Boolean(f.from), (el) => el.child(div().flex_none().text_color(t.dim).child(`← ${f.from}`)))
        .child(this.stat(f, t))
        .when(row.seen, (el) => el.child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child("Viewed")));
    }
    const line = h_flex().w_full().h(ROW).flex_none().font_family(mono).text_size(TEXT.small);
    if (row.kind === "@") return line.px(12).bg(t.raised).text_color(t.dim).child(div().truncate().child(row.text));
    if (row.kind === "note" || row.kind === "") return line.px(12).text_color(t.dim).child(row.text);
    const number = (n) => div().w(44).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return line
      .when(row.kind === "+", (el) => el.bg(`${t.ansi2}18`))
      .when(row.kind === "-", (el) => el.bg(`${t.ansi1}18`))
      .child(number(row.old))
      .child(number(row.new))
      .child(div().w(16).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
      .child(div().flex_1().min_w(0).truncate().child(row.text));
  }

  clickRow(key, cx) {
    if (!key.startsWith("f:")) return;
    const file = this.files.find((f) => f.path === key.slice(2));
    if (file) this.toggle(file, true, cx);
  }

  empty(t, title, body) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(6)
      .p(24)
      .child(div().text_size(TEXT.body).text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().text_size(TEXT.small).text_color(t.dim).text_center().child(body)));
  }

  diffView(t) {
    const repo = this.repo;
    if (!this.origin) return this.empty(t, "No folder", "Open Review from a terminal, or with props { folder }.");
    if (this.error) return this.empty(t, this.error, this.origin.folder.replace(home(), "~"));
    if (!this.loaded || (this.loading && !this.files.length)) return this.empty(t, "Loading changes…");
    if (this.scope === "branch" && !repo?.base) return this.empty(t, "No base branch", "Neither origin/HEAD, main nor master is here. Open it with: review --base <branch>");
    if (!this.files.length) {
      if (this.scope === "uncommitted") return this.empty(t, "No uncommitted changes");
      if (this.scope === "branch") return this.empty(t, `Nothing on ${repo.branch ?? "HEAD"} against ${repo.base} yet`);
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
    return v_flex()
      .id("review")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(TEXT.body)
      .child(this.header(t))
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
