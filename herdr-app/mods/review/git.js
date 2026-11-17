// Review's git reads, and the parsing that turns their output into files, rows and a tree.
// No Herdr imports: main.js hands in git(args) (run in the repo's top folder), read(path)
// (a file there) and pause() (a yield to the host), so node can run this against a real repo too.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
// Fixed prefixes whatever the user's diff config says, so paths parse the same everywhere.
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
// git's empty tree: what a repo without commits is compared with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// changed: added + deleted lines above which a view isn't loaded (exec returns at most 8 MiB).
export const CAP = { files: 1000, lines: 1500, chars: 4000, changed: 100000, commits: 200 };

const out = (r, args) => {
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed (exit ${r.code})`);
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

// Where HEAD is, the base it's compared with, and how far apart. The base: picked (as is), else
// the default (fallback): the freshest of want or origin/HEAD's branch.
export async function info(git, want, picked) {
  const head = await quiet(git, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = await quiet(git, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const named = want || (await defaultBase(git));
  const fallback = named && (await freshest(git, named));
  const kept = picked && (await quiet(git, ["rev-parse", "--verify", "-q", `${picked}^{commit}`])) ? picked : null;
  const base = kept ?? fallback;
  let mergeBase = null, ahead = 0, behind = 0;
  if (head && base) {
    mergeBase = await quiet(git, ["merge-base", base, "HEAD"]);
    const counts = await quiet(git, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
    if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);
  }
  return { head, branch, base, fallback, mergeBase, ahead, behind };
}

// origin/HEAD's branch, else main or master.
async function defaultBase(git) {
  const remote = await quiet(git, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (remote && remote !== "origin/HEAD") return remote.replace(/^origin\//, "");
  for (const name of ["main", "master"]) if (await quiet(git, ["rev-parse", "--verify", "-q", `${name}^{commit}`])) return name;
  return null;
}

// A local branch only while it holds everything origin's has (workers branch from an
// unpushed local main); a stale one would drag in every commit it's missing.
async function freshest(git, name) {
  const local = await quiet(git, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  const remote = await quiet(git, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`]);
  if (local && remote) return (await git(["merge-base", "--is-ancestor", remote, local])).code === 0 ? name : `origin/${name}`;
  if (remote) return `origin/${name}`;
  return (await quiet(git, ["rev-parse", "--verify", "-q", `${name}^{commit}`])) ? name : null;
}

// The base picker's list: every local branch and origin's, last committed to first, as
// {name, at}; the given ones (the default, the base) on top, the branch under review (skip) left out.
export async function branches(git, first, skip) {
  const text = (await quiet(git, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes/origin"])) ?? "";
  const all = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, at] = line.split("\t");
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ""), at: Number(at) || 0 };
    })
    .filter((b) => b.name !== "origin/HEAD" && b.name !== skip);
  const top = [...new Set(first.filter(Boolean))].map((name) => all.find((b) => b.name === name) ?? { name, at: 0 });
  return [...top, ...all.filter((b) => !top.some((t) => t.name === b.name))];
}

// range: ["<merge-base>..HEAD"] for a branch, ["-n", "30", "HEAD"] for recent ones. At most CAP.commits.
export async function commits(git, range) {
  const text = (await quiet(git, ["log", "-n", String(CAP.commits), "--format=%H%x1f%h%x1f%s%x1f%at%x1e", ...range])) ?? "";
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
// (and untracked files) against that commit, or against nothing when it's null. Over
// CAP.changed lines it returns only the counts, as {big: {files, add, del}}.
export async function changes(git, read, spec, pause) {
  const [cmd, ...opts] = spec.sha ? ["show", "--format=", "--diff-merges=first-parent"] : ["diff"];
  const rev = spec.sha ?? spec.from ?? EMPTY_TREE;
  const run = async (more) => {
    const args = [cmd, ...opts, ...more, rev];
    return out(await git(args), args);
  };
  const paths = spec.sha ? [] : out(await git(["ls-files", "--others", "--exclude-standard", "-z"]), ["ls-files"]).split("\0").filter(Boolean);
  const big = { files: paths.length, add: 0, del: 0 };
  for (const line of (await run(["--numstat", "--no-ext-diff", "--no-textconv", "-M"])).split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    big.files++;
    big.add += Number(add) || 0;
    big.del += Number(del) || 0;
  }
  if (big.add + big.del > CAP.changed) return { files: [], limited: false, big };
  const files = await parsePatch(await run(DIFF), pause);
  await markWords(files, pause);
  const total = files.length + paths.length;
  for (const path of paths.slice(0, Math.max(0, CAP.files - files.length))) files.push(await untracked(path, read));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, CAP.files), limited: total > CAP.files, big: null };
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

// Herdr ends a task that runs JS for about 0.5 s without yielding (silently: no throw, no
// finally), and a big patch takes seconds there, so long loops call this, which pauses every 50 ms.
function pacer(pause) {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < 50) return;
    await pause();
    since = Date.now();
  };
}

export async function parsePatch(text, pause = async () => {}) {
  const files = [];
  const tick = pacer(pause);
  let file = null, n = 0;
  for (const line of text.split("\n")) {
    if (++n % 500 === 0) await tick();
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
  file.lines = file.lines.slice(0, CAP.lines).map((l) => (l.length > CAP.chars ? `${l.slice(0, CAP.chars)}… (line truncated)` : l));
  file.rows = null;
  if (file.status !== "A" && file.status !== "D") rows(file);
  return file;
}

// A file's numbered rows and widest line, made once. A new or deleted file's wait until it's
// opened: on a big branch they're most of the lines, and numbering them most of the load.
export function rows(file) {
  if (file.rows) return file.rows;
  file.rows = diffRows(file.lines);
  file.width = Math.max(0, ...file.rows.map((r) => r.text.length));
  delete file.lines;
  return file.rows;
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

// A token is a run of word characters, a run of spaces, or one other character.
const TOKEN = /\w+|\s+|[^\w\s]/g;
// PAIR: the share of tokens a removed and an added line need in common to pair. Blocks over
// BLOCK removed × added lines pair line for line; LCS tables over CELLS mark the middle whole.
const WORDS = { PAIR: 0.5, BLOCK: 400, CELLS: 4096 };

// In changed and renamed files, each removed line and the added line that replaces it get
// row.words: the [start, end) ranges of their text that differ. Other lines get none.
export async function markWords(files, pause = async () => {}) {
  const tick = pacer(pause);
  for (const file of files) {
    if (file.status !== "M" && file.status !== "R") continue;
    const rows = file.rows;
    for (let i = 0; i < rows.length; ) {
      if (rows[i].kind !== "-") {
        i++;
        continue;
      }
      const start = i;
      while (rows[i]?.kind === "-") i++;
      const mid = i;
      while (rows[i]?.kind === "+") i++;
      for (const [del, add] of pairs(rows.slice(start, mid), rows.slice(mid, i))) {
        [del.words, add.words] = wordDiff(del.text, add.text);
        await tick();
      }
      await tick();
    }
  }
}

// Each removed line with the most alike added line after the last one paired, so an inserted
// line doesn't shift the pairs; past WORDS.BLOCK, line i with line i.
function pairs(dels, adds) {
  const bag = (row) => {
    const counts = new Map();
    let n = 0;
    for (const token of row.text.match(TOKEN) ?? []) {
      if (!token.trim()) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
      n++;
    }
    return { counts, n };
  };
  const alike = (a, b) => {
    let common = 0;
    for (const [token, c] of a.counts) common += Math.min(c, b.counts.get(token) ?? 0);
    return a.n + b.n ? (2 * common) / (a.n + b.n) : 0;
  };
  const bags = adds.map(bag);
  const wide = dels.length * adds.length > WORDS.BLOCK;
  const found = [];
  let last = -1;
  for (const [i, del] of dels.entries()) {
    const d = bag(del);
    let best = -1, score = 0;
    for (let j = wide ? i : last + 1; j < (wide ? Math.min(i + 1, adds.length) : adds.length); j++) {
      const s = alike(d, bags[j]);
      if (s >= WORDS.PAIR && s > score) [best, score] = [j, s];
    }
    if (best < 0) continue;
    found.push([del, adds[best]]);
    last = best;
  }
  return found;
}

// The changed ranges of two lines: common tokens trimmed from both ends, then an LCS of the
// tokens left. A changed indent alone isn't marked.
function wordDiff(a, b) {
  const x = a.match(TOKEN) ?? [], y = b.match(TOKEN) ?? [];
  let p = 0, s = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const n = x.length - p - s, m = y.length - p - s;
  const same = (tokens, kept) => tokens.map((_, k) => k < p || k >= tokens.length - s || kept[k - p]);
  const keptX = new Array(n).fill(false), keptY = new Array(m).fill(false);
  if (n * m <= WORDS.CELLS) {
    const w = m + 1, len = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) len[i * w + j] = x[p + i] === y[p + j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (x[p + i] === y[p + j]) keptX[i++] = keptY[j++] = true;
      else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
      else j++;
    }
  }
  return [ranges(x, same(x, keptX)), ranges(y, same(y, keptY))];
}

// Changed tokens as [start, end) ranges, joined across the spaces between them.
function ranges(tokens, same) {
  const out = [];
  let at = 0;
  for (const [k, token] of tokens.entries()) {
    const space = !token.trim();
    const changed = !same[k] ? !(space && k === 0) : space && k > 0 && !same[k - 1] && k + 1 < tokens.length && !same[k + 1];
    if (changed && out.length && out.at(-1)[1] === at) out.at(-1)[1] += token.length;
    else if (changed) out.push([at, at + token.length]);
    at += token.length;
  }
  return out;
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
