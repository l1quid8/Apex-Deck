import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../desktop/hostIdentity.mjs').catch(()=>({}));
const welcome={protocol:1,host_id:'daemon-a',boot_id:'boot-a',last_seq:0,resumed:false};
test('welcome identity requires protocol and refuses retargets',()=>{
  assert.equal(typeof mod.checkWelcome,'function');
  assert.equal(mod.checkWelcome(undefined,welcome),'daemon-a');
  assert.throws(()=>mod.checkWelcome('daemon-b',welcome),/identity|different/i);
  assert.throws(()=>mod.checkWelcome(undefined,{...welcome,host_id:''}),/identity|id/i);
  assert.throws(()=>mod.checkWelcome(undefined,{...welcome,protocol:2}),/protocol/i);
});
test('identity binding refuses an existing alias and preserves the command',()=>{
  assert.equal(typeof mod.bindHostIdentity,'function');
  const state={hosts:[{id:'at',name:'AT',ssh:'at',command:'/opt/apex-daemon'},{id:'other',name:'Other',daemonHostId:'daemon-b'}]};
  const bound=mod.bindHostIdentity(state,'at',welcome);
  assert.equal(bound.hosts[0].daemonHostId,'daemon-a');assert.equal(bound.hosts[0].command,'/opt/apex-daemon');
  assert.throws(()=>mod.bindHostIdentity(bound,'at',{...welcome,host_id:'daemon-b'}),/identity|different/i);
  assert.throws(()=>mod.bindHostIdentity(state,'at',{...welcome,host_id:'daemon-b'}),/already/i);
});
test('only a persisted accepted welcome unlocks commands',async()=>{
  assert.equal(typeof mod.verifiedLink,'function');
  let incoming;const sent=[];const heard=[];let accepted=false;
  const link=await mod.verifiedLink({open:async handlers=>{incoming=handlers;return {send:l=>sent.push(JSON.parse(l)),close(){}};},handlers:{onLine:l=>heard.push(JSON.parse(l)),onClose(){}},accept:()=>{accepted=true;}});
  link.send(JSON.stringify({id:1,cmd:'room_post'}));assert.equal(sent.length,0);
  link.send(JSON.stringify({id:2,cmd:'hello'}));incoming.onLine(JSON.stringify({id:2,ok:welcome}));
  assert.equal(accepted,true);assert.equal(heard[0].ok.host_id,'daemon-a');
  link.send(JSON.stringify({id:3,cmd:'room_post'}));assert.equal(sent.at(-1).id,3);
});

const hostsState = () => ({ version: 1, hosts: [
  { id: 'at', name: 'AT', ssh: 'l1@apex-terminal', command: 'apex-daemon', daemonHostId: 'd-at' },
  { id: 'hz', name: 'HZ', ssh: 'root@hz', command: '/root/.cargo/bin/apex-daemon', daemonHostId: 'd-hz' }] });
const before = (s, id) => { const h = s.hosts.find((x) => x.id === id); return { name: h.name, ssh: h.ssh, command: h.command }; };

test('a probe says hello only, returns the welcome and always closes', async () => {
  const sent = []; let closed = false;
  const got = await mod.probeWelcome(async ({ onLine }) => ({
    send(line) { sent.push(JSON.parse(line)); onLine(JSON.stringify({ id: 0, ok: { host_id: 'd-at', protocol: 1, version: '0.5.1' } })); },
    close() { closed = true; },
  }));
  assert.deepEqual(sent.map((f) => f.cmd), ['hello']);
  assert.equal(got.host_id, 'd-at');
  assert.equal(closed, true);
  let shut = false;
  await assert.rejects(mod.probeWelcome(async ({ onClose }) => ({ send() { onClose('Permission denied (publickey).'); }, close() { shut = true; } })), /Permission denied/);
  assert.equal(shut, true);
  await assert.rejects(mod.probeWelcome(async () => ({ send() {}, close() {} }), { timeoutMs: 20 }), /timed out/);
  await assert.rejects(mod.probeWelcome(async ({ onLine }) => ({ send() { onLine(JSON.stringify({ id: 0, err: 'protocol 2 required' })); }, close() {} })), /protocol 2/);
  await assert.rejects(mod.probeWelcome(async () => { throw new Error('There is no ssh on this Mac.'); }), /no ssh/);
});

test('a new address saves only when it reaches the same machine', () => {
  const s = hostsState();
  const next = mod.applyHostUpdate(s, 'at', { name: 'AT', ssh: 'l1@203.0.113.24', command: 'apex-daemon' }, { before: before(s, 'at'), probed: { host_id: 'd-at' } });
  assert.equal(next.hosts[0].ssh, 'l1@203.0.113.24');
  assert.equal(next.hosts[0].daemonHostId, 'd-at');
  assert.equal(s.hosts[0].ssh, 'l1@apex-terminal', 'the saved state is not changed in place');
  assert.throws(() => mod.applyHostUpdate(s, 'at', { name: 'AT', ssh: 'l1@other', command: 'apex-daemon' }, { before: before(s, 'at'), probed: { host_id: 'd-new' } }), (e) => e.code === 'different' && /different machine/.test(e.message));
  assert.throws(() => mod.applyHostUpdate(s, 'at', { name: 'AT', ssh: 'root@hz', command: 'apex-daemon' }, { before: before(s, 'at'), probed: { host_id: 'd-hz' } }), (e) => e.code === 'known' && /HZ/.test(e.message));
  const unbound = { ...s, hosts: [{ ...s.hosts[0], daemonHostId: undefined }, s.hosts[1]] };
  assert.equal(mod.applyHostUpdate(unbound, 'at', { name: 'AT', ssh: 'l1@x', command: 'apex-daemon' }, { before: before(unbound, 'at'), probed: { host_id: 'd-first' } }).hosts[0].daemonHostId, 'd-first');
});

test('Save keeps the daemon command, and a rename needs no probe', () => {
  const s = hostsState();
  const next = mod.applyHostUpdate(s, 'hz', { name: 'Hetzner-EU', ssh: 'root@hz', command: '/root/.cargo/bin/apex-daemon' }, { before: before(s, 'hz'), probed: null });
  assert.equal(next.hosts[1].command, '/root/.cargo/bin/apex-daemon');
  assert.equal(next.hosts[1].name, 'Hetzner-EU');
  assert.equal(next.hosts[1].daemonHostId, 'd-hz');
  assert.throws(() => mod.applyHostUpdate(s, 'hz', { name: 'HZ', ssh: 'root@new', command: 'apex-daemon' }, { before: before(s, 'hz'), probed: null }), (e) => e.code === 'unreachable');
  assert.throws(() => mod.applyHostUpdate(s, 'hz', { name: 'HZ', ssh: 'root@hz', command: 'rm -rf /' }, { before: before(s, 'hz'), probed: null }), (e) => e.code === 'invalid');
});

test('a commit after a slow probe re-checks names, removal and concurrent edits', () => {
  const s = hostsState(); const was = before(s, 'at');
  const renamed = { ...s, hosts: s.hosts.map((h) => (h.id === 'hz' ? { ...h, name: 'Apex' } : h)) };
  assert.throws(() => mod.applyHostUpdate(renamed, 'at', { name: 'Apex', ssh: 'l1@203.0.113.24', command: 'apex-daemon' }, { before: was, probed: { host_id: 'd-at' } }), (e) => e.code === 'invalid' && /already a host called Apex/.test(e.message));
  const removed = { ...s, hosts: s.hosts.filter((h) => h.id !== 'at') };
  assert.throws(() => mod.applyHostUpdate(removed, 'at', { name: 'AT', ssh: 'l1@x', command: 'apex-daemon' }, { before: was, probed: { host_id: 'd-at' } }), (e) => e.code === 'changed');
  const edited = { ...s, hosts: s.hosts.map((h) => (h.id === 'at' ? { ...h, ssh: 'l1@elsewhere' } : h)) };
  assert.throws(() => mod.applyHostUpdate(edited, 'at', { name: 'AT', ssh: 'l1@x', command: 'apex-daemon' }, { before: was, probed: { host_id: 'd-at' } }), (e) => e.code === 'changed');
  const rebound = { ...s, hosts: s.hosts.map((h) => (h.id === 'hz' ? { ...h, daemonHostId: 'd-at2' } : h)) };
  assert.throws(() => mod.applyHostUpdate(rebound, 'at', { name: 'AT', ssh: 'l1@x', command: 'apex-daemon' }, { before: was, probed: { host_id: 'd-at2' } }), (e) => e.code === 'known');
});
