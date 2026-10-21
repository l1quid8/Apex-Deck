import test from "node:test";
import assert from "node:assert/strict";
import { DaemonClient } from "../src/daemon/client.ts";
async function fixture() {
  let receive;
  const sent = [];
  const link = {
    send: (s) => sent.push(JSON.parse(s)),
    close() {},
    onLine: (cb) => (receive = cb),
    onClose() {},
  };
  const client = new DaemonClient(async () => link);
  assert.equal(client.sendVoice({ channel: 3, bin: "AAAA" }), false);
  const ready = client.start();
  await new Promise((r) => setImmediate(r));
  receive(
    JSON.stringify({
      id: sent[0].id,
      ok: {
        host_id: "h",
        boot_id: "b",
        protocol: 1,
        last_seq: 0,
        resumed: false,
      },
    }),
  );
  await ready;
  return { client, sent, receive: (f) => receive(JSON.stringify(f)) };
}
test("voice frames bypass ordinary event listeners", async () => {
  const f = await fixture(),
    voice = [],
    events = [];
  f.client.onVoice((v) => voice.push(v));
  f.client.on("ready", (v) => events.push(v));
  f.client.on("voice", (v) => events.push(v));
  f.receive({ voice: { channel: 3, ctl: { type: "ready" } } });
  assert.deepEqual(voice, [{ channel: 3, ctl: { type: "ready" } }]);
  assert.deepEqual(events, []);
  f.client.close();
});
test("sendVoice writes an id-less line and refuses offline", async () => {
  const f = await fixture();
  assert.equal(f.client.sendVoice({ channel: 3, bin: "AAAA" }), true);
  assert.deepEqual(f.sent.at(-1), { voice: { channel: 3, bin: "AAAA" } });
  f.client.close();
  assert.equal(f.client.sendVoice({ channel: 3, bin: "AAAA" }), false);
});
test("malformed voice and primitive socket messages are ignored without touching chat", async () => {
  const f = await fixture(),
    got = [];
  f.client.onVoice((v) => got.push(v));
  for (const v of [
    null,
    "bad",
    { channel: 1 },
    { channel: -1, rx: 4 },
    { channel: 1, rx: -1 },
    { channel: 1, ctl: [] },
    { channel: 1, ctl: null },
    { channel: 1, bin: 7 },
  ])
    f.receive({ voice: v });
  f.receive(null);
  f.receive(9);
  assert.deepEqual(got, []);
  assert.equal(f.client.sendVoice({ channel: 1, ctl: { type: "end" } }), true);
  f.client.close();
});
