import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonClient } from "../src/daemon/client.ts";
import { irohConnect } from "../src/daemon/irohLink.ts";
import { EventRouter } from "../src/phone/remotePlugin.ts";

const HOST = "a".repeat(64);
const target = () => ({ hostEndpointId: HOST, addrs: ["203.0.113.7:41641"] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The native plugin, faked: handles from one counter, events through a real EventRouter. */
class FakePlugin {
  router = new EventRouter();
  next = 1;
  sent = [];
  closed = [];
  dials = 0;
  async connect() { this.dials += 1; return this.next++; }
  async send(handle, line) { this.sent.push({ handle, line }); }
  async close(handle) { this.closed.push(handle); this.emit({ type: "closed", handle, code: 1000, reason: "closed" }); }
  listen(handle, cb) { return this.router.listen(handle, cb); }
  emit(event) { this.router.deliver(event); }
}

/** Timers the test moves by hand, so no retry can hide. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    now: () => 0,
  };
}

test("irohConnect resolves a Link that round-trips lines", async () => {
  const plugin = new FakePlugin();
  const opening = irohConnect(target, plugin, () => "automatic")();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  const link = await opening;
  const got = [];
  link.onLine((line) => got.push(line));
  link.send("{\"id\":1}");
  await tick();
  assert.deepEqual(plugin.sent, [{ handle: 1, line: "{\"id\":1}" }]);
  plugin.emit({ type: "line", handle: 1, line: "{\"id\":1,\"ok\":{}}" });
  assert.deepEqual(got, ["{\"id\":1,\"ok\":{}}"]);
});

test("a line that arrives before onLine is held, not lost", async () => {
  const plugin = new FakePlugin();
  const opening = irohConnect(target, plugin, () => "automatic")();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  plugin.emit({ type: "line", handle: 1, line: "early" });
  const link = await opening;
  const got = [];
  link.onLine((line) => got.push(line));
  assert.deepEqual(got, ["early"]);
});

test("events that come before the subscriber are replayed to it, closed included", { timeout: 2000 }, async () => {
  const plugin = new FakePlugin();
  plugin.connect = async () => {
    // Native events can beat the call's answer back to JavaScript.
    plugin.emit({ type: "closed", handle: 7, code: 1002, reason: "dial failed" });
    return 7;
  };
  await assert.rejects(irohConnect(target, plugin, () => "automatic")(), /Can't reach this machine/);
});

test("closed after open calls onClose with the reason", async () => {
  const plugin = new FakePlugin();
  const opening = irohConnect(target, plugin, () => "automatic")();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  const link = await opening;
  let heard = null;
  link.onClose((reason, final) => { heard = { reason, final }; });
  plugin.emit({ type: "closed", handle: 1, code: 1005, reason: "connection lost" });
  assert.deepEqual(heard, { reason: "connection lost", final: false });
});

test("an old handle's events never reach the newer link", async () => {
  const plugin = new FakePlugin();
  const connect = irohConnect(target, plugin, () => "automatic");
  const first = connect();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  (await first).close();
  const second = connect();
  await tick();
  plugin.emit({ type: "opened", handle: 2 });
  const link = await second;
  const got = [];
  link.onLine((line) => got.push(line));
  plugin.emit({ type: "line", handle: 1, line: "late" });
  plugin.emit({ type: "line", handle: 2, line: "current" });
  assert.deepEqual(got, ["current"]);
});

test("route events report Direct or Relayed, and nothing once closed", async () => {
  const plugin = new FakePlugin();
  const routes = [];
  const opening = irohConnect(target, plugin, () => "automatic", (route) => routes.push(route))();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  plugin.emit({ type: "route", handle: 1, route: "relayed" });
  plugin.emit({ type: "route", handle: 1, route: "direct" });
  await opening;
  plugin.emit({ type: "closed", handle: 1, code: 1005, reason: "lost" });
  assert.deepEqual(routes, ["relayed", "direct", null]);
});

for (const [code, name] of [[2, "REVOKED"], [1, "NOT_PAIRED"]]) {
  test(`revoked_close_stops_retrying: close code ${code} (${name})`, async () => {
    const plugin = new FakePlugin();
    const timers = fakeTimers();
    const client = new DaemonClient(irohConnect(target, plugin, () => "automatic"), { timers });
    const statuses = [];
    client.onStatus((status) => statuses.push(status));
    void client.start();
    await tick();
    plugin.emit({ type: "opened", handle: 1 });
    await tick();
    plugin.emit({ type: "closed", handle: 1, code, reason: name.toLowerCase() });
    await tick();
    const last = statuses.at(-1);
    assert.equal(last.kind, "failed");
    assert.equal(last.reason, "Access removed — pair again on this machine");
    assert.equal(timers.pending.size, 0, "no retry timer");
    assert.equal(plugin.dials, 1);
  });
}

test("a revoke during connect also stops without a retry", async () => {
  const plugin = new FakePlugin();
  const timers = fakeTimers();
  const client = new DaemonClient(irohConnect(target, plugin, () => "automatic"), { timers });
  const statuses = [];
  client.onStatus((status) => statuses.push(status));
  void client.start();
  await tick();
  plugin.emit({ type: "closed", handle: 1, code: 2, reason: "revoked" });
  await tick();
  assert.equal(statuses.at(-1).kind, "failed");
  assert.equal(timers.pending.size, 0);
});

test("Direct only that can't connect says so and backs off at the normal pace", async () => {
  const plugin = new FakePlugin();
  const timers = fakeTimers();
  const client = new DaemonClient(irohConnect(target, plugin, () => "direct"), { timers });
  const statuses = [];
  client.onStatus((status) => statuses.push(status));
  void client.start();
  await tick();
  plugin.emit({ type: "closed", handle: 1, code: 1002, reason: "timed out" });
  await tick();
  const last = statuses.at(-1);
  assert.equal(last.kind, "reconnecting");
  assert.match(last.reason, /^Direct connection blocked/);
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [1000]);
  // The second failure waits longer, not shorter.
  [...timers.pending.values()][0].fn();
  timers.pending.clear();
  await tick();
  plugin.emit({ type: "closed", handle: 2, code: 1002, reason: "timed out" });
  await tick();
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [2000]);
});

test("a send the plugin refuses closes the link so the client reconnects", async () => {
  const plugin = new FakePlugin();
  plugin.send = async () => { throw new Error("busy"); };
  const opening = irohConnect(target, plugin, () => "automatic")();
  await tick();
  plugin.emit({ type: "opened", handle: 1 });
  const link = await opening;
  link.send("x");
  await tick();
  assert.deepEqual(plugin.closed, [1]);
});

test("each dial reads the newest saved addresses", async () => {
  const plugin = new FakePlugin();
  const asked = [];
  plugin.connect = async (host, addrs) => { asked.push(addrs); return plugin.next++; };
  let addrs = ["old:1"];
  const connect = irohConnect(() => ({ hostEndpointId: HOST, addrs }), plugin, () => "automatic");
  void connect().catch(() => {});
  await tick();
  addrs = ["new:2"];
  void connect().catch(() => {});
  await tick();
  assert.deepEqual(asked, [["old:1"], ["new:2"]]);
});
