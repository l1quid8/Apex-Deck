import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Run an Electron main script and resolve with its exit code and captured
 * stdout + stderr.
 *
 * These are heavyweight smoke tests: each run boots a real Chromium and, for
 * most suites, a fresh Vite dependency cache, so the first launch on a loaded
 * machine can outlive a fixed timer (a Chromium page load that is still in
 * flight when the timer fires is indistinguishable from a hang). A child still
 * alive at timeoutMs is SIGKILLed and the whole scenario retried against the
 * now-warm cache; a nonzero exit from a load-induced gesture/geometry flake is
 * retried once too. A real regression fails every attempt, so the test still
 * fails — just after the retries. Each attempt gets its own --user-data-dir so
 * a SIGKILLed Chromium's stale profile lock never blocks the next attempt.
 */
export async function runElectronScenario(electron, main, temp, { timeoutMs = 60000, attempts = 2 } = {}) {
  // An empty ELECTRON_RUN_AS_NODE is not the same as a missing one. On Windows an
  // empty value still arrives as a set variable, so Electron boots in Node mode
  // and every scenario dies at its first `require('electron')` (79 failures on
  // run 40233880246, 45 of them this). Deleting the key unsets it everywhere.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let last = { code: null, output: '' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 250 * attempt));
    const child = spawn(electron, [main, '--user-data-dir=' + path.join(temp, 'profile-' + attempt)], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => output += bytes);
    child.stderr.on('data', bytes => output += bytes);
    last = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      // A failed spawn is not a scenario result: on Windows the runner holds
      // electron.exe open while it unpackages it, and a second look succeeds.
      // Report it as a failed attempt so the retry above gets its chance.
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, output: output + String(error) }); });
      child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    if (last.code === 0 || attempt === attempts) break;
    console.log(`[electron scenario] attempt ${attempt}/${attempts} exited ${last.code}; retrying`);
  }
  return last;
}
