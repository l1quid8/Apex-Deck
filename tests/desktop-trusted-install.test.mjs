import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TRUSTED_APP, TRUSTED_DAEMON, TRUSTED_ROOT, bundlePath, bundleVersion, isProtectedCopy, launchPlan, plistDaemonBin, rootProtected } from '../desktop/trustedInstall.mjs';
import { LABEL, agentPlist, installAgent } from '../desktop/launchAgent.mjs';

const APP = '/Applications/Apex Deck.app';
const TRUSTED = TRUSTED_APP;
const UID = 501;

/**
 * A Mac's disks as the launch reads them. `/Applications` is group-writable,
 * like the real one, so nothing under it can ever be trusted; the protected
 * tree is root-owned with no group or world write.
 */
function fakeFiles({ version = '0.8.2', trusted = true, trustedVersion = version, owner = 0 } = {}) {
  const nodes = new Map([
    ['/', { uid: 0, mode: 0o755, kind: 'dir' }],
    ['/Applications', { uid: 0, mode: 0o775, kind: 'dir' }],
    ['/Library', { uid: 0, mode: 0o755, kind: 'dir' }],
    ['/Library/Application Support', { uid: 0, mode: 0o755, kind: 'dir' }],
    // Root owns the app itself; only the folder it sits in is group-writable.
    [APP, { uid: 0, mode: 0o755, kind: 'dir' }],
    [`${APP}/Contents`, { uid: 0, mode: 0o755, kind: 'dir' }],
    [`${APP}/Contents/Resources`, { uid: 0, mode: 0o755, kind: 'dir' }],
    [`${APP}/Contents/Info.plist`, { uid: 0, mode: 0o644, kind: 'file', text: plist(version) }],
  ]);
  if (trusted) {
    for (const dir of [TRUSTED_ROOT, path.join(TRUSTED_ROOT, 'TrustedUI'), TRUSTED, `${TRUSTED}/Contents`]) {
      nodes.set(dir, { uid: owner, mode: 0o755, kind: 'dir' });
    }
    nodes.set(`${TRUSTED}/Contents/Info.plist`, { uid: owner, mode: 0o644, kind: 'file', text: plist(trustedVersion) });
  }
  const at = (p) => nodes.get(path.normalize(p));
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    nodes,
    lstatSync: (p) => { const node = at(p); if (!node) throw missing(p); return { ...node, isSymbolicLink: () => node.kind === 'link' }; },
    statSync: (p) => { const node = at(p); if (!node) throw missing(p); return { ...node, isDirectory: () => node.kind === 'dir' }; },
    readFileSync: (p) => { const node = at(p); if (!node || node.kind !== 'file') throw missing(p); return node.text; },
    realpathSync: (p) => { const node = at(p); if (!node) throw missing(p); return path.normalize(p); },
  };
}

const plist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key>
<string>${version}</string>
</dict></plist>`;

/** The plan for a launch of `bundle` (the running app) with the given disk. */
const plan = (files, over = {}) => launchPlan({
  packaged: true,
  platform: 'darwin',
  bundle: APP,
  version: '0.8.2',
  daemon: `${APP}/Contents/Resources/bin/apex-daemon`,
  plist: null,
  files,
  ...over,
});

test('the /Applications copy hands off to the protected copy when both are the same version', () => {
  const got = plan(fakeFiles());
  assert.equal(got.kind, 'handoff');
  assert.equal(got.app, TRUSTED);
  assert.equal(got.daemon, TRUSTED_DAEMON, 'the agent keeps the protected daemon');
  assert.match(got.notice.detail, /could not be opened/i, 'a notice is ready if the handoff will not open');
});

test('a missing protected copy is no handoff: the running daemon, and a notice saying what to do', () => {
  const got = plan(fakeFiles({ trusted: false }));
  assert.equal(got.kind, 'notice');
  assert.equal(got.daemon, `${APP}/Contents/Resources/bin/apex-daemon`);
  assert.match(got.notice.message, /trusted Apex Deck install/i);
  assert.match(got.notice.detail, /isn't installed|is not installed/i);
});

test('a protected copy of another version is no handoff, and the notice names both versions', () => {
  const got = plan(fakeFiles({ trustedVersion: '0.8.1' }));
  assert.equal(got.kind, 'notice');
  assert.match(got.notice.detail, /0\.8\.1/);
  assert.match(got.notice.detail, /0\.8\.2/);
});

test('an agent that already runs the protected daemon is never downgraded, even across a version mismatch', () => {
  const files = fakeFiles({ trustedVersion: '0.8.1' });
  const got = plan(files, { plist: agentPlist({ bin: TRUSTED_DAEMON, logFile: '/tmp/l.log' }) });
  assert.equal(got.kind, 'notice');
  assert.equal(got.daemon, TRUSTED_DAEMON, 'launchd keeps the protected daemon');
});

test('the protected copy running itself hands off nowhere and keeps its own daemon', () => {
  const got = plan(fakeFiles(), { bundle: `${TRUSTED}/Contents/Resources/app.asar` });
  assert.equal(got.kind, 'run');
  assert.equal(got.daemon, TRUSTED_DAEMON);
});

test('the /Applications copy running from inside its bundle is the same launch', () => {
  assert.equal(plan(fakeFiles(), { bundle: `${APP}/Contents/Resources/app.asar` }).kind, 'handoff');
});

test('the protected copy is only trusted while root owns every part of its path', () => {
  const files = fakeFiles({ owner: 501 });
  assert.equal(rootProtected(TRUSTED, files), false);
  assert.equal(isProtectedCopy(TRUSTED, files), false);
  const got = plan(files);
  assert.equal(got.kind, 'notice', 'nothing to hand off to that the broker would trust');
  assert.match(got.notice.detail, /root/i);
});

test('/Applications is group-writable, so no copy in it is ever protected, whatever its hashes', () => {
  const files = fakeFiles();
  assert.equal(rootProtected(APP, files), false);
  assert.equal(isProtectedCopy(APP, files), false);
  assert.equal(rootProtected(TRUSTED, files), true);
  files.nodes.get('/Applications').mode = 0o755;
  assert.equal(rootProtected(APP, files), true, 'the check is the path, not the name');
});

test('a dev build and an isolated data folder keep today\'s behavior', () => {
  const dev = plan(fakeFiles(), { packaged: false });
  assert.equal(dev.kind, 'run');
  assert.equal(dev.daemon, `${APP}/Contents/Resources/bin/apex-daemon`);
  const qa = plan(fakeFiles(), { dataDir: '/tmp/apex-qa' });
  assert.equal(qa.kind, 'run');
  assert.equal(qa.daemon, `${APP}/Contents/Resources/bin/apex-daemon`);
});

test('another platform is left alone', () => {
  const got = plan(fakeFiles(), { platform: 'linux' });
  assert.equal(got.kind, 'run');
});

test('a bundle path is found from anywhere inside the bundle', () => {
  assert.equal(bundlePath(`${APP}/Contents/Resources/app.asar`), APP);
  assert.equal(bundlePath(`${APP}/Contents/MacOS/Apex Deck`), APP);
  assert.equal(bundlePath(APP), APP);
  assert.equal(bundlePath('/Users/me/apex-deck/desktop/main.mjs'), '/Users/me/apex-deck/desktop/main.mjs');
});

test('a bundle version is read from Info.plist, and a missing one is null', () => {
  const files = fakeFiles();
  assert.equal(bundleVersion(TRUSTED, files), '0.8.2');
  assert.equal(bundleVersion('/nowhere/Apex Deck.app', files), null);
  assert.equal(bundleVersion(TRUSTED, fakeFiles({ trusted: false, version: 'x' })), null);
});

test('the daemon an agent plist runs is its first program argument, un-escaped', () => {
  assert.equal(plistDaemonBin(null), null);
  assert.equal(plistDaemonBin('not a plist'), null);
  const bin = `/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app/Contents/Resources/bin/apex-daemon`;
  assert.equal(plistDaemonBin(agentPlist({ bin, logFile: '/tmp/l.log' })), bin);
  assert.equal(plistDaemonBin(agentPlist({ bin: '/x/it\'s & <b>/apex-daemon', logFile: '/tmp/l' })), '/x/it\'s & <b>/apex-daemon');
});

test('installing never replaces an agent that runs the protected daemon', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-trusted-');
  const plistPath = path.join(dir, 'LaunchAgents', `${LABEL}.plist`);
  const calls = [];
  const run = async (args) => { calls.push(args.join(' ')); return ''; };
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, agentPlist({ bin: TRUSTED_DAEMON, logFile: '/tmp/l.log' }));
    const outcome = await installAgent({ plistPath, plist: agentPlist({ bin: `${APP}/Contents/Resources/bin/apex-daemon`, logFile: '/tmp/l.log' }), uid: UID, run });
    assert.equal(outcome, 'protected');
    assert.equal(plistDaemonBin(fs.readFileSync(plistPath, 'utf8')), TRUSTED_DAEMON, 'the file is left as it was');
    assert.deepEqual(calls, [], 'launchd is not reloaded');
    // A machine whose agent runs something else may be given the running daemon.
    fs.writeFileSync(plistPath, agentPlist({ bin: '/opt/apex-daemon', logFile: '/tmp/l.log' }));
    const installed = await installAgent({ plistPath, plist: agentPlist({ bin: `${APP}/Contents/Resources/bin/apex-daemon`, logFile: '/tmp/l2.log' }), uid: UID, run });
    assert.equal(installed, 'installed', 'any other daemon may replace any other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
