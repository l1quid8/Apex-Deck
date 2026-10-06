import test from "node:test";
import assert from "node:assert/strict";
import { dotState, helperNotice, reachNotice, classifyIdentity } from "../src/hostFacts.ts";
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
