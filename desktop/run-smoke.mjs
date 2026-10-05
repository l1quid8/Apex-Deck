// `npm run desktop:smoke`: run the app hidden on a fresh data folder with the
// smoke checks (desktop/smoke.mjs), and exit with their result.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const data = fs.mkdtempSync('/tmp/ads-');
const app = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, APEX_DECK_SMOKE: '1', APEX_DECK_DATA_DIR: data },
});
// The last check quits the app; one that never exits has failed.
const timer = setTimeout(() => app.kill('SIGKILL'), 120_000);
app.on('exit', (code, signal) => {
  clearTimeout(timer);
  let failed = code !== 0 ? `exit ${code ?? signal}` : '';
  if (!failed) failed = sidecarLeft();
  for (const dir of [data, `${data}-desktop`]) fs.rmSync(dir, { recursive: true, force: true });
  if (failed) console.error(`smoke: failed (${failed})`);
  else console.log('smoke: ok — quitting exits 0 and the daemon the app started is gone');
  process.exit(failed ? 1 : 0);
});

/** Why the daemon the app started isn't cleanly gone, or ''. */
function sidecarLeft() {
  if (fs.existsSync(path.join(data, 'daemon.json'))) return 'daemon.json is still there';
  let pid;
  try {
    pid = Number(fs.readFileSync(`${data}-desktop/sidecar.pid`, 'utf8'));
  } catch {
    return 'the smoke run never reached the quit';
  }
  try {
    process.kill(pid, 0);
    return `the daemon (pid ${pid}) is still running`;
  } catch {
    return '';
  }
}
