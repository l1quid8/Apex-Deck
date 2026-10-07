import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LABEL, agentPlist, agentPlistPath, daemonBuild, installAgent, removeAgent, usesLaunchAgent } from '../desktop/launchAgent.mjs';

const UID = 501;
const TARGET = `gui/${UID}/${LABEL}`;

/** A launchctl stand-in that records each call. `fail` maps a verb to the words it fails with. */
function fakeLaunchctl({ loaded = false, fail = {} } = {}) {
  const calls = [];
  let isLoaded = loaded;
  const run = async (args) => {
    calls.push(args.join(' '));
    const [verb] = args;
    if (fail[verb]) throw new Error(fail[verb]);
    if (verb === 'print' || verb === 'bootout') {
      if (!isLoaded) throw new Error('Could not find service');
      if (verb === 'bootout') isLoaded = false;
      return '';
    }
    if (verb === 'bootstrap') isLoaded = true;
    return '';
  };
  return { calls, run };
}

/** A plist path in a scratch folder, so nothing is written to the real ~/Library. */
function scratchPlist() {
  const dir = fs.mkdtempSync('/tmp/deck-agent-');
  return { dir, plistPath: path.join(dir, 'LaunchAgents', `${LABEL}.plist`) };
}

test('the plist runs serve --remote with no stdin tie, stays up, and logs to one file', () => {
  const plist = agentPlist({
    bin: '/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon',
    logFile: '/Users/me/Library/Logs/Apex Deck/apex-daemon.log',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.apexdeck\.daemon<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Applications\/Apex Deck\.app\/Contents\/Resources\/bin\/apex-daemon<\/string>\s*<string>serve<\/string>\s*<string>--remote<\/string>\s*<\/array>/);
  assert.doesNotMatch(plist, /exit-on-stdin-close/);
  assert.doesNotMatch(plist, /--data-dir/, 'no data folder is named when none is set');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/Apex Deck\/apex-daemon\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/Apex Deck\/apex-daemon\.log<\/string>/);
});

test('a data folder is named after --remote, in the same order serve takes it', () => {
  const plist = agentPlist({ bin: '/bin/apex-daemon', dataDir: '/tmp/d', logFile: '/tmp/l.log' });
  assert.match(plist, /<string>serve<\/string>\s*<string>--remote<\/string>\s*<string>--data-dir<\/string>\s*<string>\/tmp\/d<\/string>/);
});

test('every string in the plist is XML-escaped', () => {
  const plist = agentPlist({ bin: `/x/it's "a" & <b>/apex-daemon`, dataDir: '/d&e', logFile: '/l&g.log' });
  assert.match(plist, /<string>\/x\/it&apos;s &quot;a&quot; &amp; &lt;b&gt;\/apex-daemon<\/string>/);
  assert.match(plist, /<string>\/d&amp;e<\/string>/);
  assert.match(plist, /<string>\/l&amp;g\.log<\/string>/);
  assert.doesNotMatch(plist, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'no bare ampersand');
});

test('the agent plist sits in the user LaunchAgents folder', () => {
  assert.equal(agentPlistPath('/Users/me'), `/Users/me/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(LABEL, 'dev.apexdeck.daemon');
});

test('install writes the plist and loads it when the agent is not loaded yet', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    const { calls, run } = fakeLaunchctl();
    await installAgent({ plistPath, plist: 'PLIST-1', uid: UID, run });
    assert.equal(fs.readFileSync(plistPath, 'utf8'), 'PLIST-1');
    assert.deepEqual(calls, [`bootout ${TARGET}`, `print ${TARGET}`, `bootstrap gui/${UID} ${plistPath}`]);
    assert.deepEqual(fs.readdirSync(path.dirname(plistPath)), [`${LABEL}.plist`], 'the temp file is renamed away');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install skips the rewrite and the reload when the plist is the same and loaded', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, 'SAME');
    const { calls, run } = fakeLaunchctl({ loaded: true });
    await installAgent({ plistPath, plist: 'SAME', uid: UID, run });
    assert.deepEqual(calls, [`print ${TARGET}`], 'only a check that it is loaded');
    assert.deepEqual(fs.readdirSync(path.dirname(plistPath)), [`${LABEL}.plist`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install reloads when the plist content differs, stopping the old agent first', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, 'OLD');
    const { calls, run } = fakeLaunchctl({ loaded: true });
    await installAgent({ plistPath, plist: 'NEW', uid: UID, run });
    assert.equal(fs.readFileSync(plistPath, 'utf8'), 'NEW');
    assert.deepEqual(calls, [`bootout ${TARGET}`, `bootstrap gui/${UID} ${plistPath}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install loads an identical plist that launchd does not have loaded', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, 'SAME');
    const { calls, run } = fakeLaunchctl({ loaded: false });
    await installAgent({ plistPath, plist: 'SAME', uid: UID, run });
    assert.ok(calls.includes(`bootstrap gui/${UID} ${plistPath}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bootstrap that fails is reported with launchctl\'s words', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    const { run } = fakeLaunchctl({ fail: { bootstrap: 'Bootstrap failed: 5: Input/output error' } });
    await assert.rejects(
      installAgent({ plistPath, plist: 'P', uid: UID, run }),
      (e) => /didn't start: Bootstrap failed: 5/.test(e.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove stops a loaded agent, deletes its plist, and says it was running', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, 'P');
    const { calls, run } = fakeLaunchctl({ loaded: true });
    assert.equal(await removeAgent({ plistPath, uid: UID, run }), true);
    assert.deepEqual(calls, [`bootout ${TARGET}`]);
    assert.equal(fs.existsSync(plistPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove tolerates an agent that is not loaded and a plist that is missing', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    const { calls, run } = fakeLaunchctl({ loaded: false });
    assert.equal(await removeAgent({ plistPath, uid: UID, run }), false);
    assert.deepEqual(calls, [`bootout ${TARGET}`, `print ${TARGET}`]);
    assert.equal(fs.existsSync(plistPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove keeps the plist when a loaded agent will not stop, so it is not left running unmanaged', async () => {
  const { dir, plistPath } = scratchPlist();
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, 'P');
    const { run } = fakeLaunchctl({ loaded: true, fail: { bootout: 'Operation not permitted' } });
    await assert.rejects(removeAgent({ plistPath, uid: UID, run }), /Operation not permitted/);
    assert.equal(fs.existsSync(plistPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent is used only by the installed app, with no test or dev data folder', () => {
  assert.equal(usesLaunchAgent({ packaged: true, dataDir: undefined }), true);
  assert.equal(usesLaunchAgent({ packaged: true, dataDir: '' }), true);
  assert.equal(usesLaunchAgent({ packaged: false, dataDir: undefined }), false, 'a dev build');
  assert.equal(usesLaunchAgent({ packaged: true, dataDir: '/tmp/d' }), false, 'a test folder');
  assert.equal(usesLaunchAgent({ packaged: false, dataDir: '/tmp/d' }), false);
});

test('the daemon build goes in the plist, so an updated app reloads the agent', async () => {
  const { dir, plistPath } = scratchPlist();
  const bin = path.join(dir, 'apex-daemon');
  fs.writeFileSync(bin, 'old');
  const first = agentPlist({ bin, logFile: '/tmp/l.log', build: daemonBuild(bin) });
  assert.match(first, /<key>APEX_DAEMON_BUILD<\/key>\s*<string>3-\d+<\/string>/);
  const launchctl = fakeLaunchctl();
  await installAgent({ plistPath, plist: first, uid: UID, run: launchctl.run });
  fs.writeFileSync(bin, 'newer build');
  const second = agentPlist({ bin, logFile: '/tmp/l.log', build: daemonBuild(bin) });
  assert.notEqual(second, first);
  launchctl.calls.length = 0;
  await installAgent({ plistPath, plist: second, uid: UID, run: launchctl.run });
  assert.ok(launchctl.calls.includes(`bootstrap gui/${UID} ${plistPath}`), 'reloaded with the new build');
  assert.equal(daemonBuild(path.join(dir, 'gone')), 'missing');
});
