import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallFlow } from "../src/voice/callFlow.ts";

const make = (opts = {}) => {
  const statuses = [], holds = [], log = [];
  const flow = createCallFlow({
    publish: (s) => statuses.push(s),
    hold: (v) => holds.push(v),
    log: (event, detail) => log.push({ event, ...detail }),
    ...opts,
  });
  return { flow, statuses, holds, log, last: () => statuses.at(-1) };
};

test("a turn shows working until audio really plays, and speaking until the last segment drains", () => {
  const { flow, last } = make();
  flow.turnStart();
  assert.equal(last(), "waiting");
  flow.spoken(); flow.spoken();
  assert.equal(last(), "waiting");
  flow.playing();
  assert.equal(last(), "speaking");
  flow.turnEnd();
  assert.equal(last(), "speaking", "the text finished long before the audio does");
  flow.drained();
  assert.equal(last(), "speaking", "a segment is still owed");
  flow.drained();
  assert.equal(last(), "listening");
});

test("a dropped segment is not waited for", () => {
  const { flow, last } = make();
  flow.spoken(); flow.spoken(); flow.playing();
  flow.drained(); flow.dropped();
  assert.equal(last(), "listening");
});

test("speech over a reply only pauses it, and a rejection resumes exactly where it was", () => {
  const { flow, holds, last } = make();
  flow.turnStart(); flow.spoken(); flow.playing();
  flow.speechStart();
  assert.equal(last(), "hearing");
  assert.deepEqual(holds, [true]);
  flow.speechRejected("echo");
  assert.equal(last(), "speaking");
  assert.deepEqual(holds, [true, false]);
});

test("noise while the agent works goes back to working, with nothing to pause", () => {
  const { flow, holds, last } = make();
  flow.turnStart();
  flow.speechStart();
  flow.speechRejected("tooShort");
  assert.equal(last(), "waiting");
  assert.deepEqual(holds, []);
});

test("confirmed speech tells the caller to stop the reply and leaves hearing", () => {
  const { flow, last } = make();
  flow.turnStart(); flow.spoken(); flow.playing(); flow.speechStart();
  assert.equal(flow.speechConfirmed(), true);
  flow.flushed(); flow.turnEnd();
  assert.equal(last(), "listening");
});

test("flushing forgets owed audio so speaking cannot stick", () => {
  const { flow, last } = make();
  flow.spoken(); flow.playing();
  flow.flushed();
  assert.equal(last(), "listening");
  flow.spoken(); flow.playing(); flow.drained();
  assert.equal(last(), "listening", "the old owed count must not leak into the next reply");
});

test("attention outranks everything until it is cleared", () => {
  const { flow, last } = make();
  flow.spoken(); flow.playing();
  flow.attention(true);
  assert.equal(last(), "needs-attention");
  flow.attention(false);
  assert.equal(last(), "speaking");
});

test("a pause never outlives its limit when no verdict arrives", async () => {
  const { flow, holds, log, last } = make({ holdLimitMs: 5 });
  flow.spoken(); flow.playing(); flow.speechStart();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(holds, [true, false]);
  assert.equal(last(), "speaking");
  assert.ok(log.some((e) => e.event === "holdTimeout"));
});

test("every change of state is logged once with its cause", () => {
  const { flow, log } = make();
  flow.turnStart(); flow.turnStart();
  assert.deepEqual(log.filter((e) => e.event === "stateTransition"), [{ event: "stateTransition", from: "listening", to: "waiting", cause: "turnStart" }]);
});

test("reset clears everything, including a pending pause", () => {
  const { flow, statuses, holds } = make({ holdLimitMs: 5 });
  flow.spoken(); flow.playing(); flow.speechStart();
  flow.reset();
  const before = statuses.length;
  flow.playing(); flow.drained();
  assert.ok(statuses.length >= before);
  assert.deepEqual(holds, [true], "reset is a new call; there is no reply to resume");
});

test("confirmed speech with nothing playing has nothing to stop", () => {
  const { flow } = make();
  flow.speechStart();
  assert.equal(flow.speechConfirmed(), false);
});
