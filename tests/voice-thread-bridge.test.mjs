import { test } from "node:test";
import assert from "node:assert/strict";
import { createThreadVoiceBridge } from "../src/voice/threadBridge.ts";
import { ParticipantQueues } from "../src/turnQueue.ts";
test("explicit queue preserves metadata and does not use group target resolution", async () => {
  const posted = [];
  let targets = 0;
  const q = new ParticipantQueues(
    async () => {
      targets++;
      return ["wrong"];
    },
    async (...args) => posted.push(args),
    async () => {},
    () => {},
  );
  await q.sendTo("hello", ["null"], { requestId: "v1" });
  assert.equal(targets, 0);
  assert.equal(posted[0][4].requestId, "v1");
});
test("bridge speaks only matching correlated events and ignores replays", async () => {
  let listener;
  const seen = [];
  let submitted;
  const backend = {
    voiceCapabilities: async () => ({ voice_turn_correlation_v1: true }),
    onRoomEvent: async (cb) => {
      listener = cb;
      return () => {};
    },
    roomStopRequest: async () => "already-ended",
  };
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const bridge = createThreadVoiceBridge({
    backend,
    scope,
    enqueue: async (turn) => {
      submitted = turn;
    },
    remove: () => false,
  });
  bridge.subscribe((e) => seen.push(e));
  await bridge.submit({
    scope,
    callId: "c",
    generation: 1,
    utteranceId: "u",
    requestId: "v",
    text: "hello",
  });
  listener("r", { type: "delta", id: "a", text: "unrelated" });
  const event = {
    type: "voice_event",
    id: "a",
    client_turn_id: "v",
    recovery_seq: 2,
    event: { type: "delta", id: "a", text: "Hi" },
  };
  listener("r", event);
  listener("r", event);
  assert.equal(seen.filter((e) => e.type === "text").length, 1);
  assert.equal(submitted.text, "hello");
  listener("r", {
    ...event,
    recovery_seq: 3,
    event: { type: "participant_idle", id: "a" },
  });
  assert.equal(seen.at(-1).type, "done");
});
test("older hosts fail closed", async () => {
  const b = createThreadVoiceBridge({
    backend: { onRoomEvent: async () => () => {} },
    scope: { hostId: "h", roomId: "r", participantId: "a" },
    enqueue: async () => {
      throw Error("must not dispatch");
    },
    remove: () => false,
  });
  await assert.rejects(
    b.submit({
      scope: { hostId: "h", roomId: "r", participantId: "a" },
      requestId: "x",
    }),
    /host/,
  );
});
test("cancel/dispose while capability awaits never queues after End", async () => {
  let resolve;
  const posted = [];
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const bridge = createThreadVoiceBridge({
    backend: {
      voiceCapabilities: () => new Promise((r) => (resolve = r)),
      onRoomEvent: async () => () => {},
      roomStopRequest: async () => "mismatch",
    },
    scope,
    enqueue: async (t) => posted.push(t),
    remove: () => false,
  });
  const pending = bridge.submit({
    scope,
    requestId: "late",
    text: "after end",
  });
  const cancel = bridge.cancel("late");
  bridge.dispose();
  resolve({ voice_turn_correlation_v1: true });
  await pending.catch(() => {});
  await cancel;
  assert.deepEqual(posted, []);
});
test("recipient identity ignores picker display metadata and property order", async () => {
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  let sent = 0;
  const bridge = createThreadVoiceBridge({
    backend: {
      voiceCapabilities: async () => ({ voice_turn_correlation_v1: true }),
      onRoomEvent: async () => () => {},
    },
    scope,
    enqueue: async () => sent++,
    remove: () => false,
  });
  await bridge.submit({
    scope: { name: "Agent", participantId: "a", roomId: "r", hostId: "h" },
    requestId: "metadata",
    text: "hello",
  });
  assert.equal(sent, 1);
});
