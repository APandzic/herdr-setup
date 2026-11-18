// Cockpit Panel: the markdown docs an agent writes for one Herdr tab, read-only.
// props().dir is that tab's folder, ~/.herdr/docs/<tab-id>/. Each doc in it is a
// folder with doc.json ({kind, title, created, handled?, tabs: [{id, title, file}]}) and one
// .md per tab. A row of docs (when there's more than one), a row of the doc's tabs,
// then the chosen tab rendered. Rereads when anything under the folder changes. The doc's bar
// has Remove, which deletes the doc's folder after a second click.
// Opened for a cockpit (props project and cockpit_terminal too), it has two top tabs:
// Docs, and Inbox (the project's scripts and the tasks they find, inbox.js). Docs counts the docs
// that need the owner; merged ones are history, never unseen, in a closed Merged group of the list.
// A doc with decisions.json (cockpit-panel decision) also gets Open questions, answered here with
// buttons that tell the cockpit (hc send "DECISION <doc> <id>: <answer>") or hand the question to
// its chat ("DISCUSS <doc> <id>"), and Decision history.
// A doc with `review` ({repo, base?}, from cockpit-panel new --repo) has Review diff in its bar,
// which opens the Review mod on that checkout as a tab, until the doc is marked Merged.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, checking, home, props, theme, panes, notify, run } from "herdr";
import { Inbox } from "./inbox.js";

const TEXT = { badge: 10, label: 11.5, small: 12, body: 13 };
// doc.json `handled` (cockpit-panel handled): what was done with the doc on the forge or in git, and its tone.
const HANDLED = {
  approved: { label: "Approved", short: "Approved", tone: "done" },
  "changes-requested": { label: "Changes requested", short: "Changes", tone: "working" },
  commented: { label: "Commented", short: "Commented", tone: "muted" },
  merged: { label: "Merged", short: "Merged", tone: "ansi5" },
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
        // Ticket plans made before the tab was renamed still call it Open questions, the name of the decisions tab.
        const title = meta.kind === "ticket-plan" && tab.id === "questions" ? "Notes" : (tab.title ?? tab.id);
        tabs.push({ id: tab.id, title, path, text });
      }
      // Decisions: open ones and the history, as two tabs after the doc's own.
      const file = `${folder}/decisions.json`;
      let decisions = [];
      try {
        decisions = JSON.parse((await readTextFile(file).catch(() => null)) ?? "null")?.decisions ?? [];
      } catch {
        // Mid-write; the next change reloads it.
      }
      let open = [];
      if (Array.isArray(decisions) && decisions.length) {
        open = decisions.filter((x) => !x.answered);
        const done = decisions.filter((x) => x.answered).sort((a, b) => String(b.answered.at).localeCompare(String(a.answered.at)));
        const title = open.length ? `Open questions · ${open.length}` : "Open questions";
        tabs.push({ id: "open-questions", title, path: `${file}#open`, text: open.map((x) => x.id).join(), view: "open", decisions: open });
        if (done.length)
          tabs.push({ id: "decision-history", title: "Decision history", path: `${file}#history`, text: done.map((x) => x.id).join(), view: "history", decisions: done });
      }
      docs.push({
        id: name,
        title: meta.title ?? name,
        kind: meta.kind ?? "",
        worker: meta.worker ?? "",
        created: meta.created ?? "",
        handled: HANDLED[meta.handled?.state] ? meta.handled : null,
        merged: meta.handled?.state === "merged",
        open: open.length,
        review: meta.review?.repo ? meta.review : null,
        folder,
        tabs,
      });
    }
    // Active docs first, then merged ones; newest first in each.
    docs.sort((a, b) => a.merged - b.merged || String(b.created).localeCompare(String(a.created)));
    // First load: what's there counts as seen, so only later writes get a dot. A merged doc is always seen.
    if (!this.loaded) for (const d of docs) for (const tab of d.tabs) this.seen[tab.path] ??= tab.text;
    for (const d of docs) if (d.merged) for (const tab of d.tabs) this.seen[tab.path] = tab.text;
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
    this.armed = null;
    if (id) localStorage.setItem("doc", id);
    else localStorage.removeItem("doc");
    localStorage.removeItem("tab");
    cx.notify();
  }

  // Remove takes two clicks (gpui has no confirm dialog): the first arms it, and it disarms
  // when the pointer leaves it or after 5 s.
  removeButton(doc, t) {
    const armed = this.armed === doc.id;
    const red = t.blocked ?? t.accent;
    return div()
      .id(`remove-${doc.id}`)
      .flex_none()
      .ml(6)
      .px(8)
      .h(20)
      .flex()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .text_size(TEXT.label)
      .font_medium()
      .when(armed, (el) => el.bg(`${red}26`).text_color(red))
      .when(!armed, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(armed ? "Deletes this doc's folder" : "Remove this doc from Docs")
      .on_hover((hovered, cx) => {
        if (!hovered && this.armed === doc.id) {
          this.armed = null;
          cx.notify();
        }
      })
      .on_click((_e, cx) => (this.armed === doc.id ? this.remove(doc, cx) : this.arm(doc, cx)))
      .child(armed ? "Click again to remove" : "Remove");
  }

  reviewButton(doc, t) {
    return div()
      .id(`review-${doc.id}`)
      .flex_none()
      .ml(6)
      .px(8)
      .h(20)
      .flex()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .border_1()
      .border_color(t.border)
      .text_size(TEXT.label)
      .font_medium()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .tooltip(`Open ${doc.review.repo.replace(home(), "~")} in Review${doc.review.base ? ` against ${doc.review.base}` : ""}`)
      .on_click(() => run("tab.new", { name: `Review · ${doc.worker || doc.id}`, mod: "review", props: { folder: doc.review.repo, base: doc.review.base, scope: "branch" } }))
      .child("Review diff");
  }

  arm(doc, cx) {
    this.armed = doc.id;
    this.disarm?.cancel();
    this.disarm = cx.timer.after(5000, (cx) => {
      if (this.armed !== doc.id) return;
      this.armed = null;
      cx.notify();
    });
    cx.notify();
  }

  // Moved to a hidden name first: load() lists only visible folders, so no reload sees it
  // half-deleted. The shown doc hands over to its neighbour in the list.
  remove(doc, cx) {
    this.armed = null;
    const name = doc.folder.slice(this.dir.length + 1);
    if (!name || name.includes("/") || name.startsWith(".") || doc.folder !== `${this.dir}/${name}`) return;
    const i = this.docs.indexOf(doc);
    if (doc === this.current().doc) this.pickDoc((this.docs[i + 1] ?? this.docs[i - 1])?.id ?? null, cx);
    this.docs = this.docs.filter((d) => d !== doc);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("/bin/sh", ["-c", 'gone="$1/.removed-$2-$$" && mv "$1/$2" "$gone" && rm -rf "$gone"', "sh", this.dir, name]).catch(() => null);
      if (r?.code !== 0) notify({ title: "Couldn't remove the doc", body: `${doc.title} is still in Docs.`, level: "error" });
      await this.load();
      cx.notify();
    });
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

  // "Approved", "Changes requested", "Commented" or "Merged", in its tone; short for the doc list. Null when not handled.
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

  openQuestions(doc, tab, t) {
    if (!tab.decisions.length) return this.empty(t, "No open questions", "What you've answered is in Decision history.");
    return v_flex()
      .id("open-questions")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .px(18)
      .py(14)
      .gap(14)
      .children(tab.decisions.map((q) => this.question(doc, q, t)));
  }

  question(doc, q, t) {
    const sending = this.sending?.has(`${doc.id}/${q.id}`);
    const option = (label, i) =>
      div()
        .id(`answer-${q.id}-${i}`)
        .px(10)
        .py(4)
        .rounded(6)
        .cursor_pointer()
        .text_size(TEXT.small)
        .font_medium()
        .when(label === q.rec, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
        .when(label !== q.rec, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.answer(doc, q, label, cx))
        .child(label);
    return v_flex()
      .id(`question-${q.id}`)
      .gap(8)
      .pb(14)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_start()
          .child(div().flex_none().pt(1).text_size(TEXT.label).font_semibold().text_color(t.dim).child(q.id))
          .child(div().flex_1().min_w(0).child(TextView.markdown(`q-${doc.id}-${q.id}`, q.question).selectable())),
      )
      .when(Boolean(q.context), (el) =>
        el.child(div().pl(26).text_size(TEXT.small).text_color(t.muted).child(TextView.markdown(`qc-${doc.id}-${q.id}`, q.context))),
      )
      .when(Boolean(q.discussing) && !sending, (el) =>
        el.child(div().pl(26).text_size(TEXT.small).font_medium().text_color(t.accent).child("Being discussed in the cockpit's chat")),
      )
      .when(sending, (el) => el.child(div().pl(26).text_size(TEXT.small).text_color(t.dim).child("Sending to the cockpit…")))
      .when(!sending, (el) =>
        el.child(
          h_flex()
            .pl(26)
            .flex_wrap()
            .gap(6)
            .children((q.options ?? []).map(option))
            .when(!q.discussing, (row) =>
              row.child(
                div()
                  .id(`discuss-${q.id}`)
                  .px(10)
                  .py(4)
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(TEXT.small)
                  .text_color(t.dim)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.discuss(doc, q, cx))
                  .child("Discuss in chat"),
              ),
            ),
        ),
      )
      .when(Boolean(q.rec), (el) => el.child(div().pl(26).text_size(TEXT.label).text_color(t.dim).child(`Recommended: ${q.rec}`)));
  }

  decisionHistory(doc, tab, t) {
    const pad = (n) => String(n).padStart(2, "0");
    const when = (iso) => {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return "";
      const day = at.toDateString() !== new Date().toDateString() ? `${at.getDate()}/${at.getMonth() + 1} ` : "";
      return `${day}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    };
    return v_flex()
      .id("decision-history")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .px(18)
      .py(14)
      .gap(12)
      .children(
        tab.decisions.map((q) =>
          v_flex()
            .id(`decided-${q.id}`)
            .gap(4)
            .pb(12)
            .border_b(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(8)
                .items_start()
                .child(div().flex_none().pt(1).text_size(TEXT.label).font_semibold().text_color(t.dim).child(q.id))
                .child(div().flex_1().min_w(0).text_color(t.muted).child(TextView.markdown(`h-${doc.id}-${q.id}`, q.question))),
            )
            .child(div().pl(26).text_size(TEXT.body).font_semibold().text_color(t.foreground).child(`→ ${q.answered.answer}`))
            .child(
              div()
                .pl(26)
                .text_size(TEXT.label)
                .text_color(t.dim)
                .child(`${q.answered.via === "panel" ? "Answered here" : q.discussing ? "Decided in the chat discussion" : "Answered in chat"} · ${when(q.answered.at)}`),
            ),
        ),
      );
  }

  // Answering and "Discuss in chat" both record on q in decisions.json, then tell the cockpit.
  // Not delivered: the change is undone, so the question is as it was.
  answer(doc, q, answer, cx) {
    this.toCockpit(doc, q, { answered: { answer, at: new Date().toISOString(), via: "panel" } }, `DECISION ${doc.id} ${q.id}: ${answer}`, cx);
  }

  discuss(doc, q, cx) {
    this.toCockpit(doc, q, { discussing: { at: new Date().toISOString() } }, `DISCUSS ${doc.id} ${q.id}`, cx);
  }

  toCockpit(doc, q, change, message, cx) {
    const cockpit = props()?.cockpit_terminal;
    if (!cockpit) {
      notify({ title: "No cockpit to send it to", body: "This panel isn't connected to a cockpit. Use the cockpit's chat instead.", level: "warning" });
      return;
    }
    const key = `${doc.id}/${q.id}`;
    const path = `${doc.folder}/decisions.json`;
    // apply(d) changes the decision on disk; false when it's gone or already answered.
    const edit = async (apply) => {
      const raw = await readTextFile(path);
      const data = JSON.parse(raw ?? '{"decisions":[]}');
      const d = data.decisions?.find((x) => x.id === q.id);
      if (!d || apply(d) === false) return false;
      await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, raw);
      return true;
    };
    this.sending ??= new Set();
    this.sending.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      const saved = await edit((d) => (d.answered ? false : void Object.assign(d, change))).catch(() => false);
      if (saved) {
        await this.load();
        cx.notify();
        // hc send waits for a draft the owner is typing in the cockpit, so it never clobbers it.
        const sent = await exec("hc", ["send", cockpit, message], { timeout: 600000 }).catch(() => null);
        if (sent?.code !== 0) {
          await edit((d) => void Object.keys(change).forEach((k) => delete d[k])).catch(() => false);
          notify({ title: "Couldn't reach the cockpit", body: `${q.id} is as it was.`, level: "error" });
        }
      }
      this.sending.delete(key);
      await this.load();
      cx.notify();
    });
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
            .when(!d.merged && d.open > 0, (el) => el.child(div().flex_none().text_size(TEXT.badge).font_medium().text_color(t.accent).child(`${d.open} open`)))
            .when(!picked && d.tabs.some(unseen), (el) => el.child(div().flex_none().size(6).rounded(3).bg(t.accent)))
            // Narrow: a dot in the handled tone; wide: the short badge in place of the progress marks.
            .when(Boolean(d.handled) && narrow, (el) =>
              el.child(div().flex_none().size(6).rounded(3).bg(t[HANDLED[d.handled.state].tone] ?? t.muted)),
            )
            .when(Boolean(d.handled) && !narrow, (el) => el.child(this.handledBadge(d, t, true)))
            .when(!d.handled, (el) =>
              el.child(div().flex_none().text_size(TEXT.label).text_color(t.dim).child(d.tabs.filter((x) => !x.view).map((x) => this.progress(x)).join(""))),
            ),
        )
        .when(!narrow, (el) => el.child(div().truncate().text_size(TEXT.label).text_color(t.dim).child(d.title)));
    };
    // Merged docs under a header that opens and closes them (closed when the panel opens); the doc
    // shown keeps its row while closed.
    const merged = this.docs.filter((d) => d.merged);
    const header = h_flex()
      .id("doc-merged")
      .flex_none()
      .mt(8)
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.showMerged = !this.showMerged;
        cx.notify();
      })
      .child(div().flex_none().w(8).text_size(TEXT.label).text_color(t.dim).child(this.showMerged ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).font_semibold().text_color(t.muted).child("Merged"))
      .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(TEXT.badge).text_color(t.muted).child(String(merged.length)));
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
      .children(this.docs.filter((d) => !d.merged).map(row))
      .when(merged.length > 0, (el) => el.child(header).children(merged.filter((d) => this.showMerged || d === current).map(row)));
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
        .when(Boolean(doc.review) && doc.handled?.state !== "merged", (el) => el.child(this.reviewButton(doc, t)))
        .when(Boolean(doc.handled), (el) => el.child(this.handledBadge(doc, t)))
        .when(Boolean(doc.kind), (el) => el.child(div().flex_none().ml(6).text_size(TEXT.label).text_color(t.dim).child(doc.kind)))
        .child(this.removeButton(doc, t)),
    );

    if (tab.view) {
      main.child(tab.view === "open" ? this.openQuestions(doc, tab, t) : this.decisionHistory(doc, tab, t));
      root.child(main);
      return root;
    }
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
    // Rendered before counting: it marks the tab on screen as seen.
    const body = this.view === "inbox" ? this.inbox.render() : this.renderDocs();
    // Docs that need the owner: not merged, with unseen changes or open questions.
    const waiting = this.docs.filter((d) => !d.merged && (d.open > 0 || d.tabs.some((x) => this.seen[x.path] !== x.text))).length;
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
          .child(top("docs", "Docs", waiting))
          .child(top("inbox", "Inbox", fresh)),
      )
      .child(div().flex_1().min_h(0).child(body));
  }
}
