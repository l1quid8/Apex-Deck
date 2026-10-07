import { test } from "node:test";
import assert from "node:assert/strict";
import { addMachine, canSeeNewThread, editMachine, loadMachines, saveMachines, withHints } from "../src/phoneRules.ts";
import { parsePairingLink, startPairing, RELAY } from "../src/phone/pairing.ts";
import { EventRouter } from "../src/phone/remotePlugin.ts";

const HOST = "ab".repeat(32);
const now = 1_800_000_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function link(fields = {}) {
  const wire = { v: 1, host: HOST, name: "Tyler's Mac Studio", relay: RELAY, addrs: ["192.168.1.20:41641"], inv: "BwcHBwcHBwcHBwcHBwcHBw", secret: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk", exp: now + 300, ...fields };
  return `apexdeck://pair?p=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
}

const direct = { id: "local", name: "My Mac", kind: "mac", url: "ws://192.168.1.20:7421", token: "abc123" };
const paired = { id: "h-1", name: "Apex-Terminal", kind: "server", transport: "iroh", hostEndpointId: HOST, addrs: ["203.0.113.7:41641"], pairedAt: 5 };

test("loadMachines reads an old WebSocket-only list unchanged", () => {
  const raw = JSON.stringify([direct, { id: "h-2", name: "VPS", kind: "server", url: "wss://vps.example.com", token: "t" }]);
  assert.deepEqual(loadMachines(raw), JSON.parse(raw));
});

test("loadMachines reads a mixed list and drops a broken paired entry", () => {
  const raw = JSON.stringify([direct, paired, { ...paired, id: "h-3", name: "Bad", hostEndpointId: "nope" }]);
  assert.deepEqual(loadMachines(raw), [direct, paired]);
  assert.deepEqual(loadMachines(saveMachines(loadMachines(raw))), [direct, paired]);
});

test("a paired machine edits its name and id but keeps how it's reached", () => {
  const list = editMachine([direct, paired], "h-1", { ...paired, name: "VPS", id: "h-9", hostEndpointId: "c".repeat(64) });
  assert.deepEqual(list[1], { ...paired, name: "VPS", id: "h-9" });
});

test("a paired Mac still has to use the id local", () => {
  assert.throws(() => addMachine([], { ...paired, kind: "mac", id: "h-1" }), /local/);
});

test("the camera and paste go through the same parser", () => {
  const preview = parsePairingLink(`  ${link()}\n`, now);
  assert.deepEqual(preview, { name: "Tyler's Mac Studio", host: HOST, addrs: ["192.168.1.20:41641"], exp: now + 300 });
});

test("a link naming another relay is refused", () => {
  assert.throws(() => parsePairingLink(link({ relay: "https://evil.example/" }), now), { message: "This code isn't from Apex Deck." });
});

test("things that aren't our links are refused the same way", () => {
  for (const text of ["https://example.com", "apexdeck://pair?p=!!!", link({ v: 2 }), link({ host: "XYZ" }), link({ addrs: "x" })]) {
    assert.throws(() => parsePairingLink(text, now), { message: "This code isn't from Apex Deck." }, text);
  }
});

test("an expired code says so", () => {
  assert.throws(() => parsePairingLink(link({ exp: now - 600 }), now), /expired/);
  // Within the two-minute skew it still reads.
  assert.ok(parsePairingLink(link({ exp: now - 60 }), now));
});

test("canSeeNewThread: only Full, or a WebSocket pair with no access", () => {
  assert.equal(canSeeNewThread({ tier: "chat", threads: "all" }), false);
  assert.equal(canSeeNewThread({ tier: "read_only", threads: "all" }), false);
  assert.equal(canSeeNewThread({ tier: "full", threads: "all" }), true);
  assert.equal(canSeeNewThread(null), true);
});

test("hello.addrs replaces the saved hints", () => {
  assert.deepEqual(withHints(paired, ["myhome.ddns.net:41641"]).addrs, ["myhome.ddns.net:41641"]);
  assert.equal(withHints(paired, ["203.0.113.7:41641"]), paired, "unchanged list keeps the same object");
  assert.equal(withHints(paired, undefined), paired);
  assert.equal(withHints(paired, [1]), paired);
});

class FakePlugin {
  router = new EventRouter();
  next = 1;
  cancelled = [];
  answer = null;
  async pair() { if (this.answer) await this.answer; return this.next++; }
  async pairCancel(handle) { this.cancelled.push(handle); this.emit({ type: "closed", handle, code: 1000, reason: "closed" }); }
  listen(handle, cb) { return this.router.listen(handle, cb); }
  emit(event) { this.router.deliver(event); }
}

test("the pairing screen shows the code from pairCode, then done after the machine approves", async () => {
  const plugin = new FakePlugin();
  const states = [];
  startPairing(plugin, link(), "iPhone", (state) => states.push(state));
  await tick();
  plugin.emit({ type: "pairCode", handle: 1, code: "123 456", hostName: "Tyler's Mac Studio" });
  plugin.emit({ type: "pairDone", handle: 1, hostEndpointId: HOST, addrs: ["192.168.1.20:41641"], name: "Mac", hostName: "Tyler's Mac Studio", tier: "chat", threads: "all" });
  plugin.emit({ type: "closed", handle: 1, code: 0, reason: "bye" });
  assert.deepEqual(states, [
    { kind: "dialing" },
    { kind: "code", code: "123 456", hostName: "Tyler's Mac Studio" },
    { kind: "done", paired: { hostEndpointId: HOST, addrs: ["192.168.1.20:41641"], name: "Tyler's Mac Studio", tier: "chat" } },
  ]);
});

test("a closed for an old pairing handle doesn't touch the current attempt", async () => {
  const plugin = new FakePlugin();
  const first = [];
  const attempt = startPairing(plugin, link(), "iPhone", (state) => first.push(state));
  await tick();
  attempt.cancel();
  const second = [];
  startPairing(plugin, link(), "iPhone", (state) => second.push(state));
  await tick();
  plugin.emit({ type: "closed", handle: 1, code: 14, reason: "denied" });
  plugin.emit({ type: "pairCode", handle: 2, code: "654 321", hostName: "Mac" });
  assert.deepEqual(second.map((state) => state.kind), ["dialing", "code"]);
  assert.deepEqual(first.map((state) => state.kind), ["dialing"]);
});

test("Deny, expiry and a used code each say what happened", async () => {
  for (const [code, words] of [[14, /denied/], [11, /expired/], [12, /already used/], [1003, /different machine/]]) {
    const plugin = new FakePlugin();
    const states = [];
    startPairing(plugin, link(), "iPhone", (state) => states.push(state));
    await tick();
    plugin.emit({ type: "closed", handle: 1, code, reason: "x" });
    assert.equal(states.at(-1).kind, "failed");
    assert.match(states.at(-1).message, words);
  }
});

test("cancel before the native call answers still cancels that handle", async () => {
  const plugin = new FakePlugin();
  let release;
  plugin.answer = new Promise((resolve) => { release = resolve; });
  const states = [];
  const attempt = startPairing(plugin, link(), "iPhone", (state) => states.push(state));
  attempt.cancel();
  release();
  await tick();
  await tick();
  assert.deepEqual(plugin.cancelled, [1]);
  assert.deepEqual(states.map((state) => state.kind), ["dialing"]);
});

test("a drop after the machine's ok still counts as paired", async () => {
  const plugin = new FakePlugin();
  const states = [];
  startPairing(plugin, link(), "iPhone", (state) => states.push(state));
  await tick();
  plugin.emit({ type: "pairDone", handle: 1, hostEndpointId: HOST, addrs: [], name: "Mac", tier: "full" });
  plugin.emit({ type: "closed", handle: 1, code: 1005, reason: "lost" });
  assert.equal(states.at(-1).kind, "done");
});

test("a handle whose early events overflow is closed and its subscriber hears why", () => {
  const overflowed = [];
  const router = new EventRouter((handle) => overflowed.push(handle));
  for (let i = 0; i < 65; i++) router.deliver({ type: "line", handle: 3, line: `l${i}` });
  assert.deepEqual(overflowed, [3]);
  router.deliver({ type: "line", handle: 3, line: "after" });
  const got = [];
  router.listen(3, (event) => got.push(event));
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "closed");
  assert.equal(got[0].code, 1001);
});

test("a handle that finds the early table full is closed, not silently dropped", () => {
  const overflowed = [];
  const router = new EventRouter((handle) => overflowed.push(handle));
  for (let h = 1; h <= 33; h++) router.deliver({ type: "opened", handle: h });
  assert.deepEqual(overflowed, [33]);
  const got = [];
  router.listen(33, (event) => got.push(event));
  assert.deepEqual(got.map((e) => [e.type, e.code]), [["closed", 1001]]);
  // Handles that fit still get their events.
  const first = [];
  router.listen(1, (event) => first.push(event.type));
  assert.deepEqual(first, ["opened"]);
});
