// Every file that carries the release version, how to read each site in it
// and how to rewrite it. `check-versions.mjs` and `bump-version.mjs` are
// thin fronts over this; a new place the version lives is added here once.
//
// Sites, all of which must equal `[workspace.package] version` in Cargo.toml:
//   Cargo.toml                       the workspace version itself
//   Cargo.lock                       every workspace member (version.workspace = true)
//   crates/iroh-mobile/Cargo.lock    the same members, in the mobile bridge's own lockfile
//   package.json                     the app
//   package-lock.json                the app, twice (root and packages[""])
//   npm/cli/package.json             the CLI, plus its exact pins on the platform packages
//   npm/cli-darwin-arm64/package.json, npm/cli-linux-x64/package.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A release version: three numbers, nothing else. */
export const VERSION = /^\d+\.\d+\.\d+$/;

export const FILES = [
  'Cargo.toml', 'Cargo.lock', 'crates/iroh-mobile/Cargo.lock',
  'package.json', 'package-lock.json',
  'npm/cli/package.json', 'npm/cli-darwin-arm64/package.json', 'npm/cli-linux-x64/package.json',
];

const read = (root, file) => {
  try { return readFileSync(join(root, file), 'utf8'); }
  catch (e) { throw new Error(`${file}: cannot read (${e.code || e.message})`); }
};

/** `[workspace.package] version = "…"` as the match of a regex over the whole file. */
function workspaceVersionMatch(text) {
  const section = /^\[workspace\.package\]\s*$/m.exec(text);
  if (!section) throw new Error('Cargo.toml: no [workspace.package] section');
  const rest = text.slice(section.index);
  const end = /^\[/m.exec(rest.slice(1));
  const body = end ? rest.slice(0, end.index + 1) : rest;
  const m = /^(version\s*=\s*")([^"]*)(")/m.exec(body);
  if (!m) throw new Error('Cargo.toml: no version in [workspace.package]');
  return { start: section.index + m.index + m[1].length, version: m[2] };
}

/** The crates whose version is the workspace version, by package name. */
export function workspaceMembers(root) {
  const toml = read(root, 'Cargo.toml');
  const list = /^members\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!list) throw new Error('Cargo.toml: no workspace members list');
  const names = [];
  for (const path of list[1].match(/"[^"]+"/g).map(s => s.slice(1, -1))) {
    const crate = read(root, `${path}/Cargo.toml`);
    const name = /^name\s*=\s*"([^"]+)"/m.exec(crate);
    if (!name) throw new Error(`${path}/Cargo.toml: no package name`);
    if (/^version\.workspace\s*=\s*true/m.test(crate)) names.push(name[1]);
  }
  return names;
}

/** One place a version is written: where it is, what it says, and how to spell it. */
function site(file, label, text, start, version) {
  return { file, label, version, start, end: start + version.length, text };
}

function jsonRootVersion(file, text) {
  const m = /^(\s{2}"version":\s*")([^"]*)(")/m.exec(text);
  if (!m) throw new Error(`${file}: no top-level "version"`);
  return site(file, 'version', text, m.index + m[1].length, m[2]);
}

/** Every version site in `file`, in file order. */
export function sitesIn(root, file, members) {
  const text = read(root, file);
  const out = [];
  if (file === 'Cargo.toml') {
    const m = workspaceVersionMatch(text);
    out.push(site(file, 'workspace.package', text, m.start, m.version));
  } else if (file.endsWith('Cargo.lock')) {
    const re = /^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]*)"/gm;
    for (let m; (m = re.exec(text));) {
      if (members.includes(m[1])) out.push(site(file, m[1], text, m.index + m[0].length - m[2].length - 1, m[2]));
    }
    if (out.length === 0) throw new Error(`${file}: none of the workspace members (${members.join(', ')}) appear in it`);
  } else if (file === 'package-lock.json') {
    out.push(jsonRootVersion(file, text));
    const m = /("packages"\s*:\s*\{\s*""\s*:\s*\{[^{}]*?"version"\s*:\s*")([^"]*)(")/.exec(text);
    if (!m) throw new Error(`${file}: no packages[""] version`);
    out.push(site(file, 'packages[""]', text, m.index + m[1].length, m[2]));
  } else if (file.endsWith('package.json')) {
    out.push(jsonRootVersion(file, text));
    if (file === 'npm/cli/package.json') {
      const re = /("(@apex-deck\/cli-[^"]+)"\s*:\s*")([^"]*)(")/g;
      let any = false;
      for (let m; (m = re.exec(text));) { any = true; out.push(site(file, m[2], text, m.index + m[1].length, m[3])); }
      if (!any) throw new Error(`${file}: no @apex-deck/cli-* platform pins`);
    }
  } else {
    throw new Error(`${file}: not a file this script knows`);
  }
  return out;
}

/** Every version site in the repository at `root`. */
export function allSites(root) {
  const members = workspaceMembers(root);
  return FILES.flatMap(file => sitesIn(root, file, members));
}

/** The version everything is measured against: the Cargo workspace's. */
export function workspaceVersion(root) {
  return workspaceVersionMatch(read(root, 'Cargo.toml')).version;
}

/** Sites whose version is not `expected`. */
export function disagreements(sites, expected) {
  return sites.filter(s => s.version !== expected);
}

/** Rewrite every site in the repository to `version`. Returns what changed per file. */
export function rewriteAll(root, version, { write = true } = {}) {
  const members = workspaceMembers(root);
  const report = [];
  for (const file of FILES) {
    const sites = sitesIn(root, file, members);
    let text = sites[0].text;
    // Back to front, so earlier offsets stay valid.
    for (const s of [...sites].sort((a, b) => b.start - a.start)) text = text.slice(0, s.start) + version + text.slice(s.end);
    const changed = sites.filter(s => s.version !== version).length;
    if (write && changed) writeFileSync(join(root, file), text);
    report.push({ file, sites: sites.length, changed, from: [...new Set(sites.map(s => s.version))] });
  }
  return report;
}

/** `--root DIR` and the rest of argv. */
export function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return { root: process.cwd(), rest: argv };
  const root = argv[i + 1];
  if (!root) throw new Error('--root needs a directory');
  return { root, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Numeric x.y.z comparison: negative, zero or positive. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
