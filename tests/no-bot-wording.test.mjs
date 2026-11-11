// Guard: on-screen text says "agent", never "bot" (user decision 2026-11-08,
// done 2026-11-11). Code names (ids, CSS classes, saved keys, protocol kinds)
// may still say bot; this only reads strings and JSX text a person would see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse } = require("sucrase/dist/parser");
const { formatTokenType } = require("sucrase/dist/parser/tokenizer/types");

const root = new URL("../src/", import.meta.url).pathname;
const WORD = /(?<![\w-])bots?(?![\w-])/i;

// Phrase-like text: has a space, or is a capitalised heading word ("Bots").
// Single lowercase tokens ("bot", "bots") are ids and protocol kinds.
const words = (text) => WORD.test(text) && (/\s/.test(text.trim()) || /^Bots?$/.test(text.trim()));
const CODE_ATTRS = new Set(["className", "class", "key", "id", "data-testid", "role", "htmlFor", "name", "value", "type"]);
const CODE_CALLS = /^(querySelector|querySelectorAll|closest|matches|add|remove|toggle|contains)$/;

export function scan(src) {
  const { tokens } = parse(src, true, true, false);
  const found = [];
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const name = (t) => t && src.slice(t.start, t.end);
  const kind = (t) => t && formatTokenType(t.type);
  let keywordsDepth = -1, depth = 0;
  tokens.forEach((t, i) => {
    const k = kind(t);
    if (k === "[") { depth++; if (kind(tokens[i - 1]) === ":" && name(tokens[i - 2]) === "keywords") keywordsDepth = depth; }
    if (k === "]") { if (depth === keywordsDepth) keywordsDepth = -1; depth--; }
    let text;
    if (k === "jsxText") text = name(t);
    else if (k === "string") text = name(t).slice(1, -1);
    else if (k === "template") text = name(t);
    else return;
    if (!WORD.test(text)) return;
    // Settings search words: typing "bot" still finds agent settings (user, 2026-11-11).
    if (keywordsDepth !== -1) return;
    if (k !== "jsxText") {
      // className="bubble bot", class="row bot" in exported HTML, querySelector(".bot-row")
      let j = i - 1;
      while (j >= 0 && ["`", "${", "{", "name", "?", ":", ".", "(", "+", "template", "string", "}", "||", "&&"].includes(kind(tokens[j])) && !(kind(tokens[j]) === "name" && CODE_CALLS.test(name(tokens[j])))) j--;
      if (kind(tokens[j]) === "=" && kind(tokens[j - 1]) === "jsxName" && CODE_ATTRS.has(name(tokens[j - 1]))) return;
      if (kind(tokens[j]) === "name" && CODE_CALLS.test(name(tokens[j]))) return;
      if (/class="[^"]*$/.test(src.slice(Math.max(0, t.start - 80), t.start + 1)) || /^[^"]*"/.test(text) && /class="/.test(text)) return;
      if (/^(?:[.#]?[\w-]+\s*)+$/.test(text.trim()) && /[\w]-|-[\w]/.test(text)) return; // class lists
    }
    if (k === "jsxText" ? true : words(text)) found.push(`${lineOf(t.start)}: ${text.trim().slice(0, 100)}`);
  });
  return found;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|mts)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

test("the scanner catches on-screen bot wording and ignores code names", () => {
  assert.equal(scan(`<button title="Add bot">+ Add bot</button>`).length, 2);
  assert.equal(scan("notify(`${n} bots are working`)").length, 1);
  assert.equal(scan(`const x = n === 1 ? "1 bot" : "Bots";`).length, 2);
  assert.deepEqual(scan(`<div className="bubble bot completed">{bot.name}</div>`), []);
  assert.deepEqual(scan(`if (kind === "bot") send({ bot: id, kind: "bots" });`), []);
  assert.deepEqual(scan(`const o = { id: 'access', label: 'Access for new agents', keywords: ['bot','bots','access'] }`), []);
});

test("no on-screen text says bot", () => {
  const all = files(root).flatMap((path) => scan(readFileSync(path, "utf8")).map((hit) => `${relative(root, path)}:${hit}`));
  assert.deepEqual(all, [], `Use "agent" in on-screen text:\n${all.join("\n")}`);
});
