// `npm run desktop:smoke`: run the app hidden on a fresh data folder with the
// smoke checks (desktop/smoke.mjs), and exit with their result.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import electron from 'electron';

// With --packaged it runs the built .app. With --ssh DEST the window runs on that host instead; --ssh-config FILE
// makes ssh read FILE; --pause, --resume, --stop and --start are shell
// commands that do that to the server, for the remote checks.
const { values: options } = parseArgs({
  options: {
    ...Object.fromEntries(['ssh', 'ssh-config', 'pause', 'resume', 'stop', 'start'].map((name) => [name, { type: 'string' }])),
    // Run the app built by `npm run desktop:package` instead of `electron .`.
    packaged: { type: 'boolean' },
  },
});

const data = fs.mkdtempSync('/tmp/ads-');
const env = { ...process.env, APEX_DECK_SMOKE: '1', APEX_DECK_DATA_DIR: data };
if (options.ssh) {
  fs.mkdirSync(`${data}-desktop`, { recursive: true });
  fs.writeFileSync(`${data}-desktop/hosts.json`, JSON.stringify({
    version: 1, last: 'h-smoke', hosts: [{ id: 'h-smoke', name: 'smoke-host', ssh: options.ssh, command: 'apex-daemon' }],
  }));
  Object.assign(env, {
    APEX_DECK_SMOKE_HOST: 'smoke-host',
    APEX_DECK_SMOKE_PAUSE: options.pause ?? '',
    APEX_DECK_SMOKE_RESUME: options.resume ?? '',
    APEX_DECK_SMOKE_STOP: options.stop ?? '',
    APEX_DECK_SMOKE_START: options.start ?? '',
  });
  if (options['ssh-config']) {
    const bin = `${data}-desktop/bin`;
    fs.mkdirSync(bin);
    fs.writeFileSync(`${bin}/ssh`, `#!/bin/sh\nexec /usr/bin/ssh -F ${JSON.stringify(options['ssh-config'])} "$@"\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
}
const [program, args] = options.packaged
  ? [path.resolve(`release/mac-${process.arch}/Apex Deck.app/Contents/MacOS/Apex Deck`), []]
  : [electron, ['.']];
let app = spawn(program, args, { stdio: 'inherit', env });
/** The second launch, on this Mac: what the first left behind is still there. */
let again = !options.ssh;
// The last check quits the app; one that never exits has failed.
const timer = setTimeout(() => app.kill('SIGKILL'), options.ssh ? 600_000 : 180_000);
function finished(code, signal) {
  let failed = code !== 0 ? `exit ${code ?? signal}` : '';
  // On another host the app starts no daemon here.
  if (!failed && !options.ssh) failed = sidecarLeft();
  if (!failed && again) {
    again = false;
    console.log('smoke: ok — quitting exits 0 and the daemon the app started is gone');
    fs.rmSync(`${data}-desktop/sidecar.pid`, { force: true });
    app = spawn(program, args, { stdio: 'inherit', env: { ...env, APEX_DECK_SMOKE_PHASE: 'again' } });
    app.on('exit', finished);
    return;
  }
  clearTimeout(timer);
  for (const dir of [data, `${data}-desktop`]) fs.rmSync(dir, { recursive: true, force: true });
  if (failed) console.error(`smoke: failed (${failed})`);
  else console.log(options.ssh ? 'smoke: ok — quitting exits 0' : 'smoke: ok — the second launch quits cleanly too');
  process.exit(failed ? 1 : 0);
}
app.on('exit', finished);

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
