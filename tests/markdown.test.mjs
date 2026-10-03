import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, parseInline } from "../src/markdownText.ts";

const kinds = (text) => parseBlocks(text).map((b) => b.kind);

test("paragraphs, headings, rules and quotes are told apart", () => {
  const blocks = parseBlocks("# Title\n\nFirst line\nsecond line\n\n---\n\n> quoted\n> more\n\nLast.");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, text: "Title" },
    { kind: "paragraph", text: "First line\nsecond line" },
    { kind: "rule" },
    { kind: "quote", text: "quoted\nmore" },
    { kind: "paragraph", text: "Last." },
  ]);
});

test("a code block keeps its text exactly and may still be open", () => {
  assert.deepEqual(parseBlocks("Run:\n```sh\nnpm run   build\n# not a heading\n```\nDone."), [
    { kind: "paragraph", text: "Run:" },
    { kind: "code", language: "sh", text: "npm run   build\n# not a heading" },
    { kind: "paragraph", text: "Done." },
  ]);
  // A reply still being written has not closed its block yet.
  assert.deepEqual(parseBlocks("```\nlet x = 1;\n- not a list"), [{ kind: "code", language: "", text: "let x = 1;\n- not a list" }]);
  // A shorter run of backticks inside does not close a longer fence.
  assert.equal(parseBlocks("````\n```\ninner\n```\n````")[0].text, "```\ninner\n```");
});

test("lists keep nesting, numbers and continued lines", () => {
  const [list] = parseBlocks("- one\n  - nested\n    more of nested\n- two\n\n- three");
  assert.deepEqual(list, {
    kind: "list",
    ordered: false,
    items: [
      { depth: 0, number: undefined, text: "one" },
      { depth: 1, number: undefined, text: "nested\nmore of nested" },
      { depth: 0, number: undefined, text: "two" },
      { depth: 0, number: undefined, text: "three" },
    ],
  });
  const [numbered] = parseBlocks("3. third\n4. fourth");
  assert.equal(numbered.ordered, true);
  assert.deepEqual(numbered.items.map((i) => i.number), [3, 4]);
  assert.deepEqual(kinds("- item\nplain after"), ["list", "paragraph"]);
});

test("tables need a divider row and line their columns up", () => {
  assert.deepEqual(parseBlocks("| Name | Size |\n|---|---:|\n| a \\| b | 1 |\n| short |\n\nafter"), [
    { kind: "table", header: ["Name", "Size"], rows: [["a | b", "1"], ["short", ""]] },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(kinds("a | b\nno divider"), ["paragraph"]);
});

test("inline formatting nests and plain text is kept", () => {
  assert.deepEqual(parseInline("a **bold *both*** `x*y` ~~gone~~ end"), [
    { kind: "text", text: "a " },
    { kind: "bold", children: [{ kind: "text", text: "bold " }, { kind: "italic", children: [{ kind: "text", text: "both" }] }] },
    { kind: "text", text: " " },
    { kind: "code", text: "x*y" },
    { kind: "text", text: " " },
    { kind: "strike", children: [{ kind: "text", text: "gone" }] },
    { kind: "text", text: " end" },
  ]);
  assert.deepEqual(parseInline("_soft_ and __strong__"), [
    { kind: "italic", children: [{ kind: "text", text: "soft" }] },
    { kind: "text", text: " and " },
    { kind: "bold", children: [{ kind: "text", text: "strong" }] },
  ]);
});

test("stars and underscores inside words, paths and links are left alone", () => {
  for (const plain of [
    "snake_case_name and other_one",
    "2 * 3 * 4 = 24",
    "[my_file_name.md](/Users/me/my_project/my_file_name.md)",
    "see https://example.com/a_b_c/*x* now",
    "a * lone star and a _ lone underscore",
    "unclosed **bold and `code",
  ]) {
    assert.deepEqual(parseInline(plain), [{ kind: "text", text: plain }], plain);
  }
  assert.deepEqual(parseInline("`` a ` b ``"), [{ kind: "code", text: "a ` b" }]);
});
