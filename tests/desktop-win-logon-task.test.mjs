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
  startLogonTaskDaemon as startReal,
  cmdCommand,
  taskArguments,
  taskPresence,
  taskState,
  TASK_STATE,
  scheduledTaskState,
  taskCommand,
  taskXml,
  usesLogonTask,
  killTaskDaemon,
  daemonExited,
  endLogonTaskDaemon,
  daemonProcesses,
  listDaemonProcesses,
  parseDaemonList,
  processPath,
  processPathScript,
  DAEMON_LIST_SCRIPT,
} from '../desktop/winLogonTask.mjs';
import { daemonBuild } from '../desktop/launchAgent.mjs';
import { answers, daemonBinary, daemonEndpoint, waitForSocket } from '../desktop/sidecar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function fakeSchtasks({ loaded = false, fail = {}, running = () => false, code = null, queryFails = () => false, onEnd = () => {}, onCreate = () => {}, stateOutput = null, listFails = false, nameQueryFails = false, listOutput = null } = {}) {
  const calls = [];
  let isLoaded = loaded;
  const run = async (args) => {
    calls.push(args.join(' '));
    const [verb] = args;
    if (fail[verb]) throw new Error(fail[verb]);
    if (verb === '/Query' && !args.includes('/TN')) {
      if (listFails) throw new Error('ERROR: Access is denied.');
      if (listOutput !== null) return listOutput;
      return `"\\Other","N/A","Ready"\r\n${isLoaded ? '"\\ApexDeckDaemon","N/A","Running"\r\n' : ''}`;
    }
    if (verb === '/Query' && nameQueryFails) throw new Error('ERROR: Access is denied.');
    if (verb === '/Query' || verb === '/Delete') {
      if (!isLoaded) throw new Error('ERROR: The system cannot find the file specified.');
      if (verb === '/Delete') isLoaded = false;
      return '';
    }
    if (verb === '/Create') { isLoaded = true; onCreate(); }
    if (verb === '/End') onEnd();
    return '';
  };
  // Get-ScheduledTask's numeric TASK_STATE: Running 4, Ready 3, unless `code` says otherwise.
  const state = async (name) => {
    calls.push(`STATE ${name}`);
    if (!isLoaded) throw new Error('No MSFT_ScheduledTask objects found');
    if (queryFails()) throw new Error('Access is denied.');
    if (stateOutput !== null) return stateOutput;
    return `${code ? code() : running() ? TASK_STATE.RUNNING : TASK_STATE.READY}\r\n`;
  };
  return { calls, run, state };
}

/**
 * startLogonTaskDaemon with an injected process list, so no unit test runs the
 * real Get-Process. By default Windows lists no apex-daemon; tests that model a
 * daemon outliving its task pass their own `listDaemons`.
 */
const startLogonTaskDaemon = (options) => startReal({ listDaemons: async () => [], ...options });

/** A clock that moves `step` ms each time it is read. */
function fakeClock(step) {
  let t = 0;
  return () => (t += step);
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
    const { run, state } = fakeSchtasks({ fail: { '/Create': 'ERROR: Access is denied.' } });
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

test('startLogonTaskDaemon attaches to a foreign daemon or starts the scheduled task', async () => {
  let installs = 0;
  let serving = false;
  let info = null;
  const { run, calls, state } = fakeSchtasks({ loaded: false });

  assert.equal(
    await startLogonTaskDaemon({
      socket: '\\\\.\\pipe\\apex-test',
      infoFile: 'C:\\info.json',
      run,
      queryState: state,
      answers: async () => true,
      install: async () => { installs += 1; },
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
      queryState: state,
      answers: async () => serving,
      install: async () => { installs += 1; serving = true; info = { pid: 4242 }; },
      readInfo: () => info,
      wait: async () => {},
    }),
    'agent',
  );
  assert.equal(installs, 1);
  assert.ok(!calls.some((c) => c.startsWith('/Delete')), 'the task is never deleted');
});

test('a task whose daemon exits before answering stays registered for the next sign-in', async () => {
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => false });
  await assert.rejects(
    startLogonTaskDaemon({
      socket: 'p', infoFile: 'i', run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
      answers: async () => false, install: async () => {}, readInfo: () => null,
      wait: async () => {}, now: fakeClock(1_000),
    }),
    /stopped before it answered/,
  );
  assert.ok(!calls.some((c) => c.startsWith('/Delete')), 'not deleted');
  assert.ok(!calls.some((c) => c.startsWith('/End')), 'nothing left to end');
});

test('a slow start is waited for past 15 seconds while the task is still running', async () => {
  let reads = 0;
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => true });
  const got = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    // Serving only after about 40 seconds of the fake clock.
    answers: async () => reads > 40, install: async () => {}, readInfo: () => { reads += 1; return { pid: 77 }; },
    wait: async () => {}, now: fakeClock(1_000),
  });
  assert.equal(got, 'agent');
  assert.ok(calls.some((c) => c.startsWith('STATE')), 'asked Task Scheduler whether it is still running');
  assert.ok(!calls.some((c) => c.startsWith('/Delete') || c.startsWith('/End')));
});

test('a task still running at the long limit is ended, not deleted, and a fallback is allowed once it is confirmed stopped', async () => {
  let ended = false;
  let killed = false;
  const bin = 'C:\\Apex\\apex-daemon.exe';
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => !ended, onEnd: () => { ended = true; } });
  const error = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', bin, run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => ({ pid: 4242 }),
    pathOf: async () => (killed ? null : bin), kill: async () => { killed = true; },
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.match(error.message, /didn't start within 120 seconds$/);
  assert.notEqual(error.fallback, false, 'confirmed stopped: the fallback daemon may start');
  assert.ok(calls.includes('/End /TN ApexDeckDaemon'));
  assert.ok(!calls.some((c) => c.startsWith('/Delete')));
});

test('killTaskDaemon kills the daemon.json process tree only when Windows says it is apex-daemon', async () => {
  const bin = 'C:\\Program Files\\Apex Deck\\apex-daemon.exe';
  const run = async (over) => {
    const killed = [];
    const got = await killTaskDaemon({
      infoFile: 'i', bin, readInfo: () => ({ pid: 4242 }), pathOf: async () => bin,
      kill: async (pid) => { killed.push(pid); }, ...over,
    });
    return { got, killed };
  };
  assert.deepEqual(await run({}), { got: 'killed', killed: [4242] });
  // Same program, different case and a redundant segment.
  assert.deepEqual(await run({ pathOf: async () => 'c:\\program files\\APEX DECK\\.\\APEX-DAEMON.EXE\r\n' }), { got: 'killed', killed: [4242] });
  // No usable process ID in daemon.json.
  for (const info of [null, {}, { pid: 0 }, { pid: -1 }, { pid: '4242' }, { pid: 1.5 }]) {
    assert.deepEqual(await run({ readInfo: () => info }), { got: 'no-pid', killed: [] }, JSON.stringify(info));
  }
  // A stale ID now used by another program, an apex-daemon from elsewhere, a gone process, or no answer.
  assert.deepEqual(await run({ pathOf: async () => 'C:\\Windows\\notepad.exe' }), { got: 'not-daemon', killed: [] });
  assert.deepEqual(await run({ pathOf: async () => 'D:\\Other\\apex-daemon.exe' }), { got: 'not-daemon', killed: [] });
  assert.deepEqual(await run({ pathOf: async () => { throw new Error('Cannot find a process with the process identifier 4242.'); } }), { got: 'not-daemon', killed: [] });
  assert.deepEqual(await run({ pathOf: async () => '' }), { got: 'not-daemon', killed: [] });
  // Without bin, the program name alone must still be apex-daemon.exe.
  assert.deepEqual(await run({ bin: '', pathOf: async () => 'D:\\Other\\apex-daemon.exe' }), { got: 'killed', killed: [4242] });
  assert.deepEqual(await run({ bin: '', pathOf: async () => 'D:\\Other\\apex-daemon-helper.exe' }), { got: 'not-daemon', killed: [] });
  // taskkill failing is reported, not thrown.
  assert.deepEqual(await run({ kill: async () => { throw new Error('ERROR: Access is denied.'); } }), { got: 'failed', killed: [] });
});

test('endLogonTaskDaemon ends the task first, then kills the daemon under it, even when /End fails', async () => {
  const order = [];
  const got = await endLogonTaskDaemon({
    taskName: 'T', run: async (args) => { order.push(args.join(' ')); throw new Error('ERROR: Access is denied.'); },
    infoFile: 'i', readInfo: () => ({ pid: 7 }), pathOf: async () => 'C:\\x\\apex-daemon.exe',
    kill: async (pid) => { order.push(`kill ${pid}`); },
  });
  assert.equal(got, 'killed');
  assert.deepEqual(order, ['/End /TN T', 'kill 7']);
});

test('at the slow limit the daemon under the task is killed by its daemon.json ID before a fallback is allowed', async () => {
  // The daemon wrote daemon.json, then hung: it never answers. /End stops only the task.
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => !calls.includes('/End /TN ApexDeckDaemon') });
  const bin = 'C:\\Apex\\apex-daemon.exe';
  const error = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', bin, run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => ({ pid: 4242 }),
    pathOf: async (pid) => { calls.push(`PATH ${pid}`); return calls.includes(`KILL ${pid}`) ? null : bin; },
    kill: async (pid) => { calls.push(`KILL ${pid}`); },
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.notEqual(error.fallback, false, 'killed, confirmed exited and quiet: the fallback may start');
  const end = calls.indexOf('/End /TN ApexDeckDaemon');
  assert.ok(end >= 0 && calls.indexOf('KILL 4242') > end, 'the daemon is killed after /End');
  // A daemon.json ID that now belongs to another program is never killed.
  const other = fakeSchtasks({ loaded: true, running: () => !other.calls.includes('/End /TN ApexDeckDaemon') });
  let killed = false;
  await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', bin, run: other.run, queryState: other.state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => ({ pid: 4242 }),
    pathOf: async () => 'C:\\Windows\\notepad.exe', kill: async () => { killed = true; },
    wait: async () => {}, now: fakeClock(1_000),
  }).catch(() => {});
  assert.equal(killed, false);
});

test('daemonExited needs Windows to confirm the process is gone or now another program', async () => {
  const bin = 'C:\\Apex\\apex-daemon.exe';
  const exited = (pathOf, pid = 4242, over = {}) => daemonExited(pid, { bin, pathOf, ...over });
  assert.equal(await exited(async () => null), true, 'no process with that ID');
  assert.equal(await exited(async () => 'C:\\Windows\\notepad.exe'), true, 'the ID now belongs to another program');
  assert.equal(await exited(async () => 'D:\\Other\\apex-daemon.exe'), true, 'an apex-daemon somewhere else is not ours');
  assert.equal(await exited(async () => bin), false, 'still our daemon');
  assert.equal(await exited(async () => 'c:\\apex\\APEX-DAEMON.EXE\r\n'), false, 'capital letters and line ends do not matter');
  assert.equal(await exited(async () => ''), false, 'a process whose path cannot be read may still be ours');
  assert.equal(await exited(async () => { throw new Error('Access is denied.'); }), false, 'a failed query proves nothing');
  assert.equal(await exited(async () => 'D:\\Other\\apex-daemon.exe', 4242, { bin: '' }), false, 'without bin, any apex-daemon may be ours');
  for (const pid of [undefined, null, 0, -1, 1.5, '4242']) {
    assert.equal(await daemonExited(pid, { bin, pathOf: async () => null }), false, `no usable ID: ${pid}`);
  }
});

test('at the slow limit a daemon that was not killed, or did not exit, forbids the fallback', async () => {
  const bin = 'C:\\Apex\\apex-daemon.exe';
  // In every case /End works and the task reads as stopped with nothing answering:
  // only the process check stands between the hung daemon and a second one.
  const attempt = async (over) => {
    const fake = fakeSchtasks({ loaded: true, running: () => !fake.calls.includes('/End /TN ApexDeckDaemon') });
    const error = await startLogonTaskDaemon({
      socket: 'p', infoFile: 'i', bin, run: fake.run, queryState: fake.state, timeout: 15_000, slowTimeout: 120_000,
      answers: async () => false, install: async () => {}, readInfo: () => ({ pid: 4242 }),
      pathOf: async () => bin, kill: async () => {},
      wait: async () => {}, now: fakeClock(1_000), ...over,
    }).catch((e) => e);
    assert.ok(error instanceof Error, 'never answered: an error');
    return error;
  };
  // daemon.json has no process ID yet: nothing to kill.
  const noPid = await attempt({ readInfo: () => null });
  assert.equal(noPid.fallback, false);
  assert.match(noPid.message, /hasn't recorded its process ID/);
  // taskkill refused: the daemon stays alive.
  const denied = await attempt({ kill: async () => { throw new Error('ERROR: Access is denied.'); } });
  assert.equal(denied.fallback, false);
  assert.match(denied.message, /couldn't be stopped/);
  // The recorded ID isn't our daemon (a stale daemon.json): the hung one is unidentified.
  const stale = await attempt({ pathOf: async () => null });
  assert.equal(stale.fallback, false);
  assert.match(stale.message, /isn't a running apex-daemon/);
  // taskkill reported success, but Windows still shows the daemon running.
  const alive = await attempt({});
  assert.equal(alive.fallback, false);
  assert.match(alive.message, /couldn't be confirmed stopped/);
  // Windows can't be asked after the kill: not confirmed.
  let killed = false;
  const unasked = await attempt({
    pathOf: async () => { if (killed) throw new Error('powershell failed'); return bin; },
    kill: async () => { killed = true; },
  });
  assert.equal(unasked.fallback, false);
});

test('a failed /End that leaves the task running forbids the fallback daemon', async () => {
  const { run, state } = fakeSchtasks({ loaded: true, running: () => true, fail: { '/End': 'ERROR: Access is denied.' } });
  const error = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => null,
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(error.fallback, false);
  assert.match(error.message, /won't start a second one/);
});

test('a Task Scheduler query that fails is not taken as stopped: it keeps waiting, then forbids the fallback', async () => {
  let reads = 0;
  // The query always fails; the daemon answers after about 40 fake seconds.
  const slow = fakeSchtasks({ loaded: true, running: () => true, queryFails: () => true });
  assert.equal(
    await startLogonTaskDaemon({
      socket: 'p', infoFile: 'i', run: slow.run, queryState: slow.state, timeout: 15_000, slowTimeout: 120_000,
      answers: async () => reads > 40, install: async () => {}, readInfo: () => { reads += 1; return { pid: 7 }; },
      wait: async () => {}, now: fakeClock(1_000),
    }),
    'agent',
  );
  const never = fakeSchtasks({ loaded: true, running: () => true, queryFails: () => true });
  const error = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: never.run, queryState: never.state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => null,
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(error.fallback, false, 'never confirmed stopped');
});

test('a daemon that becomes ready while Task Scheduler is asked at the long limit is kept, not ended', async () => {
  let ready = false;
  let t = 0;
  const now = () => (t += 1_000);
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => true });
  const answering = async (name) => {
    const out = await state(name);
    // The daemon finishes starting during the state query past the long limit.
    if (t > 120_000) ready = true;
    return out;
  };
  const got = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run, queryState: answering, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => ready, install: async () => {}, readInfo: () => ({ pid: 9 }),
    wait: async () => {}, now,
  });
  assert.equal(got, 'agent');
  assert.ok(!calls.some((c) => c.startsWith('/End')), 'a ready daemon is never ended');
});

test('taskState reads the numeric TASK_STATE, so it works in any Windows language', async () => {
  const of = (code) => taskState(fakeSchtasks({ loaded: true, code: () => code }).state);
  assert.equal(await of(TASK_STATE.RUNNING), 'running');
  assert.equal(await of(TASK_STATE.QUEUED), 'queued');
  assert.equal(await of(TASK_STATE.READY), 'stopped');
  assert.equal(await of(TASK_STATE.DISABLED), 'unknown');
  assert.equal(await of(TASK_STATE.UNKNOWN), 'unknown');
  assert.equal(await of(9), 'unknown');
  assert.equal(await taskState(fakeSchtasks({ loaded: true, queryFails: () => true }).state), 'unknown');
  assert.equal(await taskState(fakeSchtasks({ loaded: false }).state), 'unknown');
  assert.equal(await taskState(() => { throw new Error('spawn failed'); }), 'unknown');
});

test('taskState treats missing or unrecognized output as unknown, never stopped', async () => {
  for (const stateOutput of [
    '',
    '\r\n',
    'Ready\r\n',
    'Bereit\r\n',
    '3 4\r\n',
    '-3\r\n',
    '0x3\r\n',
    '3\r\n4\r\n',
    '"PC","\\ApexDeckDaemon","N/A","Ready","Interactive","N/A","0","PC\\user","C:\\x.exe"\r\n',
  ]) {
    assert.equal(await taskState(fakeSchtasks({ loaded: true, stateOutput }).state), 'unknown', JSON.stringify(stateOutput));
  }
});

test('a queued task is never taken as stopped: no fallback at 15 seconds, after /End, or after a failed install', async () => {
  // Queued the whole time and never answers: Deck waits out the long limit, ends it, and still refuses a second daemon.
  const queued = fakeSchtasks({ loaded: true, code: () => TASK_STATE.QUEUED });
  const slow = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: queued.run, queryState: queued.state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => {}, readInfo: () => null,
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(slow.fallback, false, 'a task still queued after /End is not confirmed stopped');
  assert.ok(queued.calls.includes('/End /TN ApexDeckDaemon'), 'it was not given up on at 15 seconds');
  // The install fails while the sign-in run is queued: no fallback at once either.
  const failedInstall = fakeSchtasks({ loaded: true, code: () => TASK_STATE.QUEUED });
  let polls = 0;
  const afterInstall = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: failedInstall.run, queryState: failedInstall.state,
    answers: async () => { polls += 1; return false; },
    install: async () => { throw new Error('ERROR: /Run failed'); },
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(afterInstall.fallback, false);
  assert.ok(polls > 15, 'Deck waited instead of falling back at once');
  // Queued, then the daemon starts and answers: Deck attaches to it.
  let reads = 0;
  const starts = fakeSchtasks({ loaded: true, code: () => (reads > 20 ? TASK_STATE.RUNNING : TASK_STATE.QUEUED) });
  assert.equal(await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: starts.run, queryState: starts.state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => reads > 40, install: async () => {}, readInfo: () => { reads += 1; return { pid: 3 }; },
    wait: async () => {}, now: fakeClock(1_000),
  }), 'agent');
});

test('scheduledTaskState refuses a task name it would have to quote for PowerShell', async () => {
  await assert.rejects(scheduledTaskState("x'; Remove-Item C:\\ -Recurse; '"), /Unexpected task name/);
  assert.equal(await taskState(() => scheduledTaskState('bad name')), 'unknown');
});

test('a failed registration or /Run while the sign-in daemon is still starting forbids the fallback', async () => {
  // /Run fails, the task's daemon from sign-in is still starting and never answers.
  const { run, calls, state } = fakeSchtasks({ loaded: true, running: () => true, fail: { '/End': 'ERROR: Access is denied.' } });
  const error = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => false, install: async () => { throw new Error("The background service didn't start: ERROR: Access is denied."); },
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(error.fallback, false, 'the sign-in daemon was never confirmed stopped');
  assert.ok(!calls.some((c) => c.startsWith('/Delete')));
});

test('a failed registration while the sign-in daemon is starting waits for it and attaches', async () => {
  let reads = 0;
  const { run, state } = fakeSchtasks({ loaded: true, running: () => true });
  const got = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run, queryState: state, timeout: 15_000, slowTimeout: 120_000,
    answers: async () => reads > 40, install: async () => { throw new Error('ERROR: Access is denied.'); },
    readInfo: () => { reads += 1; return { pid: 5 }; }, wait: async () => {}, now: fakeClock(1_000),
  });
  assert.equal(got, 'agent');
});

test('a failed install falls back at once only when no task daemon can be running', async () => {
  const failing = async () => { throw new Error("The background service didn't start: ERROR: Access is denied."); };
  // Registered, but Task Scheduler confirms its program stopped.
  const stopped = fakeSchtasks({ loaded: true, running: () => false });
  const a = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: stopped.run, queryState: stopped.state, answers: async () => false, install: failing,
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.match(a.message, /Access is denied/);
  assert.notEqual(a.fallback, false);
  // Never registered, and registration failed.
  const none = fakeSchtasks({ loaded: false, fail: { '/Create': 'ERROR: Access is denied.' } });
  const b = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: none.run, queryState: none.state, answers: async () => false, install: failing,
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.notEqual(b.fallback, false);
  // Registered just now (/Create worked), then /Run failed and the state can't be read: wait, never a second daemon.
  const fresh = fakeSchtasks({ loaded: false, queryFails: () => true });
  const c = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: fresh.run, queryState: fresh.state, answers: async () => false,
    install: async () => { await fresh.run(['/Create', '/TN', 'ApexDeckDaemon', '/XML', 'x', '/F']); throw new Error('ERROR: /Run failed'); },
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(c.fallback, false);
});

test('taskPresence is absent only when the task list can be read and lacks the task', async () => {
  assert.equal(await taskPresence(fakeSchtasks({ loaded: true }).run), 'present');
  assert.equal(await taskPresence(fakeSchtasks({ loaded: false }).run), 'absent');
  // The name query is denied, but the list shows the task.
  assert.equal(await taskPresence(fakeSchtasks({ loaded: true, nameQueryFails: true }).run), 'present');
  // Both queries fail: nothing is known, so it is never treated as absent.
  assert.equal(await taskPresence(fakeSchtasks({ loaded: false, listFails: true }).run), 'unknown');
  assert.equal(await taskPresence(fakeSchtasks({ loaded: true, nameQueryFails: true, listFails: true }).run), 'unknown');
});

test('taskPresence treats an unrecognized task list as unknown, never absent', async () => {
  const presence = (listOutput) => taskPresence(fakeSchtasks({ loaded: true, nameQueryFails: true, listOutput }).run);
  // Nothing, a message, or a different layout can't prove the task is missing.
  assert.equal(await presence(''), 'unknown');
  assert.equal(await presence('\r\n\r\n'), 'unknown');
  assert.equal(await presence('INFO: There are no scheduled tasks presently available at your access level.\r\n'), 'unknown');
  assert.equal(await presence('TaskName:  \\Other\r\nStatus:    Ready\r\n'), 'unknown');
  assert.equal(await presence('"\\Other","N/A"\r\n'), 'unknown');
  assert.equal(await presence('"Other","N/A","Ready"\r\n'), 'unknown');
  // A valid list with one malformed row is not a complete list.
  assert.equal(await presence('"\\Other","N/A","Ready"\r\n"\\Broken","N/A\r\n'), 'unknown');
  assert.equal(await presence('"\\Other","N/A","Ready"\r\ngarbage\r\n'), 'unknown');
  // A complete, well-formed list without the task is the only absence.
  assert.equal(await presence('"\\Other","N/A","Ready"\r\n"\\Microsoft\\Windows\\X","N/A","Ready"\r\n'), 'absent');
});

test('an unrecognized task list plus a failed install waits for the login daemon instead of doubling it', async () => {
  // The task exists, the name query is denied, the list is garbled, and the install fails.
  const garbled = fakeSchtasks({ loaded: true, nameQueryFails: true, listOutput: 'garbage\r\n', queryFails: () => true });
  let polls = 0;
  const err = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: garbled.run, queryState: garbled.state, answers: async () => { polls += 1; return false; },
    install: async () => { throw new Error('ERROR: /Create failed'); },
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(err.fallback, false, 'no second daemon while the login one may still be starting');
  assert.ok(polls > 15, 'Deck waited past the 15-second mark instead of falling back at once');
});

test('when every query and the install fail, a starting login daemon is waited for and never doubled', async () => {
  // The login task exists and its daemon is starting, but Task Scheduler answers nothing.
  const blind = fakeSchtasks({ loaded: true, nameQueryFails: true, listFails: true, queryFails: () => true });
  const err = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: blind.run, queryState: blind.state, answers: async () => false,
    install: async () => { throw new Error("The background service didn't start: ERROR: Access is denied."); },
    readInfo: () => null, wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.equal(err.fallback, false);
  assert.ok(blind.calls.includes('/End /TN ApexDeckDaemon'), 'it waited out the slow limit before giving up');
  // Same, but the login daemon answers while Deck waits.
  let reads = 0;
  const later = fakeSchtasks({ loaded: true, nameQueryFails: true, listFails: true, queryFails: () => true });
  const got = await startLogonTaskDaemon({
    socket: 'p', infoFile: 'i', run: later.run, queryState: later.state, answers: async () => reads > 40,
    install: async () => { throw new Error('ERROR: Access is denied.'); },
    readInfo: () => { reads += 1; return { pid: 5 }; }, wait: async () => {}, now: fakeClock(1_000),
  });
  assert.equal(got, 'agent');
});

test('with a log file the daemon runs under cmd.exe and appends its output and errors to that file', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const args = taskArguments({
    bin: 'C:\\Program Files\\Apex Deck\\apex-daemon.exe',
    logFile: 'C:\\Users\\a b\\AppData\\Roaming\\Apex Deck\\logs\\apex-daemon.log',
    env,
  });
  assert.equal(
    args,
    '--headless "C:\\Windows\\System32\\cmd.exe" /d /s /c ""C:\\Program Files\\Apex Deck\\apex-daemon.exe" serve >>"C:\\Users\\a b\\AppData\\Roaming\\Apex Deck\\logs\\apex-daemon.log" 2>&1"',
  );
  assert.equal(cmdCommand({ windir: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
  const xmlText = taskXml({ bin: 'C:\\a.exe', logFile: 'C:\\l.log', env: { ...env, USERNAME: 'u' } });
  assert.match(xmlText, /\/d \/s \/c &quot;&quot;C:\\a\.exe&quot; serve &gt;&gt;&quot;C:\\l\.log&quot; 2&gt;&amp;1&quot;/);
});

test('Windows Task Scheduler registers real taskXml, launches apex-daemon via headless conhost and cmd, logs, and answers on the pipe', { skip: process.platform !== 'win32' }, async () => {
  const bin = daemonBinary({ packaged: false, repo, env: process.env });
  if (!fs.existsSync(bin)) {
    execFileSync('cargo', ['build', '--locked', '-p', 'apex-daemon'], { cwd: repo, stdio: 'inherit' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-win-sched-'));
  const dataDir = path.join(dir, 'data');
  const stampFile = path.join(dir, 'logon-task.stamp');
  const infoFile = path.join(dataDir, 'daemon.json');
  const logFile = path.join(dir, 'logs', 'apex-daemon.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const taskName = `ApexDeckDaemonTest-${process.pid}`;
  let socket = '';
  try {
    socket = await daemonEndpoint(bin, dataDir);
    const got = await startReal({
      socket,
      infoFile,
      taskName,
      answers,
      install: () => installLogonTask({ bin, dataDir, logFile, build: daemonBuild(bin), stampFile, taskName }),
    });
    assert.equal(got, 'agent');
    assert.equal(await answers(socket), true);
    assert.equal(fs.existsSync(logFile), true, 'the task writes the daemon output to its log file');
    // Real Get-ScheduledTask: the numeric TASK_STATE of a running task.
    assert.equal(await taskState(scheduledTaskState, taskName), 'running', 'taskState reads the real TASK_STATE');
    // Real task list: the registered task is found, a missing one is confirmed absent.
    assert.equal(await taskPresence(schtasks, taskName), 'present');
    // Same, through the full-list path: the named query is forced to fail.
    const listOnly = (args) => (args[0] === '/Query' && args.includes('/TN') ? Promise.reject(new Error('forced')) : schtasks(args));
    assert.equal(await taskPresence(listOnly, taskName), 'present', 'taskPresence finds the task in the real task list');
    assert.equal(await taskPresence(listOnly, `${taskName}-missing`), 'absent', 'taskPresence reads the real task list');
    // Ending must take the daemon under conhost and cmd down too, or Deck refuses its fallback.
    // Real Get-Process and taskkill: /End alone leaves apex-daemon running under the task.
    const daemonPid = JSON.parse(fs.readFileSync(infoFile, 'utf8')).pid;
    assert.equal(await daemonExited(daemonPid, { bin }), false, 'real Get-Process: the running daemon has not exited');
    assert.ok((await listDaemonProcesses()).some((p) => p.pid === daemonPid), 'real Get-Process lists the running daemon');
    assert.equal(await daemonProcesses({ bins: [bin] }), 'running', 'a daemon at bin counts as running');
    assert.equal(await endLogonTaskDaemon({ taskName, infoFile, bin }), 'killed', 'the daemon.json ID is a running apex-daemon at bin');
    assert.equal(
      await waitForSocket(socket, { wanted: false, timeout: 10_000 }),
      true,
      'ending the task and killing its daemon: nothing answers within 10 s',
    );
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) {
      gone = await daemonExited(daemonPid, { bin });
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(gone, true, 'real Get-Process: the killed daemon reads as exited within 10 s');
    // Other test files may run their own daemons from the same build, so only this one is checked.
    assert.ok(!(await listDaemonProcesses()).some((p) => p.pid === daemonPid), 'real Get-Process no longer lists the killed daemon');
    assert.equal(await taskState(scheduledTaskState, taskName), 'stopped', 'an ended task reads as Ready (stopped)');
    assert.equal(await taskState(scheduledTaskState, `${taskName}-missing`), 'unknown', 'a missing task is unknown, not stopped');
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

test('a stopped task whose daemon is still running is not taken as exited: no fallback before the guarded kill', async () => {
  const bin = 'C:\\Apex\\apex-daemon.exe';
  const failing = async () => { throw new Error("The background service didn't start: ERROR: Access is denied."); };
  // The task reads Ready, nothing answers, but apex-daemon 4242 outlived it (as on Windows CI).
  const scenario = (over = {}) => {
    const fake = fakeSchtasks({ loaded: true, running: () => false });
    const seen = { lists: 0, kills: [], paths: 0 };
    let alive = true;
    const options = {
      socket: 'p', infoFile: 'i', bin, run: fake.run, queryState: fake.state, timeout: 15_000, slowTimeout: 120_000,
      answers: async () => false, install: async () => {}, readInfo: () => ({ pid: 4242 }),
      listDaemons: async () => { seen.lists += 1; return alive ? [{ pid: 4242, path: bin }] : []; },
      pathOf: async () => { seen.paths += 1; return alive ? bin : null; },
      kill: async (pid) => { seen.kills.push(pid); },
      wait: async () => {}, now: fakeClock(1_000),
      ...over,
    };
    return { fake, seen, options, die: () => { alive = false; } };
  };

  // During startup: the stopped task alone no longer allows the fallback at 15 s.
  const during = scenario();
  const a = await startReal(during.options).catch((e) => e);
  assert.ok(during.seen.lists > 0, 'Windows was asked which apex-daemon processes run');
  assert.deepEqual(during.seen.kills, [4242], 'it went through the guarded kill at the long limit');
  assert.doesNotMatch(a.message, /stopped before it answered/);
  assert.equal(a.fallback, false, 'the kill never took effect: no second daemon');

  // After a failed install: same, no immediate fallback.
  const install = scenario({ install: failing });
  const b = await startReal(install.options).catch((e) => e);
  assert.ok(install.seen.lists > 0);
  assert.deepEqual(install.seen.kills, [4242]);
  assert.equal(b.fallback, false);

  // The guarded kill works: then, and only then, the fallback is allowed.
  const works = scenario();
  works.options.kill = async (pid) => { works.seen.kills.push(pid); works.die(); };
  const c = await startReal(works.options).catch((e) => e);
  assert.deepEqual(works.seen.kills, [4242]);
  assert.match(c.message, /didn't start within 120 seconds$/);
  assert.notEqual(c.fallback, false);

  // Windows can't list processes: unknown never allows a fallback.
  const blind = scenario({ listDaemons: async () => { throw new Error('powershell failed'); } });
  blind.options.kill = async (pid) => { blind.seen.kills.push(pid); blind.die(); };
  const d = await startReal(blind.options).catch((e) => e);
  assert.equal(d.fallback, false, 'process list unreadable: never confirmed gone');
  const blindInstall = scenario({ install: failing, listDaemons: async () => { throw new Error('powershell failed'); } });
  assert.equal((await startReal(blindInstall.options).catch((e) => e)).fallback, false);
});

test('a stopped task with no daemon left still falls back at once', async () => {
  const fake = fakeSchtasks({ loaded: true, running: () => false });
  let lists = 0;
  const error = await startReal({
    socket: 'p', infoFile: 'i', bin: 'C:\\Apex\\apex-daemon.exe', run: fake.run, queryState: fake.state,
    timeout: 15_000, slowTimeout: 120_000, answers: async () => false, install: async () => {}, readInfo: () => null,
    listDaemons: async () => { lists += 1; return [{ pid: 9, path: 'D:\\Other\\apex-daemon.exe' }]; },
    wait: async () => {}, now: fakeClock(1_000),
  }).catch((e) => e);
  assert.match(error.message, /stopped before it answered/);
  assert.notEqual(error.fallback, false);
  assert.ok(lists > 0);
  assert.ok(!fake.calls.some((c) => c.startsWith('/End')));
});

test('daemonProcesses counts apex-daemon at Deck\'s paths or with a hidden path, and only a real list is none', async () => {
  const bin = 'C:\\Apex\\apex-daemon.exe';
  const other = 'C:\\Users\\u\\AppData\\Local\\Apex Deck\\apex-daemon.exe';
  const at = (found, bins = [bin, other]) => daemonProcesses({ bins, list: async () => found });
  assert.equal(await at([]), 'none');
  assert.equal(await at([{ pid: 1, path: 'c:\\apex\\APEX-DAEMON.EXE' }]), 'running');
  assert.equal(await at([{ pid: 1, path: other }]), 'running', 'the fallback copy counts too');
  assert.equal(await at([{ pid: 1, path: '' }]), 'running', 'a path Windows hides counts as ours');
  assert.equal(await at([{ pid: 1, path: 'D:\\Other\\apex-daemon.exe' }]), 'none');
  assert.equal(await at([{ pid: 1, path: 'D:\\Other\\apex-daemon.exe' }], ['', '']), 'running', 'no known path: any apex-daemon counts');
  assert.equal(await daemonProcesses({ bins: [bin], list: async () => { throw new Error('denied'); } }), 'unknown');
  assert.equal(await daemonProcesses({ bins: [bin], list: async () => null }), 'unknown');
});

// A PowerShell run that exits non-zero, the way the scripts do when Get-Process fails.
const failedPowerShell = (stdout = '') => (_file, _args, _opts, cb) => {
  const error = Object.assign(new Error('Command failed'), { code: 3 });
  queueMicrotask(() => cb(error, stdout, ''));
};
const okPowerShell = (stdout) => (_file, _args, _opts, cb) => queueMicrotask(() => cb(null, stdout, ''));

test('the process lookups fail on any Get-Process error and print markers only after a full list', async () => {
  for (const script of [DAEMON_LIST_SCRIPT, processPathScript(4242)]) {
    assert.doesNotMatch(script, /SilentlyContinue/, 'errors must not be suppressed');
    assert.match(script, /^try \{ \$all = @\(Get-Process -ErrorAction Stop\) \} catch \{ exit 3 \}; /, 'enumerate everything first; a failure exits non-zero');
    assert.doesNotMatch(script.slice(0, script.indexOf('}; ') + 3), /'BEGIN'|'NO-PROCESS'|'PATH:'/, 'no marker before the lookup succeeds');
    assert.doesNotMatch(script, /Get-Process -Name|Get-Process -Id/, 'filter after listing, not in the lookup');
  }
  // The command boundary: a failed run rejects even if it printed valid-looking markers.
  await assert.rejects(listDaemonProcesses({}, failedPowerShell('BEGIN\r\nEND\r\n')));
  await assert.rejects(processPath(4242, {}, failedPowerShell('NO-PROCESS\r\n')));
  assert.deepEqual(await listDaemonProcesses({}, okPowerShell('BEGIN\r\nEND\r\n')), []);
  assert.equal(await processPath(4242, {}, okPowerShell('NO-PROCESS\r\n')), null);
  // And that failure never reads as "no daemon left" or "daemon exited".
  assert.equal(await daemonProcesses({ list: () => listDaemonProcesses({}, failedPowerShell('BEGIN\r\nEND\r\n')) }), 'unknown');
  assert.equal(await daemonExited(4242, { pathOf: (pid) => processPath(pid, {}, failedPowerShell('NO-PROCESS\r\n')) }), false);
});

test('real PowerShell: a failing Get-Process makes both lookups exit non-zero with no markers', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Shadow Get-Process with one that reports a non-terminating error, like access denied.
  const failing = "function Get-Process { [CmdletBinding()] param() Write-Error 'lookup failed' }; ";
  for (const script of [DAEMON_LIST_SCRIPT, processPathScript(4242)]) {
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', failing + script], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = error.status;
      stdout = String(error.stdout ?? '');
    }
    assert.equal(status, 3, 'exits 3 when Get-Process fails');
    assert.doesNotMatch(stdout, /BEGIN|END|NO-PROCESS|PATH:/, 'prints no success marker');
  }
});

test('parseDaemonList accepts only the marked Get-Process output', () => {
  assert.deepEqual(parseDaemonList('BEGIN\r\nEND\r\n'), []);
  assert.deepEqual(
    parseDaemonList('BEGIN\r\nP:4242:C:\\Apex Deck\\apex-daemon.exe\r\nP:7:\r\nEND\r\n'),
    [{ pid: 4242, path: 'C:\\Apex Deck\\apex-daemon.exe' }, { pid: 7, path: '' }],
  );
  for (const bad of ['', 'END', 'BEGIN', 'BEGIN\r\nEND garbage', 'BEGIN\r\nWarnung: Zugriff verweigert\r\nEND', 'BEGIN\r\nP:x:C:\\a.exe\r\nEND', 'Zugriff verweigert']) {
    assert.equal(parseDaemonList(bad), null, JSON.stringify(bad));
  }
});
