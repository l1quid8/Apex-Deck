import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CARD_CHARS, readCard } from "../src/interactiveAnswers/schema.ts";
import { EXAMPLE, source, variant } from "./interactive-answers-fixture.mjs";

const reason = (text) => {
  const read = readCard(text);
  assert.equal(read.ok, false, "expected the card to be refused");
  return read;
};

test("the example card in the bots' instructions reads exactly as written", () => {
  const read = readCard(source);
  assert.equal(read.ok, true);
  assert.deepEqual(read.card, EXAMPLE);
});

test("text that isn't a card object says why", () => {
  assert.deepEqual(reason("{"), { ok: false, reason: "The card isn't valid JSON.", unsupported: false });
  assert.deepEqual(reason("[]"), { ok: false, reason: "The card must be a JSON object.", unsupported: false });
  assert.match(reason(" ".repeat(MAX_CARD_CHARS + 1)).reason, /larger than 16,000 characters/);
  assert.deepEqual(reason(variant((c) => { delete c.schemaVersion; })), { ok: false, reason: "The card has no schemaVersion.", unsupported: false });
});

test("a newer version or kind asks for a newer Apex Deck", () => {
  assert.deepEqual(reason(variant((c) => { c.schemaVersion = 2; })), { ok: false, reason: "Card version 2 needs a newer Apex Deck.", unsupported: true });
  assert.deepEqual(reason(variant((c) => { c.kind = "chart"; })), { ok: false, reason: '"chart" cards need a newer Apex Deck.', unsupported: true });
});

test("every limit is checked, with the field that broke it", () => {
  const cases = [
    [(c) => { c.cardId = "Hosting!"; }, /^cardId must be a short id/],
    [(c) => { c.title = " "; }, /^title must be text\.$/],
    [(c) => { c.title = "x".repeat(81); }, /^title is longer than 80 characters\.$/],
    [(c) => { c.options = c.options.slice(0, 1); }, /^options must list 2 to 6 items\.$/],
    [(c) => { c.rows = []; }, /^rows must list 1 to 12 items\.$/],
    [(c) => { c.inputs[0].min = 600; }, /^inputs\[0\] needs min below max\.$/],
    [(c) => { c.inputs[0].step = 0.1; }, /at most 1000 stops/],
    [(c) => { c.inputs[0].default = 1000; }, /^inputs\[0\]\.default must be between min and max\.$/],
    [(c) => { c.inputs[1].default = "speed"; }, /^inputs\[1\]\.default must be one of its options\.$/],
    [(c) => { c.inputs[0].type = "slider"; }, /^inputs\[0\]\.type must be "range" or "choice"\.$/],
    [(c) => { c.options[1].id = "vps"; }, /^options uses the id "vps" twice\.$/],
    [(c) => { c.options[0].values.price = "cheap"; }, /^rules\[0\]\.row: every option needs a number for "Monthly cost"\.$/],
    [(c) => { c.options[0].values.work = { a: 1 }; }, /^options\[0\]\.values\.work must be a number or text\.$/],
    [(c) => { c.rules.push({ ...c.rules[1] }); }, /^Only one rankBy rule is allowed\.$/],
    [(c) => { c.rules[0].input = "priority"; }, /^rules\[0\]\.input must name a range input\.$/],
    [(c) => { c.rules[1].input = "budget"; }, /^rules\[1\]\.input must name a choice input\.$/],
    [(c) => { c.rows.push({ id: "score", label: "Score" }); c.options.forEach((o, i) => { o.values.score = i; }); c.rules[1].rows.ease = "score"; }, /row "score" needs "better"/],
    [(c) => { c.sources[0].url = "javascript:alert(1)"; }, /^sources\[0\]\.url must start with http:\/\/ or https:\/\/\.$/],
    [(c) => { c.sources[0].url = "file:///etc/hosts"; }, /must start with http/],
  ];
  for (const [change, expected] of cases) assert.match(reason(variant(change)).reason, expected);
});

test("extra fields are ignored and the optional parts may be left out", () => {
  const extra = readCard(variant((c) => { c.theme = "dark"; c.options[0].icon = "server"; }));
  assert.equal(extra.ok, true);
  assert.equal("theme" in extra.card, false);
  const bare = readCard(variant((c) => { delete c.summary; delete c.assumptions; delete c.sources; c.inputs = []; c.rules = []; }));
  assert.equal(bare.ok, true);
  assert.deepEqual([bare.card.summary, bare.card.inputs, bare.card.rules, bare.card.assumptions, bare.card.sources], ["", [], [], [], []]);
});
