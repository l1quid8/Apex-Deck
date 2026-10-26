#!/usr/bin/env node
// Builds Apex Deck's Windows installer: `npm run desktop:win`.
//
// What it makes: `release/Apex-Deck-Setup.exe`, an NSIS installer with
// apex-daemon.exe inside it, plus `release/Apex-Deck-Setup.exe.sha256` so a
// download can be checked. It is UNSIGNED for now, so Windows shows "unknown
// publisher" until Azure Trusted Signing is wired in (`win.azureSignOptions`).
// That signing step is the last piece of M4; see
// docs/superpowers/plans/2026-10-21-windows-11.md.
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

function main() {
  assertWindowsHost();
  const release = resolve('release');
  const stamp = readStamp({ env: process.env, git });
  if (stamp.commit === 'unknown') {
    console.error('package-win: no commit to stamp; refusing to ship an unlabelled build.');
    return 1;
  }
  const env = stampEnv(stamp);
  log(`stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the service and the UI`);

  for (const [command, args] of releaseBuildCommands()) run(command, args, { env });
  // tsc --noEmit then vite build, so a type error stops the run before packaging.
  run('npm', ['run', 'build'], { env, shell: process.platform === 'win32' });
  log('building the unsigned NSIS installer');
  run(
    process.execPath,
    [resolve('node_modules/electron-builder/cli.js'), '--win', 'nsis', '--publish', 'never'],
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
  log('this installer is unsigned: Windows will show "unknown publisher" until Azure Trusted Signing is added');
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
