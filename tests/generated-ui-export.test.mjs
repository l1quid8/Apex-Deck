import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exportHtml, exportJson, exportMarkdown } from "../src/exportThread.ts";
import { cardMarkdown, cardVersions, withCardSummaries } from "../src/interactiveAnswers/share.ts";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { variant as comparisonVariant } from "./interactive-answers-fixture.mjs";

const card = JSON.parse(readFileSync(new URL("./fixtures/generated-counter.json", import.meta.url), "utf8"));
const literal = JSON.parse(readFileSync(new URL("./fixtures/generated-literal-text.json", import.meta.url), "utf8"));
const fence = (card) => "```apex-ui\n" + JSON.stringify(card) + "\n```";
const thread = (card) => ({ title: "Generated card", participants: [{ id: "null", display_name: "Null" }], pins: [], compaction: null, transcript: [{ seq: 3, speaker: { kind: "bot", id: "null" }, text: "Essential prose.\n\n" + fence(card) }] });
const at = new Date("2026-10-14T12:00:00Z");

test("generated Markdown summaries contain only title, summary and fallback", () => {
  const result = readCard(JSON.stringify(card));
  assert.equal(result.ok, true);
  assert.equal(cardMarkdown(result.card, null), "**Counter**\n\nAdjust a count locally\\.\n\nStarts at zero\\. Add one increments the count; Reset returns it to zero\\. Changes last only while this interface is running\\.");
  const markdown = exportMarkdown(thread(card), at);
  assert.match(markdown, /Essential prose/);
  assert.match(markdown, /\*\*Counter\*\*/);
  assert.match(markdown, /Starts at zero/);
  assert.doesNotMatch(markdown, /schemaVersion|document\.getElementById|<label>|margin:/);
});

test("generated exports never read comparison saved settings or execute model code", () => {
  const answers = new Proxy({}, { get() { throw new Error("Generated card read saved comparison inputs"); } });
  globalThis.generatedExportExecuted = false;
  const summary = withCardSummaries(fence(literal), 3, answers);
  assert.match(summary, /Literal/);
  assert.doesNotMatch(summary, /globalThis|Never export this generated markup|body \{/);
  assert.equal(globalThis.generatedExportExecuted, false);
  const json = exportJson({ ...thread(literal), answers: {} }, at);
  assert.equal(JSON.parse(json).transcript[0].text, thread(literal).transcript[0].text);
  assert.equal(globalThis.generatedExportExecuted, false);
  delete globalThis.generatedExportExecuted;
});

test("generated Markdown escapes field markup so the fields stay literal text", () => {
  const markdown = withCardSummaries(fence(literal), 3);
  assert.ok(markdown.startsWith("**Literal \\*title\\* \\<img src=x\\>**\n\n"));
  assert.ok(markdown.includes("\\[Fake link\\]\\(https://example\\.com\\) \\& \\*\\*literal summary\\*\\*"));
  assert.ok(markdown.includes("\\# Literal heading"));
  assert.ok(markdown.includes("\\`\\`\\`js"));
  assert.ok(markdown.includes("\\- Literal bullet"));
  assert.ok(markdown.includes("1\\. Literal number"));
  assert.ok(markdown.includes("\\> Literal quote"));
  assert.ok(markdown.includes("\\| A \\| B \\|"));
  assert.doesNotMatch(markdown, /apex-ui|schemaVersion|generatedExportExecuted/);
});

test("PDF exports render generated title, summary and fallback as escaped literal paragraphs", () => {
  const html = exportHtml(thread(literal), at);
  assert.match(html, /Literal \*title\* &lt;img src=x&gt;/);
  assert.match(html, /\[Fake link\]\(https:\/\/example\.com\) &amp; \*\*literal summary\*\*/);
  assert.match(html, /# Literal heading/);
  assert.match(html, /&lt;script&gt;alert\('literal'\)&lt;\/script&gt;/);
  assert.match(html, /&amp;amp; stays literal/);
  assert.doesNotMatch(html, /<script[\s>]|<img[\s>]|<em>title|<strong>literal summary|schemaVersion|generatedExportExecuted/);
});

test("generated and comparison revisions of the same cardId share the revision series", () => {
  const bot = (seq, text) => ({ seq, speaker: { kind: "bot" }, text });
  const generated = { ...card, cardId: "hosting" };
  const versions = cardVersions([
    bot(1, "```apex-ui\n" + comparisonVariant(() => {}) + "\n```"),
    bot(2, fence(generated)),
    bot(3, fence({ ...generated, title: "Revision" })),
    { seq: 4, speaker: { kind: "human" }, text: fence(generated) },
    bot(5, fence({ ...generated, extra: true })),
  ]);
  assert.deepEqual([...versions], [["1:hosting", 1], ["2:hosting", 2], ["3:hosting", 3]]);
});

test("invalid generated Markdown exports show generic text and JSON keeps the complete reply", () => {
  const invalid = [{ ...literal, extra: true }, { ...literal }];
  delete invalid[1].html;
  for (const card of invalid) {
    const exported = exportMarkdown(thread(card), at);
    assert.match(exported, /interactive answer.*could not be shown/i);
    assert.doesNotMatch(exported, /apex-ui|schemaVersion|globalThis|extra|literal summary|Never export|body \{/);
    assert.equal(JSON.parse(exportJson(thread(card), at)).transcript[0].text, thread(card).transcript[0].text);
  }
});

test("invalid generated PDF exports show generic text without the rejected card's code or properties", () => {
  for (const card of [{ ...literal, extra: true }, { ...literal, html: null }]) {
    const exported = exportHtml(thread(card), at);
    assert.match(exported, /interactive answer.*could not be shown/i);
    assert.doesNotMatch(exported, /apex-ui|schemaVersion|globalThis|extra|literal summary|Never export/);
  }
});

test("oversized fences of any kind have generic exports without parsing or printing raw data", () => {
  const oversized = [
    JSON.stringify(card) + " ".repeat(131072),
    comparisonVariant(() => {}) + " ".repeat(131072),
    "{" + " ".repeat(131072),
    JSON.stringify({ ...card, html: "é".repeat(66000) }),
  ];
  for (const source of oversized) {
    const original = "Essential prose.\n\n```apex-ui\n" + source + "\n```";
    const value = { ...thread(card), transcript: [{ seq: 3, speaker: { kind: "bot", id: "null" }, text: original }] };
    const markdown = exportMarkdown(value, at);
    assert.match(markdown, /interactive answer.*could not be shown/i);
    assert.doesNotMatch(markdown, /apex-ui|schemaVersion|document\.getElementById|\{/);
    assert.ok(markdown.length < 1000);
    assert.equal(JSON.parse(exportJson(value, at)).transcript[0].text, original);
    const html = exportHtml(value, at);
    assert.match(html, /interactive answer.*could not be shown/i);
    assert.doesNotMatch(html, /schemaVersion|document\.getElementById/);
    assert.ok(html.length < 10000);
  }
  assert.equal(withCardSummaries("```apex-ui\n{invalid\n```", 3), "```apex-ui\n{invalid\n```");
});

test('a missing or mistyped generated discriminator still produces safe text exports', () => {
  for (const kind of [undefined, 3, 'generatd']) {
    const invalidCard = { ...card, js: 'globalThis.codeSecret = "never export code"' };
    if (kind === undefined) delete invalidCard.kind;
    else invalidCard.kind = kind;
    const source = JSON.stringify(invalidCard);
    const reply = 'Useful answer.\n\n```apex-ui\n' + source + '\n```';
    const summary = withCardSummaries(reply, 1);
    assert.ok(!summary.includes('codeSecret'));
    const thread = { title: 'Test', participants: [], transcript: [{seq:1,speaker:{kind:'bot',id:'null'},text:reply}], pins: [], compaction: null };
    const html = exportHtml(thread, new Date('2026-10-14T00:00:00Z'));
    assert.ok(!html.includes('codeSecret'));
  }
});
