#!/usr/bin/env node
// Native Linux build only. No approval-service installation or publishing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStamp, stampEnv } from './build-stamp.mjs';

export function assertLinuxHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux') throw new Error('Build the AppImage on Linux (see linux-appimage.yml).');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux architecture: ${arch}`);
}

export const builderArgs = (arch = process.arch) => ['--linux', 'AppImage', `--${arch}`, '--publish', 'never'];

function main() {
  assertLinuxHost();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const stamp = readStamp({ git });
  if (stamp.commit === 'unknown' || stamp.dirty) throw new Error('Commit the packaging changes before building a labelled AppImage.');
  const env = stampEnv(stamp);
  const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: 'inherit' });
  run('cargo', ['build', '--release', '--locked', '-p', 'apex-daemon', '--features', 'remote']);
  run('npm', ['run', 'build']);
  run(process.execPath, [resolve('node_modules/electron-builder/cli.js'), ...builderArgs()]);
  if (git(['rev-parse', '--short=12', 'HEAD']) !== stamp.commit || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('The checkout changed during packaging; do not use this AppImage.');
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const name = `Apex-Deck_${version}_${process.arch}.AppImage`;
  const artifact = resolve('release', name);
  const hash = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(`${artifact}.sha256`, `${hash}  ${name}\n`);
  writeFileSync(`${artifact}.json`, JSON.stringify({ ...stamp, version, arch: process.arch, milestone: 'packaging-only', protectedApprovals: false }, null, 2) + '\n');
  console.log(`Built ${artifact} (${stamp.commit}). Protected approvals are not installed by this build.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`package-linux: ${error.message}`); process.exitCode = 1; }
}
