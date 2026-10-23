import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'target');
const fixture = path.join(target, 'debug', process.platform === 'win32' ? 'apex-daemon-fixture.exe' : 'apex-daemon-fixture');
const files = readdirSync(path.join(root, 'tests/e2e')).filter(file => file.endsWith('.e2e.mjs')).sort().map(file => path.join(root, 'tests/e2e', file));
if (!files.length) throw new Error('No E2E fixture tests were found.');
console.log('E2E uses the temporary-directory verified-UI fixture daemon. This does not establish signed installed-app acceptance.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: '/tmp', APEX_DAEMON_BIN: fixture },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
