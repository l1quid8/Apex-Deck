// The Windows PC's apex-daemon as a per-user Scheduled Task at logon on a
// packaged build, so it keeps running after Deck quits. Like launchAgent.mjs
// on macOS, everything that runs schtasks.exe or touches the disk is passed in
// so unit tests never touch the real Task Scheduler.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASK_NAME = 'ApexDeckDaemon';
export const CONHOST_COMMAND = '%SystemRoot%\\System32\\conhost.exe';
/** cmd.exe as a full path: conhost.exe is handed it literally, with no %SystemRoot% expansion. */
export const cmdCommand = (env = process.env) =>
  path.win32.join(env?.SystemRoot || env?.windir || 'C:\\Windows', 'System32', 'cmd.exe');
/**
 * Task Scheduler's numeric TASK_STATE (the same in every Windows language):
 * https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_state
 */
export const TASK_STATE = Object.freeze({ UNKNOWN: 0, DISABLED: 1, QUEUED: 2, READY: 3, RUNNING: 4 });

/**
 * The logon task serves the daemon only on a packaged Windows build with no
 * test or dev data folder; a dev build or test run keeps the daemon Deck owns.
 */
export const usesLogonTask = ({ packaged, dataDir, platform = process.platform }) =>
  platform === 'win32' && Boolean(packaged) && !dataDir;

/** The current Windows user as `DOMAIN\user` when `USERDOMAIN` is set, else `USERNAME`. */
export function currentUserId(env = process.env) {
  const domain = env?.USERDOMAIN?.trim();
  const user = env?.USERNAME?.trim() || env?.USER?.trim() || os.userInfo().username;
  return domain ? `${domain}\\${user}` : user;
}

const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

const xml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/** Encode Task Scheduler XML as UTF-16LE with a leading byte-order mark (0xFF, 0xFE). */
export function encodeTaskXml(xmlText) {
  return Buffer.from(`\uFEFF${String(xmlText).replace(/^\uFEFF/, '')}`, 'utf16le');
}

/** Decode a UTF-16LE (with BOM) or UTF-8 task XML buffer/string back to plain text. */
export function decodeTaskXml(raw) {
  if (typeof raw === 'string') return raw.replace(/^\uFEFF/, '');
  if (Buffer.isBuffer(raw)) {
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
      return raw.subarray(2).toString('utf16le');
    }
    return raw.toString('utf8').replace(/^\uFEFF/, '');
  }
  return null;
}

/**
 * Arguments passed to `conhost.exe` to start `apex-daemon serve` with no
 * console window. With `logFile`, the daemon runs under `cmd.exe /d /s /c` so
 * its output and errors are appended to that file, like the Mac LaunchAgent's
 * log: a start that fails at sign-in then leaves a record. `/s` makes cmd strip
 * exactly the outer pair of quotes, so quoted paths with spaces survive.
 */
export function taskArguments({ bin, dataDir, logFile = '', env = process.env }) {
  const serve = [quoteArg(bin), 'serve', ...(dataDir ? ['--data-dir', quoteArg(dataDir)] : [])].join(' ');
  if (!logFile) return `--headless ${serve}`;
  return `--headless ${quoteArg(cmdCommand(env))} /d /s /c "${serve} >>${quoteArg(logFile)} 2>&1"`;
}

/** The full command line for starting the headless logon task. */
export function taskCommand({ bin, dataDir, logFile = '', env = process.env }) {
  return `${CONHOST_COMMAND} ${taskArguments({ bin, dataDir, logFile, env })}`;
}

/**
 * Task Scheduler XML for `ApexDeckDaemon`. Runs at the current user's logon
 * with no battery restrictions (`DisallowStartIfOnBatteries=false`,
 * `StopIfGoingOnBatteries=false`), no 72-hour execution cap
 * (`ExecutionTimeLimit=PT0S`), normal priority (`Priority=5`), and headless
 * `%SystemRoot%\System32\conhost.exe` so no console window flashes on screen.
 */
export function taskXml({ bin, dataDir, logFile = '', build = '', userId, env = process.env }) {
  const description = build ? `Apex Deck background daemon (${build})` : 'Apex Deck background daemon';
  const account = userId ?? currentUserId(env);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(account)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(account)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${CONHOST_COMMAND}</Command>
      <Arguments>${xml(taskArguments({ bin, dataDir, logFile, env }))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** `schtasks.exe` with `args`: its output, or an error with what it said. */
export function schtasks(args) {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(stderr.trim() || stdout.trim() || error.message), { code: error.code }));
      else resolve(stdout);
    });
  });
}

/** Whether Task Scheduler has the logon task registered. A failed query counts as no. */
export const taskLoaded = (run = schtasks, taskName = TASK_NAME) =>
  run(['/Query', '/TN', taskName]).then(() => true, () => false);

/** The quoted fields of one `schtasks /FO CSV` row, or `null` if it isn't one. */
function csvFields(line) {
  const fields = [];
  const pattern = /"((?:[^"]|"")*)"(,|$)/y;
  let match;
  while (pattern.lastIndex < line.length && (match = pattern.exec(line))) {
    fields.push(match[1].replace(/""/g, '"'));
    if (match[2] === '') return fields;
  }
  return null;
}

/**
 * Whether the logon task is registered: `'present'`, `'absent'`, or
 * `'unknown'`. A failed `/Query /TN` is only `'absent'` when the full task
 * list (`/Query /FO CSV /NH`) can be read and has no row for the task, since
 * the error text for a missing task is localized and access denied fails the
 * same way. If the list can't be read either, the answer is `'unknown'`.
 */
export async function taskPresence(run = schtasks, taskName = TASK_NAME) {
  try {
    await run(['/Query', '/TN', taskName]);
    return 'present';
  } catch { /* missing, or the query itself failed: ask for the list */ }
  let out;
  try {
    out = await run(['/Query', '/FO', 'CSV', '/NH']);
  } catch {
    return 'unknown';
  }
  const rows = parseTaskList(out);
  if (!rows) return 'unknown';
  const wanted = `\\${taskName}`.toLowerCase();
  return rows.some((row) => row[0].toLowerCase() === wanted) ? 'present' : 'absent';
}

/** Columns of one `schtasks /Query /FO CSV /NH` row: TaskName, Next Run Time, Status. */
const TASK_LIST_COLUMNS = 3;

/**
 * The rows of a `schtasks /Query /FO CSV /NH` list, or `null` unless every
 * nonblank line is a well-formed row whose name starts with `\` and there is
 * at least one. Empty, partial or unrecognized output can't prove a task is
 * missing, so it yields `null` (unknown), never an empty list.
 */
function parseTaskList(out) {
  const lines = String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const rows = [];
  for (const line of lines) {
    const fields = csvFields(line);
    if (!fields || fields.length !== TASK_LIST_COLUMNS || !fields[0].startsWith('\\')) return null;
    rows.push(fields);
  }
  return rows;
}

/** Task names this module passes to PowerShell: no quoting needed, nothing to inject. */
const SAFE_TASK_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The logon task's numeric TASK_STATE as PowerShell prints it, e.g. `4\r\n`.
 * schtasks.exe only reports state as localized words, so this asks
 * `Get-ScheduledTask`, whose `State` is the TASK_STATE enum.
 */
export function scheduledTaskState(taskName = TASK_NAME, env = process.env) {
  if (!SAFE_TASK_NAME.test(taskName)) return Promise.reject(new Error(`Unexpected task name: ${taskName}`));
  const powershell = path.win32.join(env?.SystemRoot || env?.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `[int](Get-ScheduledTask -TaskPath '\\' -TaskName '${taskName}' -ErrorAction Stop).State`;
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || error.message));
        else resolve(stdout);
      });
  });
}

/**
 * The task's state: `'running'`, `'queued'`, `'stopped'` or `'unknown'`, from
 * its numeric TASK_STATE. Only Ready (no instance running or waiting to run)
 * is `'stopped'`. Queued means Task Scheduler is about to start the program,
 * so it never counts as stopped. A failed query, Disabled, Unknown, or output
 * that isn't one whole number is `'unknown'`.
 */
export const taskState = (query = scheduledTaskState, taskName = TASK_NAME) =>
  Promise.resolve()
    .then(() => query(taskName))
    .then(
      (out) => {
        const text = String(out ?? '').trim();
        if (!/^\d+$/.test(text)) return 'unknown';
        switch (Number(text)) {
          case TASK_STATE.RUNNING: return 'running';
          case TASK_STATE.QUEUED: return 'queued';
          case TASK_STATE.READY: return 'stopped';
          default: return 'unknown';
        }
      },
      () => 'unknown',
    );

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register the logon task from UTF-16LE XML and start it. When `stampFile`
 * already records the same XML and the task is registered, nothing is rewritten.
 */
export async function installLogonTask({
  bin,
  dataDir,
  logFile = '',
  build = '',
  stampFile = '',
  taskName = TASK_NAME,
  userId,
  env = process.env,
  run = schtasks,
  fs: files = fs,
}) {
  const xmlText = taskXml({ bin, dataDir, logFile, build, userId, env });
  let current = null;
  if (stampFile) {
    try { current = decodeTaskXml(files.readFileSync(stampFile)); } catch { /* not written yet */ }
  }
  const exists = await taskLoaded(run, taskName);
  if (stampFile && current === xmlText && exists) {
    await run(['/Run', '/TN', taskName]);
    return 'unchanged';
  }
  const xmlFile = stampFile || path.join(os.tmpdir(), `${taskName}-${process.pid}.xml`);
  try {
    files.mkdirSync(path.dirname(xmlFile), { recursive: true });
    files.writeFileSync(xmlFile, encodeTaskXml(xmlText));
    await run(['/Create', '/TN', taskName, '/XML', xmlFile, '/F']);
    await run(['/Run', '/TN', taskName]);
    return 'installed';
  } catch (error) {
    throw new Error(`The background service didn't start: ${error.message}`);
  } finally {
    if (!stampFile) {
      try { files.rmSync(xmlFile, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** Delete the logon task so it no longer runs at logon. */
export async function removeLogonTask({
  stampFile = '',
  taskName = TASK_NAME,
  run = schtasks,
  fs: files = fs,
} = {}) {
  const wasLoaded = await taskLoaded(run, taskName);
  if (wasLoaded) {
    await run(['/Delete', '/TN', taskName, '/F']).catch(async (error) => {
      if (await taskLoaded(run, taskName)) throw error;
    });
  }
  if (stampFile) {
    try { files.rmSync(stampFile, { force: true }); } catch { /* ignore */ }
  }
  return wasLoaded;
}

/**
 * Start the Windows logon task and wait until its daemon is serving `socket`.
 * Resolves `'agent'` when the task's daemon is serving, or `'foreign'` when
 * another daemon was already listening before the task was registered.
 *
 * The task is never deleted here: it is what starts the daemon at the next
 * sign-in, and Task Scheduler does not retry it in a loop the way launchd
 * would. A slow start (a first run scanned by antivirus, a busy sign-in) is
 * waited for until `slowTimeout` unless Task Scheduler confirms the program
 * stopped. At `slowTimeout` the program is ended, and the error allows a
 * fallback daemon only once the end is confirmed. Otherwise the error has
 * `fallback: false`, so no second daemon shares the data folder.
 */
export async function startLogonTaskDaemon({
  socket,
  infoFile,
  install,
  answers,
  taskName = TASK_NAME,
  run = schtasks,
  queryState = scheduledTaskState,
  readInfo = readJson,
  timeout = 15_000,
  slowTimeout = 120_000,
  endTimeout = 10_000,
  wait = sleep,
  now = Date.now,
}) {
  // 'unknown' never counts as absent: a task daemon may be starting.
  const registered = await taskPresence(run, taskName);
  if (await answers(socket)) {
    return registered === 'absent' ? 'foreign' : 'agent';
  }
  const ready = async () => {
    const info = readInfo(infoFile);
    return (await answers(socket)) && typeof info?.pid === 'number' && info.pid > 0;
  };
  let installError = null;
  try {
    await install();
  } catch (error) {
    // Registration or /Run failed, but a daemon the task started at sign-in
    // may still be starting. Fall back at once only when no task daemon can
    // be running; otherwise wait for it like any slow start.
    const noTaskDaemon = registered === 'absent' && (await taskPresence(run, taskName)) === 'absent';
    if (noTaskDaemon || (await taskState(queryState, taskName)) === 'stopped') {
      if (await ready()) return 'agent';
      throw error;
    }
    installError = error;
  }
  const started = now();
  let limit = timeout;
  for (;;) {
    if (await ready()) return 'agent';
    const elapsed = now() - started;
    if (elapsed > limit) {
      const state = await taskState(queryState, taskName);
      if (state === 'stopped') {
        const why = installError ? ` (${installError.message})` : '';
        throw new Error(`The background apex-daemon stopped before it answered, after ${Math.round(elapsed / 1000)} seconds${why}`);
      }
      if (elapsed > slowTimeout) {
        // It may have become ready while Task Scheduler was being asked.
        if (await ready()) return 'agent';
        return endSlowTask({ run, queryState, taskName, socket, answers, ready, endTimeout, slowTimeout, wait, now });
      }
      // Still starting, queued, or Task Scheduler didn't say: check again in a few seconds.
      limit = elapsed + 5_000;
    }
    await wait(50);
  }
}

/**
 * End a task whose daemon never answered. Resolves `'agent'` if it answers
 * after all; otherwise throws, with `fallback: false` unless Task Scheduler
 * confirmed the program stopped and nothing answers on `socket`.
 */
async function endSlowTask({ run, queryState, taskName, socket, answers, ready, endTimeout, slowTimeout, wait, now }) {
  const reason = `The background apex-daemon didn't start within ${Math.round(slowTimeout / 1000)} seconds`;
  await run(['/End', '/TN', taskName]).catch(() => { /* confirmed below */ });
  const ending = now();
  for (;;) {
    if (await ready()) return 'agent';
    if ((await taskState(queryState, taskName)) === 'stopped' && !(await answers(socket))) {
      throw new Error(reason);
    }
    if (now() - ending > endTimeout) {
      throw Object.assign(
        new Error(`${reason}, and it couldn't be confirmed stopped, so Deck won't start a second one`),
        { fallback: false },
      );
    }
    await wait(250);
  }
}
