import test from "node:test";
import assert from "node:assert/strict";
import { forkedPane, forkUpto, messagePreview } from "../src/phone/messageFork.ts";

const source = { id: "pane-a", workspaceId: "ws-1", kind: "chat", title: "Ship the widget" };

test("a fork from a message keeps that message and everything before it", () => {
  assert.equal(forkUpto(0), 1);
  assert.equal(forkUpto(4), 5);
});

test("the forked pane is a chat in the same project, titled as a fork and remembering its source", () => {
  assert.deepEqual(forkedPane(source, "pane-b", 4, "Hetzner"), {
    id: "pane-b",
    workspaceId: "ws-1",
    kind: "chat",
    title: "Ship the widget (fork)",
    fork: { from: "pane-a", title: "Ship the widget", host: "Hetzner", at: 5 },
  });
});

test("a preview is one trimmed line", () => {
  assert.equal(messagePreview("  Hello\n\n  there\tfriend  "), "Hello there friend");
  assert.equal(messagePreview(""), "");
  assert.equal(messagePreview("   \n  "), "");
});

test("a long preview is cut to the limit, ellipsis included", () => {
  const preview = messagePreview("word ".repeat(40));
  assert.equal([...preview].length, 80);
  assert.ok(preview.endsWith("…"));
  assert.ok(!preview.includes("  "));
});

test("a preview counts characters, not UTF-16 units", () => {
  assert.equal(messagePreview("😀".repeat(10), 5), "😀😀😀😀…");
});

test("a text exactly at the limit has no ellipsis", () => {
  assert.equal(messagePreview("abcde", 5), "abcde");
  assert.equal(messagePreview("abcdef", 5), "abcd…");
});
