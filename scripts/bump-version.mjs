#!/usr/bin/env node
// Set the release version everywhere it is written, in one go.
//
//   node scripts/bump-version.mjs 0.9.17              # rewrite every manifest and lockfile
//   node scripts/bump-version.mjs 0.9.17 --dry-run    # say what would change
//   node scripts/bump-version.mjs 0.9.15 --allow-downgrade
//
// Files: Cargo.toml, Cargo.lock, crates/iroh-mobile/Cargo.lock, package.json,
// package-lock.json and the three npm/*/package.json (see version-files.mjs).
// The lockfiles are edited in place for the workspace's own crates, which is
// what `cargo` would write for path dependencies, so `--locked` builds keep
// working without a network. Nothing is committed; review the diff and commit
// it as one change, then run `node scripts/check-versions.mjs`.
import { compareVersions, parseRoot, rewriteAll, allSites, disagreements, workspaceVersion, VERSION } from './version-files.mjs';

function main(argv) {
  const { root, rest } = parseRoot(argv);
  let version, dryRun = false, allowDowngrade = false;
  for (const arg of rest) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-downgrade') allowDowngrade = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument ${arg}`);
    else if (version) throw new Error('One version only');
    else version = arg;
  }
  if (!version) throw new Error('Usage: bump-version.mjs <x.y.z> [--dry-run] [--allow-downgrade]');
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version like x.y.z`);
  const current = workspaceVersion(root);
  if (compareVersions(version, current) < 0 && !allowDowngrade) {
    throw new Error(`${version} is lower than the current ${current}; pass --allow-downgrade if that is meant`);
  }
  const report = rewriteAll(root, version, { write: !dryRun });
  for (const r of report) {
    const from = r.from.filter(v => v !== version);
    const what = r.changed ? `${r.changed} of ${r.sites} site(s): ${from.join(', ')} -> ${version}` : `already ${version}`;
    console.log(`${dryRun ? 'would write' : 'wrote'.padEnd(11)} ${r.file.padEnd(36)} ${what}`);
  }
  if (dryRun) return 0;
  const wrong = disagreements(allSites(root), version);
  if (wrong.length) {
    for (const s of wrong) console.error(`  still ${s.version}: ${s.file} (${s.label})`);
    throw new Error('some sites did not take the new version');
  }
  console.log(`OK: every version site now says ${version}. Review the diff and commit it as one change.`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error(`bump-version: ${e.message}`);
  process.exit(1);
}
