// Cockpit Panel: the markdown docs an agent writes for one Herdr tab, read-only.
// props().dir is that tab's folder, ~/.herdr/docs/<tab-id>/. Each doc in it is a
// folder with doc.json ({kind, title, created, handled?, tabs: [{id, title, file}]}) and one
// .md per tab. A row of docs (when there's more than one), a row of the doc's tabs,
// then the chosen tab rendered. Rereads when anything under the folder changes.
// Opened for a cockpit (props project and cockpit_terminal too), it has two top tabs:
// Docs, and Inbox (the project's scripts and the tasks they find, inbox.js).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, readTextFile, watchFolder, checking, home, props, theme, panes } from "herdr";
import { Inbox } from "./inbox.js";

const TEXT = { badge: 10, label: 11.5, small: 12, body: 13 };
// doc.json `handled` (cockpit-panel handled): what was done with the doc on the forge, and its tone.
const HANDLED = {
  approved: { label: "Approved", short: "Approved", tone: "done" },
  "changes-requested": { label: "Changes requested", short: "Changes", tone: "working" },
  commented: { label: "Commented", short: "Commented", tone: "muted" },
};
const PENDING = /<!--\s*agent:[\s\S]*?-->/g;
const COMMENT = /<!--[\s\S]*?-->/g;

const expand = (path) => (path?.startsWith("~/") ? `${home()}${path.slice(1)}` : path);

export default class CockpitPanel extends View {
  init(_props, cx) {
    this.dir = expand(props()?.dir);
    this.docs = [];
    this.seen = {}; // file → the text last shown, for the changed dot
    this.loaded = false;
    this.doc = localStorage.getItem("doc");
    this.tab = localStorage.getItem("tab");
    this.view = localStorage.getItem("view") === "inbox" ? "inbox" : "docs";
    if (props()?.project) {
      this.inbox = new Inbox();
      this.inbox.init(cx);
    }
    if (!this.dir || checking()) return;
    this.reload(cx);
    cx.spawn(async (cx) => {
      // .panel tells the skill's script this tab already has a panel. It keeps the pane id the
      // script wrote; load() fills it in when the script didn't (see recordPane).
      await exec("/bin/sh", ["-c", 'mkdir -p "$1" && touch "$1/.panel"', "sh", this.dir]);
      for (;;) {
        this.watch = watchFolder(this.dir);
        await this.watch;
        await this.load();
        cx.notify();
      }
    });
    // Watches can be reclaimed when idle; the timer catches what they miss.
    cx.timer.every(10000, (cx) => this.reload(cx));
  }

  async close() {
    this.watch?.cancel();
    await this.inbox?.close();
    if (this.dir) await exec("rm", ["-f", `${this.dir}/.panel`]);
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      await this.load();
      cx.notify();
    });
  }

  // The pane id goes in .panel so the script can close or replace this panel. A pane isn't in
  // panes() yet while its mod starts, so this runs on every load until it's known.
  async recordPane() {
    if (this.paneKnown) return;
    const tabId = this.dir.split("/").filter(Boolean).at(-1); // the folder is named after the tab
    const pane = panes().find((p) => p.mod === "cockpit-panel" && p.tab === tabId)?.pane;
    if (!pane) return;
    const current = ((await readTextFile(`${this.dir}/.panel`).catch(() => null)) ?? "").trim();
    if (current !== pane) await exec("/bin/sh", ["-c", 'printf %s "$2" > "$1/.panel"', "sh", this.dir, pane]);
    this.paneKnown = true;
  }

  async load() {
    await this.recordPane();
    const r = await exec("/bin/sh", ["-c", 'cd "$1" 2>/dev/null && ls -d */ 2>/dev/null', "sh", this.dir]).catch(() => null);
    const names = (r?.stdout ?? "").split("\n").map((s) => s.replace(/\/$/, "")).filter(Boolean);
    const docs = [];
    for (const name of names) {
      const folder = `${this.dir}/${name}`;
      let meta;
      try {
        meta = JSON.parse((await readTextFile(`${folder}/doc.json`)) ?? "null");
      } catch {
        meta = null;
      }
      if (!meta || !Array.isArray(meta.tabs)) continue;
      const tabs = [];
      for (const tab of meta.tabs) {
        const path = `${folder}/${tab.file ?? `${tab.id}.md`}`;
        const text = (await readTextFile(path).catch(() => null)) ?? "";
        tabs.push({ id: tab.id, title: tab.title ?? tab.id, path, text });
      }
      docs.push({
        id: name,
        title: meta.title ?? name,
        kind: meta.kind ?? "",
        worker: meta.worker ?? "",
        created: meta.created ?? "",
        handled: HANDLED[meta.handled?.state] ? meta.handled : null,
        folder,
        tabs,
      });
    }
    docs.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    // First load: what's there counts as seen, so only later writes get a dot.
    if (!this.loaded) for (const d of docs) for (const tab of d.tabs) this.seen[tab.path] ??= tab.text;
    this.docs = docs;
    this.loaded = true;
  }

  current() {
    const doc = this.docs.find((d) => d.id === this.doc) ?? this.docs[0];
    const tab = doc?.tabs.find((x) => x.id === this.tab) ?? doc?.tabs[0];
    if (tab) this.seen[tab.path] = tab.text;
    return { doc, tab };
  }

  pickDoc(id, cx) {
    this.doc = id;
    this.tab = null;
    localStorage.setItem("doc", id);
    localStorage.removeItem("tab");
    cx.notify();
  }

  pickTab(id, cx) {
    this.tab = id;
    localStorage.setItem("tab", id);
    cx.notify();
  }

  // A pill, filled when picked, with a dot when the agent wrote to it unseen.
  pill(id, label, picked, changed, onClick, t) {
    return h_flex()
      .id(id)
      .flex_none()
      .px(10)
      .h(24)
      .gap(5)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(TEXT.label)
      .font_medium()
      .text_color(picked ? t.foreground : t.dim)
      .when(picked, (el) => el.bg(t.selected))
      .when(!picked, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => onClick(cx))
      .child(label)
      .when(changed, (el) => el.child(div().size(6).rounded(3).bg(t.accent)));
  }

  // "Approved", "Changes requested" or "Commented", in its tone; short for the doc list. Null when not handled.
  handledBadge(d, t, short = false) {
    if (!d.handled) return null;
    const h = HANDLED[d.handled.state];
    const color = t[h.tone] ?? t.muted;
    const at = d.handled.at ? new Date(d.handled.at) : null;
    const pad = (n) => String(n).padStart(2, "0");
    const day = at && at.toDateString() !== new Date().toDateString() ? `${at.getDate()}/${at.getMonth() + 1} ` : "";
    const when = at && !Number.isNaN(at.getTime()) ? ` · ${day}${pad(at.getHours())}:${pad(at.getMinutes())}` : "";
    return div()
      .id(`handled-${d.id}${short ? "-short" : ""}`)
      .flex_none()
      .px(6)
      .h(18)
      .flex()
      .items_center()
      .rounded(5)
      .bg(`${color}26`)
      .text_size(TEXT.badge)
      .font_semibold()
      .text_color(color)
      .tooltip(`${h.label}${when}`)
      .child(short ? h.short : h.label);
  }

  bar(t) {
    return h_flex().flex_none().px(8).py(6).gap(2).items_center().border_b(1).border_color(t.border).overflow_x_hidden();
  }

  empty(t, title, body) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(6)
      .p(24)
      .child(div().text_size(TEXT.body).text_color(t.foreground).child(title))
      .child(div().text_size(TEXT.small).text_color(t.dim).text_center().child(body));
  }

  // How far along a tab is: ✓ filled, … still has agent comments, ○ nothing yet.
  progress(tab) {
    if (/<!--\s*agent:/.test(tab.text)) return "…";
    return tab.text.replace(COMMENT, "").trim() ? "✓" : "○";
  }

  // One row per doc, for a tab with several (a cockpit's workers). Narrow: names only.
  sideList(current, unseen, narrow, t) {
    const row = (d) => {
      const picked = d === current;
      return v_flex()
        .id(`doc-${d.id}`)
        .flex_none()
        .px(8)
        .py(5)
        .gap(1)
        .rounded(6)
        .cursor_pointer()
        .when(picked, (el) => el.bg(t.selected))
        .when(!picked, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pickDoc(d.id, cx))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(TEXT.small)
                .font_medium()
                .text_color(picked ? t.foreground : t.muted)
                .child(d.worker || d.id),
            )
            .when(!picked && d.tabs.some(unseen), (el) => el.child(div().flex_none().size(6).rounded(3).bg(t.accent)))
            // Narrow: a dot in the handled tone; wide: the short badge in place of the progress marks.
            .when(Boolean(d.handled) && narrow, (el) =>
              el.child(div().flex_none().size(6).rounded(3).bg(t[HANDLED[d.handled.state].tone] ?? t.muted)),
            )
            .when(Boolean(d.handled) && !narrow, (el) => el.child(this.handledBadge(d, t, true)))
            .when(!d.handled, (el) =>
              el.child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child(d.tabs.map((x) => this.progress(x)).join(""))),
            ),
        )
        .when(!narrow, (el) => el.child(div().truncate().text_size(TEXT.label).text_color(t.dim).child(d.title)));
    };
    return v_flex()
      .id("cockpit-panel-list")
      .flex_none()
      .w(narrow ? 110 : 180)
      .h_full()
      .p(6)
      .gap(2)
      .bg(t.chrome)
      .border_r(1)
      .border_color(t.border)
      .overflow_y_scrollbar()
      .children(this.docs.map(row));
  }

  renderDocs() {
    const t = theme();
    const root = h_flex()
      .id("cockpit-panel")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_size(TEXT.body)
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      });
    if (!this.dir) return root.child(this.empty(t, "No folder", "Open this panel with props { dir }."));
    if (!this.loaded) return root;
    if (!this.docs.length)
      return root.child(this.empty(t, "No docs in this tab yet", "Ask an agent to make one with the cockpit-panel skill."));

    const { doc, tab } = this.current();
    const unseen = (x) => this.seen[x.path] !== x.text;
    if (this.docs.length > 1) root.child(this.sideList(doc, unseen, (this.width ?? 1000) < 480, t));
    const main = v_flex().flex_1().min_w(0).h_full().min_h(0);
    main.child(
      this.bar(t)
        .children(doc.tabs.map((x) => this.pill(`tab-${x.id}`, x.title, x === tab, x !== tab && unseen(x), (cx) => this.pickTab(x.id, cx), t)))
        .child(div().flex_1())
        .when(Boolean(doc.handled), (el) => el.child(this.handledBadge(doc, t)))
        .when(Boolean(doc.kind), (el) => el.child(div().flex_none().ml(6).text_size(TEXT.label).text_color(t.dim).child(doc.kind))),
    );

    const pending = (tab.text.match(PENDING) ?? []).length;
    const body = tab.text.replace(COMMENT, "").trim();
    if (pending)
      main.child(
        div()
          .flex_none()
          .px(14)
          .py(5)
          .text_size(TEXT.label)
          .text_color(t.dim)
          .border_b(1)
          .border_color(t.border)
          .child(`${pending} section${pending === 1 ? "" : "s"} still to fill`),
      );
    main.child(
      body
        ? div()
            .id("cockpit-panel-body")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .px(18)
            .py(14)
            .child(TextView.markdown(`md-${doc.id}-${tab.id}`, body).selectable())
        : this.empty(t, "Waiting for agent…", tab.path.replace(home(), "~")),
    );
    // Children first, then into the parent: an element added to a parent is closed.
    root.child(main);
    return root;
  }

  // Docs | Inbox, when this panel belongs to a cockpit; just the docs otherwise.
  render() {
    if (!this.inbox) return this.renderDocs();
    const t = theme();
    const fresh = this.inbox.newCount();
    const top = (id, label, count) =>
      this.pill(`view-${id}`, label, this.view === id, false, (cx) => {
        this.view = id;
        localStorage.setItem("view", id);
        cx.notify();
      }, t).when(count > 0, (el) =>
        el.child(div().px(5).rounded(4).bg(this.view === id ? t.accent : t.hover).text_size(10).text_color(this.view === id ? t.accent_foreground : t.foreground).child(String(count))),
      );
    return v_flex()
      .id("cockpit-panel-shell")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .child(
        h_flex()
          .flex_none()
          .px(8)
          .py(6)
          .gap(2)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(top("docs", "Docs", this.docs.length))
          .child(top("inbox", "Inbox", fresh)),
      )
      .child(div().flex_1().min_h(0).child(this.view === "inbox" ? this.inbox.render() : this.renderDocs()));
  }
}
