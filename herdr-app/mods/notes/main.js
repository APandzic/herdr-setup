// Notes: a plain-text pad in a floating window over the layout, kept in ~/.herdr/notes.md.
// mod.open:notes (cmd-j) opens it and hides it again (mod.json's overlay). It saves a moment after
// typing stops and when it's hidden, and reads the file every second while open, so lines added
// outside (bin/note, an agent) show up; an outside change made while you type is merged in.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, readTextFile, writeTextFile, exec, theme, home, checking, closeOverlay } from "herdr";

const FILE = ".herdr/notes.md"; // under home
const TICK = 1000; // how often the file is read while open
const SAVE_AFTER = 400; // quiet time after typing before saving
const TITLE = 30;

const tilde = (path) => (path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path);

// What changed from a to b, as one replaced range of a: [start, end) became text.
export function splice(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let tail = 0;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { start, end: a.length - tail, text: b.slice(start, b.length - tail) };
}

// Both sides changed base: apply the two edits when they don't touch (mine first at the same spot,
// on its own line when theirs starts one: a note added while you type the last line); else keep
// mine and append what theirs added, so neither side's new text is lost.
export function merge(base, mine, theirs) {
  const m = splice(base, mine);
  const o = splice(base, theirs);
  const [first, second] = m.start <= o.start ? [m, o] : [o, m];
  const same = m.start === o.start;
  if (first.end <= second.start && !(same && m.end > m.start && o.end > o.start)) {
    const lineStart = first.start === 0 || base[first.start - 1] === "\n";
    const gap = same && lineStart && m.text && o.text && !m.text.endsWith("\n") ? "\n" : "";
    return base.slice(0, first.start) + first.text + gap + base.slice(first.end, second.start) + second.text + base.slice(second.end);
  }
  if (!o.text) return mine;
  return mine + (mine.endsWith("\n") || !mine ? "" : "\n") + o.text;
}

// Where an offset in a lands in b, given splice(a, b).
const moved = (at, s) => (at <= s.start ? at : at >= s.end ? at + s.text.length - (s.end - s.start) : s.start + s.text.length);

export default class Notes extends View {
  init(_props, cx) {
    this.file = `${home()}/${FILE}`;
    this.saved = null; // the file as last read or written; null: no file yet
    this.loaded = false;
    this.edited = 0; // when unsaved typing last happened; 0: nothing unsaved
    this.error = null;
    this.text = TextareaState.new({ placeholder: "Jot something down…" });
    this.text.on("change", (_e, cx) => {
      if (this.setting) return;
      const was = this.edited;
      this.edited = Date.now();
      if (!was) cx.notify();
    });
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.sync(cx);
      this.text.focus();
      for (;;) {
        await cx.sleep(this.edited ? SAVE_AFTER / 2 : TICK);
        await this.sync(cx);
      }
    });
  }

  // On hide: write what's still unsaved, merged with the file if it moved meanwhile.
  async close() {
    if (!this.loaded || !this.edited) return;
    const mine = this.text.value();
    try {
      await writeTextFile(this.file, mine, this.saved);
    } catch {
      const disk = await readTextFile(this.file).catch(() => null);
      await writeTextFile(this.file, merge(this.saved ?? "", mine, disk ?? ""), disk).catch(() => {});
    }
  }

  // Shows text in the pad, keeping the caret (and selection) on the same text.
  show(text) {
    const before = this.text.value();
    if (text === before) return;
    const s = splice(before, text);
    const sel = this.text.selected_range();
    this.setting = true;
    try {
      this.text.set_value(text);
      if (this.loaded) this.text.set_selected_range({ start: moved(sel.start, s), end: moved(sel.end, s) });
    } finally {
      this.setting = false;
    }
  }

  // One pass: take in outside changes, then save if typing has paused.
  async sync(cx) {
    let disk;
    try {
      disk = await readTextFile(this.file);
    } catch (e) {
      this.fail(`Can't read ${tilde(this.file)}: ${e?.message ?? e}`, cx);
      return;
    }
    if (!this.loaded) {
      this.saved = disk;
      this.show(disk ?? "");
      this.loaded = true;
      cx.notify();
      return;
    }
    if (disk !== this.saved) {
      const mine = this.text.value();
      this.show(this.edited ? merge(this.saved ?? "", mine, disk ?? "") : disk ?? "");
      this.saved = disk;
      if (this.edited && this.text.value() === (disk ?? "")) this.edited = 0;
      cx.notify();
    }
    if (this.edited && Date.now() - this.edited >= SAVE_AFTER) await this.save(cx);
  }

  async save(cx) {
    const text = this.text.value();
    const at = this.edited;
    try {
      if (this.saved === null) await exec("mkdir", ["-p", this.file.slice(0, this.file.lastIndexOf("/"))]);
      await writeTextFile(this.file, text, this.saved);
    } catch (e) {
      // Refused when the file changed since it was read: the next pass merges and saves again.
      const disk = await readTextFile(this.file).catch(() => this.saved);
      if (disk === this.saved) this.fail(`Can't save ${tilde(this.file)}: ${e?.message ?? e}`, cx);
      return;
    }
    this.saved = text;
    if (this.edited === at) this.edited = 0;
    this.error = null;
    cx.notify();
  }

  fail(message, cx) {
    if (this.error === message) return;
    this.error = message;
    cx.notify();
  }

  hide() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const status = this.error ? "Not saved" : !this.loaded ? "Loading…" : this.edited ? "Editing" : "Saved";
    return v_flex()
      .id("notes")
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.hide();
        }
      })
      .child(
        // Not stopped, so a press here drags the window.
        h_flex()
          .id("notes-title")
          .flex_none()
          .h(TITLE)
          .pl(12)
          .pr(4)
          .gap(8)
          .items_center()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .cursor_grab()
          .child(div().flex_1().text_size(12.5).font_semibold().child("Notes"))
          .child(
            div()
              .id("notes-status")
              .flex_none()
              .text_size(11)
              .text_color(this.error ? t.blocked : t.dim)
              .tooltip(this.error ?? tilde(this.file))
              .child(status),
          )
          .child(
            div()
              .id("notes-close")
              .flex_none()
              .size(22)
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Hide (Esc or cmd-j)")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click(() => this.hide())
              .child("✕"),
          ),
      )
      .child(
        // Stopped, so a press here places the caret instead of dragging.
        div()
          .id("notes-body")
          .flex_1()
          .min_h(0)
          .p(10)
          .cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.text).size_full().text_size(13).text_color(t.foreground)),
      );
  }
}
