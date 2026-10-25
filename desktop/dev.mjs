// `npm run desktop:dev`: the Vite dev server, and Electron pointed at it.

import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { developmentDataDir, developmentHostDataDir } from './sidecar.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const env = { ...process.env, APEX_DECK_DEV_URL: url };
// When APEX_DECK_DATA_DIR is explicitly set or APEX_DECK_USE_LIVE_DAEMON=1 is
// requested, connect directly to that data directory / live daemon socket so
// development can test against real assistants and settings. Otherwise,
// keep the dev host socket separate from an installed service.
const explicitDataDir = process.env.APEX_DECK_DATA_DIR?.trim();
const attachLive = process.env.APEX_DECK_USE_LIVE_DAEMON === '1' || Boolean(explicitDataDir);
env.APEX_DECK_DATA_DIR = attachLive
  ? (explicitDataDir || developmentDataDir(repo, env))
  : developmentHostDataDir(developmentDataDir(repo, env));
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
