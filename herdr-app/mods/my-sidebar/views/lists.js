// Spaces and agents in one block. Combined (the default): tabs for Spaces, with
// each space's tabs and agents under it, and Agents. With `combined: false` in the settings: the
// two lists one above the other, as two blocks of this mod would draw them.
// A tab whose terminals carry an `attention` label (hc label <terminal> attention="<why>", set by
// a script, cockpit-task for a new inbox task, or an agent) shows "Needs your attention" under its
// row until the person has looked at it.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, theme, setAgentOrder, terminals, panes, exec, run } from "herdr";
import { Spaces } from "./spaces.js";
import { Agents } from "./agents.js";
import { TEXT, Badge, Rail } from "./ui.js";

const TABS = ["spaces", "agents"];

export class Lists {
  init(props, cx) {
    this.spaces = new Spaces();
    this.spaces.init(props, cx);
    this.agents = new Agents();
    this.agents.init(props, cx);
    const saved = localStorage.getItem("lists.tab");
    this.tab = TABS.includes(saved) ? saved : "spaces";
    this.seen = null; // { tab, at }: the flagged tab on screen, and since when
    cx.timer.every(1000, () => this.clearSeen());
  }

  // Tab id → its flags: [{ terminal, why }] from the terminals' `attention` labels.
  attention() {
    const tabOf = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.tab]));
    const byTab = new Map();
    for (const term of terminals()) {
      const why = term.labels?.attention;
      const tab = why && tabOf.get(term.address);
      if (tab) byTab.set(tab, [...(byTab.get(tab) ?? []), { terminal: term.address, why }]);
    }
    return byTab;
  }

  // Looked at: with the window in front, a flagged tab shown for 2 s has its flags cleared.
  clearSeen() {
    const tab = focused()?.tab;
    const flags = tab && window.is_window_active() ? this.attention().get(tab) : null;
    if (!flags) return void (this.seen = null);
    if (this.seen?.tab !== tab) return void (this.seen = { tab, at: Date.now() });
    if (Date.now() - this.seen.at < 2000) return;
    this.seen = null;
    for (const f of flags) exec("hc", ["label", f.terminal, "attention="]).catch(() => null);
  }

  attentionRow(w, tab, flags, t) {
    const why = [...new Set(flags.map((f) => f.why))];
    return h_flex()
      .id(`attention-${tab}`)
      .px(8)
      .pb(4)
      .gap(6)
      .min_w(0)
      .items_center()
      .cursor_pointer()
      .tooltip(why.join("\n"))
      .on_click(() => {
        run("space.select", { id: w.id });
        run("tab.select", { id: tab });
      })
      .child(
        div()
          .flex_none()
          .px(6)
          .h(18)
          .rounded(5)
          .bg(t.blocked + "26")
          .text_size(TEXT.avatar)
          .font_semibold()
          .text_color(t.blocked)
          .flex()
          .items_center()
          .child("Needs your attention"),
      )
      .child(div().min_w(0).truncate().text_size(TEXT.label).text_color(t.dim).child(why.join(" · ")));
  }

  pick(tab, cx) {
    this.tab = tab;
    localStorage.setItem("lists.tab", tab);
    cx.notify();
  }

  render() {
    const t = theme();
    const collapsed = this.spaces.collapsed();
    const root = v_flex()
      .id("my-sidebar-lists")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .on_size_change((size, cx) => this.spaces.resized(size, cx));
    this.spaces.under = null;
    this.spaces.quiet = null;
    this.spaces.above = null;
    // The rail has no room for tabs: both lists, as numbers.
    if (!this.spaces.settings.combined || collapsed)
      return root
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(this.spaces.header(t, collapsed))
            .child(this.spaces.body(t, collapsed)),
        )
        .child(v_flex().flex_1().min_h(0).child(this.agents.render()));

    const view = this.agents.readView();
    root.child(this.tabBar(t, view));
    if (this.tab !== "spaces") return root.child(this.agents.render({ view, heading: false }));

    // Spaces, each with its tabs and agents beneath in tab order, so rows don't move as
    // their state changes; next-agent keys follow that order.
    const nested = { ...view, sort: { id: "grouped" }, byPriority: false, nested: true };
    const order = [];
    const all = agents();
    // Pinned agents go above every space, in the Agents tab's Pinned group.
    const pinned = view.groups.find((g) => g.id === "pinned");
    const pins = pinned?.members.map((a) => a.address) ?? [];
    order.push(...pins);
    this.spaces.above = () => (pinned ? this.agents.groupRows(pinned, 0, view, t) : []);
    const nest = (lines, row) => h_flex().children(lines.map((l) => Rail(l))).child(row.flex_1().min_w(0));
    // A space's agents hang from its line; a main space's worktrees come after them,
    // so its line carries on, and a worktree's own agents sit one step further in.
    // Every tab shows: a tab with agents as its agents, any other as itself.
    const shownTab = focused()?.tab;
    const plain = (tab) => !all.some((a) => a.tab === tab.id);
    const flagged = this.attention();
    this.spaces.under = ({ w, tree, kids }) => {
      const items = w.tabs.flatMap((tab) =>
        plain(tab)
          ? tab.settled && !flagged.has(tab.id) ? [] : [{ tab }]
          : all.filter((a) => a.tab === tab.id && !pins.includes(a.address)).map((a) => ({ a })),
      );
      // The flag goes under the first row of its tab.
      const flagAt = new Map();
      items.forEach((x, i) => {
        const tab = x.a ? x.a.tab : x.tab.id;
        if (flagged.has(tab) && !flagAt.has(tab)) flagAt.set(tab, i);
      });
      order.push(...items.filter((x) => x.a).map((x) => x.a.address));
      const before = tree ? [tree.startsWith("└") ? "" : "│"] : [];
      return items.flatMap((x, i) => {
        const last = i === items.length - 1 && !kids;
        const [row, ...subs] = x.a
          ? this.agents.agentWithSubs(x.a, i, nested, t)
          : [this.agents.tabRow(w, x.tab, x.tab.id === shownTab, t)];
        const tab = x.a ? x.a.tab : x.tab.id;
        if (flagAt.get(tab) === i) subs.unshift(this.attentionRow(w, tab, flagged.get(tab), t));
        return [nest([...before, last ? "└" : "├"], row), ...subs.map((s) => nest([...before, last ? "" : "│"], s))];
      });
    };
    // One row lit: a space whose focused agent or tab shows beneath it leaves it to that row.
    this.spaces.quiet = (w) =>
      all.some((a) => a.space === w.id && a.focused) || w.tabs.some((tab) => tab.id === shownTab && plain(tab));
    const body = this.spaces.body(t, false);
    setAgentOrder(order);
    return root.child(body);
  }

  // Tabs side by side from the left, the picked one filled.
  tabBar(t, view) {
    const tab = (id, label, count) =>
      h_flex()
        .id(`lists-tab-${id}`)
        .px(10)
        .h(24)
        .gap(5)
        .justify_center()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(TEXT.label)
        .font_medium()
        .text_color(this.tab === id ? t.foreground : t.dim)
        .when(this.tab === id, (el) => el.bg(t.selected))
        .when(this.tab !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => this.pick(id, cx))
        .child(label)
        // The count badge the group headers use.
        .when(count !== null, (el) => el.child(Badge(count)));
    return h_flex()
      .px(8)
      .pt(6)
      .pb(6)
      .mb(4)
      .border_b(1)
      .border_color(t.border)
      .flex_none()
      .gap(6)
      .items_center()
      .child(
        h_flex()
          .flex_1()
          .gap(2)
          .child(tab("spaces", "Spaces", null))
          .child(tab("agents", "Agents", view.count)),
      )
      .child(this.tab === "spaces" ? this.spaces.newSpaceButton() : this.agents.sortMenu());
  }
}
