import test from "node:test";
import assert from "node:assert/strict";
import { steerAsks, steerAnswer } from "../src/steerConfirm.ts";

test("a thread's choice wins over Settings", () => {
  assert.equal(steerAsks(true, "global"), true);
  assert.equal(steerAsks(false, "global"), false);
  assert.equal(steerAsks(false, "ask"), true);
  assert.equal(steerAsks(true, "never"), false);
});

test("each answer steers or not, and saves the right setting", () => {
  assert.deepEqual(steerAnswer("cancel"), { steer: false });
  assert.deepEqual(steerAnswer("once"), { steer: true });
  assert.deepEqual(steerAnswer("thread"), { steer: true, thread: "never" });
  assert.deepEqual(steerAnswer("always"), { steer: true, confirmSteer: false });
});
