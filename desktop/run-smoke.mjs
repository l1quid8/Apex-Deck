// `npm run desktop:smoke`: run the app hidden on a fresh data folder with the
// smoke checks (desktop/smoke.mjs), and exit with their result.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import electron from 'electron';

const data = fs.mkdtempSync('/tmp/ads-');
const app = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, APEX_DECK_SMOKE: '1', APEX_DECK_DATA_DIR: data },
});
app.on('exit', (code, signal) => {
  for (const dir of [data, `${data}-desktop`]) fs.rmSync(dir, { recursive: true, force: true });
  if (code !== 0) console.error(`smoke: failed (${code ?? signal})`);
  process.exit(code ?? 1);
});
