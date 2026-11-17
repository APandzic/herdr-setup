// Inbox: a project's helper scripts and the inbox they fill, the Inbox tab of the Cockpit Panel
// panel when it's opened for a cockpit. props(): { dir, project, cockpit_terminal }. The scripts are listed in <project>/.herdr/cockpit.json;
// the inbox is kept by the cockpit-task helper (~/.local/bin/cockpit-task), which this panel
// also calls for every change, so scripts, agents and the panel share one writer.
//   watch     long-running: an hc terminal, labelled so the panel finds it again after a restart
//   schedule  run once every `every` while switched on, output appended to logs/<id>.log
//   manual    a Run button
// Start worker hands the task to the cockpit (hc send "INBOX START <key>"); Decline hides it
// for inbox.decline_for (default 48h).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, checking, home, props, theme, run, notify } from "herdr";

const TEXT = { badge: 10, label: 11.5, small: 12, body: 13 };
const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
const PRESETS = ["12h", "24h", "48h", "7d"];

const expand = (path) => (path?.startsWith("~/") ? `${home()}${path.slice(1)}` : path);
const ms = (value, fallback) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(String(value ?? ""));
  return m ? Math.round(Number(m[1]) * UNITS[m[2] ?? "s"]) : fallback;
};
const ago = (seconds) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const initials = (name) => {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase();
};
// Authors get the same colors as the sidebar's space avatars, picked from their name.
const AUTHOR_COLORS = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
const authorColor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
};
const sizeOf = (lines) => (lines < 100 ? "S" : lines < 400 ? "M" : lines < 1000 ? "L" : "XL");
const left = (seconds) => {
  const s = Math.max(0, Math.ceil(seconds));
  return s >= 3600 ? `${Math.ceil(s / 3600)}h left` : `${Math.ceil(s / 60)}m left`;
};

export class Inbox {
  init(cx) {
    this.project = expand(props()?.project);
    this.cockpit = props()?.cockpit_terminal ?? null;
    this.config = null; // parsed cockpit.json
    this.configRaw = null; // its text, for safe writes
    this.problem = null;
    this.tasks = [];
    this.watchers = {}; // script id → terminal address
    this.runs = {}; // script id → { at, ok, running }
    this.showDeclined = false;
    this.loaded = false;
    this.helper = `${home()}/.local/bin/cockpit-task`;
    try {
      this.scheduled = JSON.parse(localStorage.getItem("scheduled") ?? "{}"); // id → true
    } catch {
      this.scheduled = {};
    }
    if (!this.project || checking()) return;
    cx.spawn(async (cx) => {
      const r = await this.task(["where"]).catch(() => null);
      this.state = r?.stdout.trim() || null;
      if (!this.state) this.problem = `cockpit-task isn't installed at ${this.helper}. Run herdr-setup's install.sh.`;
      await this.load();
      this.autostart(cx);
      cx.notify();
      // The config and the inbox both live in watched folders.
      for (;;) {
        this.watch = watchFolder(this.state ?? `${this.project}/.herdr`);
        this.watchConfig = watchFolder(`${this.project}/.herdr`);
        await Promise.race([this.watch, this.watchConfig]);
        this.watch.cancel();
        this.watchConfig.cancel();
        await this.load();
        cx.notify();
      }
    });
    // Data the watches can miss (watchers ending), and schedules coming due.
    cx.timer.every(10000, (cx) => {
      this.tick(cx);
      cx.spawn(async (cx) => {
        await this.load();
        cx.notify();
      });
    });
  }

  async close() {
    this.watch?.cancel();
    this.watchConfig?.cancel();
  }

  // cockpit-task with this project, through a login-like PATH.
  task(args) {
    return exec("/usr/bin/env", [`COCKPIT_PROJECT=${this.project}`, this.helper, ...args], { cwd: this.project });
  }

  label() {
    return this.state?.split("/").at(-1) ?? "";
  }

  async load() {
    // Connected: the cockpit this panel was opened for is still a live terminal.
    const c = this.cockpit && (await exec("hc", ["get", this.cockpit, "--json"]).catch(() => null));
    this.connected = Boolean(c && JSON.parse(c.stdout || "{}").state === "live");
    this.configRaw = await readTextFile(`${this.project}/.herdr/cockpit.json`).catch(() => null);
    try {
      this.config = this.configRaw ? JSON.parse(this.configRaw) : null;
      if (this.state) this.problem = null;
    } catch (e) {
      this.config = null;
      this.problem = `.herdr/cockpit.json isn't valid JSON: ${e.message}`;
    }
    if (this.state) {
      try {
        this.tasks = JSON.parse((await readTextFile(`${this.state}/inbox.json`)) ?? '{"tasks":[]}').tasks ?? [];
      } catch {
        // Mid-write; the next change reloads it.
      }
      const r = await exec("hc", ["ls", "--json", "--label", `cockpit.state=${this.label()}`]).catch(() => null);
      const live = r ? JSON.parse(r.stdout || "{}").terminals ?? [] : [];
      const watchers = {};
      for (const t of live) {
        const g = await exec("hc", ["get", t.address, "--json"]).catch(() => null);
        const id = g && JSON.parse(g.stdout || "{}").labels?.["cockpit.script"];
        if (id) watchers[id] = t.address;
      }
      this.watchers = watchers;
    }
    this.loaded = true;
  }

  newCount() {
    return this.tasks.filter((x) => x.state === "new").length;
  }

  scripts() {
    return Array.isArray(this.config?.scripts) ? this.config.scripts.filter((s) => s?.id && s?.run) : [];
  }

  declineFor() {
    return this.config?.inbox?.decline_for ?? "48h";
  }

  // The command line a script runs with: project folder, its env, cockpit-task on PATH.
  command(script, log) {
    const argv = [expand(script.run), ...(Array.isArray(script.args) ? script.args.map(String) : [])];
    const quoted = argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
    return [
      `cd '${this.project.replaceAll("'", "'\\''")}' || exit 1`,
      `export COCKPIT_PROJECT="$PWD" COCKPIT_SCRIPT='${script.id}' PATH="$HOME/.local/bin:$PATH"`,
      log ? `exec ${quoted} >> '${log}' 2>&1` : `exec ${quoted}`,
    ].join("; ");
  }

  autostart(cx) {
    for (const s of this.scripts()) {
      if (!s.autostart) continue;
      if (s.mode === "watch" && !this.watchers[s.id]) this.startWatcher(s, cx);
      if (s.mode === "schedule") this.scheduled[s.id] = true;
    }
    this.saveScheduled();
    this.tick(cx);
  }

  saveScheduled() {
    localStorage.setItem("scheduled", JSON.stringify(this.scheduled));
  }

  tick(cx) {
    for (const s of this.scripts()) {
      if (s.mode !== "schedule" || !this.scheduled[s.id] || this.runs[s.id]?.running) continue;
      const last = this.runs[s.id]?.at ?? 0;
      if (Date.now() - last >= ms(s.every, 30 * 60000)) this.runOnce(s, cx);
    }
  }

  runOnce(script, cx) {
    this.runs[script.id] = { ...(this.runs[script.id] ?? {}), running: true };
    cx.notify();
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${this.state}/logs`]);
      const log = `${this.state}/logs/${script.id}.log`;
      const r = await exec("/bin/sh", ["-c", this.command(script, log)], { timeout: 600000 }).catch((e) => ({ code: -1, error: e }));
      this.runs[script.id] = { at: Date.now(), ok: r.code === 0, running: false };
      await this.load();
      cx.notify();
    });
  }

  startWatcher(script, cx) {
    cx.spawn(async (cx) => {
      await exec("hc", [
        "run", "--bg", "--no-parent", "--cwd", this.project,
        "--label", `cockpit.state=${this.label()}`, "--label", `cockpit.script=${script.id}`,
        "--", "/bin/sh", "-c", this.command(script, null),
      ]);
      await this.load();
      cx.notify();
    });
  }

  stopWatcher(script, cx) {
    const address = this.watchers[script.id];
    if (!address) return;
    cx.spawn(async (cx) => {
      await exec("hc", ["kill", address]).catch(() => null);
      await exec("hc", ["rm", address]).catch(() => null);
      await this.load();
      cx.notify();
    });
  }

  act(args, cx, after) {
    cx.spawn(async (cx) => {
      await this.task(args).catch(() => null);
      if (after) await after();
      await this.load();
      cx.notify();
    });
  }

  start(item, cx) {
    if (!this.connected) {
      notify({
        title: "No cockpit to start it",
        body: "This panel isn't connected to a running cockpit. Start one in this project (e.g. /herdr-review-cockpit) and it opens a connected panel.",
        level: "warning",
      });
      return;
    }
    this.act(["update", "--key", item.key, "--state", "starting"], cx, async () => {
      // hc send waits for a draft the owner is typing in the cockpit, so it never clobbers it.
      const sent = await exec("hc", ["send", this.cockpit, `INBOX START ${item.key} — ${item.title}`], { timeout: 600000 }).catch(() => null);
      if (sent?.code === 0) return;
      await this.task(["undo", "--key", item.key]).catch(() => null);
      notify({ title: "Couldn't reach the cockpit", body: `${item.title} is back in the inbox.`, level: "error" });
    });
  }

  async setDeclineFor(value, cx) {
    cx.spawn(async (cx) => {
      for (let i = 0; i < 3; i++) {
        const raw = await readTextFile(`${this.project}/.herdr/cockpit.json`);
        const config = JSON.parse(raw ?? "{}");
        config.inbox = { ...(config.inbox ?? {}), decline_for: value };
        try {
          await writeTextFile(`${this.project}/.herdr/cockpit.json`, `${JSON.stringify(config, null, 2)}\n`, raw);
          break;
        } catch {
          // Changed meanwhile: reread and try again.
        }
      }
      await this.load();
      cx.notify();
    });
  }

  // ── drawing ──

  button(id, label, onClick, t, { primary = false, muted = false } = {}) {
    return div()
      .id(id)
      .flex_none()
      .px(8)
      .h(22)
      .flex()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(TEXT.label)
      .font_medium()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)))
      .when(!primary, (el) =>
        el.border_1().border_color(t.border).text_color(muted ? t.dim : t.foreground).hover((s) => s.bg(t.hover)),
      )
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  heading(label, count, t, extra) {
    return h_flex()
      .flex_none()
      .px(12)
      .pt(12)
      .pb(6)
      .gap(6)
      .items_center()
      .child(div().text_size(TEXT.label).font_semibold().text_color(t.muted).child(label))
      .when(count !== null, (el) =>
        el.child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(TEXT.badge).text_color(t.muted).child(String(count))),
      )
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  meta(text, t) {
    return div().text_size(TEXT.label).text_color(t.dim).truncate().child(text);
  }

  avatar(name, size) {
    return div()
      .flex_none()
      .size(size)
      .rounded_full()
      .bg(authorColor(name))
      .flex()
      .items_center()
      .justify_center()
      .text_size(size < 18 ? 7.5 : 8.5)
      .font_bold()
      .text_color("#ffffff")
      .child(initials(name));
  }

  authorHeading(name, count, t) {
    return h_flex()
      .flex_none()
      .mx(8)
      .px(8)
      .pt(8)
      .pb(2)
      .gap(8)
      .items_center()
      .child(this.avatar(name, 18))
      .child(div().min_w(0).truncate().text_size(TEXT.small).font_semibold().text_color(authorColor(name)).child(name))
      .child(div().flex_1())
      .child(div().text_size(TEXT.badge).text_color(t.dim).child(String(count)));
  }

  // Size badge and the counts of lines added and removed and files. Null without the numbers.
  stats(item, t) {
    const add = item.additions ?? 0;
    const del = item.deletions ?? 0;
    if (item.additions == null && item.deletions == null && item.files == null) return null;
    return h_flex()
      .gap(6)
      .items_center()
      .child(
        div()
          .flex_none()
          .px(4)
          .h(15)
          .flex()
          .items_center()
          .rounded(4)
          .border_1()
          .border_color(t.border)
          .text_size(TEXT.badge)
          .font_bold()
          .text_color(t.muted)
          .child(sizeOf(add + del)),
      )
      .child(
        h_flex()
          .min_w(0)
          .gap(4)
          .text_size(TEXT.label)
          .child(div().text_color(t.done).child(`+${add.toLocaleString("en")}`))
          .child(div().text_color(t.blocked).child(`−${del.toLocaleString("en")}`))
          .when(item.files != null, (el) => el.child(div().truncate().text_color(t.dim).child(`· ${item.files} ${item.files === 1 ? "file" : "files"}`))),
      );
  }

  taskRow(item, t, grouped = false) {
    // Under its author's heading, "PR #12: Fix" reads as "#12 Fix".
    const pr = grouped ? /^PR (#\d+):\s*(.*)$/.exec(item.title) : null;
    const title = h_flex()
      .id(`title-${item.key}`)
      .min_w(0)
      .gap(5)
      .text_size(TEXT.small)
      .text_color(t.foreground)
      .when(Boolean(item.url), (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => exec("open", [item.url])))
      .when(Boolean(pr), (el) => el.child(div().flex_none().text_color(t.dim).child(pr[1])))
      .child(div().min_w(0).truncate().child(pr ? pr[2] : item.title));
    const row = v_flex().id(`task-${item.key}`).px(8).py(6).gap(4).hover((s) => s.bg(t.hover));
    if (grouped) row.ml(26).mr(8).rounded_r(7).border_l_1().border_color(`${authorColor(item.author)}59`);
    else row.mx(8).rounded(7);
    if (item.state === "new") {
      // How long it has waited stays quiet: dim text, and a small dot once it's been over a day.
      const since = item.opened ?? item.added;
      const stale = Date.now() / 1000 - since > 86400;
      const where = item.branch ?? (grouped || !item.author ? item.source : item.author);
      const stats = this.stats(item, t);
      return row
        .child(title)
        .when(Boolean(stats), (el) => el.child(stats))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .when(stale, (el) => el.child(div().flex_none().size(5).rounded(3).bg(t.working)))
            .child(
              div()
                .id(`age-${item.key}`)
                .flex_1()
                .min_w(0)
                .tooltip(`${item.opened ? "Opened" : "Found"} ${ago(since)} ago`)
                .child(this.meta(`${ago(since)} · ${where}`, t)),
            )
            .child(this.button(`decline-${item.key}`, "Decline", (cx) => this.act(["decline", "--key", item.key], cx), t, { muted: true }))
            .child(this.button(`start-${item.key}`, "Start worker", (cx) => this.start(item, cx), t, { primary: true })),
        );
    }
    if (item.state === "declined") {
      const until = (item.declined_at ?? 0) + ms(this.declineFor(), 48 * 3600000) / 1000 - Date.now() / 1000;
      return row.child(
        h_flex()
          .gap(6)
          .items_center()
          .child(v_flex().flex_1().min_w(0).child(title.opacity(0.6)).child(this.meta(left(until), t)))
          .child(this.button(`undo-${item.key}`, "Undo", (cx) => this.act(["undo", "--key", item.key], cx), t, { muted: true })),
      );
    }
    const label = { starting: "starting…", running: `running · ${item.worker ?? ""}`, done: `done · ${item.worker ?? ""}` }[item.state] ?? item.state;
    const color = { starting: t.working, running: t.working, done: t.done }[item.state] ?? t.dim;
    return row.child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().flex_none().size(7).rounded(4).bg(color))
        .when(Boolean(item.author), (el) => el.child(this.avatar(item.author, 16)))
        .child(v_flex().flex_1().min_w(0).child(title).child(this.meta(label, t)))
        .when(item.state === "done", (el) =>
          el.child(this.button(`clear-${item.key}`, "Clear", (cx) => this.act(["update", "--key", item.key, "--state", "declined"], cx), t, { muted: true })),
        ),
    );
  }

  // New tasks under their authors, the author with the newest task first; tasks without one after.
  grouped(fresh, t) {
    const authors = new Map();
    for (const x of fresh) if (x.author) authors.set(x.author, [...(authors.get(x.author) ?? []), x]);
    const out = [];
    for (const [name, items] of authors)
      out.push(this.authorHeading(name, items.length, t), ...items.map((x) => this.taskRow(x, t, true)));
    return [...out, ...fresh.filter((x) => !x.author).map((x) => this.taskRow(x, t))];
  }

  scriptRow(s, t) {
    const running = Boolean(this.watchers[s.id]);
    const r = this.runs[s.id];
    let status;
    let control;
    if (s.mode === "watch") {
      status = running ? `watching · ${this.watchers[s.id]}` : "stopped";
      control = h_flex()
        .gap(6)
        .when(running, (el) =>
          el.child(this.button(`peek-${s.id}`, "Peek", () => run("terminal.peek", { terminal: this.watchers[s.id] }), t, { muted: true })),
        )
        .child(
          running
            ? this.button(`stop-${s.id}`, "Stop", (cx) => this.stopWatcher(s, cx), t)
            : this.button(`go-${s.id}`, "Start", (cx) => this.startWatcher(s, cx), t, { primary: true }),
        );
    } else if (s.mode === "schedule") {
      const on = Boolean(this.scheduled[s.id]);
      const last = r?.running ? "running…" : r?.at ? `last ${ago(r.at / 1000)} ${r.ok ? "✓" : "✗"}` : "not run yet";
      status = `every ${s.every ?? "30m"} · ${on ? last : "off"}`;
      control = this.button(
        `sched-${s.id}`,
        on ? "On" : "Off",
        (cx) => {
          this.scheduled[s.id] = !on;
          this.saveScheduled();
          if (!on) this.tick(cx);
          cx.notify();
        },
        t,
        { primary: on },
      );
    } else {
      status = r?.running ? "running…" : r?.at ? `last ${ago(r.at / 1000)} ${r.ok ? "✓" : "✗"}` : "not run yet";
      control = this.button(`run-${s.id}`, "Run", (cx) => this.runOnce(s, cx), t);
    }
    const dot = s.mode === "watch" ? (running ? t.working : t.dim) : s.mode === "schedule" && this.scheduled[s.id] ? t.working : t.dim;
    return h_flex()
      .id(`script-${s.id}`)
      .mx(8)
      .px(8)
      .py(6)
      .gap(8)
      .items_center()
      .rounded(7)
      .hover((st) => st.bg(t.hover))
      .child(div().flex_none().size(7).rounded(4).bg(dot))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().text_size(TEXT.small).text_color(t.foreground).truncate().child(s.title ?? s.id))
          .child(this.meta(`${s.mode} · ${status}`, t)),
      )
      .child(control);
  }

  empty(t, title, body) {
    return v_flex()
      .px(16)
      .py(14)
      .gap(4)
      .child(div().text_size(TEXT.small).text_color(t.muted).child(title))
      .when(Boolean(body), (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child(body)));
  }

  render() {
    const t = theme();
    const root = v_flex().id("inbox").size_full().min_h(0).bg(t.background).text_size(TEXT.body);
    if (!this.project) return root.child(this.empty(t, "No project", "Open this panel with props { project, cockpit_terminal }."));
    if (!this.loaded) return root;

    const body = v_flex().id("inbox-body").flex_1().min_h(0).overflow_y_scrollbar().pb(10);
    if (this.problem) body.child(div().mx(12).mt(10).text_size(TEXT.label).text_color(t.blocked).child(this.problem));

    const fresh = this.tasks.filter((x) => x.state === "new").sort((a, b) => b.added - a.added);
    const active = this.tasks.filter((x) => ["starting", "running", "done"].includes(x.state));
    const declined = this.tasks.filter((x) => x.state === "declined");

    if (!this.connected)
      body.child(
        div()
          .mx(12)
          .mt(10)
          .px(10)
          .py(8)
          .rounded(7)
          .border_1()
          .border_color(t.border)
          .bg(t.surface)
          .text_size(TEXT.label)
          .text_color(t.muted)
          .child("Not connected to a cockpit. Scripts run and tasks collect, but Start worker needs a running cockpit in this project."),
      );
    // Workers first: what you started stays in sight however long the inbox gets.
    if (active.length) body.child(this.heading("Workers", active.length, t, null)).children(active.map((x) => this.taskRow(x, t)));
    body.child(this.heading("Inbox", fresh.length, t, null));
    if (!fresh.length) body.child(this.empty(t, "Nothing waiting", "Tasks your scripts find show up here."));
    body.children(this.grouped(fresh, t));
    if (declined.length) {
      body.child(
        this.heading(
          "Declined",
          declined.length,
          t,
          this.button("toggle-declined", this.showDeclined ? "Hide" : "Show", (cx) => {
            this.showDeclined = !this.showDeclined;
            cx.notify();
          }, t, { muted: true }),
        ),
      );
      if (this.showDeclined) body.children(declined.map((x) => this.taskRow(x, t)));
    }

    const scripts = this.scripts();
    body.child(this.heading("Scripts", scripts.length, t, null));
    if (!scripts.length)
      body.child(this.empty(t, "No scripts yet", "Add them to .herdr/cockpit.json in this project, or ask the cockpit to."));
    body.children(scripts.map((s) => this.scriptRow(s, t)));

    const current = this.declineFor();
    body.child(
      h_flex()
        .mx(16)
        .mt(14)
        .gap(6)
        .items_center()
        .child(div().flex_1().text_size(TEXT.label).text_color(t.dim).child("Remember declined for"))
        .children(
          [...new Set([...PRESETS, current])].map((p) =>
            this.button(`decline-for-${p}`, p, (cx) => this.setDeclineFor(p, cx), t, { primary: p === current, muted: p !== current }),
          ),
        ),
    );
    return root.child(body);
  }
}
