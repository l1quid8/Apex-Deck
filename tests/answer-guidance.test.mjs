import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { EXAMPLE } from "./interactive-answers-fixture.mjs";

test("the card in the bots' instructions reads as a card, and is the one the tests use", () => {
  const view = fs.readFileSync(new URL("../crates/apex-core/src/view.rs", import.meta.url), "utf8");
  const guidance = view.slice(view.indexOf("pub const ANSWERS_SYSTEM"));
  const example = guidance.match(/```apex-ui\n(.*)\n```/)[1];
  const read = readCard(example);
  assert.equal(read.ok, true, read.reason);
  assert.deepEqual(read.card, EXAMPLE);
});
