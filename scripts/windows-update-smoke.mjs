// CI-only: run Deck's real update check against the installer just built, using
// the installed app as the publisher to match, as an installed copy would.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { windowsSigner, windowsVerifier } from '../desktop/updater.mjs';

const exec = promisify(execFile);
const run = async (command, args, options) => (await exec(command, args, { encoding: 'utf8', ...options })).stdout;
const [installer, installed] = process.argv.slice(2);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const signer = await windowsSigner(run, installed);
if (!signer) throw new Error(`no valid signature on ${installed}`);
const verify = windowsVerifier({ run, signer });
await verify(installer, { version });
await verify(installer, { version: '0.0.1' }).then(
  () => { throw new Error('the check accepted the wrong version'); },
  (error) => { if (!/not 0\.0\.1/.test(error.message)) throw error; },
);
console.log(`windows update check: ${version} signed by ${signer.subject}`);
