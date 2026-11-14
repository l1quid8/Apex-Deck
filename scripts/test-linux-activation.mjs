#!/usr/bin/env node
// Explicit privileged test on disposable CI only. No guest or real authority
// directory is touched; the Rust fixture uses its own root-owned /var/lib tree.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'linux');
assert.equal(process.env.CI, 'true', 'Run only on a disposable CI runner');
const output = execFileSync('cargo', ['test', '--locked', '-p', 'apex-provenance', '--lib', '--no-run', '--message-format=json'], { encoding: 'utf8' });
const artifacts = output.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.reason === 'compiler-artifact' && row.profile.test && row.target.name === 'apex_provenance' && row.executable);
assert.equal(artifacts.length, 1);
execFileSync('sudo', [artifacts[0].executable, '--exact', 'linux_activation::tests::native_root_store_lock_restart_and_authority_preservation', '--ignored', '--nocapture'], { stdio: 'inherit' });
