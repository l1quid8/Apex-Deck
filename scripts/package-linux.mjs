#!/usr/bin/env node
// Native Linux build only. No approval-service installation or publishing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStamp, stampEnv } from './build-stamp.mjs';
import { channel } from '../desktop/channel.mjs';
import { nightlyIdentity } from '../desktop/channelIdentity.mjs';

export function assertLinuxHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux') throw new Error('Build the AppImage on Linux (see linux-appimage.yml).');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux architecture: ${arch}`);
}

export function builderArgs(arch = process.arch, nightly) {
  const args = [
    '--linux', 'AppImage', `--${arch}`, '--publish', 'never',
    '--config.electronFuses.grantFileProtocolExtraPrivileges=false',
  ];
  if (nightly) args.push(
    `--config.appId=${nightly.appId}`,
    `--config.productName=${nightly.product}`,
    `--config.extraMetadata.desktopName=${nightly.appId}.desktop`,
    '--config.linux.syncDesktopName=true',
    '--config.directories.output=release/nightly',
    `--config.linux.artifactName=${nightly.name}`,
  );
  return args;
}

export function artifactName(version, arch = process.arch, nightly) {
  const suffix = arch === 'x64' ? 'x86_64' : arch;
  return nightly
    ? `Apex-Deck-Nightly_${nightly.date}_${nightly.commit.slice(0, 7)}_${suffix}.AppImage`
    : `Apex-Deck_${version}_${suffix}.AppImage`;
}

export function linuxNightlyRelease(commit, buildNumber, date) {
  if (!/^[1-9]\d*$/.test(buildNumber ?? '')) throw new Error('APEX_BUILD_NUMBER must be a positive decimal integer');
  const identity = nightlyIdentity({ commit, buildNumber: Number(buildNumber) });
  if (!/^\d{8}$/.test(date)) throw new Error('Invalid Nightly source date');
  return { ...identity, date, tag: `nightly-${date}-${commit.slice(0, 7)}` };
}

// The scheduled Nightly planner owns the release date and commit, so the
// AppImage name matches the immutable nightly-<date>-<sha7> tag it ships under.
export function nightlySourceDate(env, commitSeconds) {
  const planned = (env.APEX_NIGHTLY_DATE ?? '').trim();
  return planned || new Date(commitSeconds * 1000).toISOString().slice(0, 10).replaceAll('-', '');
}

// APEX_NIGHTLY_COMMIT, not APEX_BUILD_COMMIT: the latter is the build stamp
// (scripts/build-stamp.mjs), which this script expects at 12 characters.
export function assertPlannedCommit(env, sourceCommit) {
  const planned = (env.APEX_NIGHTLY_COMMIT ?? '').trim();
  if (planned && planned !== sourceCommit) {
    throw new Error(`APEX_NIGHTLY_COMMIT ${planned} does not match the checked-out commit ${sourceCommit}`);
  }
}

async function main() {
  assertLinuxHost();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const stamp = readStamp({ git });
  const checkSource = () => {
    if (stamp.dirty || stamp.commit !== sourceCommit.slice(0, 12) ||
        git(['rev-parse', 'HEAD']) !== sourceCommit || git(['status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('The AppImage requires a clean checkout at the stamped commit.');
    }
  };
  checkSource();
  if (channel.nightly) assertPlannedCommit(process.env, sourceCommit);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const nightly = channel.nightly ? linuxNightlyRelease(
    sourceCommit, process.env.APEX_BUILD_NUMBER,
    nightlySourceDate(process.env, Number(git(['show', '-s', '--format=%ct', sourceCommit]))),
  ) : undefined;
  const name = artifactName(version, process.arch, nightly);
  const env = stampEnv(stamp, {
    ...process.env, APEX_CHANNEL: channel.name, CARGO_TARGET_DIR: resolve('target'),
    ...(nightly && { APEX_BUILD_NUMBER: String(nightly.buildNumber), APEX_BUILD_SOURCE_COMMIT: sourceCommit }),
  });
  const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: 'inherit' });
  run('cargo', ['build', '--release', '--locked', '-p', 'apex-daemon', '--features', 'remote']);
  if (nightly) {
    const binary = JSON.parse(execFileSync(resolve('target/release/apex-daemon'), ['--build-identity'], { encoding: 'utf8' }));
    if (binary.channel !== channel.name || binary.version !== version ||
        binary.commit !== sourceCommit || binary.buildNumber !== nightly.buildNumber) {
      throw new Error('The Linux daemon build identity does not match the AppImage.');
    }
  }
  run('npm', ['run', 'build']);
  run(process.execPath, [resolve('node_modules/electron-builder/cli.js'), ...builderArgs(process.arch,
    nightly && { name, appId: channel.APP_ID, product: channel.PRODUCT })]);
  checkSource();
  const artifact = resolve(nightly ? 'release/nightly' : 'release', name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  writeFileSync(`${artifact}.sha256`, `${sha256}  ${name}\n`);
  writeFileSync(`${artifact}.json`, JSON.stringify({
    ...stamp, sourceCommit, ...nightly, channel: channel.name, version, arch: process.arch,
    name, size: statSync(artifact).size, sha256, milestone: 'packaging-only', protectedApprovals: false,
  }, null, 2) + '\n');
  console.log(`Built ${artifact} (${stamp.commit}). Protected approvals are not installed by this build.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`package-linux: ${error.message}`); process.exitCode = 1; });
}
