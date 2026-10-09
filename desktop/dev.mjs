// `npm run desktop:dev`: the Vite dev server, and Electron pointed at it.

import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { developmentDataDir } from './sidecar.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const env = { ...process.env, APEX_DECK_DEV_URL: url };
env.APEX_DECK_DATA_DIR = developmentDataDir(repo, env);
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
