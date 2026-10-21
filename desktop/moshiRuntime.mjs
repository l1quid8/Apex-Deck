import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMoshi } from './moshi.mjs';

const UV_URL = 'https://github.com/astral-sh/uv/releases/download/0.9.4/uv-aarch64-apple-darwin.tar.gz';
const UV_SHA256 = '52793821b13ac7e424f76c47f544b103a9bdd10546f165b327eba225d0ba4993';
const assets = fileURLToPath(new URL('./moshi/', import.meta.url));
const exists = file => fs.access(file).then(() => true, () => false);

async function copyClient(root) {
  const destination = path.join(root, 'client');
  await fs.mkdir(destination, { recursive: true });
  // Electron supports reading individual archive files, but fs.cp cannot
  // recursively extract an app.asar directory. Python needs real files.
  for (const name of ['runner.py', 'index.html', 'voice.js', 'voice.css', 'audio-worklet.js']) {
    await fs.writeFile(path.join(destination, name), await fs.readFile(path.join(assets, name)));
  }
}

// A group contains the runner AND its two multiprocessing children.
export function spawnVoiceProcess(command, args, options, signal, report) {
  signal.throwIfAborted();
  const proc = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = sig => { try { process.kill(-proc.pid, sig); } catch {} };
  let killTimer;
  const abort = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000); };
  signal.addEventListener('abort', abort, { once: true });
  let tail = '', ended = false;
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    // A surviving grandchild can hold stdout/stderr open after its parent
    // exits. Kill the group on exit; waiting for close first would deadlock.
    proc.once('exit', () => { ended = true; kill('SIGKILL'); });
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-4000); report?.(tail); });
    proc.on('close', (code, sig) => {
      ended = true; clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      kill('SIGKILL');
      if (code === 0) resolve(); else reject(new Error(`Local voice exited (${sig ?? code}): ${tail.slice(-1200)}`));
    });
  });
  // Avoid unhandled rejection while readiness polling is in flight.
  done.catch(() => {});
  return { done, get ended() { return ended; }, async stop() {
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    try { await done.catch(() => {}); } finally { clearTimeout(timer); kill('SIGKILL'); }
  } };
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const chosen = server.address().port;
  await new Promise(resolve => server.close(resolve)); return chosen;
}

export function moshiRuntime(root, { platform = process.platform, arch = process.arch } = {}) {
  const python = path.join(root, 'venv/bin/python');
  const marker = path.join(root, 'installed-v1');
  const runtimeEnv = { ...process.env, HF_HOME: path.join(root, 'hf'), PYTHONUNBUFFERED: '1',
    UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(root, 'uv-cache'),
    HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '0' };
  const run = async (command, args, signal, report) => {
    const job = spawnVoiceProcess(command, args, { env: runtimeEnv }, signal, report);
    try { await job.done; signal.throwIfAborted(); } finally { await job.stop(); }
  };
  return createMoshi({
    supported: platform === 'darwin' && arch === 'arm64',
    installed: async () => await exists(marker) && await exists(python),
    async setup(signal, report) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const uv = path.join(root, 'uv-aarch64-apple-darwin/uv');
      if (!await exists(uv)) {
        report('Downloading the local voice installer…');
        const response = await fetch(UV_URL, { signal });
        if (!response.ok) throw new Error(`Installer download failed (${response.status}).`);
        const bytes = Buffer.from(await response.arrayBuffer()); signal.throwIfAborted();
        if (createHash('sha256').update(bytes).digest('hex') !== UV_SHA256) throw new Error('Voice installer checksum failed.');
        const archive = path.join(root, 'uv.tar.gz'); await fs.writeFile(archive, bytes);
        await run('/usr/bin/tar', ['-xzf', archive, '-C', root, 'uv-aarch64-apple-darwin/uv'], signal, report);
        await fs.unlink(archive);
      }
      report('Installing a private Python runtime…');
      await run(uv, ['venv', '--python', '3.12', '--managed-python', path.join(root, 'venv')], signal, report);
      report('Installing Moshi…');
      await run(uv, ['pip', 'install', '--python', python, '--only-binary=:all:', 'moshi_mlx==0.3.0'], signal, report);
      // Copy out of app.asar: Python must be able to read these as real files.
      await copyClient(root);
      report('Downloading the local voice model (approximately 5.2 GB). This can take a while…');
      await run(python, [path.join(root, 'client/runner.py'), '--download-only'], signal, report);
      await fs.writeFile(marker, 'moshi_mlx==0.3.0\n');
    },
    async launch(signal, report, onExit) {
      await copyClient(root);
      const url = `http://127.0.0.1:${await port()}`, token = randomBytes(32).toString('hex');
      const job = spawnVoiceProcess(python, [path.join(root, 'client/runner.py'), '--host', '127.0.0.1', '--port', new URL(url).port,
        '--no-browser', '-q', '4', '--steps', '24000', '--static', path.join(root, 'client')],
      { env: { ...runtimeEnv, APEX_VOICE_TOKEN: token, HF_HUB_OFFLINE: '1' } }, signal, report);
      let ready = false;
      job.done.then(() => { if (ready && !signal.aborted) onExit('The local voice helper stopped. Start a new call.'); },
        error => { if (ready && !signal.aborted) onExit(error.message); });
      try {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (job.ended) { await job.done; throw new Error('Moshi stopped before it was ready.'); }
          try {
            const response = await fetch(url, { headers: { 'X-Apex-Voice-Token': token }, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
            if (response.ok) { ready = true; return { url, token, stop: () => job.stop() }; }
          } catch (error) { if (signal.aborted) throw error; }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Moshi did not become ready within two minutes.');
      } catch (error) { await job.stop(); throw error; }
    },
  });
}
