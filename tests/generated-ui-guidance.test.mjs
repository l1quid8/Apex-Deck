import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readCard } from "../src/interactiveAnswers/schema.ts";

const view = fs.readFileSync(new URL("../crates/apex-core/src/view.rs", import.meta.url), "utf8");
test("the locally capability-gated generated guidance supplies valid calculator, chart and static flowchart examples", () => {
  const guidance = view.match(/pub const GENERATED_ANSWERS_SYSTEM: &str = r#"([\s\S]*?)"#;/)?.[1];
  assert.ok(guidance, "the pinned adapted prompt is not present yet");
  const cards = [...guidance.matchAll(/```apex-ui\n([^\n]+)\n```/g)].map((match) => readCard(match[1]));
  assert.equal(cards.length, 3);
  for (const read of cards) assert.equal(read.ok, true, read.reason);
  assert.deepEqual(cards.map((read) => read.card.cardId), ["unit-cost", "sample-bars", "decision-flow"]);
  assert.equal(cards[2].card.js, "");
  assert.match(cards[2].card.html, /<svg/);
});
