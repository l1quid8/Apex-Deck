#!/usr/bin/env node
// Packages Apex Deck with one commit stamped into every artifact.
//
// Resolves the commit once, exports it to cargo (build.rs) and vite
// (vite.config.ts), and fails the run if the checkout moved while it built --
// a mixed package is worse than a missing one, because it installs fine and
// then reports "Different builds" for no reason the Human can act on.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readStamp, stampEnv } from './build-stamp.mjs';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const stamp = readStamp({ env: process.env, git });
if (stamp.commit === 'unknown') {
  console.error('package-pinned: no commit to stamp; refusing to ship an unlabelled build.');
  process.exit(1);
}

const passThrough = process.argv.slice(2);
console.log(`package-pinned: stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the app and the service`);

const result = spawnSync('npm', ['run', '_desktop:package', '--', ...passThrough], {
  stdio: 'inherit',
  env: stampEnv(stamp),
});
if (result.status !== 0) process.exit(result.status ?? 1);

const after = git(['rev-parse', '--short=12', 'HEAD']);
if (after !== stamp.commit) {
  console.error(`package-pinned: the checkout moved during the build (${stamp.commit} -> ${after}).`);
  console.error('package-pinned: artifacts are mixed; do not install them. Re-run on a stable checkout.');
  process.exit(1);
}

// Read the stamp back out of what was actually produced. The checkout
// staying put is necessary but not proof; this is the claim worth trusting.
const built = readdirSync(resolve('release/mac-arm64'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  .map((entry) => resolve('release/mac-arm64', entry.name));

let checked = 0;
for (const app of built) {
  const artifacts = [
    ['UI bundle', resolve(app, 'Contents/Resources/app.asar')],
    ['service', resolve(app, 'Contents/Resources/bin/apex-daemon')],
  ];
  for (const [label, file] of artifacts) {
    if (!existsSync(file)) continue;
    if (!readFileSync(file).includes(stamp.commit)) {
      console.error(`package-pinned: the ${label} in ${basename(app)} does not carry ${stamp.commit}.`);
      process.exit(1);
    }
    checked += 1;
  }
}

if (checked === 0) {
  console.error('package-pinned: found no packaged app to verify under release/mac-arm64.');
  process.exit(1);
}
console.log(`package-pinned: read ${stamp.commit} back out of ${checked} built artifact(s).`);
