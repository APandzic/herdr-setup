// Review's git reads, and the parsing that turns their output into files, rows and a tree.
// No Herdr imports: main.js hands in git(args) (run in the repo's top folder) and read(path)
// (a file there), so node can run this against a real repo too.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
// Fixed prefixes whatever the user's diff config says, so paths parse the same everywhere.
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
// git's empty tree: what a repo without commits is compared with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const CAP = { files: 1000, lines: 1500, chars: 4000 };

const out = (r) => {
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout;
};
const quiet = async (git, args) => {
  const r = await git(args);
  return r.code === 0 ? r.stdout.trim() : null;
};

// FNV-1a: a short, stable fingerprint of a file's diff, to key its Viewed mark to.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Where HEAD is, the base it's compared with, and how far apart they are.
export async function info(git, base) {
  const head = await quiet(git, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = await quiet(git, ["symbolic-ref", "--short", "-q", "HEAD"]);
  base ||= await defaultBase(git);
  let mergeBase = null, ahead = 0, behind = 0;
  if (head && base) {
    mergeBase = await quiet(git, ["merge-base", base, "HEAD"]);
    const counts = await quiet(git, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
    if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);
  }
  return { head, branch, base, mergeBase, ahead, behind };
}

// origin/HEAD's branch, the local one when it exists: workers branch from the local main.
async function defaultBase(git) {
  const remote = await quiet(git, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const names = remote && remote !== "origin/HEAD" ? [remote.replace(/^origin\//, ""), remote] : ["main", "master"];
  for (const name of names) if (await quiet(git, ["rev-parse", "--verify", "-q", `${name}^{commit}`])) return name;
  return null;
}

// range: ["<merge-base>..HEAD"] for a branch, ["-n", "30", "HEAD"] for recent ones.
export async function commits(git, range) {
  const text = (await quiet(git, ["log", "--format=%H%x1f%h%x1f%s%x1f%at%x1e", ...range])) ?? "";
  return text
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [sha, short, subject, at] = s.split("\x1f");
      return { sha, short, subject, at: Number(at) };
    });
}

// One view's files, in path order. spec: {sha} for one commit, else {from}: the work tree
// (and untracked files) against that commit, or against nothing when it's null.
export async function changes(git, read, spec) {
  const args = spec.sha ? ["show", "--format=", "--diff-merges=first-parent", ...DIFF, spec.sha] : ["diff", ...DIFF, spec.from ?? EMPTY_TREE];
  const files = parsePatch(out(await git(args)));
  let total = files.length;
  if (!spec.sha) {
    const paths = out(await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    total += paths.length;
    for (const path of paths.slice(0, Math.max(0, CAP.files - files.length))) files.push(await untracked(path, read));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, CAP.files), limited: total > CAP.files };
}

// An untracked file reads as all added, as Changes shows it.
async function untracked(path, read) {
  const file = { path, from: null, status: "A", add: 0, del: 0, lines: [], note: null };
  const text = await read(path).catch(() => null);
  if (text === null) file.note = "Cannot preview this file (binary, too large, or unreadable)";
  else if (text.includes("\0")) file.note = "Binary file";
  else if (text) {
    const body = text.replace(/\n$/, "").split("\n");
    file.add = body.length;
    file.lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
  }
  return finish(file);
}

// git quotes a path with tabs, quotes or backslashes in it ("a/x\ty").
function unquote(s) {
  if (!s.startsWith('"')) return s;
  return s.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ t: "\t", n: "\n" })[c] ?? c);
}

// "diff --git a/<p> b/<p>": both halves are the same path when nothing was renamed.
function headerPath(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) return unquote(rest.slice(0, rest.indexOf('" ') + 1)).slice(2);
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

export function parsePatch(text) {
  const files = [];
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (file) files.push(finish(file));
      file = { path: headerPath(line), from: null, status: "M", add: 0, del: 0, lines: [], note: null };
    } else if (!file) {
      continue;
    } else if (file.lines.length) {
      if (line.startsWith("+")) file.add++;
      else if (line.startsWith("-")) file.del++;
      if (/^[-+ @\\]/.test(line)) file.lines.push(line);
    } else if (line.startsWith("@@")) file.lines.push(line);
    else if (line.startsWith("new file mode")) file.status = "A";
    else if (line.startsWith("deleted file mode")) file.status = "D";
    else if (line.startsWith("rename from ")) file.from = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) {
      file.path = unquote(line.slice(10));
      file.status = "R";
    }
    else if (line.startsWith("Binary files ")) file.note = "Binary file";
  }
  if (file) files.push(finish(file));
  return files;
}

// The hash covers the whole diff; what's kept to draw is capped as in Changes.
function finish(file) {
  file.hash = hash(`${file.from ?? ""}\n${file.note ?? ""}\n${file.lines.join("\n")}`);
  file.more = Math.max(0, file.lines.length - CAP.lines);
  file.rows = diffRows(file.lines.slice(0, CAP.lines).map((l) => (l.length > CAP.chars ? `${l.slice(0, CAP.chars)}… (line truncated)` : l)));
  file.width = Math.max(0, ...file.rows.map((r) => r.text.length));
  delete file.lines;
  return file;
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
    }
    const kind = line[0], text = untab(line.slice(1)) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, new: next++, text };
    if (kind === " ") return { kind, old: old++, new: next++, text };
    return { kind: "", text: line };
  });
}

// The file tree's rows: folders first, then files, by name; a folder holding only one
// folder is folded into it ("herdr-app/mods/review/"). Its file order is the diff's.
export function tree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/"), name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name, file });
  }
  const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const rows = [];
  const walk = (node, depth) => {
    for (const [name, dir] of [...node.dirs].sort(byName)) {
      let label = `${name}/`, inner = dir;
      while (!inner.files.length && inner.dirs.size === 1) {
        const [[next, child]] = inner.dirs;
        label += `${next}/`;
        inner = child;
      }
      rows.push({ kind: "dir", name: label, depth });
      walk(inner, depth + 1);
    }
    for (const { name, file } of node.files.sort((a, b) => byName([a.name], [b.name]))) rows.push({ kind: "file", name, depth, file });
  };
  walk(root, 0);
  return rows;
}
