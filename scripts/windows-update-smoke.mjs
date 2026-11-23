// CI-only: run Deck's real update check against the installer just built, using
// the installed app as the publisher to match, as an installed copy would.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { channel } from '../desktop/channel.mjs';
import { windowsSigner, windowsVerifier } from '../desktop/updater.mjs';

const exec = promisify(execFile);
const run = async (command, args, options) => {
  try {
    const { stdout, stderr } = await exec(command, args, { encoding: 'utf8', ...options });
    console.log(`powershell said: ${stdout.trim()} ${stderr.trim()}`);
    return stdout;
  } catch (error) {
    console.log(`powershell failed: ${error.stderr || error.message}`);
    throw error;
  }
};
export async function verifyWindowsSetup(installer, app, target) {
  const signer = await windowsSigner(run, app);
  if (!signer || !/(?:^|,\s*)CN=Tyler Caldwell(?:,|$)/.test(signer.subject) || signer.product !== channel.PRODUCT) {
    throw new Error(`Missing valid ${channel.PRODUCT} publisher signature on ${app}`);
  }
  const verify = windowsVerifier({ run, signer });
  await verify(installer, target);
  return verify;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installer, app, previous] = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const buildNumber = Number(process.env.APEX_BUILD_NUMBER);
  const verify = await verifyWindowsSetup(installer, app, {version, buildNumber});
  // Keep the real signed bytes in place and present them as a different release.
  await assert.rejects(verify(installer, {version: version === '0.0.1' ? '0.0.2' : '0.0.1', buildNumber}), /holds version/);
  if (channel.nightly && buildNumber < Number.MAX_SAFE_INTEGER) {
    await assert.rejects(verify(installer, {version, buildNumber: buildNumber + 1}), /build number mismatch/);
  }
  if (previous) {
    await verify(previous, {version, buildNumber: buildNumber - 1});
    await assert.rejects(verify(previous, {version, buildNumber}), /build number mismatch/);
  }
  console.log(`Windows verified the signed ${channel.PRODUCT} installer for ${version}.`);
}
