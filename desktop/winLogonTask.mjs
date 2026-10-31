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

/** Arguments passed to `conhost.exe` to start `apex-daemon serve` with no console window. */
export function taskArguments({ bin, dataDir }) {
  const parts = ['--headless', quoteArg(bin), 'serve', ...(dataDir ? ['--data-dir', quoteArg(dataDir)] : [])];
  return parts.join(' ');
}

/** The full command line for starting the headless logon task. */
export function taskCommand({ bin, dataDir }) {
  return `${CONHOST_COMMAND} ${taskArguments({ bin, dataDir })}`;
}

/**
 * Task Scheduler XML for `ApexDeckDaemon`. Runs at the current user's logon
 * with no battery restrictions (`DisallowStartIfOnBatteries=false`,
 * `StopIfGoingOnBatteries=false`), no 72-hour execution cap
 * (`ExecutionTimeLimit=PT0S`), normal priority (`Priority=5`), and headless
 * `%SystemRoot%\System32\conhost.exe` so no console window flashes on screen.
 */
export function taskXml({ bin, dataDir, build = '', userId, env = process.env }) {
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
      <Arguments>${xml(taskArguments({ bin, dataDir }))}</Arguments>
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

/** Whether Task Scheduler has the logon task registered. */
export const taskLoaded = (run = schtasks, taskName = TASK_NAME) =>
  run(['/Query', '/TN', taskName]).then(() => true, () => false);

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
  build = '',
  stampFile = '',
  taskName = TASK_NAME,
  userId,
  env = process.env,
  run = schtasks,
  fs: files = fs,
}) {
  const xmlText = taskXml({ bin, dataDir, build, userId, env });
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
 */
export async function startLogonTaskDaemon({
  socket,
  infoFile,
  install,
  remove,
  answers,
  taskName = TASK_NAME,
  run = schtasks,
  readInfo = readJson,
  timeout = 15_000,
  wait = sleep,
}) {
  const registered = await taskLoaded(run, taskName);
  if (await answers(socket)) {
    return registered ? 'agent' : 'foreign';
  }
  await install();
  const started = Date.now();
  for (;;) {
    const info = readInfo(infoFile);
    const serving = await answers(socket);
    if (serving && typeof info?.pid === 'number' && info.pid > 0) return 'agent';
    if (Date.now() - started > timeout) break;
    await wait(50);
  }
  await remove().catch(() => {});
  const seconds = Math.round(timeout / 1000);
  throw new Error(`The background apex-daemon didn't start within ${seconds} seconds`);
}
