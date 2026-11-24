// Test-only helper for scripts/windows-channel-lifecycle.ps1 on a disposable Windows VM.
// relay: stands in for a stopped installed daemon so the real installed UI's genuine
//   receipt can be captured unspent. Other frames go to a scratch daemon of the same channel.
// send:  presents a captured receipt to an installed daemon and records its catalog
//   before and after, so a refused receipt is shown to have changed nothing.
import fs from 'node:fs';
import net from 'node:net';

const [mode, ...rest] = process.argv.slice(2);
const HELD = 'Held by the cross-channel receipt test; not executed.';

function lines(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      onLine(line);
    }
  });
}

function relay(listenAt, forwardTo, captureFile) {
  let held = 0;
  const server = net.createServer((client) => {
    const upstream = net.createConnection(forwardTo);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);
    // Whole lines only in each direction, so a held reply never splits a daemon frame.
    lines(upstream, (line) => client.write(line));
    lines(client, (line) => {
      let frame = null;
      try { frame = JSON.parse(line); } catch {}
      if (frame?.cmd !== 'provenance_execute') return upstream.write(line);
      held += 1;
      if (held === 1) {
        fs.writeFileSync(`${captureFile}.part`, JSON.stringify(frame.args.receipt));
        fs.renameSync(`${captureFile}.part`, captureFile);
      }
      console.log(JSON.stringify({ held, id: frame.id, command: JSON.parse(frame.args.receipt.payload).receipt?.command?.cmd }));
      client.write(JSON.stringify({ id: frame.id, err: HELD }) + '\n');
    });
  });
  server.on('error', (error) => { console.error(error); process.exit(1); });
  server.listen(listenAt, () => console.log(`relay ${listenAt} -> ${forwardTo}`));
}

async function send(endpoint, captureFile, variant) {
  let receipt = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  if (variant === 'tampered') {
    const payload = JSON.parse(receipt.payload);
    payload.receipt.command.args = { ...payload.receipt.command.args, tampered: true };
    receipt = { ...receipt, payload: JSON.stringify(payload) };
  } else if (variant === 'garbage') {
    receipt = { ...receipt, signature: Buffer.alloc(64, 7).toString('base64') };
  } else if (variant !== 'genuine') throw new Error(`Unknown variant ${variant}`);
  const socket = net.createConnection(endpoint);
  const waiting = new Map();
  lines(socket, (line) => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (waiting.has(frame.id)) { waiting.get(frame.id)(frame); waiting.delete(frame.id); }
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const call = (id, cmd, args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} timed out at ${endpoint}`)), 60000);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    socket.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
  const hello = await call(0, 'hello', { protocol: 1 });
  if (hello.err) throw new Error(`hello refused: ${hello.err}`);
  const before = await call(1, 'chat_list', {});
  const reply = await call(2, 'provenance_execute', { receipt });
  const after = await call(3, 'chat_list', {});
  socket.destroy();
  const command = JSON.parse(receipt.payload).receipt?.command;
  console.log(JSON.stringify({
    endpoint, variant, command: command?.cmd, target: command?.args?.id ?? null,
    reply, before: before.ok, after: after.ok,
    unchanged: JSON.stringify(before.ok) === JSON.stringify(after.ok),
  }));
}

if (mode === 'relay') relay(...rest);
else if (mode === 'send') await send(...rest);
else throw new Error('usage: relay <listen> <forward> <capture> | send <endpoint> <capture> genuine|tampered|garbage');
