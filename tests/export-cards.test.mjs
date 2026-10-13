import test from "node:test";
import assert from "node:assert/strict";
import { exportHtml, exportJson, exportMarkdown } from "../src/exportThread.ts";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { source } from "./interactive-answers-fixture.mjs";

test("Markdown and PDF exports print cards as summaries at their saved settings; JSON keeps the reply as written", () => {
  const reply = `Pick one.\n\n\`\`\`apex-ui\n${source}\n\`\`\``;
  const thread = {
    title: "Hosting", participants: [{ id: "null", display_name: "Null" }], pins: [], compaction: null,
    transcript: [{ seq: 3, speaker: { kind: "bot", id: "null" }, text: reply }],
    answers: { [cardKey(3, "hosting")]: { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" }, revision: 1, at: 0 } },
  };
  const at = new Date("2026-10-12T12:00:00Z");
  const markdown = exportMarkdown(thread, at);
  assert.match(markdown, /Monthly budget: \$100 · Priority: Simplicity/);
  assert.doesNotMatch(markdown, /schemaVersion/);
  const html = exportHtml(thread, at);
  assert.match(html, /<table><thead><tr><th><\/th><th>VPS<\/th>/);
  assert.doesNotMatch(html, /schemaVersion/);
  assert.match(exportJson(thread, at), /schemaVersion/);
});
