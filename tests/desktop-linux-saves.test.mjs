import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLinuxSaves, LAYOUT_REFUSAL } from '../desktop/linuxSaves.mjs';
import { linuxAttestedCommands, protectedCommands } from '../desktop/provenance.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function harness({ attest = async (frame) => ({ id: frame.id, cmd: 'provenance_execute', args: { receipt: { for: frame.cmd } } }) } = {}) {
  const sent = [], replies = [], attested = [];
  const saves = createLinuxSaves({
    attest: async (frame) => { attested.push(frame); return attest(frame); },
    send: (contentsId, gen, line) => sent.push([contentsId, gen, JSON.parse(line)]),
    reply: (contentsId, gen, line) => replies.push([contentsId, gen, JSON.parse(line)]),
  });
  return { saves, sent, replies, attested, settle: () => new Promise((r) => setImmediate(r)) };
}

test('the refusal text matches the engine', () => {
  assert.ok(read('../crates/apex-host/src/storage.rs').includes(`pub const LAYOUT_SAVE_CHANGES_PROFILES: &str = ${JSON.stringify(LAYOUT_REFUSAL)};`));
});

test('the Linux-attested list matches the host and the broker, and stays off the Mac list', () => {
  const host = read('../crates/apex-host/src/command.rs').match(/pub fn attested_on_linux[\s\S]*?\n\}/)[0];
  const broker = read('../crates/apex-provenance/src/lib.rs').match(/pub fn protected\(name: &str\)[\s\S]*?\n\}/)[0];
  for (const cmd of linuxAttestedCommands) {
    const variant = cmd.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    assert.ok(host.includes(`Command::${variant} {`), `host admits a receipt for ${cmd}`);
    assert.ok(broker.includes(`"${cmd}"`), `broker signs ${cmd}`);
    // The Mac and Windows windows keep sending these without a receipt.
    assert.ok(!protectedCommands.has(cmd), cmd);
  }
});

test('a session save goes out as a layout save, with no receipt', async () => {
  const h = harness();
  const frame = { id: 7, cmd: 'session_save', args: { session: { version: 1, workspaces: [{ id: 'w' }] } } };
  assert.equal(h.saves.outgoing(1, 2, frame), true);
  assert.deepEqual(h.sent, [[1, 2, { ...frame, cmd: 'session_save_layout' }]]);
  // The engine's answer reaches the window untouched.
  assert.equal(h.saves.incoming(1, 2, JSON.stringify({ id: 7, ok: null })), false);
  await h.settle();
  assert.equal(h.attested.length, 0);
});

test('a layout save refused for changing profiles is resent once with a receipt', async () => {
  const h = harness();
  const frame = { id: 8, cmd: 'session_save', args: { session: { version: 1, profiles: [{ id: 'a', access: 'full' }] } } };
  h.saves.outgoing(1, 2, frame);
  assert.equal(h.saves.incoming(1, 2, JSON.stringify({ err: LAYOUT_REFUSAL, id: 8 })), true, 'the refusal is not shown to the window');
  await h.settle();
  assert.deepEqual(h.attested, [frame], 'the original session_save is what gets signed');
  assert.deepEqual(h.sent[1], [1, 2, { id: 8, cmd: 'provenance_execute', args: { receipt: { for: 'session_save' } } }]);
  // The receipted save's own answer, even another refusal, goes to the window.
  assert.equal(h.saves.incoming(1, 2, JSON.stringify({ err: LAYOUT_REFUSAL, id: 8 })), false);
});

test('other errors, other windows and other link generations are not retried', async () => {
  const h = harness();
  h.saves.outgoing(1, 2, { id: 9, cmd: 'session_save', args: { session: {} } });
  assert.equal(h.saves.incoming(3, 2, JSON.stringify({ id: 9, err: LAYOUT_REFUSAL })), false);
  assert.equal(h.saves.incoming(1, 5, JSON.stringify({ id: 9, err: LAYOUT_REFUSAL })), false);
  assert.equal(h.saves.incoming(1, 2, JSON.stringify({ id: 9, err: 'Could not save data: disk full' })), false);
  assert.equal(h.saves.incoming(1, 2, JSON.stringify({ id: 9, err: LAYOUT_REFUSAL })), false, 'already answered');
  await h.settle();
  assert.equal(h.attested.length, 0);
});

test('settings and the other raising saves always carry a receipt', async () => {
  const h = harness();
  for (const [i, cmd] of ['settings_save', 'folder_accept', 'settings_code_mode_set', 'monitor_watch_save'].entries()) {
    assert.equal(h.saves.outgoing(1, 1, { id: i, cmd, args: {} }), true, cmd);
  }
  await h.settle();
  assert.deepEqual(h.sent.map(([, , f]) => f.cmd), Array(4).fill('provenance_execute'));
  assert.equal(h.saves.outgoing(1, 1, { id: 99, cmd: 'session_load', args: {} }), false, 'everything else is left alone');
});

test('a broker failure answers the window instead of sending an unproven save', async () => {
  const h = harness({ attest: async () => { throw new Error('Protected provenance service unavailable. Submission was not sent.'); } });
  h.saves.outgoing(4, 1, { id: 3, cmd: 'settings_save', args: { settings: {} } });
  await h.settle();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.replies, [[4, 1, { id: 3, err: 'Protected provenance service unavailable. Submission was not sent.' }]]);
});

test('main routes only the broker-launched Linux window through it', () => {
  const main = read('../desktop/main.mjs');
  assert.match(main, /const linuxSaves = process\.platform === 'linux' && app\.isPackaged && plan\.scope\?\.role === 'app' && !plan\.protectedSubmissionError/);
  assert.match(main, /if \(hostId === LOCAL && linuxSaves\?\.outgoing\(event\.sender\.id, gen, frame\)\) return;/);
  assert.ok(main.indexOf('linuxSaves?.outgoing') < main.indexOf('needsAttestation(frame.cmd'), 'routed before the ordinary attestation path');
});
