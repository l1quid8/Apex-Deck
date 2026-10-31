import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const script = readFileSync(new URL('../scripts/acceptance-provenance.sh', import.meta.url), 'utf8');
const check = script.slice(script.indexOf('positive_runner_startup() {'), script.indexOf('\ntamper_forged_json() {'));

const POSIX_ONLY = process.platform === 'win32' ? { skip: 'posix-only: drives the bash acceptance harness' } : {};

// Exercise the acceptance verdict, substituting only OS service effects.
// The real harness runs the installed pinned daemon and broker, never fixtures.
function run({ log = '', reply = { id: 1, ok: null }, restartFails = false } = {}) {
  const work = mkdtempSync('/tmp/apex-runner-acceptance-');
  try {
    return execFileSync('/bin/bash', ['-s'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', WORK: work, DAEMON: '/usr/bin/true',
        LOG: log, REPLY: JSON.stringify(reply), RESTART_FAILS: restartFails ? '1' : '0' },
      input: `
start_daemon() {
  printf '%s' "$LOG" > "$WORK/$3.log"
  if [[ "$3" == runner-startup-2 && "$RESTART_FAILS" == 1 ]]; then return 1; fi
}
stop_daemon() { :; }
speak() { printf '%s' "$REPLY"; }
headline() { head -3 "$1"; }
pass_check() { printf 'PASS %s %s\\n' "$1" "$2"; }
fail_check() { printf 'FAIL %s %s\\n' "$1" "$2"; }
${check}
positive_runner_startup
`,
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test('real-helper startup acceptance requires a successful runner read and restart', POSIX_ONLY, () => {
  assert.match(run(), /^PASS positive\.runner-startup/);
  assert.match(run({ restartFails: true }), /^FAIL .*start 2 failed/);
  assert.match(run({ reply: { id: 1, err: 'Unknown command room_runner_state' } }), /^FAIL .*did not read/);
});

test('real-helper startup acceptance rejects degraded startup even with an empty runner reply', POSIX_ONLY, () => {
  for (const log of ['Not a protected ledger name', 'goals and loops unavailable: runner recovery failed', 'protected ledgers unavailable']) {
    assert.match(run({ log }), /^FAIL .*unavailable protected storage/);
  }
});
