import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stepDraft } from "../src/phone/stepDraft.ts";

const nova = { id: "nova", display_name: "Nova" };

test("a tapped suggestion fills an empty box", () => {
  assert.equal(stepDraft("", "  Review the changes. "), "Review the changes.");
});

test("the suggestion is not tagged for the bot that offered it", () => {
  assert.equal(stepDraft("", "Review the changes.", nova), "Review the changes.");
  assert.equal(stepDraft("Also ", "check tests.", nova), "Also check tests.");
  assert.equal(stepDraft("@nova also", "check tests.", nova), "@nova also check tests.");
});

test("a suggestion its author opened with its own name loses that tag", () => {
  assert.equal(stepDraft("", "@nova Review the changes.", nova), "Review the changes.");
  assert.equal(stepDraft("", "@nova @nova, review the changes.", nova), "review the changes.");
  assert.equal(stepDraft("@nova also", "@nova check tests.", nova), "@nova also check tests.");
});

test("tags for other bots, and names inside the suggestion, are kept", () => {
  assert.equal(stepDraft("", "@novak review the changes.", nova), "@novak review the changes.");
  assert.equal(stepDraft("", "@luna review the changes.", nova), "@luna review the changes.");
  assert.equal(stepDraft("", "Ask @nova to review.", nova), "Ask @nova to review.");
  assert.equal(stepDraft("", "@nova", nova), "@nova");
});

test("on the phone, suggestions start folded and fill the composer instead of sending", () => {
  const src = fs.readFileSync("src/phone/PhoneApp.tsx", "utf8");
  assert.match(src, /<ReplyNextSteps[^>]*startCollapsed onStep=\{fillStep\}/);
  assert.doesNotMatch(src, /<ReplyNextSteps[^>]*onStep=\{props\.steps\.onStep\}/);
});
