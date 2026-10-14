import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_CARD_CHARS, readCard } from "../src/interactiveAnswers/schema.ts";
import { readGeneratedCard, validateGeneratedCard } from "../shared/generatedCard.mjs";
import { source as comparisonSource, variant as comparisonVariant } from "./interactive-answers-fixture.mjs";

const card = JSON.parse(readFileSync(new URL("./fixtures/generated-counter.json", import.meta.url), "utf8"));
const source = JSON.stringify(card);
const changed = (change) => { const value = structuredClone(card); change(value); return JSON.stringify(value); };
const refused = (source, pattern) => {
  const result = readCard(source);
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, false);
  if (pattern) assert.match(result.reason, pattern);
  return result;
};

test("generated cards read with exactly their nine required fields", () => {
  const result = readCard(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.card, card);
});

test("every generated field is required and every unknown field is refused", () => {
  for (const field of Object.keys(card)) refused(changed((value) => { delete value[field]; }), /must|no /);
  refused(changed((value) => { value.inputs = []; }), /unknown.*inputs|inputs.*allowed/i);
  refused(changed((value) => { Object.defineProperty(value, "__proto__", { value: "extra", enumerable: true }); }), /unknown.*__proto__|__proto__.*allowed/i);
});

test("generated fields reject wrong types and unsupported contract values", () => {
  for (const field of ["cardId", "title", "summary", "html", "css", "js", "fallback"]) {
    for (const value of [null, 1, {}, [], true]) refused(changed((c) => { c[field] = value; }), new RegExp(field));
  }
  refused(changed((c) => { c.schemaVersion = "1"; }), /schemaVersion/);
  refused(changed((c) => { c.schemaVersion = 2; }), /schemaVersion/);
});

test("generated ids and nonblank text have character bounds", () => {
  for (const [field, max] of [["title", 80], ["summary", 280], ["fallback", 4000]]) {
    assert.equal(readCard(changed((c) => { c[field] = "x".repeat(max); })).ok, true);
    refused(changed((c) => { c[field] = "x".repeat(max + 1); }), new RegExp(field));
    refused(changed((c) => { c[field] = " \n\t"; }), new RegExp(field));
  }
  assert.equal(readCard(changed((c) => { c.cardId = "a".repeat(40); })).ok, true);
  for (const id of ["", "a".repeat(41), "Counter", "bad id", "-counter"]) refused(changed((c) => { c.cardId = id; }), /cardId/);
  refused(changed((c) => { c.html = "\t \n"; }), /html/);
});

test("generated code is preserved verbatim and CSS and JavaScript can be empty", () => {
  const raw = changed((c) => { c.html = "\r\n <div>é 😀</div>\r\n"; c.css = "\t\n"; c.js = "\r\n const literal = '</script>'; \t"; });
  const result = readCard(raw);
  assert.equal(result.ok, true);
  const original = JSON.parse(raw);
  for (const field of ["html", "css", "js"]) assert.equal(result.card[field], original[field]);
  assert.equal(readCard(changed((c) => { c.css = ""; c.js = ""; })).ok, true);
});

test("decoded generated code uses individual UTF-8 byte bounds", () => {
  for (const [field, max] of [["html", 49152], ["css", 16384], ["js", 32768]]) {
    const at = changed((c) => { c.html = "x"; c.css = ""; c.js = ""; c[field] = "x".repeat(max); });
    assert.equal(readCard(at).ok, true, field);
    refused(changed((c) => { c.html = "x"; c.css = ""; c.js = ""; c[field] = "x".repeat(max + 1); }), new RegExp(field));
    assert.equal(readCard(changed((c) => { c.html = "x"; c.css = ""; c.js = ""; c[field] = "é".repeat(max / 2); })).ok, true);
    refused(changed((c) => { c.html = "x"; c.css = ""; c.js = ""; c[field] = "é".repeat(max / 2) + "é"; }), new RegExp(field));
    refused(changed((c) => { c.html = "x"; c.css = ""; c.js = ""; c[field] = "😀".repeat(max / 4 + 1); }), new RegExp(field));
  }
});

test("generated combined code uses a separate 65,536-byte bound", () => {
  const at = changed((c) => { c.html = "x".repeat(49152); c.css = "x".repeat(16384); c.js = ""; });
  assert.equal(readCard(at).ok, true);
  refused(changed((c) => { c.html = "x".repeat(49152); c.css = "x".repeat(16384); c.js = "x"; }), /combined.*65,536|code.*65,536/i);
});

test("serialized generated source is bounded in bytes and UTF-16 code units before JSON parsing", () => {
  assert.equal(readCard(source + " ".repeat(131072 - source.length)).ok, true);
  refused(source + " ".repeat(131073 - source.length), /131,072|source/i);
  // JSON whitespace can include only ASCII; non-ASCII raw source is tested inside a string.
  const unicode = changed((c) => { c.html = "é".repeat(24000); c.css = "é".repeat(8000); c.js = ""; });
  const bytes = Buffer.byteLength(unicode, "utf8");
  assert.equal(readCard(unicode + " ".repeat(131072 - bytes)).ok, true);
  const oversizedBytes = unicode + " ".repeat(131073 - bytes);
  assert.ok(oversizedBytes.length < 131072);
  refused(oversizedBytes, /131,072|source/i);
  // This is invalid JSON: the raw-size refusal must happen first.
  refused("{" + " ".repeat(131072), /131,072|source/i);
});

test("JSON escapes count toward raw source while decoded code counts toward code limits", () => {
  const plain = changed((c) => { c.html = "x".repeat(21000); c.css = ""; c.js = ""; });
  assert.equal(readCard(plain.replace(/x/g, "\\u0078")).ok, true);
  const escapedLarge = changed((c) => { c.html = "x".repeat(22000); c.css = ""; c.js = ""; }).replace(/x/g, "\\u0078");
  refused(escapedLarge, /131,072|source/i);
});

test("comparison cards retain their 16,000-code-unit source cap and permissive keys", () => {
  assert.equal(readCard(comparisonSource).ok, true);
  assert.equal(readCard(comparisonVariant((c) => { c.extra = true; })).ok, true);
  const at = comparisonSource + " ".repeat(MAX_CARD_CHARS - comparisonSource.length);
  assert.equal(readCard(at).ok, true);
  refused(at + " ", /16,000 characters/);
  refused(" ".repeat(MAX_CARD_CHARS + 1), /16,000 characters/);
  assert.equal(readCard(comparisonVariant((c) => { c.kind = "chart"; })).unsupported, true);
});

test("shared main-process validation independently refuses extra or inherited fields", () => {
  assert.deepEqual(validateGeneratedCard(card), { ok: true, card });
  assert.equal(validateGeneratedCard({ ...card, inputs: [] }).ok, false);
  assert.equal(validateGeneratedCard({ ...card, [Symbol("extra")]: 1 }).ok, false);
  assert.equal(validateGeneratedCard(Object.create(card)).ok, false);
  for (const value of [null, [], 1, "card"]) assert.equal(validateGeneratedCard(value).ok, false);
  assert.equal(validateGeneratedCard({ ...card, kind: "comparison" }).ok, false);
  assert.equal(validateGeneratedCard({ ...card, schemaVersion: 2 }).unsupported, false);
});

test("shared source reading preserves bytes and rejects oversized JSON before parsing", () => {
  assert.deepEqual(readGeneratedCard(source), { ok: true, card });
  const bytes = changed((c) => { c.html = "\r\n<span>😀</span>\t"; c.js = "const script = '</script>';\r\n"; });
  const read = readGeneratedCard(bytes);
  assert.equal(read.ok, true);
  assert.equal(read.card.html, "\r\n<span>😀</span>\t");
  assert.equal(read.card.js, "const script = '</script>';\r\n");
  assert.match(readGeneratedCard("{" + " ".repeat(131072)).reason, /131,072/);
  assert.equal(readGeneratedCard(comparisonSource).ok, false);
});

test("bounded invalid generated cards identify their kind without accepting the card", () => {
  for (const raw of [changed((c) => { c.extra = true; }), changed((c) => { delete c.html; })]) {
    const result = readCard(raw);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "generated");
    assert.equal(result.unsupported, false);
  }
  assert.equal(readCard("{invalid").kind, undefined);
  assert.equal(readCard(comparisonVariant((c) => { c.title = ""; })).kind, undefined);
});
