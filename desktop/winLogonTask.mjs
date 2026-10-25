// The Windows PC's apex-daemon as a per-user Scheduled Task at logon on a
// packaged build, so it keeps running after Deck quits. Like launchAgent.mjs
// on macOS, everything that runs schtasks.exe or touches the disk is passed in
// so unit tests never touch the real Task Scheduler.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

export const TASK_NAME = 'ApexDeckDaemon';

/**
 * The logon task serves the daemon only on a packaged Windows build with no
 * test or dev data folder; a dev build or test run keeps the daemon Deck owns.
 */
export const usesLogonTask = ({ packaged, dataDir, platform = process.platform }) =>
  platform === 'win32' && Boolean(packaged) && !dataDir;

const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

/** The `/TR` command string for `schtasks.exe /Create`. */
export function taskCommand({ bin, dataDir }) {
  const parts = [quoteArg(bin), 'serve', ...(dataDir ? ['--data-dir', quoteArg(dataDir)] : [])];
  return parts.join(' ');
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
export const taskLoaded = (run = schtasks) =>
  run(['/Query', '/TN', TASK_NAME]).then(() => true, () => false);

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register the logon task and start it. When `stampFile` already records the
 * same command and build and the task is registered, nothing is rewritten.
 */
export async function installLogonTask({ bin, dataDir, build = '', stampFile = '', run = schtasks, fs: files = fs }) {
  const command = taskCommand({ bin, dataDir });
  const stamp = `${command}\n${build}`;
  let current = null;
  if (stampFile) {
    try { current = files.readFileSync(stampFile, 'utf8'); } catch { /* not written yet */ }
  }
  const exists = await taskLoaded(run);
  if (stampFile && current === stamp && exists) {
    await run(['/Run', '/TN', TASK_NAME]);
    return 'unchanged';
  }
  try {
    await run(['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', command, '/F']);
    if (stampFile) {
      try { files.writeFileSync(stampFile, stamp); } catch { /* best-effort stamp */ }
    }
    await run(['/Run', '/TN', TASK_NAME]);
    return 'installed';
  } catch (error) {
    throw new Error(`The background service didn't start: ${error.message}`);
  }
}

/** Delete the logon task so it no longer runs at logon. */
export async function removeLogonTask({ stampFile = '', run = schtasks, fs: files = fs } = {}) {
  const wasLoaded = await taskLoaded(run);
  if (wasLoaded) {
    await run(['/Delete', '/TN', TASK_NAME, '/F']).catch(async (error) => {
      if (await taskLoaded(run)) throw error;
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
  run = schtasks,
  readInfo = readJson,
  timeout = 15_000,
  wait = sleep,
}) {
  const registered = await taskLoaded(run);
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
