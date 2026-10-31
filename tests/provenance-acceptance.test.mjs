import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// macOS-only: the provenance acceptance harness. Windows has no such API, and the app refuses
// protected records there instead of pretending the check passed.
const MAC_ONLY = process.platform === 'darwin' ? {} : { skip: 'macOS-only: the provenance acceptance harness' };

const repo = fileURLToPath(new URL('..', import.meta.url));
// Execute the harness's actual tamper check, including its JSON comparison.
// Substitute only installed-daemon effects; these tests never start a service.
const script = readFileSync(new URL('../scripts/acceptance-provenance.sh', import.meta.url), 'utf8');
const check = script.slice(script.indexOf('tamper_forged_json() {'), script.indexOf('\nskips() {'));
const empty = { workspaceId: 'acceptance', revision: 0, tasks: [], executions: [], routingThreads: [], namedOnlyWorkerIds: [] };

function run({ firstLog = '', secondLog = '', answer = empty, rewrite = false } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'apex-tamper-check-'));
  writeFileSync(path.join(work, 'reply.json'), JSON.stringify({ id: 1, ok: answer }));
  const effects = `
start_daemon() {
  case "$3" in
    tamper-daemon) printf '%s' "$FIRST_LOG" > "$WORK/$3.log" ;;
    *) printf '%s' "$SECOND_LOG" > "$WORK/$3.log" ;;
  esac
  if [[ "$REWRITE" == 1 ]]; then printf '{}' > "$2/assistant-tasks-v1.json"; fi
}
stop_daemon() { :; }
protected_state() { cat "$WORK/reply.json"; }
headline() { head -3 "$1"; }
pass_check() { printf 'PASS %s %s\\n' "$1" "$2"; }
fail_check() { printf 'FAIL %s %s\\n' "$1" "$2"; }
skip_check() { printf 'SKIP %s %s\\n' "$1" "$2"; }
`;
  try {
    return execFileSync('/bin/bash', ['-s'], {
      input: `${effects}\n${check}\ntamper_forged_json\n`, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', WORK: work, REPO: repo, DAEMON: '/usr/bin/true',
        FIRST_LOG: firstLog, SECOND_LOG: secondLog, REWRITE: rewrite ? '1' : '0' },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('tamper acceptance requires a working protected store on the first start', MAC_ONLY, () => {
  assert.match(run({ firstLog: 'apex: protected ledgers unavailable (broker refused)' }), /^FAIL .*protected ledgers unavailable/);
});

test('tamper acceptance requires a working protected store after restart', MAC_ONLY, () => {
  assert.match(run({ secondLog: 'apex: protected ledgers unavailable (broker refused)' }), /^FAIL .*protected ledgers unavailable/);
});

test('tamper acceptance passes only for the exact protected state with the original fixture intact', MAC_ONLY, () => {
  assert.match(run(), /^PASS tamper\.forged-user-json/);
  assert.match(run({ answer: { ...empty, revision: 9 } }), /^FAIL /);
  assert.match(run({ rewrite: true }), /^FAIL .*rewritten/);
});
