import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stepDraft } from "../src/phone/stepDraft.ts";

const nova = { id: "nova", display_name: "Nova" };

test("a tapped suggestion fills an empty box", () => {
  assert.equal(stepDraft("", "  Review the changes. "), "Review the changes.");
});

test("with several bots, the suggestion is tagged for the bot that offered it", () => {
  assert.equal(stepDraft("", "Review the changes.", nova), "@nova Review the changes.");
});

test("typing already in the box is kept, and a bot already tagged is not tagged twice", () => {
  assert.equal(stepDraft("Also ", "check tests.", nova), "Also @nova check tests.");
  assert.equal(stepDraft("@nova also", "check tests.", nova), "@nova also check tests.");
});

test("on the phone, suggestions start folded and fill the composer instead of sending", () => {
  const src = fs.readFileSync("src/phone/PhoneApp.tsx", "utf8");
  assert.match(src, /<ReplyNextSteps[^>]*startCollapsed onStep=\{fillStep\}/);
  assert.doesNotMatch(src, /<ReplyNextSteps[^>]*onStep=\{props\.steps\.onStep\}/);
});
