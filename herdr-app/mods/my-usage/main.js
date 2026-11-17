// My Usage: your plan limits in the sidebar, between the lists and the footer.
// One row per service: its logo from Herdr's program table, then a line per limit with
// its bar, used % and time to reset; a click shows the plan, when each limit resets and
// how fresh the numbers are, and the block grows to fit.
// Where the numbers come from (no login token is read, nothing is sent):
//   Claude  ~/.cache/claude-usage/rate-limits.json, saved by ~/.claude/statusline-command.sh
//           from what Claude Code hands its status line, the only place it gives its
//           limits; the plan from ~/.claude.json's oauthAccount.
//   Codex   the last rate_limits in its newest session file, if it ran in the last week.
// Each is as fresh as that program's last reply; a limit past its reset time shows 0%.
// Modeled on over9k-usage (see NOTICE).
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, home, run, shared, setShared, readTextFile, checking, knownAgents } from "herdr";
import { loadSettings, duration } from "./settings.js";

const DEFAULT_SETTINGS = { refresh_every: "30s", codex: true };
const BLOCK = "usage";
const ROW = 28;
// A limit's line in a row, 3 px apart, and a line of an opened row's details.
const LINE = 16;
const FACT = 18;
const PAD = 6;

const LIMITS_FILE = ".cache/claude-usage/rate-limits.json";
// Each file's modification time in seconds, or an empty line when it's missing.
const MTIMES = `for f; do stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo; done`;
const CODEX = `f=$(ls -t "$HOME"/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | head -n 1)
[ -n "$f" ] && [ -n "$(find "$f" -mtime -7)" ] && { stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"; grep '"rate_limits"' "$f" | tail -n 1; }`;
const PLANS = { claude_pro: "Pro", claude_max: "Max", claude_team: "Team", claude_enterprise: "Enterprise" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const icon = (name) => svg(`mods/my-usage/icons/${name}.svg`).size(12).flex_none();

// A program's icon from the app's program table, as the sidebar draws agents.
function logo(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

// Seconds as "12m", "3h 54m", "6d 23h".
function left(s) {
  s = Math.max(0, Math.round(s));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// Unix seconds as "14:30" when it's today, "Sat 09:00" otherwise.
function clock(at) {
  const d = new Date(at * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

// 300 minutes is "5h", 10080 is "7d".
function windowName(min) {
  if (!min) return "Limit";
  return min % 1440 === 0 ? `${min / 1440}d` : min % 60 === 0 ? `${min / 60}h` : `${min}m`;
}

// A limit: its label, used % (0 once it has reset), seconds until it resets and when.
function limit(label, used, resetsAt, now) {
  if (resetsAt && resetsAt <= now) return { label, used: 0, left: null, at: null };
  return { label, used: Math.max(0, Math.min(100, used ?? 0)), left: resetsAt ? resetsAt - now : null, at: resetsAt || null };
}

// How long ago the numbers were saved, as "3m ago".
function ago(savedAt, now) {
  return savedAt ? `${left(now - savedAt)} ago` : null;
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// rate_limits wherever it sits in a Codex session line.
function findRateLimits(value) {
  if (!value || typeof value !== "object") return null;
  if (value.rate_limits) return value.rate_limits;
  for (const v of Object.values(value)) {
    const found = findRateLimits(v);
    if (found) return found;
  }
  return null;
}

export default class MyUsage extends View {
  init(_given, cx) {
    this.settings = DEFAULT_SETTINGS;
    this.services = [];
    this.open = new Set(shared("my-usage.open") ?? []);
    this.height = 0;
    this.accountAt = null;
    this.programs = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      const { settings } = await loadSettings("my-usage", DEFAULT_SETTINGS);
      this.settings = settings;
      await this.load();
      cx.notify();
      cx.timer.every(duration(settings.refresh_every, 30000), (cx) =>
        cx.spawn(async (cx) => {
          await this.load();
          cx.notify();
        }),
      );
    });
  }

  async load() {
    if (!this.programs) {
      const known = await knownAgents().catch(() => null);
      if (known) this.programs = Object.fromEntries(known.map((p) => [p.key, p]));
    }
    const now = Date.now() / 1000;
    const limitsPath = `${home()}/${LIMITS_FILE}`;
    const accountPath = `${home()}/.claude.json`;
    const times = await exec("sh", ["-c", MTIMES, "sh", limitsPath, accountPath]).catch(() => null);
    const [limitsAt, accountAt] = (times?.stdout ?? "").split("\n").map((x) => Number(x) || null);
    // ~/.claude.json is large and changes rarely: read it again only when it has.
    if (accountAt !== this.accountAt) {
      this.accountAt = accountAt;
      this.account = parse(await readTextFile(accountPath).catch(() => null))?.oauthAccount ?? null;
    }
    const saved = limitsAt ? parse(await readTextFile(limitsPath).catch(() => null)) : null;
    this.services = [{ ...this.claude(saved, limitsAt, now), program: this.programs?.claude }];
    if (this.settings.codex) {
      const out = await exec("sh", ["-c", CODEX]).catch(() => null);
      const [savedAt, ...line] = (out?.stdout ?? "").split("\n");
      const codex = findRateLimits(parse(line.join("\n").trim()));
      const limits = [codex?.primary, codex?.secondary]
        .filter(Boolean)
        .map((w) => limit(windowName(w.window_minutes), w.used_percent, w.resets_at, now));
      const plan = codex?.plan_type ? codex.plan_type.replace(/^\w/, (c) => c.toUpperCase()) : null;
      if (limits.length)
        this.services.push({
          key: "codex",
          name: "Codex",
          from: "Codex",
          plan,
          limits,
          ago: ago(Number(savedAt), now),
          program: this.programs?.codex,
        });
    }
    this.fit();
  }

  claude(saved, savedAt, now) {
    const a = this.account;
    const plan = a ? a.planDisplayName?.replace(/^claude\s+/i, "") || PLANS[a.organizationType] || null : null;
    const row = { key: "claude", name: "Claude", from: "Claude Code", plan };
    if (!a)
      return {
        ...row,
        note: "Not logged in",
        tip: "No Claude account in ~/.claude.json. Run claude and /login. Billed by use (an API key, Bedrock) has no plan limits.",
      };
    const limits = [
      saved?.five_hour && limit("5h", saved.five_hour.used_percentage, saved.five_hour.resets_at, now),
      saved?.seven_day && limit("7d", saved.seven_day.used_percentage, saved.seven_day.resets_at, now),
    ].filter(Boolean);
    if (!limits.length)
      return {
        ...row,
        note: "No limits yet",
        tip: `Saved in ~/${LIMITS_FILE} by your Claude Code status line (~/.claude/statusline-command.sh) after Claude Code's next reply.`,
      };
    return { ...row, limits, ago: ago(savedAt, now) };
  }

  // A row is as tall as its limits' lines; one with a note or one limit is ROW.
  rowHeight(s) {
    return s.limits ? Math.max(ROW, s.limits.length * (LINE + 3) + 4) : ROW;
  }

  // What an opened row adds to the closed one: plan, reset times, freshness.
  facts(s) {
    return [
      s.plan && ["Plan", s.plan],
      ...s.limits.filter((l) => l.at).map((l) => [`${l.label} resets`, clock(l.at)]),
      s.ago && ["Updated", s.ago],
    ].filter(Boolean);
  }

  // The block's height: every row, plus the open ones' details.
  fit() {
    const h =
      PAD +
      this.services.reduce(
        (n, s) => n + this.rowHeight(s) + (this.open.has(s.key) && s.limits ? this.facts(s).length * FACT + 4 : 0),
        0,
      );
    if (h !== this.height) {
      this.height = h;
      run("layout.resize", { id: BLOCK, px: h });
    }
  }

  toggle(key, cx) {
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
    setShared("my-usage.open", [...this.open]);
    this.fit();
    cx.notify();
  }

  color(t, used) {
    return used >= 80 ? t.ansi1 : used >= 50 ? t.ansi3 : t.ansi2;
  }

  // A limit's line: label, bar, used % and time left. Fixed widths keep the lines aligned.
  line(l, t) {
    return h_flex()
      .h(LINE)
      .items_center()
      .gap(6)
      .child(div().w(16).flex_none().text_size(10.5).text_color(t.muted).child(l.label))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .h(4)
          .rounded(2)
          .bg(t.raised)
          .child(
            div()
              .h(4)
              .rounded(2)
              .bg(this.color(t, l.used))
              .w(`${Math.max(l.used > 0 ? 3 : 0, l.used)}%`),
          ),
      )
      .child(
        div()
          .w(32)
          .flex_none()
          .flex()
          .justify_end()
          .text_size(11.5)
          .text_color(this.color(t, l.used))
          .child(`${Math.round(l.used)}%`),
      )
      .child(
        div()
          .w(44)
          .flex_none()
          .flex()
          .justify_end()
          .text_size(10.5)
          .text_color(t.dim)
          .child(l.left != null ? left(l.left) : ""),
      );
  }

  row(s, t) {
    const open = this.open.has(s.key);
    const pic = logo(s.program, 14, t.foreground);
    const head = s.plan ? `${s.name} · ${s.plan}` : s.name;
    const tip = s.note
      ? `${head}\n${s.tip}`
      : [
          head,
          ...s.limits.map((l) => `${l.label}: ${Math.round(l.used)}%${l.left != null ? `, resets in ${left(l.left)}` : ""}`),
          ...(s.ago ? [`As of ${s.from}'s reply ${s.ago}`] : []),
        ].join("\n");
    return h_flex()
      .id(`usage-${s.key}`)
      .h(this.rowHeight(s))
      .flex_none()
      .px(6)
      .gap(6)
      .items_center()
      .rounded(7)
      .tooltip(tip)
      .when(!s.note, (el) =>
        el
          .cursor_pointer()
          .hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => this.toggle(s.key, cx)),
      )
      .when(Boolean(pic), (el) => el.child(pic))
      .when(!pic, (el) => el.child(div().min_w(0).truncate().text_color(t.muted).child(s.name)))
      .when(Boolean(s.note), (el) =>
        el.child(div().flex_1()).child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(s.note)),
      )
      .when(Boolean(s.limits), (el) =>
        el.child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(3)
            .children(s.limits.map((l) => this.line(l, t))),
        ),
      )
      .when(!s.note, (el) => el.child(icon(open ? "chevron-down" : "chevron-right").text_color(t.dim)));
  }

  // Under the logo's column, values flush with the time column above.
  details(s, t) {
    return v_flex()
      .pl(s.program?.icon ? 26 : 6)
      .pr(24)
      .pb(4)
      .children(
        this.facts(s).map(([name, value]) =>
          h_flex()
            .h(FACT)
            .items_center()
            .justify_between()
            .gap(6)
            .text_size(11)
            .child(div().flex_none().text_color(t.dim).child(name))
            .child(div().min_w(0).truncate().text_color(t.muted).child(value)),
        ),
      );
  }

  render() {
    const t = theme();
    return v_flex()
      .id("my-usage")
      .size_full()
      .pt(PAD / 2)
      .px(8)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .children(
        this.services.map((s) =>
          v_flex()
            .w_full()
            .child(this.row(s, t))
            .when(this.open.has(s.key) && Boolean(s.limits), (el) => el.child(this.details(s, t))),
        ),
      );
  }
}
