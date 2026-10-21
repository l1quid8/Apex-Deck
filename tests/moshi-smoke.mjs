// Manual real-model test; never part of npm test (requires ~5.2 GB weights).
// MOSHI_SMOKE_ROOT=/path/to/prepared/voice/moshi node tests/moshi-smoke.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { moshiRuntime } from '../desktop/moshiRuntime.mjs';
const root = process.env.MOSHI_SMOKE_ROOT;
if (!root) throw new Error('Set MOSHI_SMOKE_ROOT to a prepared Moshi data directory.');
const voice = moshiRuntime(root);
const started = Date.now();
try {
  const run = await voice.start(process.env.MOSHI_SMOKE_INSTALL === '1');
  console.log(`Ready in ${Date.now() - started} ms`);
  assert.equal((await fetch(run.url)).status, 403);
  const { stdout } = await promisify(execFile)(path.join(root, 'venv/bin/python'), ['-c', `
import asyncio, os, aiohttp, numpy as np
async def main():
    async with aiohttp.ClientSession() as client:
        try:
            await client.ws_connect(os.environ['VOICE_URL'] + '/api/chat')
            raise AssertionError('Unauthenticated websocket was accepted')
        except aiohttp.WSServerHandshakeError as error:
            assert error.status == 403
        async with client.ws_connect(os.environ['VOICE_URL'] + '/api/chat', headers={'X-Apex-Voice-Token':os.environ['VOICE_TOKEN'], 'Origin': os.environ['VOICE_URL']}) as ws:
            hello = await ws.receive(timeout=10)
            assert hello.data == b'\\x00', hello
            async def send():
                for i in range(60):
                    await ws.send_bytes(b'\\x01' + np.zeros(1920, dtype='<f4').tobytes())
                    await asyncio.sleep(.08)
            async def receive():
                frames = 0
                while frames < 5:
                    msg = await ws.receive(timeout=15)
                    assert msg.type == aiohttp.WSMsgType.BINARY, msg
                    if msg.data[0] == 1:
                        assert len(msg.data) == 7681
                        assert np.isfinite(np.frombuffer(msg.data[1:], dtype='<f4')).all()
                        frames += 1
                print('Authenticated handshake; received 5 valid 24 kHz audio frames')
            await asyncio.gather(send(), receive())
asyncio.run(main())
`], { timeout: 30000, env: { ...process.env, VOICE_URL: run.url, VOICE_TOKEN: run.token } });
  console.log(stdout.trim());
  if (process.env.MOSHI_SMOKE_CRASH === '1') {
    const { stdout: ps } = await promisify(execFile)('/bin/ps', ['-axo', 'pid,ppid,command']);
    const rows = ps.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
    const parent = rows.find(row => row[3].includes(`${root}/client/runner.py --host`));
    assert.ok(parent, 'runner process exists');
    const worker = rows.find(row => row[2] === parent[1] && row[3].includes('spawn_main'));
    assert.ok(worker, 'inference/codec worker exists');
    process.kill(Number(worker[1]), 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (voice.status().phase === 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(voice.status().phase, 'error');
    console.log('Native worker crash detected; helper process group terminated');
  }
} finally {
  await voice.stop(); assert.equal(voice.status().phase, 'off');
  console.log('Helper stopped');
}
