// The sidebar's last line: Settings, Mod settings, Update and Add machine as icons. Herdr's
// own footer gives each a labelled row, which costs twice the height. Mod settings
// opens My Config, and shows only when that mod is installed. Update shows when the
// herdr-setup repo is installed here (install.sh records where, in herdr-mods/herdr-setup.json):
// it checks GitHub every setup.check_every, puts a dot on the button when there are new
// commits, and runs the repo's update.sh when clicked.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, readTextFile, appHome, home, exec, notify, checking } from "herdr";
import { Icon, SIZE } from "./ui.js";
import { DEFAULT_SETTINGS } from "./spaces.js";
import { loadSettings, duration } from "../settings.js";

// update.sh's exit codes that mean "stopped on purpose, nothing changed".
const STOPPED = { 2: "uncommitted changes in the repo", 3: "changes in the app not captured yet", 4: "local commits not pushed" };

export class Footer {
  init(_given, cx) {
    this.hasConfig = false;
    this.repo = null;
    this.behind = 0;
    this.updating = false;
    // shortcut: checked once, so installing My Config shows the button after the next reload.
    readTextFile(`${appHome()}/mods/my-config/mod.json`)
      .then((raw) => {
        this.hasConfig = raw !== null;
        cx?.notify();
      })
      .catch(() => {});
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        this.repo = JSON.parse((await readTextFile(`${home()}/.config/herdr-mods/herdr-setup.json`)) ?? "null")?.repo ?? null;
      } catch {
        this.repo = null;
      }
      if (!this.repo) return;
      const { settings } = await loadSettings("my-sidebar", DEFAULT_SETTINGS);
      cx.notify();
      this.check(cx);
      cx.timer.every(duration(settings.setup.check_every, 3600000), (cx) => this.check(cx));
    });
  }

  check(cx) {
    cx.spawn(async (cx) => {
      const r = await exec(`${this.repo}/update.sh`, ["--check"], { cwd: this.repo, timeout: 60000 }).catch(() => null);
      const behind = r?.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
      // Tell once per new batch, not on every check.
      if (behind > this.behind)
        notify({
          title: `herdr-setup: ${behind} update${behind === 1 ? "" : "s"}`,
          body: "Click Update (↓) in the sidebar footer to install.",
          level: "info",
        });
      this.behind = behind;
      cx.notify();
    });
  }

  update(cx) {
    if (this.updating) return;
    this.updating = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(`${this.repo}/update.sh`, [], { cwd: this.repo, timeout: 300000 }).catch((e) => ({ code: 1, stdout: String(e) }));
      const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
      if (r.code === 0)
        notify({
          title: lines[0] === "Up to date." ? "herdr-setup is up to date" : "herdr-setup updated",
          body: lines[0] === "Up to date." ? "Nothing new on GitHub." : lines.slice(0, 6).join("\n"),
          level: "success",
        });
      else
        notify({
          title: STOPPED[r.code] ? `Not updated: ${STOPPED[r.code]}` : "Update failed",
          body: lines.slice(0, 8).join("\n") || (r.stderr ?? "").trim(),
          level: STOPPED[r.code] ? "warning" : "error",
          timeout: 15000,
        });
      this.updating = false;
      this.check(cx);
    });
  }

  button(id, label, action, t, icons) {
    return h_flex()
      .id(id)
      .h(SIZE.icon)
      .px(6)
      .gap(3)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .accessibility_label(label)
      .tooltip(label)
      .on_click(action)
      .children(icons);
  }

  render() {
    const t = theme();
    const dot = () => div().size(6).rounded_full().bg(t.accent);
    const updateDot = updates().app.ready ? [dot()] : [];
    const setupLabel = this.updating
      ? "Updating herdr-setup…"
      : this.behind
        ? `herdr-setup: ${this.behind} update${this.behind === 1 ? "" : "s"}, click to install`
        : "herdr-setup is up to date (click to check and update)";
    return h_flex()
      .id("sidebar-footer")
      .size_full()
      .px(8)
      .gap(2)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.button("settings", "Settings", () => run("app.settings"), t, [
          Icon("settings"),
          ...updateDot,
        ]),
      )
      .when(this.hasConfig, (el) =>
        el.child(
          this.button("mod-settings", "Mod settings", () => run("mod.open", { name: "my-config" }), t, [
            Icon("sliders"),
          ]),
        ),
      )
      .when(Boolean(this.repo), (el) =>
        el.child(
          this.button("setup-update", setupLabel, (_e, cx) => this.update(cx), t, [
            this.updating ? Icon("spinner").spin(900) : Icon("download"),
            ...(this.behind && !this.updating ? [dot()] : []),
          ]),
        ),
      )
      .child(
        this.button("machine", "Add machine", () => run("mod.open", { name: "machine-add" }), t, [
          Icon("plus", 12),
          Icon("server"),
        ]),
      );
  }
}
