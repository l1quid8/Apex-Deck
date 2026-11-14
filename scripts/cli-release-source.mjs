// CLI releases are built from an exact commit on `main`, never from a copy of
// the previous release folder. Releases 0.9.10-0.9.14 were built from saved
// copies that were edited in place, and that code never reached main.
//
//   export [--commit <rev>] <dest>  copy a main commit into <dest> (git archive)
//   check [<dir>]                   fail if <dir> differs from its commit, or
//                                   the commit is not on main
//   commit [<dir>]                  print the full commit <dir> was exported from
//   verify-packages <tgz...>        before publishing: fail unless every npm
//                                   package records the same commit, that commit
//                                   is on origin/main, the versions agree, and
//                                   each platform package carries exactly its
//                                   binaries with the hashes its manifest lists
//
// Typical release (from the main checkout, after the version bump is on main):
//   node scripts/cli-release-source.mjs export release/cli-<ver>-validation/source
//   cd release/cli-<ver>-validation/source/release
//   node ../scripts/package-cli-mac.mjs && node ../scripts/package-cli-npm.mjs
// The packagers run `check` themselves and stamp the commit into manifest.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP = '.apex-release-source.json';
export const MAIN_REF = 'main';
export const PUBLISH_REF = 'origin/main';
const COMMIT = /^[0-9a-f]{40}$/;

function git(repo, args, { env, allowFail = false, input } = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r;
}

export function isOn(repo, commit, ref) {
  if (git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }).status !== 0) {
    throw new Error(`${ref} is not known in ${repo}${ref.startsWith('origin/') ? '; run git fetch origin first' : ''}`);
  }
  return git(repo, ['merge-base', '--is-ancestor', commit, ref], { allowFail: true }).status === 0;
}

function resolveCommit(repo, rev) {
  return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]).stdout.trim();
}

/** Paths in `dir` that differ from `commit`: modified, deleted, mode-changed or extra (not ignored). */
export function sourceDrift(repo, commit, dir) {
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const scratch = mkdtempSync(join(tmpdir(), 'apex-release-index-'));
  // A private index: the repo's own index and refs are never touched.
  const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_DIR: gitDir, GIT_WORK_TREE: resolve(dir) };
  const run = (args, opts = {}) => git(resolve(dir), args, { env, ...opts });
  try {
    run(['read-tree', commit]);
    run(['update-index', '-q', '--refresh'], { allowFail: true });
    const changed = run(['diff-files', '--name-status', '-z']).stdout.split('\0').filter(Boolean);
    const drift = [];
    for (let i = 0; i + 1 < changed.length; i += 2) drift.push({ status: changed[i], path: changed[i + 1] });
    for (const path of run(['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0')) {
      if (path && path !== STAMP) drift.push({ status: '?', path });
    }
    return drift;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readStamp(dir) {
  const path = join(dir, STAMP);
  if (!existsSync(path)) {
    throw new Error(`${resolve(dir)} was not exported from a main commit. CLI releases must be built from one:\n  node scripts/cli-release-source.mjs export <new folder>`);
  }
  const stamp = JSON.parse(readFileSync(path, 'utf8'));
  if (stamp.formatVersion !== 1 || !COMMIT.test(stamp.commit || '') || typeof stamp.repo !== 'string') throw new Error(`Invalid ${path}`);
  return stamp;
}

function versions(read) {
  let section = '', cargo;
  for (const line of read('Cargo.toml').split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const m = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (m && section === 'workspace.package') { cargo = m[1]; break; }
  }
  const npm = Object.fromEntries(['cli', 'cli-darwin-arm64', 'cli-linux-x64'].map(p => [p, JSON.parse(read(`npm/${p}/package.json`)).version]));
  return { cargo, npm };
}

/** The CLI version recorded at the source: Cargo workspace and all npm packages must agree. */
export function releaseVersion(read) {
  const { cargo, npm } = versions(read);
  const all = { 'Cargo.toml workspace': cargo, ...Object.fromEntries(Object.entries(npm).map(([k, v]) => [`npm/${k}`, v])) };
  if (new Set(Object.values(all)).size !== 1 || !cargo) {
    throw new Error(`CLI versions disagree; bump them together on main first: ${Object.entries(all).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  return cargo;
}

/** Throws unless `dir` is an unmodified export of a commit that is on `ref`. Returns the stamp plus version. */
export function checkSource(dir, { ref = MAIN_REF } = {}) {
  const stamp = readStamp(dir);
  if (!isOn(stamp.repo, stamp.commit, ref)) throw new Error(`Source commit ${stamp.commit.slice(0, 12)} is not on ${ref}. Merge it to ${ref} and export again.`);
  const drift = sourceDrift(stamp.repo, stamp.commit, dir);
  if (drift.length) {
    const shown = drift.slice(0, 20).map(d => `  ${d.status} ${d.path}`).join('\n');
    throw new Error(`${resolve(dir)} has drifted from ${stamp.commit.slice(0, 12)} (${drift.length} path${drift.length === 1 ? '' : 's'}):\n${shown}${drift.length > 20 ? '\n  …' : ''}\nCommit the change on a branch, merge to ${ref}, and export a fresh copy.`);
  }
  const version = releaseVersion(p => readFileSync(join(dir, p), 'utf8'));
  return { ...stamp, version };
}

/** Environment for cargo so the binaries carry the real commit (an export has no .git). */
export function buildEnv(source) {
  return { APEX_BUILD_COMMIT: source.commit.slice(0, 12), APEX_BUILD_DIRTY: 'false' };
}

export function exportSource({ repo, dest, rev = MAIN_REF, ref = MAIN_REF }) {
  const commit = resolveCommit(repo, rev);
  if (!isOn(repo, commit, ref)) throw new Error(`${rev} (${commit.slice(0, 12)}) is not on ${ref}; only main commits can be released.`);
  // Refuse before writing anything, so a bad commit leaves no folder behind.
  releaseVersion(path => git(repo, ['show', `${commit}:${path}`]).stdout);
  dest = resolve(dest);
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty; export into a new folder.`);
  mkdirSync(dest, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'apex-release-archive-'));
  try {
    const archive = join(scratch, 'source.tar');
    git(repo, ['archive', '--format=tar', '-o', archive, commit]);
    const r = spawnSync('/usr/bin/tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error('tar failed while exporting the source');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stamp = { formatVersion: 1, commit, ref, repo: resolve(repo) };
  writeFileSync(join(dest, STAMP), JSON.stringify(stamp, null, 2) + '\n');
  return checkSource(dest, { ref });
}

/** What each platform package must carry. `stamped` binaries embed the source commit (APEX_BUILD_COMMIT); `sources` are copied unchanged from the commit. */
const LAUNCHER = '@apex-deck/cli';

export const PLATFORM_PAYLOAD = {
  // The installer runs as root, so it must be the one on main byte for byte.
  '@apex-deck/cli-darwin-arm64': { files: ['apex', 'apex-daemon', 'apex-provenance'], stamped: ['apex', 'apex-daemon'], sources: { 'install-cli-provenance.sh': 'scripts/install-cli-provenance.sh' } },
  '@apex-deck/cli-linux-x64': { files: ['apex', 'apex-daemon'], stamped: ['apex', 'apex-daemon'] },
};

/** The label apex and apex-daemon carry (crates/apex-daemon/src/build_info.rs MARKER). */
export const commitMarker = commit => `apex-build-commit=${commit.slice(0, 12)};`;

/** True when the binary was stamped with `commit`. A bare hash isn't enough: it can match unrelated bytes. */
export function embedsCommit(bytes, commit) {
  return Buffer.from(bytes).includes(Buffer.from(commitMarker(commit)));
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Unpacks `tgz` into `dir` and returns a reader for files under package/ (null when absent). */
function unpack(tgz, dir) {
  mkdirSync(dir);
  const r = spawnSync('/usr/bin/tar', ['-xzf', tgz, '-C', dir]);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Cannot extract ${tgz}`);
  const root = join(dir, 'package');
  return name => (existsSync(join(root, name)) ? readFileSync(join(root, name)) : null);
}

/** Throws unless the package holds exactly its platform's binaries, each matching the manifest and built from `commit`. */
function checkPayload(p, commit, show) {
  const spec = PLATFORM_PAYLOAD[p.json.name];
  if (!spec) throw new Error(`${p.tgz}: unknown platform package ${p.json.name}; add it to PLATFORM_PAYLOAD`);
  const listed = Array.isArray(p.manifest.files) ? p.manifest.files : [];
  const names = listed.map(f => f && f.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...spec.files].sort())) {
    throw new Error(`${p.tgz}: manifest lists [${names.join(', ')}], expected exactly [${spec.files.join(', ')}]`);
  }
  for (const f of listed) {
    const bytes = p.read(f.name);
    if (!bytes) throw new Error(`${p.tgz}: ${f.name} is missing from the package`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || '') || sha256(bytes) !== f.sha256) throw new Error(`${p.tgz}: ${f.name} does not match its manifest hash`);
    if (spec.stamped.includes(f.name) && !embedsCommit(bytes, commit)) throw new Error(`${p.tgz}: ${f.name} was not built from ${commit.slice(0, 12)}`);
  }
  for (const [name, path] of Object.entries(spec.sources || {})) {
    const bytes = p.read(name);
    if (!bytes || bytes.toString('utf8') !== show(path)) throw new Error(`${p.tgz}: ${name} differs from ${path} at ${commit.slice(0, 12)}`);
  }
}

/** Pre-publish gate. Every platform package must name one commit on `ref`; the launcher must match it. */
export function verifyPackages(repo, tgzs, { ref = PUBLISH_REF } = {}) {
  if (!tgzs.length) throw new Error('Give the npm .tgz files to publish');
  const scratch = mkdtempSync(join(tmpdir(), 'apex-release-tgz-'));
  try {
    return verifyUnpacked(repo, tgzs.map((tgz, i) => ({ tgz, read: unpack(tgz, join(scratch, String(i))) })), ref);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyUnpacked(repo, unpacked, ref) {
  const pkgs = unpacked.map(({ tgz, read }) => {
    const json = read('package.json');
    if (!json) throw new Error(`${tgz} has no package.json`);
    const manifest = read('manifest.json');
    return { tgz, read, json: JSON.parse(json), manifest: manifest && JSON.parse(manifest), launcher: read('bin/apex') };
  });
  // Classify by package name, never by what the tarball happens to contain:
  // a platform package with its manifest removed must be refused, not skipped.
  const given = new Set();
  for (const p of pkgs) {
    const name = p.json.name;
    if (given.has(name)) throw new Error(`${p.tgz}: ${name} was given twice`);
    given.add(name);
    if (name === LAUNCHER) continue;
    if (!PLATFORM_PAYLOAD[name]) throw new Error(`${p.tgz}: unknown package ${name}; add it to PLATFORM_PAYLOAD`);
    if (!p.manifest) throw new Error(`${p.tgz}: ${name} has no manifest.json, so its binaries cannot be checked`);
  }
  const platforms = pkgs.filter(p => p.json.name !== LAUNCHER);
  const launchers = pkgs.filter(p => p.json.name === LAUNCHER);
  if (!platforms.length) throw new Error('No platform package given');
  // A launcher is only as safe as the platform packages it installs, so all of them must be checked here too.
  for (const l of launchers) {
    for (const dep of Object.keys(l.json.optionalDependencies || {})) {
      if (dep.startsWith('@apex-deck/cli-') && !given.has(dep)) throw new Error(`${l.tgz}: the launcher installs ${dep}, which was not given; verify every package you publish together`);
    }
  }
  for (const p of platforms) {
    if (!COMMIT.test(p.manifest.sourceCommit || '')) throw new Error(`${p.tgz} does not record its source commit; it was not built from a main export.`);
    if (p.manifest.version !== p.json.version) throw new Error(`${p.tgz}: manifest ${p.manifest.version} != package ${p.json.version}`);
  }
  const commits = new Set(platforms.map(p => p.manifest.sourceCommit));
  if (commits.size !== 1) throw new Error(`Packages were built from different commits: ${[...commits].map(c => c.slice(0, 12)).join(', ')}`);
  const [commit] = commits;
  const version = pkgs[0].json.version;
  for (const p of pkgs) if (p.json.version !== version) throw new Error(`Versions differ: ${p.tgz} is ${p.json.version}, expected ${version}`);
  if (git(repo, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true }).status !== 0) throw new Error(`Source commit ${commit.slice(0, 12)} is not in ${repo}`);
  if (!isOn(repo, commit, ref)) throw new Error(`Source commit ${commit.slice(0, 12)} is not on ${ref}. Push main before publishing.`);
  const show = path => git(repo, ['show', `${commit}:${path}`]).stdout;
  const sourceVersion = releaseVersion(show);
  if (sourceVersion !== version) throw new Error(`Packages are ${version} but ${commit.slice(0, 12)} says ${sourceVersion}`);
  for (const p of platforms) checkPayload(p, commit, show);
  for (const l of launchers) {
    const expected = show('npm/cli/bin/apex');
    if (!l.launcher || l.launcher.toString('utf8') !== expected) throw new Error(`${l.tgz}: bin/apex differs from npm/cli/bin/apex at ${commit.slice(0, 12)}`);
    for (const [dep, v] of Object.entries(l.json.optionalDependencies || {})) {
      if (dep.startsWith('@apex-deck/cli-') && v !== version) throw new Error(`${l.tgz}: ${dep} is ${v}, expected ${version}`);
    }
  }
  return { commit, version, packages: pkgs.map(p => p.json.name) };
}

function main(argv) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [cmd, ...rest] = argv;
  if (cmd === 'export') {
    let rev = MAIN_REF;
    const i = rest.indexOf('--commit');
    if (i >= 0) { rev = rest[i + 1]; rest.splice(i, 2); }
    if (rest.length !== 1 || !rev) throw new Error('Usage: cli-release-source.mjs export [--commit <rev>] <dest>');
    if (existsSync(join(repo, STAMP))) throw new Error('Run export from the main checkout, not from an exported copy.');
    const s = exportSource({ repo, dest: rest[0], rev });
    console.log(`Exported ${s.commit} (CLI ${s.version}) to ${resolve(rest[0])}`);
  } else if (cmd === 'check') {
    const s = checkSource(rest[0] || repo);
    console.log(`OK: ${resolve(rest[0] || repo)} matches ${s.commit} on ${MAIN_REF} (CLI ${s.version})`);
  } else if (cmd === 'commit') {
    console.log(checkSource(rest[0] || repo).commit);
  } else if (cmd === 'verify-packages') {
    const stamp = existsSync(join(repo, STAMP)) ? readStamp(repo) : null;
    const v = verifyPackages(stamp ? stamp.repo : repo, rest);
    console.log(`OK to publish: ${v.packages.join(', ')} ${v.version} from ${v.commit} on ${PUBLISH_REF}`);
  } else {
    throw new Error('Usage: cli-release-source.mjs export|check|commit|verify-packages …');
  }
}

// realpath on both sides: through a symlinked path (/tmp on macOS) a plain
// compare is false and the check would silently do nothing and exit 0.
const invokedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && invokedDirectly()) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
