import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONHOST_COMMAND,
  TASK_NAME,
  currentUserId,
  decodeTaskXml,
  encodeTaskXml,
  installLogonTask,
  removeLogonTask,
  schtasks,
  startLogonTaskDaemon,
  taskArguments,
  taskCommand,
  taskXml,
  usesLogonTask,
} from '../desktop/winLogonTask.mjs';
import { daemonBuild } from '../desktop/launchAgent.mjs';
import { answers, daemonBinary, daemonEndpoint, waitForSocket } from '../desktop/sidecar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function fakeSchtasks({ loaded = false, fail = {} } = {}) {
  const calls = [];
  let isLoaded = loaded;
  const run = async (args) => {
    calls.push(args.join(' '));
    const [verb] = args;
    if (fail[verb]) throw new Error(fail[verb]);
    if (verb === '/Query' || verb === '/Delete') {
      if (!isLoaded) throw new Error('ERROR: The system cannot find the file specified.');
      if (verb === '/Delete') isLoaded = false;
      return '';
    }
    if (verb === '/Create') isLoaded = true;
    return '';
  };
  return { calls, run };
}

function scratchStamp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-win-task-'));
  return { dir, stampFile: path.join(dir, 'logon-task.stamp') };
}

test('usesLogonTask enables the scheduled task only on packaged Windows builds without a custom dataDir', () => {
  assert.equal(usesLogonTask({ packaged: true, dataDir: undefined, platform: 'win32' }), true);
  assert.equal(usesLogonTask({ packaged: true, dataDir: '', platform: 'win32' }), true);
  assert.equal(usesLogonTask({ packaged: false, dataDir: undefined, platform: 'win32' }), false);
  assert.equal(usesLogonTask({ packaged: true, dataDir: 'C:\\temp\\d', platform: 'win32' }), false);
  assert.equal(usesLogonTask({ packaged: true, dataDir: undefined, platform: 'darwin' }), false);
});

test('currentUserId combines USERDOMAIN and USERNAME when present', () => {
  assert.equal(currentUserId({ USERDOMAIN: 'DESKTOP-PC', USERNAME: 'alice' }), 'DESKTOP-PC\\alice');
  assert.equal(currentUserId({ USERDOMAIN: '', USERNAME: 'alice' }), 'alice');
});

test('taskXml sets UTF-16 encoding, per-user UserId on LogonTrigger and Principal, battery/time limits, Priority 5, and System32 conhost.exe', () => {
  const xml = taskXml({
    bin: 'C:\\Program Files\\Apex Deck\\resources\\bin\\apex-daemon.exe',
    env: { USERDOMAIN: 'WORKGROUP', USERNAME: 'tester' },
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>WORKGROUP\\tester<\/UserId>\s*<\/LogonTrigger>/);
  assert.match(xml, /<Principal id="Author">\s*<UserId>WORKGROUP\\tester<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Priority>5<\/Priority>/);
  assert.match(xml, /<Command>%SystemRoot%\\System32\\conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless &quot;C:\\Program Files\\Apex Deck\\resources\\bin\\apex-daemon\.exe&quot; serve<\/Arguments>/);
  assert.doesNotMatch(xml, /--data-dir/);
  assert.equal(
    taskCommand({ bin: 'C:\\Apex\\apex-daemon.exe', dataDir: 'C:\\Data' }),
    `${CONHOST_COMMAND} ${taskArguments({ bin: 'C:\\Apex\\apex-daemon.exe', dataDir: 'C:\\Data' })}`,
  );
});

test('taskXml escapes special XML characters in paths, build stamps, and UserId', () => {
  const xml = taskXml({
    bin: `C:\\it's & <b>\\apex-daemon.exe`,
    dataDir: 'C:\\data&dir',
    build: 'v1&2<3>',
    userId: `DOM&AIN\\u"s'e<r>`,
  });
  assert.match(xml, /<Description>Apex Deck background daemon \(v1&amp;2&lt;3&gt;\)<\/Description>/);
  assert.match(xml, /<UserId>DOM&amp;AIN\\u&quot;s&apos;e&lt;r&gt;<\/UserId>/);
  assert.match(xml, /--data-dir &quot;C:\\data&amp;dir&quot;/);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'no bare ampersand');
});

test('encodeTaskXml writes UTF-16LE with a BOM and decodeTaskXml round-trips it', () => {
  const sample = taskXml({ bin: 'C:\\Apex\\apex-daemon.exe', userId: 'PC\\me' });
  const encoded = encodeTaskXml(sample);
  assert.equal(encoded[0], 0xff);
  assert.equal(encoded[1], 0xfe);
  assert.equal(encoded.length, 2 + Buffer.byteLength(sample, 'utf16le'));
  assert.equal(decodeTaskXml(encoded), sample);
});

test('installLogonTask writes UTF-16LE XML with BOM, registers when missing, and skips rewrite when stamp matches', async () => {
  const { dir, stampFile } = scratchStamp();
  try {
    const bin = path.join(dir, 'apex-daemon.exe');
    fs.writeFileSync(bin, 'v1');
    const env = { USERDOMAIN: 'PC', USERNAME: 'me' };
    const { calls, run } = fakeSchtasks({ loaded: false });

    const first = await installLogonTask({ bin, build: daemonBuild(bin), stampFile, env, run });
    assert.equal(first, 'installed');
    const raw = fs.readFileSync(stampFile);
    assert.equal(raw[0], 0xff);
    assert.equal(raw[1], 0xfe);
    assert.equal(decodeTaskXml(raw), taskXml({ bin, build: daemonBuild(bin), env }));
    assert.deepEqual(calls, [
      `/Query /TN ${TASK_NAME}`,
      `/Create /TN ${TASK_NAME} /XML ${stampFile} /F`,
      `/Run /TN ${TASK_NAME}`,
    ]);

    calls.length = 0;
    const second = await installLogonTask({ bin, build: daemonBuild(bin), stampFile, env, run });
    assert.equal(second, 'unchanged');
    assert.deepEqual(calls, [
      `/Query /TN ${TASK_NAME}`,
      `/Run /TN ${TASK_NAME}`,
    ]);

    calls.length = 0;
    fs.writeFileSync(bin, 'v2-updated-binary');
    const third = await installLogonTask({ bin, build: daemonBuild(bin), stampFile, env, run });
    assert.equal(third, 'installed');
    assert.deepEqual(calls, [
      `/Query /TN ${TASK_NAME}`,
      `/Create /TN ${TASK_NAME} /XML ${stampFile} /F`,
      `/Run /TN ${TASK_NAME}`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installLogonTask re-registers when stampFile matches but Task Scheduler does not have the task loaded', async () => {
  const { dir, stampFile } = scratchStamp();
  try {
    const bin = 'C:\\Apex\\apex-daemon.exe';
    const env = { USERDOMAIN: 'PC', USERNAME: 'me' };
    fs.writeFileSync(stampFile, encodeTaskXml(taskXml({ bin, build: 'b1', env })));
    const { calls, run } = fakeSchtasks({ loaded: false });
    const status = await installLogonTask({ bin, build: 'b1', stampFile, env, run });
    assert.equal(status, 'installed');
    assert.ok(calls.includes(`/Create /TN ${TASK_NAME} /XML ${stampFile} /F`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installLogonTask wraps schtasks failures with a clear message', async () => {
  const { dir, stampFile } = scratchStamp();
  try {
    const { run } = fakeSchtasks({ fail: { '/Create': 'ERROR: Access is denied.' } });
    await assert.rejects(
      installLogonTask({ bin: 'C:\\Apex\\apex-daemon.exe', stampFile, run }),
      /The background service didn't start: ERROR: Access is denied\./,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeLogonTask deletes a loaded task and removes the stamp file', async () => {
  const { dir, stampFile } = scratchStamp();
  try {
    fs.writeFileSync(stampFile, 'stamp');
    const { calls, run } = fakeSchtasks({ loaded: true });
    assert.equal(await removeLogonTask({ stampFile, run }), true);
    assert.deepEqual(calls, [`/Query /TN ${TASK_NAME}`, `/Delete /TN ${TASK_NAME} /F`]);
    assert.equal(fs.existsSync(stampFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startLogonTaskDaemon attaches to a foreign daemon or starts the scheduled task and cleans up on timeout', async () => {
  let installs = 0;
  let removes = 0;
  let serving = false;
  let info = null;
  const { run } = fakeSchtasks({ loaded: false });

  assert.equal(
    await startLogonTaskDaemon({
      socket: '\\\\.\\pipe\\apex-test',
      infoFile: 'C:\\info.json',
      run,
      answers: async () => true,
      install: async () => { installs += 1; },
      remove: async () => { removes += 1; },
      readInfo: () => ({ pid: 999 }),
      wait: async () => {},
    }),
    'foreign',
  );
  assert.equal(installs, 0);

  assert.equal(
    await startLogonTaskDaemon({
      socket: '\\\\.\\pipe\\apex-test',
      infoFile: 'C:\\info.json',
      run,
      answers: async () => serving,
      install: async () => { installs += 1; serving = true; info = { pid: 4242 }; },
      remove: async () => { removes += 1; },
      readInfo: () => info,
      wait: async () => {},
    }),
    'agent',
  );
  assert.equal(installs, 1);
  assert.equal(removes, 0);

  serving = false;
  info = null;
  await assert.rejects(
    startLogonTaskDaemon({
      socket: '\\\\.\\pipe\\apex-test',
      infoFile: 'C:\\info.json',
      run,
      timeout: 5,
      answers: async () => false,
      install: async () => { installs += 1; },
      remove: async () => { removes += 1; },
      readInfo: () => null,
      wait: async () => {},
    }),
    /didn't start within/,
  );
  assert.equal(removes, 1);
});

test('Windows Task Scheduler registers real taskXml, launches apex-daemon via headless conhost, and answers on the pipe', { skip: process.platform !== 'win32' }, async () => {
  const bin = daemonBinary({ packaged: false, repo, env: process.env });
  if (!fs.existsSync(bin)) {
    execFileSync('cargo', ['build', '--locked', '-p', 'apex-daemon'], { cwd: repo, stdio: 'inherit' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-win-sched-'));
  const dataDir = path.join(dir, 'data');
  const stampFile = path.join(dir, 'logon-task.stamp');
  const infoFile = path.join(dataDir, 'daemon.json');
  const taskName = `ApexDeckDaemonTest-${process.pid}`;
  let socket = '';
  try {
    socket = await daemonEndpoint(bin, dataDir);
    const got = await startLogonTaskDaemon({
      socket,
      infoFile,
      taskName,
      answers,
      install: () => installLogonTask({ bin, dataDir, build: daemonBuild(bin), stampFile, taskName }),
      remove: () => removeLogonTask({ stampFile, taskName }),
    });
    assert.equal(got, 'agent');
    assert.equal(await answers(socket), true);
  } finally {
    const info = (() => {
      try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
    })();
    await schtasks(['/End', '/TN', taskName]).catch(() => {});
    await schtasks(['/Delete', '/TN', taskName, '/F']).catch(() => {});
    if (typeof info?.pid === 'number' && info.pid > 0) {
      try { process.kill(info.pid); } catch { /* already exited */ }
    }
    if (socket) {
      await waitForSocket(socket, { wanted: false, timeout: 5_000 }).catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
