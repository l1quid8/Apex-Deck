import test from "node:test";
import assert from "node:assert/strict";
import { devicesApi, lastSeenText, shortId } from "../src/pairedDevices.ts";

test("the API sends the daemon's local-only device commands", async () => {
  const sent = [];
  const api = devicesApi({ call: async (cmd, args) => { sent.push([cmd, args]); return cmd === "devices_list" ? { version: 1, devices: [], revoked: [] } : null; } });
  assert.equal("setTier" in api, false);
  assert.deepEqual(await api.list(), { version: 1, devices: [], revoked: [] });
  await api.revoke("ab");
  assert.deepEqual(sent, [["devices_list", {}], ["devices_revoke", { id: "ab" }]]);
});

test("last seen and IDs read simply", () => {
  const now = Date.UTC(2026, 9, 7, 12, 0);
  assert.equal(lastSeenText(null, now), "Never connected");
  assert.equal(lastSeenText(now - 30_000, now), "Seen just now");
  assert.equal(lastSeenText(now - 5 * 60_000, now), "Seen 5 min ago");
  assert.equal(lastSeenText(now - 3 * 3_600_000, now), "Seen 3 h ago");
  assert.equal(lastSeenText(now - 2 * 86_400_000, now), "Seen 2 days ago");
  assert.equal(shortId("4b5c4350dfc4453debd81318209365cb1d2053b34e6444d23c85347841a34c95"), "4b5c4350…4c95");
});
