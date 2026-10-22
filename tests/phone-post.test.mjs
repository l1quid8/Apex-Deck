import test from "node:test";
import assert from "node:assert/strict";
import { postFromPhone } from "../src/phone/phonePost.ts";
test("voice posts preserve correlation and prevent bot hops", async () => {
  const calls = [];
  await postFromPhone(
    { roomPostTo: async (...a) => calls.push(a) },
    "room",
    "hi",
    ["null"],
    { requestId: "v1" },
  );
  assert.deepEqual(calls, [
    [
      "room",
      "hi",
      ["null"],
      false,
      { client_turn_id: "v1", max_bot_hops: 0 },
    ],
  ]);
});
test("typed posts go to the chosen bots", async () => {
  const calls = [];
  await postFromPhone(
    { roomPostTo: async (...a) => calls.push(a) },
    "room",
    "hi",
    ["null"],
  );
  assert.deepEqual(calls, [["room", "hi", ["null"]]]);
});
