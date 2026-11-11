import test from "node:test";
import assert from "node:assert/strict";
import { createTrace, roughKb, traceText } from "../src/phone/phoneTrace.ts";

const memory = () => { const kept = new Map(); return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v), kept }; };

test("the log keeps lines in order, saves on flush, and reloads them", () => {
  const store = memory();
  let clock = 1000;
  const trace = createTrace(store, () => clock++);
  trace.add("app out of sight");
  trace.add("Mac: reconnecting (the connection timed out)");
  trace.flush();
  const again = createTrace(store);
  assert.deepEqual(again.lines().map((line) => line.text), ["app out of sight", "Mac: reconnecting (the connection timed out)"]);
  assert.deepEqual(again.lines().map((line) => line.at), [1000, 1001]);
});

test("the log keeps only the newest 400 lines", () => {
  const trace = createTrace(memory());
  for (let i = 0; i < 450; i++) trace.add(`line ${i}`);
  assert.equal(trace.lines().length, 400);
  assert.equal(trace.lines()[0].text, "line 50");
  assert.equal(trace.lines().at(-1).text, "line 449");
});

test("a damaged saved log starts over instead of breaking the app", () => {
  const store = memory();
  store.setItem("apex-deck.phone.trace.v1", "{not json");
  assert.deepEqual(createTrace(store).lines(), []);
});

test("clear empties the log and the saved copy", () => {
  const store = memory();
  const trace = createTrace(store);
  trace.add("x");
  trace.clear();
  assert.deepEqual(createTrace(store).lines(), []);
});

test("lines read as time of day, and size is message text in KB", () => {
  const at = new Date(2026, 10, 11, 9, 5, 7, 42).getTime();
  assert.equal(traceText([{ at, text: "app back in sight" }]), "09:05:07.042 app back in sight");
  assert.equal(roughKb([{ text: "a".repeat(2048) }, { text: "b".repeat(1024) }, { text: 5 }]), 3);
});
