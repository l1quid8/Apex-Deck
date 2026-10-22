import { test } from "node:test";
import assert from "node:assert/strict";
import { ALREADY_PAIRING, createPairingGate, listenerFailure, openIncomingLinks, reserveLocal, routePairingLink, shouldAutoScan } from "../src/phone/incomingLinks.ts";
import { RELAY } from "../src/phone/pairing.ts";

const HOST = "ab".repeat(32);
const now = 1_800_000_000;

function link(fields = {}) {
  const wire = { v: 1, host: HOST, name: "Tyler's Mac Studio", relay: RELAY, addrs: ["192.168.1.20:41641"], inv: "BwcHBwcHBwcHBwcHBwcHBw", secret: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk", exp: now + 300, ...fields };
  return `apexdeck://pair?p=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
}

const OTHER = link({ host: "cd".repeat(32), name: "Other Mac" });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeApp() {
  let listener = null;
  let launch = Promise.resolve(undefined);
  const calls = [];
  const app = {
    calls,
    listener: () => listener,
    holdLaunch() {
      let resolve;
      launch = new Promise((r) => { resolve = r; });
      return resolve;
    },
    setLaunch(value) { launch = Promise.resolve(value); },
    emit(url) { listener?.({ url }); },
    addListener(event, cb) {
      calls.push(["listen", event]);
      listener = cb;
      return Promise.resolve({ async remove() { if (listener === cb) listener = null; } });
    },
    getLaunchUrl() {
      calls.push("launch");
      return launch;
    },
  };
  return app;
}

function session(app, deliver) {
  const refused = [];
  const invalid = [];
  const started = [];
  const opened = openIncomingLinks(app, async (url) => {
    started.push(url);
    return deliver(url);
  }, {
    refuse: (message) => refused.push(message),
    invalid: (message) => invalid.push(message),
  });
  return { ...opened, refused, invalid, started };
}

test("the warm listener is registered before getLaunchUrl is awaited", () => {
  const app = fakeApp();
  app.holdLaunch();
  openIncomingLinks(app, async () => "cancelled", { refuse() {}, invalid() {} });
  assert.deepEqual(app.calls, [["listen", "appUrlOpen"], "launch"]);
});

test("a cold-start link keeps the scanner closed and starts pairing", async () => {
  const app = fakeApp();
  const url = link();
  app.setLaunch({ url });
  const run = session(app, async () => "paired");
  const launch = await run.launch;
  await flush();
  assert.equal(launch, url);
  assert.equal(shouldAutoScan(launch, 0, true), false);
  assert.deepEqual(run.started, [url]);
});

test("with no launch link the camera still opens when nothing is paired", async () => {
  const app = fakeApp();
  const run = session(app, async () => "cancelled");
  assert.equal(await run.launch, null);
  assert.equal(shouldAutoScan(null, 0, true), true);
  assert.equal(shouldAutoScan(null, 2, true), false);
  assert.equal(shouldAutoScan(null, 0, false), false);
});

test("a warm link from Threads or Settings opens Add a machine as a Mac", async () => {
  for (const from of ["threads", "settings"]) {
    const app = fakeApp();
    let screen = { tab: from, kind: "server", adding: false };
    openIncomingLinks(app, async (url) => {
      assert.equal(url, link());
      screen = { ...screen, ...routePairingLink() };
      return "cancelled";
    }, { refuse() {}, invalid() {} });
    app.emit(link());
    await flush();
    assert.deepEqual(screen, { tab: "machines", kind: "mac", adding: true });
  }
});

test("the same cold-start link from both sources pairs once", async () => {
  const app = fakeApp();
  const url = link();
  const release = app.holdLaunch();
  const run = session(app, async () => "paired");
  app.emit(url);
  release({ url });
  await run.launch;
  await flush();
  assert.deepEqual(run.started, [url]);
  assert.deepEqual(run.refused, []);
});

test("a link delivered during startup, before getLaunchUrl resolves, is handled", async () => {
  const app = fakeApp();
  const url = link();
  const release = app.holdLaunch();
  let finish;
  const run = session(app, () => new Promise((resolve) => { finish = resolve; }));
  assert.deepEqual(app.calls, [["listen", "appUrlOpen"], "launch"]);
  app.emit(url);
  await flush();
  assert.deepEqual(run.started, [url]);
  release({ url });
  assert.equal(await run.launch, url);
  await flush();
  assert.deepEqual(run.started, [url]);
  assert.equal(shouldAutoScan(url, 0, true), false);
  finish("cancelled");
});

test("cancel, then the same link, starts a new attempt", async () => {
  const app = fakeApp();
  const url = link();
  const run = session(app, async () => "cancelled");
  app.emit(url);
  await flush();
  app.emit(url);
  await flush();
  assert.deepEqual(run.started, [url, url]);
});

test("a temporary connection failure, then the same link, works", async () => {
  const app = fakeApp();
  const url = link();
  const run = session(app, async () => "failed");
  app.emit(url);
  await flush();
  app.emit(url);
  await flush();
  assert.deepEqual(run.started, [url, url]);
  assert.deepEqual(run.refused, []);
});

test("a second link while pairing is refused", async () => {
  const app = fakeApp();
  const url = link();
  let release;
  const run = session(app, () => new Promise((resolve) => { release = resolve; }));
  app.emit(url);
  app.emit(OTHER);
  assert.deepEqual(run.started, [url]);
  assert.deepEqual(run.refused, [ALREADY_PAIRING]);
  release("cancelled");
  await flush();
  app.emit(OTHER);
  await flush();
  assert.deepEqual(run.started, [url, OTHER]);
});

test("a link that paired is ignored for the rest of the session", async () => {
  const app = fakeApp();
  const url = link();
  const run = session(app, async () => "paired");
  app.emit(url);
  await flush();
  app.emit(url);
  await flush();
  assert.deepEqual(run.started, [url]);
  assert.deepEqual(run.refused, []);
});

test("a malformed link uses the existing not-ours words and does not start pairing", async () => {
  const app = fakeApp();
  const run = session(app, async () => "paired");
  app.emit("https://example.com");
  await flush();
  assert.deepEqual(run.invalid, ["This code isn't from Apex Deck."]);
  assert.deepEqual(run.started, []);
  app.emit(link());
  await flush();
  assert.deepEqual(run.started, [link()]);
});

test("camera and links share one gate, in both directions", async () => {
  const app = fakeApp();
  const refused = [];
  const gate = createPairingGate((message) => refused.push(message));
  const started = [];
  let release;
  const opened = openIncomingLinks(app, (url) => {
    started.push(url);
    return new Promise((resolve) => { release = resolve; });
  }, { refuse() { refused.push("from hooks"); }, invalid() {}, broken() {} }, gate);
  const scanned = link();
  assert.equal(reserveLocal(gate, scanned), true);
  app.emit(OTHER);
  await flush();
  assert.deepEqual(started, [], "a link during a camera attempt does not start");
  assert.deepEqual(refused, [ALREADY_PAIRING]);
  gate.release(scanned, "cancelled");
  app.emit(OTHER);
  await flush();
  assert.deepEqual(started, [OTHER]);
  const pasted = link({ name: "Pasted Mac" });
  assert.equal(reserveLocal(gate, pasted), false, "paste during a link attempt does not take the slot");
  assert.deepEqual(refused, [ALREADY_PAIRING, ALREADY_PAIRING]);
  assert.deepEqual(started, [OTHER]);
  release("cancelled");
  await flush();
  assert.equal(reserveLocal(gate, pasted), true);
  opened.close();
});

test("a listener that fails to register is reported, and the launch link is still read", async () => {
  const refused = [];
  const broken = [];
  const hooks = { refuse() {}, invalid() {}, broken(message) { broken.push(message); } };
  const sync = fakeApp();
  sync.addListener = () => { throw new Error("no bridge"); };
  openIncomingLinks(sync, async () => "cancelled", hooks);
  assert.deepEqual(sync.calls, ["launch"]);
  assert.deepEqual(broken, [listenerFailure(new Error("no bridge"))]);

  const asyncApp = fakeApp();
  asyncApp.addListener = () => Promise.reject(new Error("bridge missing"));
  openIncomingLinks(asyncApp, async () => "cancelled", {
    refuse(message) { refused.push(message); },
    invalid() {},
    broken(message) { broken.push(message); },
  });
  await flush();
  assert.deepEqual(broken, [
    "Pairing links aren't being received: no bridge",
    "Pairing links aren't being received: bridge missing",
  ]);
  assert.deepEqual(refused, []);
});

test("an expired link uses the existing expired words", async () => {
  const app = fakeApp();
  const run = session(app, async () => "paired");
  app.emit(link({ exp: Math.floor(Date.now() / 1000) - 600 }));
  await flush();
  assert.deepEqual(run.invalid, ["This code has expired. Press Pair phone on the machine for a new one."]);
  assert.deepEqual(run.started, []);
});
