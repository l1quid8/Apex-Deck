import test from "node:test";
import assert from "node:assert/strict";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { evaluate, formatValue, resolveInputs, resultLine, snap } from "../src/interactiveAnswers/comparison.ts";
import { cardMarkdown, cardVersions, discussDraft, snapshotText, withCardSummaries } from "../src/interactiveAnswers/share.ts";
import { source, variant } from "./interactive-answers-fixture.mjs";

const card = readCard(source).card;
const read = (text) => readCard(text).card;

test("saved settings that no longer fit are clamped, snapped or replaced by the default", () => {
  assert.deepEqual(resolveInputs(card, null), { budget: 250, priority: "ease" });
  assert.deepEqual(resolveInputs(card, { budget: 999, priority: "speed", stray: 1 }), { budget: 500, priority: "ease" });
  assert.deepEqual(resolveInputs(card, { budget: 112, priority: "cost" }), { budget: 100, priority: "cost" });
  assert.deepEqual(resolveInputs(card, { budget: "100" }), { budget: 250, priority: "ease" });
  assert.equal(snap({ min: 0, max: 1, step: 0.1 }, 0.30000000000000004), 0.3);
  assert.equal(snap({ min: 0, max: 10, step: 3 }, 10), 9);
});

test("limits put options out and the chosen priority ranks the rest", () => {
  const ease = evaluate(card, { budget: 250, priority: "ease" });
  assert.equal(ease.best, "managed");
  assert.deepEqual(ease.options.map((o) => [o.id, o.rank, o.out]), [["vps", 3, []], ["managed", 1, []], ["serverless", 2, []]]);
  assert.equal(resultLine(card, ease), "Best fit: Managed (priority: Simplicity).");

  const tight = evaluate(card, { budget: 100, priority: "ease" });
  assert.equal(tight.best, "serverless");
  assert.deepEqual(tight.options[1], { id: "managed", label: "Managed", out: ["Above monthly budget"], rank: null });

  assert.equal(evaluate(card, { budget: 250, priority: "cost" }).best, "vps");

  const none = evaluate(card, { budget: 50, priority: "cost" });
  assert.equal(none.best, null);
  assert.equal(resultLine(card, none), "No option fits these settings.");
});

test("ties keep the card's order; without a ranking the line counts what fits", () => {
  assert.equal(evaluate(read(variant((c) => { c.options[2].values.ease = 5; })), null).best, "managed");
  const unranked = read(variant((c) => { c.rules = [c.rules[0]]; }));
  const ev = evaluate(unranked, { budget: 100 });
  assert.equal(ev.best, null);
  assert.equal(resultLine(unranked, ev), "2 of 3 options fit these settings.");
});

test("values read the way people write them", () => {
  assert.equal(formatValue(1250, "$"), "$1,250");
  assert.equal(formatValue(-5, "$"), "-$5");
  assert.equal(formatValue(35, "%"), "35%");
  assert.equal(formatValue(12.5, "ms"), "12.5 ms");
  assert.equal(formatValue(3), "3");
  assert.equal(formatValue("High"), "High");
  assert.equal(formatValue(undefined), "—");
  assert.equal(formatValue(""), "—");
});

test("a card's version counts the bot cards with its id before it", () => {
  const bot = (seq, text) => ({ seq, speaker: { kind: "bot", id: "null" }, text });
  const fenced = (body) => `Here.\n\n\`\`\`apex-ui\n${body}\n\`\`\``;
  const versions = cardVersions([
    bot(1, fenced(source)),
    { seq: 2, speaker: { kind: "human" }, text: fenced(source) },
    bot(3, "No card here."),
    bot(4, fenced(variant((c) => { c.title = "Revised"; }))),
    bot(5, fenced("{broken")),
  ]);
  assert.deepEqual([...versions], [[cardKey(1, "hosting"), 1], [cardKey(4, "hosting"), 2]]);
});

test("the snapshot names the card, version and author, each setting, and the result", () => {
  assert.equal(snapshotText(card, { budget: 100, priority: "ease" }, 2, "Null"), [
    'Settings from Null\'s card "Where should this run?" (v2):',
    "- Monthly budget: $100",
    "- Priority: Simplicity",
    "Best fit: Serverless (priority: Simplicity). Out: Managed (above monthly budget).",
  ].join("\n"));
});

test("Discuss puts the snapshot under what's typed, with a line to write on", () => {
  assert.equal(discussDraft("", "S"), "S\n\n");
  assert.equal(discussDraft("  ", "S"), "S\n\n");
  assert.equal(discussDraft("@jigga thoughts?\n", "S"), "@jigga thoughts?\n\nS\n\n");
});

test("exports print a card as a summary and table at its saved settings", () => {
  const reply = `Pick one.\n\n\`\`\`apex-ui\n${source}\n\`\`\`\n\nAsk me anything.`;
  const saved = { [cardKey(7, "hosting")]: { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" }, revision: 1, at: 0 } };
  const out = withCardSummaries(reply, 7, saved);
  assert.ok(out.startsWith("Pick one.\n\n**Where should this run?**\n\nManaged hosting fits"));
  assert.match(out, /Monthly budget: \$100 · Priority: Simplicity/);
  assert.match(out, /\| {2}\| VPS \| Managed \| Serverless \|/);
  assert.match(out, /\| Monthly cost \| \$60 \| \$180 \| \$90 \|/);
  assert.match(out, /Best fit: Serverless \(priority: Simplicity\)\. Out: Managed \(above monthly budget\)\./);
  assert.match(out, /- \[Provider pricing\]\(https:\/\/example\.com\/pricing\)/);
  assert.ok(out.endsWith("Ask me anything."));
  // Settings saved on another card, or a block that isn't a card, change nothing.
  const other = { [cardKey(7, "hosting")]: { ...saved[cardKey(7, "hosting")], fingerprint: "00000000" } };
  assert.match(withCardSummaries(reply, 7, other), /Monthly budget: \$250/);
  const broken = "```apex-ui\n{oops\n```";
  assert.equal(withCardSummaries(broken, 7, {}), broken);
  assert.equal(cardMarkdown(card, null).split("\n\n")[0], "**Where should this run?**");
});
