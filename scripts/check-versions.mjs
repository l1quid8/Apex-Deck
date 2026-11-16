#!/usr/bin/env node
// Fail when the release version is not the same everywhere it is written.
//
//   node scripts/check-versions.mjs                 # against this checkout
//   node scripts/check-versions.mjs --expect 0.9.17 # and insist on one value
//   node scripts/check-versions.mjs --root DIR      # another checkout
//
// CI runs this on every push (see .github/workflows/daemon.yml). Fix a
// disagreement with `node scripts/bump-version.mjs <x.y.z>`, never by hand.
import { allSites, disagreements, parseRoot, workspaceVersion, VERSION } from './version-files.mjs';

function main(argv) {
  const { root, rest } = parseRoot(argv);
  let expected;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--expect') {
      expected = rest[++i];
      if (!VERSION.test(expected || '')) throw new Error('--expect needs a version like x.y.z');
    } else {
      throw new Error(`Unknown argument ${rest[i]}`);
    }
  }
  const sites = allSites(root);
  const reference = expected ?? workspaceVersion(root);
  for (const s of sites) console.log(`${s.file.padEnd(36)} ${s.label.padEnd(28)} ${s.version}`);
  const wrong = disagreements(sites, reference);
  if (wrong.length === 0) {
    console.log(`OK: every version site says ${reference}`);
    return 0;
  }
  console.error(`Versions disagree (expected ${reference}${expected ? ', from --expect' : ', the Cargo workspace version'}):`);
  for (const s of wrong) console.error(`  ${s.file} (${s.label}): ${s.version}`);
  console.error(`Fix: node scripts/bump-version.mjs ${reference}`);
  return 1;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error(`check-versions: ${e.message}`);
  process.exit(2);
}
