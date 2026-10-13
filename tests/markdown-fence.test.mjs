import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "sucrase";
import { parseBlocks, parseInline, pathLike } from "../src/markdownText.ts";

const React = { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const code = fs.readFileSync(new URL("../src/Markdown.tsx", import.meta.url), "utf8");
const compiled = transform(code.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), { transforms: ["typescript", "jsx"], jsxRuntime: "classic" }).code;
const { Markdown, BlockView, CodeBlock } = new Function("React", "useEffect", "useMemo", "useState", "parseBlocks", "parseInline", "pathLike", "RichText", `${compiled}\nreturn { Markdown, BlockView, CodeBlock };`)(
  React, () => {}, (make) => make(), (start) => [start, () => {}], parseBlocks, parseInline, pathLike, "RichText",
);
const inline = (source) => source;

test("a fence the caller draws replaces the code view; other code blocks stay code", () => {
  const fence = (block) => (block.language === "apex-ui" ? { type: "card", props: { text: block.text }, children: [] } : undefined);
  const card = BlockView({ block: { kind: "code", language: "apex-ui", text: "{}" }, inline, fence });
  assert.equal(card.type, "Fragment");
  assert.deepEqual(card.children, [{ type: "card", props: { text: "{}" }, children: [] }]);
  assert.equal(BlockView({ block: { kind: "code", language: "js", text: "x" }, inline, fence }).type, CodeBlock);
  assert.equal(BlockView({ block: { kind: "code", language: "apex-ui", text: "{}" }, inline }).type, CodeBlock);
});

test("Markdown hands its fence to every block", () => {
  const fence = () => undefined;
  const tree = Markdown({ text: "Hi\n\n```apex-ui\n{}\n```", onOpen() {}, fence });
  assert.deepEqual(tree.children.map((child) => child.props.fence), [fence, fence]);
});
