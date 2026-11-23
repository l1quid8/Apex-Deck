#!/usr/bin/env node
// Builds Apex Deck's Windows installer: `npm run desktop:win`.
//
// What it makes: `release/Apex-Deck-Setup.exe`, an NSIS installer with
// apex-daemon.exe inside it, plus `release/Apex-Deck-Setup.exe.sha256` so a
// download can be checked. With APEX_DECK_WIN_SIGN=1 the installer is signed
// through Azure Artifact Signing, which needs a live Azure login; any other build
// is unsigned, so Windows shows "unknown publisher". `--compile` builds everything
// into release/win-unpacked and `--package` wraps that in the installer, so CI can
// sign in a job that never runs build code.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readStamp, stampEnv } from './build-stamp.mjs';
import { channel } from '../desktop/channel.mjs';
import { installerInclude, nightlyRelease, windowsBuilderConfig, windowsOutput } from './windows-build.mjs';

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

export function windowsRelease() {
  if (!channel.nightly) return null;
  const date = process.env.APEX_BUILD_DATE ?? new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return nightlyRelease(git(['rev-parse', '--verify', 'HEAD']), process.env.APEX_BUILD_NUMBER, date);
}

async function checkUnpacked(unpacked, nightly) {
  const { extractFile } = await import('@electron/asar');
  const asar = resolve(unpacked, 'resources/app.asar');
  const stamp = JSON.parse(extractFile(asar, 'dist/channel.json'));
  const metadata = JSON.parse(extractFile(asar, 'package.json'));
  const source = JSON.parse(readFileSync('package.json', 'utf8'));
  if (metadata.version !== source.version || stamp.channel !== channel.name ||
      (nightly && (stamp.commit !== nightly.commit || stamp.buildNumber !== nightly.buildNumber))) {
    throw new Error('Unpacked app version/channel/build differs from the requested installer');
  }
  for (const file of [`${channel.PRODUCT}.exe`, `resources/bin/${channel.WINDOWS_DAEMON}`, `resources/bin/${channel.WINDOWS_HELPER}`]) {
    if (!existsSync(resolve(unpacked, file))) throw new Error(`Missing ${channel.name} program: ${file}`);
  }
}

async function main(phase = process.argv[2]) {
  assertWindowsHost();
  const nightly = windowsRelease();
  const release = resolve(windowsOutput);
  const unpacked = resolve(release, 'win-unpacked');
  const stamp = readStamp({ env: process.env, git });
  if (stamp.commit === 'unknown') {
    console.error('package-win: no commit to stamp; refusing to ship an unlabelled build.');
    return 1;
  }
  const env = stampEnv(stamp);
  if (nightly && (!nightly.commit.startsWith(stamp.commit) || (stamp.dirty && env.APEX_DECK_WIN_SIGN === '1'))) {
    throw new Error('Nightly source stamp differs from the checkout or signed build has tracked edits');
  }
  log(`stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the service and the UI`);

  if (phase !== '--package') {
    for (const [command, args] of releaseBuildCommands()) run(command, args, { env });
    // tsc --noEmit then vite build, so a type error stops the run before packaging.
    run('npm', ['run', 'build'], { env, shell: process.platform === 'win32' });
  }
  mkdirSync(release, { recursive: true });
  const include = resolve(release, 'installer-channel.nsh');
  writeFileSync(include, installerInclude(channel, nightly));
  const { load } = await import('js-yaml');
  const base = load(readFileSync('electron-builder.yml', 'utf8'));
  const config = resolve(release, 'windows-builder.json');
  const options = windowsBuilderConfig(base, channel, nightly, release, include);
  writeFileSync(config, JSON.stringify(options));
  const builder = [resolve('node_modules/electron-builder/cli.js'), '--config', config];
  if (phase !== '--package') run(process.execPath, [...builder, '--win', 'dir', '--x64', '--publish', 'never'], { env });
  await checkUnpacked(unpacked, nightly);
  if (phase === '--compile') return 0;
  const signed = process.env.APEX_DECK_WIN_SIGN === '1';
  if (signed && phase !== '--package') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/sign-win-unpacked.ps1'), '-Unpacked', unpacked], { env });
  }
  log(`building the ${signed ? 'signed' : 'unsigned'} NSIS installer`);
  if (signed) {
    options.win.azureSignOptions = AZURE_SIGNING;
    writeFileSync(config, JSON.stringify(options));
  }
  run(process.execPath, [...builder, '--win', 'nsis', '--x64', '--publish', 'never', '--prepackaged', unpacked], { env });

  // A moved checkout makes a mixed package, which installs fine and then
  // reports mismatched builds, so fail here instead.
  const after = git(['rev-parse', '--verify', 'HEAD']);
  if (!after?.startsWith(stamp.commit) || (nightly && after !== nightly.commit)) {
    throw new Error(`the checkout moved during the build (${stamp.commit} -> ${after}); do not install this installer`);
  }
  const installers = installersIn(release);
  if (!nightly && installers.length !== 1) {
    throw new Error(`expected one .exe installer in release/, found ${installers.length}: ${installers.join(', ') || 'none'}`);
  }
  const installer = resolve(release, nightly?.asset ?? INSTALLER_NAME);
  if (!existsSync(installer)) throw new Error(`Installer missing: ${installer}`);
  log(`wrote ${installer} (${(readFileSync(installer).length / 1048576).toFixed(1)} MB)`);
  log(`sha256 ${writeChecksum(installer)}`);
  if (!signed) log('this installer is unsigned: Windows will show "unknown publisher"');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`package-win: ${error.message}`);
    process.exitCode = 1;
  }
}
