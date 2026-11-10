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

test("A pick made while Apply now waits is the one the bot restarts with", async () => {
  // Review case: pick Edit, tap Apply now, pick Read-only before the Edit save lands.
  const queue = saveQueue();
  let finishEdit, finishRead;
  const order = [];
  queue.track(new Promise((resolve) => { finishEdit = resolve; }).then(() => order.push("edit saved")));
  const applied = queue.afterSaves(async () => { order.push("restart"); });
  queue.track(new Promise((resolve) => { finishRead = resolve; }).then(() => order.push("read saved")));
  finishEdit();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["edit saved"], "restarted before the later Read-only save landed");
  finishRead();
  assert.equal(await applied, true);
  assert.deepEqual(order, ["edit saved", "read saved", "restart"]);
});

test("A failed pick made while Apply now waits stops the restart", async () => {
  const queue = saveQueue();
  let finishEdit;
  queue.track(new Promise((resolve) => { finishEdit = resolve; }));
  let restarted = false;
  const applied = queue.afterSaves(async () => { restarted = true; });
  queue.track(Promise.reject(new Error("offline")));
  finishEdit();
  assert.equal(await applied, false);
  assert.equal(restarted, false);
});

import { readFileSync } from "node:fs";

test("The phone's bot settings are locked while Apply now runs", () => {
  const source = readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('<fieldset className="ph-group ph-turn" disabled={Boolean(props.offline) || applying === "…"}'), "settings stay editable during Apply now");
});
