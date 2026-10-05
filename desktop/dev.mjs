// `npm run desktop:dev`: the Vite dev server, and Electron pointed at it.

import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const app = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, APEX_DECK_DEV_URL: url } });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
