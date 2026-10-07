import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, devicesApi, lastSeenText, shortId, threadsText } from "../src/pairedDevices.ts";

test("each tier says plainly what it lets a phone do, and Chat says bots can run code", () => {
  assert.deepEqual(TIERS.map((t) => t.id), ["read_only", "chat", "full"]);
  const chat = TIERS.find((t) => t.id === "chat");
  assert.match(chat.note, /bots/);
  assert.match(chat.note, /run code/);
  assert.match(chat.note, /threads you already set up/);
  assert.match(TIERS.find((t) => t.id === "full").note, /terminals/);
});

test("the API sends the daemon's local-only device commands", async () => {
  const sent = [];
  const api = devicesApi({ call: async (cmd, args) => { sent.push([cmd, args]); return cmd === "devices_list" ? { version: 1, devices: [], revoked: [] } : null; } });
  assert.deepEqual(await api.list(), { version: 1, devices: [], revoked: [] });
  await api.setTier("ab", "full");
  await api.revoke("ab");
  assert.deepEqual(sent, [["devices_list", {}], ["devices_set_tier", { id: "ab", tier: "full" }], ["devices_revoke", { id: "ab" }]]);
});

test("last seen, threads and IDs read simply", () => {
  const now = Date.UTC(2026, 9, 7, 12, 0);
  assert.equal(lastSeenText(null, now), "Never connected");
  assert.equal(lastSeenText(now - 30_000, now), "Seen just now");
  assert.equal(lastSeenText(now - 5 * 60_000, now), "Seen 5 min ago");
  assert.equal(lastSeenText(now - 3 * 3_600_000, now), "Seen 3 h ago");
  assert.equal(lastSeenText(now - 2 * 86_400_000, now), "Seen 2 days ago");
  assert.equal(threadsText("all"), "All threads");
  assert.equal(threadsText(["a"]), "1 thread");
  assert.equal(threadsText(["a", "b"]), "2 threads");
  assert.equal(shortId("4b5c4350dfc4453debd81318209365cb1d2053b34e6444d23c85347841a34c95"), "4b5c4350…4c95");
});
