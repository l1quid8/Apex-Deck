// Drive the packaged app's update flow against the disposable QA-signed copies.
// The feed and download are local, and the final launch acknowledgement is simulated.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { channel } from '../desktop/channel.mjs';
import { fileSha256, Updater, windowsInstaller, windowsSigner, windowsVerifier } from '../desktop/updater.mjs';
import { nightlyRelease } from './windows-build.mjs';
import { buildWindowsManifest } from './windows-update-manifest.mjs';

const [scratch, previousBuild, currentBuild] = process.argv.slice(2);
const previous = path.join(scratch, 'previous.exe');
const current = path.join(scratch, 'current.exe');
const app = path.join(scratch, 'app.exe');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.ok(channel.nightly && Number(currentBuild) > Number(previousBuild));
const exec = promisify(execFile);
const run = async (command, args, options) => (await exec(command, args, options)).stdout;
const signer = await windowsSigner(run, app);
assert.equal(signer?.product, channel.PRODUCT, 'Expected a validly signed Nightly desktop app');
assert.equal(signer.issuer, 'Apex Deck CI');
assert.match(signer.subject, /\bCN=Apex Deck Nightly QA [a-f\d-]+\b/i);
const verify = windowsVerifier({ run, signer });
await verify(previous, { version, buildNumber: Number(previousBuild) });

const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const release = nightlyRelease(process.env.GITHUB_SHA, currentBuild, date);
let source = previous;
const launches = [];
const updater = new Updater({
  current: version, installedBuild: { buildNumber: Number(previousBuild) }, arch: 'x64', osVersion: '10.0.22631',
  extension: '.exe', retryDelays: [], cacheDir: path.join(scratch, 'cache'), stateFile: path.join(scratch, 'state.json'),
  fetchJson: async () => buildWindowsManifest({ version, size: statSync(source).size, sha256: await fileSha256(source) }, release),
  download: async (_url, destination) => {
    copyFileSync(source, destination);
    return fileSha256(destination);
  },
  verify,
  requestInstall: windowsInstaller({
    verify, app, resultFile: path.join(scratch, 'result.json'),
    launch(file, env) {
      launches.push(file);
      writeFileSync(env.APEX_UPDATE_STARTED, 'started');
    },
  }),
});

// The local feed supplies the older file's genuine digest, but claims the newer build.
const refused = await updater.check();
assert.equal(refused.state, 'error');
assert.match(refused.error, /build number mismatch/);
console.log(`Download verification rejected QA-signed ${version} build ${previousBuild} presented as build ${currentBuild}.`);

source = current;
const accepted = await updater.check();
assert.equal(accepted.state, 'ready', accepted.error);
const cached = updater.ready.package;
copyFileSync(previous, cached);
await assert.rejects(updater.restart(), /build number mismatch/);
assert.deepEqual(launches, []);
copyFileSync(current, cached);
await updater.restart();
assert.deepEqual(launches, [cached]);
console.log(`Restart verification rejected substituted build ${previousBuild} and accepted genuine build ${currentBuild} of ${version}.`);
