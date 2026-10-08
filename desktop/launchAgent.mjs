// The Mac's apex-daemon as a per-user LaunchAgent while Settings → Remote
// access is on, so paired phones keep reaching this Mac after Deck quits.
// launchd starts it at login and starts it again when it exits with an error.
// Everything that runs launchctl or touches the disk is passed in, so tests
// never touch the real ~/Library.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LABEL = 'dev.apexdeck.daemon';

/** Where the agent's plist lives: the user's LaunchAgents folder. */
export const agentPlistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

/**
 * The LaunchAgent serves the daemon only for the installed app with no test
 * or dev data folder; a dev build or a test run keeps the daemon Deck owns.
 */
export const usesLaunchAgent = ({ packaged, dataDir }) => Boolean(packaged) && !dataDir;

const xml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Which build of the daemon `bin` is: its size and change time. Kept in the
 * plist, so an updated app reloads the agent instead of leaving the old
 * daemon running until the next login.
 */
export function daemonBuild(bin, files = fs) {
  try {
    const { size, mtimeMs } = files.statSync(bin);
    return `${size}-${Math.trunc(mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/** The plist for `serve --remote`, which stays up without the app. */
export function agentPlist({ bin, dataDir, logFile, build = '' }) {
  const args = [bin, 'serve', '--remote', ...(dataDir ? ['--data-dir', dataDir] : [])];
  const items = args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  const stamp = build ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>APEX_DAEMON_BUILD</key>
    <string>${xml(build)}</string>
  </dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>${stamp}
</dict>
</plist>
`;
}

/** `launchctl` with `args`: its output, or an error with what it said. */
export function launchctl(args) {
  return new Promise((resolve, reject) => {
    execFile('/bin/launchctl', args, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

const target = (uid) => `gui/${uid}/${LABEL}`;

/** Whether launchd has the agent loaded. */
const loaded = (uid, run) => run(['print', target(uid)]).then(() => true, () => false);

/**
 * The agent as launchd has it: whether it is loaded, and the pid of its
 * daemon, null between a crash and the next start or when not loaded.
 */
export async function agentState(uid, run = launchctl) {
  let out;
  try { out = await run(['print', target(uid)]); } catch { return { loaded: false, pid: null }; }
  const match = /^\s*pid = (\d+)\s*$/m.exec(String(out));
  return { loaded: true, pid: match ? Number(match[1]) : null };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop the agent if it is loaded. Resolves true when it was loaded; "not
 * loaded" is fine, any other failure is thrown.
 */
async function bootout(uid, run) {
  try {
    await run(['bootout', target(uid)]);
    return true;
  } catch (error) {
    if (await loaded(uid, run)) throw error;
    return false;
  }
}

/**
 * Write the plist and load it. Nothing is rewritten or reloaded when the file
 * already matches and launchd has the agent loaded.
 */
export async function installAgent({ plistPath, plist, uid, run = launchctl, fs: files = fs }) {
  let current = null;
  try { current = files.readFileSync(plistPath, 'utf8'); } catch { /* not installed yet */ }
  if (current === plist && await loaded(uid, run)) return;
  files.mkdirSync(path.dirname(plistPath), { recursive: true });
  const temp = `${plistPath}.${process.pid}.tmp`;
  files.writeFileSync(temp, plist);
  files.renameSync(temp, plistPath);
  await bootout(uid, run);
  try {
    await run(['bootstrap', `gui/${uid}`, plistPath]);
  } catch (error) {
    throw new Error(`The background service didn't start: ${error.message}`);
  }
}

/**
 * Stop the agent and delete its plist, so it does not start at login.
 * Resolves true when the agent was loaded (and so was running).
 */
export async function removeAgent({ plistPath, uid, run = launchctl, fs: files = fs }) {
  const wasLoaded = await bootout(uid, run);
  files.rmSync(plistPath, { force: true });
  return wasLoaded;
}

/**
 * Start the agent and wait until its daemon is the one serving `socket` with
 * Remote access up: `infoFile` (daemon.json, written once the daemon is
 * ready) names the agent's pid and an endpoint. Resolves 'agent' then.
 *
 * A daemon something else started already on the socket is left alone and
 * the agent is not started: resolves 'foreign', for the caller to attach to
 * it as a daemon Deck found. When the wait runs out, the agent is removed,
 * so launchd doesn't retry it every ten seconds, and this rejects saying why.
 */
export async function startAgentDaemon({ socket, infoFile, uid, install, remove, answers, run = launchctl, readInfo = readJson, timeout = 15_000, wait = sleep }) {
  const before = await agentState(uid, run);
  if (before.pid === null && await answers(socket)) {
    if (before.loaded) await remove();
    return 'foreign';
  }
  await install();
  const started = Date.now();
  let pid = null;
  let info = null;
  let serving = false;
  for (;;) {
    ({ pid } = await agentState(uid, run));
    info = readInfo(infoFile);
    serving = await answers(socket);
    if (pid !== null && serving && info?.pid === pid && info.remote?.endpoint_id) return 'agent';
    if (Date.now() - started > timeout) break;
    await wait(50);
  }
  await remove().catch(() => {});
  const seconds = Math.round(timeout / 1000);
  if (serving && info?.pid && info.pid !== pid) {
    throw new Error(`Another apex-daemon (pid ${info.pid}) is using Deck's data folder, so the background service can't start. Quit it, then turn Remote access on again`);
  }
  if (serving && info?.pid === pid) throw new Error('The background apex-daemon started without Remote access');
  throw new Error(`The background apex-daemon didn't start within ${seconds} seconds`);
}
