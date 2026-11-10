import test from "node:test";
import assert from "node:assert/strict";
import { applyNowFirst } from "../src/accessChange.ts";

test("Apply now leads when access goes down, and waits when it goes up", () => {
  assert.equal(applyNowFirst("full", "read"), true);
  assert.equal(applyNowFirst("edits", "ask"), true);
  assert.equal(applyNowFirst("read", "full"), false);
  assert.equal(applyNowFirst("ask", "edits"), false);
});

import { saveQueue } from "../src/accessChange.ts";

test("Apply now waits for the Access save before restarting the bot", async () => {
  const queue = saveQueue();
  let finishSave;
  queue.track(new Promise((resolve) => { finishSave = resolve; }));
  const order = [];
  const applied = queue.afterSaves(async () => { order.push("restart"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, [], "restarted before the save landed");
  order.push("saved");
  finishSave();
  assert.equal(await applied, true);
  assert.deepEqual(order, ["saved", "restart"]);
});

test("Apply now waits for every save in flight, not just the newest", async () => {
  const queue = saveQueue();
  let finishFirst;
  queue.track(new Promise((resolve) => { finishFirst = resolve; }));
  queue.track(Promise.resolve());
  let restarted = false;
  const applied = queue.afterSaves(async () => { restarted = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(restarted, false);
  finishFirst();
  assert.equal(await applied, true);
  assert.equal(restarted, true);
});

test("Apply now doesn't restart when the Access save failed", async () => {
  const queue = saveQueue();
  queue.track(Promise.reject(new Error("offline")));
  let restarted = false;
  assert.equal(await queue.afterSaves(async () => { restarted = true; }), false);
  assert.equal(restarted, false);
  // A later save that works clears the failure.
  queue.track(Promise.resolve());
  assert.equal(await queue.afterSaves(async () => { restarted = true; }), true);
  assert.equal(restarted, true);
});
