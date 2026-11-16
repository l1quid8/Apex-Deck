import test from "node:test";
import assert from "node:assert/strict";
import { messagePinChange, ThreadPinActions } from "../src/thread/threadActions.ts";

test("a message toggles its own sequence while older plain pins keep their positions", () => {
  const pins = ["plain fact", "[Pinned response #2]\nsame", "[Pinned response #9]\nsame"];
  assert.deepEqual(messagePinChange(pins, 9, "same"), { kind: "unpin", index: 2 });
  assert.deepEqual(messagePinChange(pins, 5, "same"), { kind: "pin", seq: 5, text: "same" });
});

test("a pending change blocks a second index mutation and publishes the returned list before unlocking", async () => {
  const actions = new ThreadPinActions();
  const changes = [];
  const unsubscribe = actions.subscribe(() => changes.push(actions.isPending()));
  const calls = [];
  let finish;
  const backend = {
    roomPin(id, fact) {
      calls.push([id, fact]);
      return new Promise(resolve => { finish = resolve; });
    },
    async roomUnpin(id, index) { calls.push([id, index]); return []; },
  };
  const updated = [];
  const apply = pins => { assert.equal(actions.isPending(), true); updated.push(pins); };
  const pending = actions.apply(backend, "room-7", { kind: "pin", seq: 0, text: " full text " }, apply);
  await actions.apply(backend, "room-7", { kind: "unpin", index: 1 }, apply);
  assert.deepEqual(calls, [["room-7", "[Pinned response #0]\nfull text"]]);
  finish(["saved by host"]);
  await pending;
  assert.deepEqual(updated, [["saved by host"]]);
  assert.deepEqual(changes, [true, false]);
  unsubscribe();
  await actions.apply(backend, "room-7", { kind: "unpin", index: 0 }, apply);
  assert.deepEqual(calls[1], ["room-7", 0]);
  assert.deepEqual(changes, [true, false]);
});

test("host rejection preserves displayed pins and allows the next action", async () => {
  const actions = new ThreadPinActions();
  const failure = new Error("host offline");
  await assert.rejects(actions.apply({ roomUnpin: () => Promise.reject(failure) },
    "room", { kind: "unpin", index: 0 }, () => assert.fail("failed update")), failure);
  assert.equal(actions.isPending(), false);
  await actions.apply({ roomUnpin: async () => [] }, "room", { kind: "unpin", index: 0 },
    pins => assert.deepEqual(pins, []));
});
