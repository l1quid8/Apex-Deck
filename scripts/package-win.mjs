#!/usr/bin/env node
// Builds Apex Deck's Windows installer: `npm run desktop:win`.
//
// What it makes: `release/Apex-Deck-Setup.exe`, an NSIS installer with
// apex-daemon.exe inside it, plus `release/Apex-Deck-Setup.exe.sha256` so a
// download can be checked. With APEX_DECK_WIN_SIGN=1 it is signed through Azure
// Artifact Signing, which needs a live Azure login; any other build is unsigned,
// so Windows shows "unknown publisher". `--compile` and `--package` split the run
// so CI can sign in right before packaging: its Azure login lasts only minutes.
//
// Why Windows only: the service and the app must be compiled for the machine
// they run on, and this project has no Windows cross-compiler. GitHub's
// `windows-latest` runner is where this runs (see
// .github/workflows/windows-installer.yml). Set APEX_DECK_WIN_CROSS=1 to try it
// anyway, for example to check the config, and expect it to fail in cargo or in
// electron-builder's icon editing.
//
// One commit is stamped into every artifact, the way package-pinned.mjs does it
// for the Mac, so a build can say which checkout it came from.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readStamp, stampEnv } from './build-stamp.mjs';

const log = (message) => console.log(`package-win: ${message}`);

/** Must match `nsis.artifactName` in electron-builder.yml; a test checks that. */
export const INSTALLER_NAME = 'Apex-Deck-Setup.exe';

/** Plain release builds only: never a test or fixture binary out of target/. */
export function releaseBuildCommands() {
  return [
    ['cargo', ['build', '--release', '-p', 'apex-daemon', '--features', 'remote']],
    ['cargo', ['build', '--release', '-p', 'apex-provenance']],
  ];
}

/** Public names, not secrets: only the Azure login can use them to sign. */
export const AZURE_SIGNING = {
  publisherName: 'Tyler Caldwell',
  endpoint: 'https://eus.codesigning.azure.net',
  codeSigningAccountName: 'apexdecksigning',
  certificateProfileName: 'apexdeckpublic',
};

/** electron-builder's arguments; signing is opt-in so a local build still works. */
export function builderArgs(env = process.env) {
  const args = ['--win', 'nsis', '--publish', 'never'];
  if (env.APEX_DECK_WIN_SIGN !== '1') return args;
  return [...args, ...Object.entries(AZURE_SIGNING).map(
    ([name, value]) => `--config.win.azureSignOptions.${name}=${value}`,
  )];
}

/** The installer has to be built where it will run; say so before cargo errors. */
export function assertWindowsHost(platform = process.platform, env = process.env) {
  if (platform === 'win32' || env.APEX_DECK_WIN_CROSS === '1') return;
  throw new Error(
    'the Windows installer is built on Windows (GitHub\'s windows-latest runner; see '
    + '.github/workflows/windows-installer.yml). Nothing was built. Set '
    + 'APEX_DECK_WIN_CROSS=1 to attempt it on another system anyway.',
  );
}

/** Every .exe electron-builder left in `release/`, so the caller can be strict. */
export function installersIn(release, readdir = readdirSync) {
  return readdir(release, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name)
    .sort();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Write `<installer>.sha256` beside the installer and return its line. */
export function writeChecksum(installer) {
  const line = `${sha256(installer)}  ${installer.split(/[\\/]/).pop()}`;
  writeFileSync(`${installer}.sha256`, `${line}\n`);
  return line;
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function run(command, args, options = {}) {
  const built = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(`${command} ${args.join(' ')} failed; refusing to package`);
}

function main(phase = process.argv[2]) {
  assertWindowsHost();
  const release = resolve('release');
  const stamp = readStamp({ env: process.env, git });
  if (stamp.commit === 'unknown') {
    console.error('package-win: no commit to stamp; refusing to ship an unlabelled build.');
    return 1;
  }
  const env = stampEnv(stamp);
  log(`stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the service and the UI`);

  if (phase !== '--package') {
    for (const [command, args] of releaseBuildCommands()) run(command, args, { env });
    // tsc --noEmit then vite build, so a type error stops the run before packaging.
    run('npm', ['run', 'build'], { env, shell: process.platform === 'win32' });
  }
  if (phase === '--compile') return 0;
  const signed = process.env.APEX_DECK_WIN_SIGN === '1';
  log(`building the ${signed ? 'signed' : 'unsigned'} NSIS installer`);
  run(
    process.execPath,
    [resolve('node_modules/electron-builder/cli.js'), ...builderArgs()],
    { env },
  );

  // A moved checkout makes a mixed package, which installs fine and then
  // reports mismatched builds, so fail here instead.
  const after = git(['rev-parse', '--short=12', 'HEAD']);
  if (after !== stamp.commit) {
    throw new Error(`the checkout moved during the build (${stamp.commit} -> ${after}); do not install this installer`);
  }
  const installers = installersIn(release);
  if (installers.length !== 1) {
    throw new Error(`expected one .exe installer in release/, found ${installers.length}: ${installers.join(', ') || 'none'}`);
  }
  const installer = resolve(release, installers[0]);
  if (!existsSync(installer)) throw new Error(`electron-builder reported ${installers[0]} but it is not on disk`);
  log(`wrote ${installer} (${(readFileSync(installer).length / 1048576).toFixed(1)} MB)`);
  log(`sha256 ${writeChecksum(installer)}`);
  if (!signed) log('this installer is unsigned: Windows will show "unknown publisher"');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`package-win: ${error.message}`);
    process.exitCode = 1;
  }
}
