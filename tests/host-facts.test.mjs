import test from "node:test";
import assert from "node:assert/strict";
import { dotState, helperNotice, buildNotice, reachNotice, classifyIdentity, hostLine } from "../src/hostFacts.ts";
import { hostConnectionStore } from "../src/hostConnections.ts";

test("a server's dot: green connected, amber on its way, gray offline, hollow before first use", () => {
  assert.deepEqual([{ kind: "connected", hostId: "x" }, { kind: "connecting" }, { kind: "resync" }, { kind: "reconnecting", attempt: 1, reason: "", retryAt: 0 }, { kind: "failed", reason: "" }, { kind: "idle" }].map(dotState),
    ["on", "wait", "wait", "off", "off", "idle"]);
});

test("the card names an old helper without offering a restart", () => {
  assert.equal(helperNotice("AT", "0.5.1", "0.5.1"), null);
  assert.equal(helperNotice("AT", "0.5.1", undefined), null);
  assert.match(helperNotice("AT", "0.5.1", "0.5.0"), /AT runs apex-daemon 0\.5\.0; this app is 0\.5\.1/);
  assert.match(helperNotice("AT", "0.5.1", null), /older than this app \(0\.5\.1\)/);
  assert.doesNotMatch(helperNotice("AT", "0.5.1", null), /Restart/);
});

test("a service on a different build than the app gets a warning; a matching one doesn't", () => {
  const app = { commit: "fd13c103931e", dirty: false };
  assert.equal(buildNotice("VPS", app, { commit: "fd13c103931e", dirty: false }), null);
  assert.equal(buildNotice("VPS", app, undefined), null, "nothing before the service answers");
  assert.match(buildNotice("VPS", app, { commit: "0754cb82d102", dirty: false }), /VPS's service is build 0754cb82d102; this app is build fd13c103931e/);
  assert.match(buildNotice("VPS", app, { commit: "0754cb82d102", dirty: true }), /build 0754cb82d102-dirty/);
  assert.match(buildNotice("VPS", app, null), /VPS's service is older than build IDs/);
  assert.match(buildNotice("VPS", app, { commit: "unknown", dirty: false }), /doesn't know which build it is/);
  // A dev app with no git can't compare, so it stays quiet rather than crying wolf.
  assert.equal(buildNotice("VPS", { commit: "unknown", dirty: false }, { commit: "0754cb82d102", dirty: false }), null);
});

test("the store keeps the service's build next to its version", () => {
  const store = hostConnectionStore("at", "AT");
  assert.equal(store.get().build, undefined);
  store.setHelper("0.5.1", { commit: "fd13c103931e", dirty: false });
  assert.deepEqual(store.get().build, { commit: "fd13c103931e", dirty: false });
  store.setHelper("0.5.1", null);
  assert.equal(store.get().build, null);
});

test("an unreachable server says when it was last reached, and offers Retry", () => {
  const time = () => "7:02 AM";
  assert.deepEqual(reachNotice("Staging", { kind: "failed", reason: "x" }, 1, time), { tone: "bad", text: "Can't reach Staging. Last reached at 7:02 AM.", action: "retry" });
  assert.deepEqual(reachNotice("Staging", { kind: "reconnecting", attempt: 2, reason: "x", retryAt: 0 }, undefined, time), { tone: "bad", text: "Can't reach Staging.", action: "retry" });
  assert.deepEqual(reachNotice("AT", { kind: "idle" }, undefined, time), { tone: "warn", text: "Not connected yet. Deck connects when one of its threads opens.", action: "connect" });
  assert.deepEqual(reachNotice("AT", { kind: "connecting" }, undefined, time), { tone: "warn", text: "Connecting to AT…", action: null });
  assert.equal(reachNotice("AT", { kind: "connected", hostId: "d" }, 1, time), null);
});

test("a probed identity is the same machine, a new one, or one Deck already has", () => {
  const hosts = [{ id: "local", name: "This Mac", remote: false }, { id: "at", name: "AT", remote: true, daemonHostId: "d-at" }, { id: "hz", name: "HZ", remote: true }];
  assert.deepEqual(classifyIdentity(hosts, "at", "d-at"), { kind: "same" });
  assert.deepEqual(classifyIdentity(hosts, "at", "d-new"), { kind: "different" });
  assert.deepEqual(classifyIdentity(hosts, "hz", "d-new"), { kind: "bind" });
  assert.deepEqual(classifyIdentity(hosts, "hz", "d-at"), { kind: "known", name: "AT" });
  assert.deepEqual(classifyIdentity(hosts, null, "d-new"), { kind: "new" });
  assert.deepEqual(classifyIdentity(hosts, null, "d-at"), { kind: "known", name: "AT" });
});

test("the store remembers the helper version and when the host was last reached", () => {
  const store = hostConnectionStore("at", "AT");
  assert.equal(store.get().seenAt, undefined);
  store.setHelper("0.5.0");
  store.setStatus({ kind: "connected", hostId: "d" });
  assert.equal(store.get().helper, "0.5.0");
  assert.equal(typeof store.get().seenAt, "number");
  const seen = store.get().seenAt;
  store.setStatus({ kind: "reconnecting", attempt: 1, reason: "x", retryAt: 0 });
  assert.equal(store.get().seenAt, seen, "a drop keeps the last time it was reached");
  let heard = 0; store.subscribe(() => heard++);
  store.rename("Apex");
  assert.equal(store.get().name, "Apex");
  assert.equal(heard, 1);
});

const app = { version: "0.7.0", build: { commit: "aaa", dirty: false } };
const at = () => "7:02 AM";
const conn = (status, extra = {}) => ({ hostId: "h", name: "AT", status, revision: 0, agents: [], discovery: "idle", ...extra });

test("hostLine: no store is idle, never connected", () => {
  const line = hostLine("AT", null, app, at);
  assert.equal(line.dot, "idle");
  assert.equal(line.action, "connect");
  assert.doesNotMatch(line.text, /^Connected/);
});

test("hostLine: idle, connecting and resync use the sidebar's words", () => {
  assert.deepEqual(hostLine("AT", conn({ kind: "idle" }), app, at), { dot: "idle", text: "Not connected yet. Deck connects when one of its threads opens.", tone: "warn", why: null, notice: null, action: "connect" });
  assert.deepEqual(hostLine("AT", conn({ kind: "connecting" }), app, at), { dot: "wait", text: "Connecting to AT…", tone: "warn", why: null, notice: null, action: null });
  assert.deepEqual(hostLine("AT", conn({ kind: "resync" }), app, at), { dot: "wait", text: "Catching up with AT…", tone: "warn", why: null, notice: null, action: null });
});

test("hostLine: reconnecting and failed carry the raw reason and offer Retry", () => {
  const re = hostLine("AT", conn({ kind: "reconnecting", attempt: 1, reason: "timed out", retryAt: 0 }, { seenAt: 1 }), app, at);
  assert.deepEqual(re, { dot: "off", text: "Can't reach AT. Last reached at 7:02 AM.", tone: "bad", why: "timed out", notice: null, action: "retry" });
  const failed = hostLine("AT", conn({ kind: "failed", reason: "no route" }), app, at);
  assert.equal(failed.why, "no route");
  assert.equal(failed.action, "retry");
});

test("hostLine: connected, with and without a helper version, and with an old helper", () => {
  const ok = { kind: "connected", hostId: "d" };
  assert.deepEqual(hostLine("AT", conn(ok, { helper: "0.7.0", build: { commit: "aaa", dirty: false } }), app, at), { dot: "on", text: "Connected · apex-daemon 0.7.0", tone: "plain", why: null, notice: null, action: null });
  assert.equal(hostLine("AT", conn(ok), app, at).text, "Connected");
  assert.equal(hostLine("AT", conn(ok, { helper: null }), app, at).text, "Connected");
  const old = hostLine("AT", conn(ok, { helper: "0.5.0", build: { commit: "aaa", dirty: false } }), app, at);
  assert.match(old.notice, /AT runs apex-daemon 0\.5\.0; this app is 0\.7\.0/);
  assert.equal(old.tone, "plain");
});
