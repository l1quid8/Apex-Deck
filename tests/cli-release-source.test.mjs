import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSource, exportSource, releaseVersion, sourceDrift, verifyPackages, STAMP } from '../scripts/cli-release-source.mjs';
const UNIX_ONLY = process.platform === 'win32' ? { skip: 'Unix-only: uses /usr/bin/tar' } : {};

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const g = (repo, ...args) => sh(repo, 'git', args);

function write(root, path, text) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

function sources(root, version, deps = version) {
  write(root, 'Cargo.toml', `[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`);
  write(root, 'npm/cli/package.json', JSON.stringify({ name: '@apex-deck/cli', version, optionalDependencies: { '@apex-deck/cli-darwin-arm64': deps, '@apex-deck/cli-linux-x64': deps } }));
  write(root, 'npm/cli/bin/apex', '#!/bin/sh\necho launcher\n');
  write(root, 'npm/cli-darwin-arm64/package.json', JSON.stringify({ name: '@apex-deck/cli-darwin-arm64', version }));
  write(root, 'npm/cli-linux-x64/package.json', JSON.stringify({ name: '@apex-deck/cli-linux-x64', version }));
}

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-release-source-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  sources(repo, '0.9.15');
  write(repo, '.gitignore', 'target\nrelease/\n*.log\n');
  write(repo, 'scripts/run.sh', '#!/bin/sh\n');
  write(repo, 'scripts/install-cli-provenance.sh', '#!/bin/bash\necho install\n');
  chmodSync(join(repo, 'scripts/run.sh'), 0o755);
  write(repo, 'crates/a/src/lib.rs', 'pub fn a() {}\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'release 0.9.15');
  return { tmp, repo, main: g(repo, 'rev-parse', 'HEAD') };
}

test('export copies an exact main commit and the check passes on it', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    const dest = join(tmp, 'source');
    const s = exportSource({ repo, dest });
    assert.equal(s.commit, main);
    assert.equal(s.version, '0.9.15');
    assert.equal(JSON.parse(readFileSync(join(dest, STAMP), 'utf8')).commit, main);
    assert.equal(readFileSync(join(dest, 'crates/a/src/lib.rs'), 'utf8'), 'pub fn a() {}\n');
    // Build output in ignored folders is not drift.
    write(dest, 'target/release/apex', 'binary');
    write(dest, 'release/apex-deck-cli-0.9.15.tgz', 'tgz');
    write(dest, 'release/build.log', 'log');
    assert.deepEqual(sourceDrift(repo, main, dest), []);
    assert.equal(checkSource(dest).commit, main);
    // The repo's own index is untouched by the private-index check.
    assert.equal(g(repo, 'status', '--porcelain'), '');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the check fails when the exported copy is edited, extended, trimmed or re-moded', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    const dest = join(tmp, 'source');
    exportSource({ repo, dest });
    write(dest, 'crates/a/src/lib.rs', 'pub fn a() { patched() }\n');
    write(dest, 'crates/a/src/extra.rs', 'pub fn extra() {}\n');
    rmSync(join(dest, 'npm/cli/bin/apex'));
    chmodSync(join(dest, 'scripts/run.sh'), 0o644);
    const drift = sourceDrift(repo, main, dest).map(d => `${d.status} ${d.path}`).sort();
    assert.deepEqual(drift, ['? crates/a/src/extra.rs', 'D npm/cli/bin/apex', 'M crates/a/src/lib.rs', 'M scripts/run.sh']);
    assert.throws(() => checkSource(dest), /has drifted from .*4 paths[\s\S]*M crates\/a\/src\/lib\.rs/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('only main commits can be exported, and a copy with no stamp is refused', UNIX_ONLY, () => {
  const { tmp, repo } = fixture();
  try {
    g(repo, 'switch', '-q', '-c', 'feat/side');
    write(repo, 'crates/a/src/lib.rs', 'pub fn side() {}\n');
    g(repo, 'commit', '-q', '-am', 'side');
    assert.throws(() => exportSource({ repo, dest: join(tmp, 'side'), rev: 'feat/side' }), /not on main/);
    // A plain copy (the old snapshot habit) has no stamp.
    const copy = join(tmp, 'copy');
    sources(copy, '0.9.15');
    assert.throws(() => checkSource(copy), /was not exported from a main commit/);
    // Exporting into a used folder is refused instead of mixing trees.
    assert.throws(() => exportSource({ repo, dest: copy }), /not empty/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a stamp pointing at a commit that later left main is refused', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    const dest = join(tmp, 'source');
    exportSource({ repo, dest });
    // Rewrite main so the exported commit is no longer on it.
    g(repo, 'commit', '-q', '--amend', '-m', 'rewritten');
    assert.notEqual(g(repo, 'rev-parse', 'main'), main);
    assert.throws(() => checkSource(dest), /is not on main/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the Cargo workspace and npm package versions must agree', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-release-version-'));
  try {
    sources(tmp, '0.9.15');
    const fromDisk = p => readFileSync(join(tmp, p), 'utf8');
    assert.equal(releaseVersion(fromDisk), '0.9.15');
    write(tmp, 'npm/cli-linux-x64/package.json', JSON.stringify({ name: '@apex-deck/cli-linux-x64', version: '0.9.14' }));
    assert.throws(() => releaseVersion(fromDisk), /versions disagree.*npm\/cli-linux-x64=0\.9\.14/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

function tgz(tmp, name, files) {
  const stage = join(tmp, `stage-${name}`);
  for (const [path, text] of Object.entries(files)) write(stage, join('package', path), text);
  const out = join(tmp, `${name}.tgz`);
  sh(stage, '/usr/bin/tar', ['-czf', out, 'package']);
  return out;
}

const hash = text => createHash('sha256').update(text).digest('hex');

// Fake binaries: apex and apex-daemon carry the commit the way APEX_BUILD_COMMIT stamps them.
function payload(platform, commit) {
  const bin = name => `\x7fELF ${platform} ${name} apex-build-commit=${commit.slice(0, 12)};\n`;
  const files = { apex: bin('apex'), 'apex-daemon': bin('apex-daemon') };
  if (platform === 'mac') Object.assign(files, { 'apex-provenance': 'provenance\n', 'install-cli-provenance.sh': '#!/bin/bash\necho install\n' });
  return files;
}

// `tamper(platform, files)` edits the payload after its manifest is written.
function packages(tmp, commit, { version = '0.9.15', linuxCommit = commit, launcher = '#!/bin/sh\necho launcher\n', tamper = () => {} } = {}) {
  const platform = (platform, name, c) => {
    const files = payload(platform, c);
    const binaries = Object.keys(files).filter(n => n.startsWith('apex'));
    const manifest = { formatVersion: 1, product: 'apex-cli', version, sourceCommit: c, files: binaries.map(n => ({ name: n, sha256: hash(files[n]) })) };
    const contents = { 'package.json': JSON.stringify({ name, version }), 'manifest.json': JSON.stringify(manifest), ...files };
    tamper(platform, contents, manifest);
    if (contents['manifest.json'] !== undefined) contents['manifest.json'] = JSON.stringify(manifest);
    for (const [k, v] of Object.entries(contents)) if (v === undefined) delete contents[k];
    return tgz(tmp, platform, contents);
  };
  return [
    platform('mac', '@apex-deck/cli-darwin-arm64', commit),
    platform('linux', '@apex-deck/cli-linux-x64', linuxCommit),
    tgz(tmp, 'cli', { 'package.json': JSON.stringify({ name: '@apex-deck/cli', version, optionalDependencies: { '@apex-deck/cli-darwin-arm64': version, '@apex-deck/cli-linux-x64': version } }), 'bin/apex': launcher }),
  ];
}

test('publishing is refused until the packages name one commit that is on origin/main', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    const tgzs = packages(tmp, main);
    assert.throws(() => verifyPackages(repo, tgzs), /origin\/main is not known/);
    // main moved ahead locally but was never pushed: origin/main is still behind.
    g(repo, 'update-ref', 'refs/remotes/origin/main', main);
    write(repo, 'crates/a/src/lib.rs', 'pub fn b() {}\n');
    g(repo, 'commit', '-q', '-am', 'unpushed');
    const unpushed = g(repo, 'rev-parse', 'HEAD');
    assert.throws(() => verifyPackages(repo, packages(join(tmp, 'u'), unpushed)), /not on origin\/main\. Push main/);
    // The pushed commit passes.
    assert.deepEqual(verifyPackages(repo, tgzs), { commit: main, version: '0.9.15', packages: ['@apex-deck/cli-darwin-arm64', '@apex-deck/cli-linux-x64', '@apex-deck/cli'] });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('publishing is refused when packages drift from each other or from the source', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    g(repo, 'update-ref', 'refs/remotes/origin/main', main);
    const other = 'f'.repeat(40);
    assert.throws(() => verifyPackages(repo, packages(join(tmp, 'a'), main, { linuxCommit: other })), /different commits/);
    assert.throws(() => verifyPackages(repo, packages(join(tmp, 'b'), main, { launcher: '#!/bin/sh\necho edited\n' })), /bin\/apex differs/);
    assert.throws(() => verifyPackages(repo, packages(join(tmp, 'c'), main, { version: '0.9.16' })), /Packages are 0\.9\.16 but .* says 0\.9\.15/);
    // A package from the old snapshot builds has no recorded commit at all.
    const old = tgz(join(tmp, 'd'), 'old', { 'package.json': JSON.stringify({ name: '@apex-deck/cli-darwin-arm64', version: '0.9.15' }), 'manifest.json': JSON.stringify({ version: '0.9.15', files: [] }) });
    assert.throws(() => verifyPackages(repo, [old]), /does not record its source commit/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('publishing is refused when a package\'s binaries do not match its manifest or its commit', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    g(repo, 'update-ref', 'refs/remotes/origin/main', main);
    let n = 0;
    const refused = (tamper, pattern) => assert.throws(() => verifyPackages(repo, packages(join(tmp, String(n++)), main, { tamper })), pattern);
    // Null's reproduction: the daemon is swapped and the manifest left alone.
    refused((p, files) => { if (p === 'linux') files['apex-daemon'] = `\x7fELF other daemon apex-build-commit=${main.slice(0, 12)};\n`; }, /linux\.tgz: apex-daemon does not match its manifest hash/);
    // Swapped and re-hashed, but built from another commit (the stale-CLI case).
    refused((p, files, m) => {
      if (p !== 'linux') return;
      files.apex = `\x7fELF apex apex-build-commit=0123456789ab; bare ${main.slice(0, 12)}\n`;
      m.files.find(f => f.name === 'apex').sha256 = hash(files.apex);
    }, /linux\.tgz: apex was not built from/);
    // A binary listed in the manifest but missing from the package.
    refused((p, files) => { if (p === 'mac') files['apex-provenance'] = undefined; }, /mac\.tgz: apex-provenance is missing/);
    // The manifest drops a binary, so nothing would check it.
    refused((p, files, m) => { if (p === 'mac') m.files = m.files.filter(f => f.name !== 'apex-provenance'); }, /mac\.tgz: manifest lists \[apex, apex-daemon\], expected exactly/);
    // The root-run installer must be the one on main.
    refused((p, files) => { if (p === 'mac') files['install-cli-provenance.sh'] = '#!/bin/bash\necho patched\n'; }, /install-cli-provenance\.sh differs from scripts\/install-cli-provenance\.sh/);
    // A platform the gate doesn't know is refused rather than skipped.
    const unknown = tgz(join(tmp, 'w'), 'win', { 'package.json': JSON.stringify({ name: '@apex-deck/cli-win32-x64', version: '0.9.15' }), 'manifest.json': JSON.stringify({ version: '0.9.15', sourceCommit: main, files: [] }) });
    assert.throws(() => verifyPackages(repo, [unknown]), /unknown package @apex-deck\/cli-win32-x64/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a platform package is identified by name, so dropping its manifest cannot skip the checks', UNIX_ONLY, () => {
  const { tmp, repo, main } = fixture();
  try {
    g(repo, 'update-ref', 'refs/remotes/origin/main', main);
    let n = 0;
    const set = () => packages(join(tmp, String(n++)), main);
    const noManifest = platform => packages(join(tmp, String(n++)), main, { tamper: (p, files) => { if (p === platform) files['manifest.json'] = undefined; } });
    // Null's reproduction: the Linux manifest is removed and everything else is untouched.
    assert.throws(() => verifyPackages(repo, noManifest('linux')), /linux\.tgz: @apex-deck\/cli-linux-x64 has no manifest\.json/);
    assert.throws(() => verifyPackages(repo, noManifest('mac')), /mac\.tgz: @apex-deck\/cli-darwin-arm64 has no manifest\.json/);
    // An unknown package is refused even without a manifest, rather than passed over.
    const stray = tgz(join(tmp, 's'), 'stray', { 'package.json': JSON.stringify({ name: '@apex-deck/cli-win32-x64', version: '0.9.15' }), apex: 'MZ windows\n' });
    assert.throws(() => verifyPackages(repo, [...set(), stray]), /stray\.tgz: unknown package @apex-deck\/cli-win32-x64/);
    // Leaving a platform package out entirely would publish a launcher that installs something unchecked.
    const [mac, , cli] = set();
    assert.throws(() => verifyPackages(repo, [mac, cli]), /cli\.tgz: the launcher installs @apex-deck\/cli-linux-x64, which was not given/);
    // The same package twice is refused too.
    const [mac2, linux2, cli2] = set();
    assert.throws(() => verifyPackages(repo, [mac2, mac2, linux2, cli2]), /@apex-deck\/cli-darwin-arm64 was given twice/);
    // The untouched set still passes.
    assert.equal(verifyPackages(repo, set()).commit, main);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
