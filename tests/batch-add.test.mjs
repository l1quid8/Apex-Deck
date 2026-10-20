import test from "node:test";
import assert from "node:assert/strict";
import { addInOrder, checkBatch, MAX_NEW_BOTS } from "../src/batchAdd.ts";

const bot = (name) => ({ id: name.toLowerCase(), display_name: name });

test("a batch caps new bots at four", () => {
  assert.equal(MAX_NEW_BOTS, 4);
});

test("checkBatch accepts distinct names and gives each its id", () => {
  const result = checkBatch([bot("Opus"), bot("Forge")], { others: [], agents: [] });
  assert.deepEqual(result.ok.map((c) => c.id), ["opus", "forge"]);
});

test("checkBatch refuses two new bots with the same handle", () => {
  const result = checkBatch([bot("Opus"), { id: "opus-x", display_name: "opus" }], { others: [], agents: [] });
  assert.equal(result.index, 1);
  assert.match(result.error, /already answers to @opus/);
});

test("checkBatch refuses a bot that clashes with someone already in the chat", () => {
  const result = checkBatch([bot("Opus"), bot("Gwen")], { others: [bot("Gwen")], agents: [] });
  assert.equal(result.index, 1);
});

test("checkBatch refuses @all", () => {
  const result = checkBatch([bot("All")], { others: [], agents: [] });
  assert.equal(result.index, 0);
  assert.match(result.error, /means everyone/);
});

test("addInOrder adds in order and stops at the first failure", async () => {
  const calls = [];
  const result = await addInOrder([bot("A"), bot("B"), bot("C"), bot("D")], async (config) => {
    calls.push(config.id);
    if (config.id === "c") throw new Error("room closed");
  });
  assert.deepEqual(result.added.map((c) => c.id), ["a", "b"]);
  assert.equal(result.failed.index, 2);
  assert.match(result.failed.error, /room closed/);
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("addInOrder with no failure returns failed null", async () => {
  const result = await addInOrder([bot("A")], async () => {});
  assert.deepEqual(result.added.map((c) => c.id), ["a"]);
  assert.equal(result.failed, null);
});
