import test from "node:test";
import assert from "node:assert/strict";
import { paneMenuItems, copyMenuItems, projectMenuItems } from "../src/paneMenu.ts";

const idle = { running: false, installed: true, tool: "Codex", folder: "/Users/tyler/apex-deck" };
const summary = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}${i.danger ? " (danger)" : ""}`);

test("a thread's menu is Codex's, with Deck's Share as PDF, Copy ›, Fork, Export and Delete", () => {
  const items = paneMenuItems("chat", idle, { address: "" }, { mac: true });
  assert.deepEqual(summary(items), ["Rename", "Pin", "Mark as unread", "| Share as PDF", "Copy", "Fork", "Export", "| Archive", "Delete… (danger)"]);
  assert.deepEqual(items.map((i) => i.keys ?? ""), ["⌥⌘R", "⌥⌘P", "⇧⌘U", "", "", "", "", "⇧⌘A", ""]);
  assert.deepEqual(items.map((i) => i.action), ["rename", "pin", "mark_unread", "share_pdf", "copy", "fork", "export", "archive", "delete"]);
  assert.equal(items.find((i) => i.action === "copy").submenu, true);
  const marked = paneMenuItems("chat", idle, { address: "" }, { pinned: true, unread: true, mac: true });
  assert.equal(marked.find((i) => i.action === "pin").label, "Unpin");
  assert.equal(marked.find((i) => i.action === "mark_unread").label, "Mark as read");
  assert.equal(paneMenuItems("chat", idle).find((i) => i.action === "rename").keys, "Ctrl+Alt+Shift+R");
});

test("Copy › copies Markdown, the last reply, the folder with its server, and the thread ID", () => {
  const items = copyMenuItems({ hasReply: false, path: "root@hetzner-eu:/root/apex-deck", id: "pane-1" });
  assert.deepEqual(items.map((i) => [i.kind, i.label, i.side, i.disabled]), [
    ["markdown", "Copy as Markdown", "", false], ["reply", "Copy last reply", "", true],
    ["path", "Copy folder path", "root@hetzner-eu:/root/apex-deck", false], ["id", "Copy thread ID", "pane-1", false]]);
  assert.equal(items[1].reason, "No reply yet.");
  assert.equal(copyMenuItems({ hasReply: true, path: "", id: "x" })[2].disabled, true);
  assert.equal(copyMenuItems({ hasReply: true, path: "", id: "x" })[1].disabled, false);
});

test("a project's menu: Pin, Edit…, then Edit connection… for a server or Reveal in Finder for the Mac", () => {
  const sum = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}${i.danger ? " (danger)" : ""}`);
  assert.deepEqual(sum(projectMenuItems({ remote: true, path: "/root/x", threads: 2 })), ["Pin", "Edit…", "| Edit connection…", "| Archive threads", "| Remove project… (danger)"]);
  assert.deepEqual(sum(projectMenuItems({ remote: false, path: "", threads: 0, pinned: true })), ["Unpin", "Edit…", "| Reveal in Finder (off)", "| Archive threads (off)", "| Remove project… (danger)"]);
  assert.deepEqual(projectMenuItems({ remote: false, path: "/a", threads: 1 }).map((i) => i.action), ["pin", "edit", "reveal", "archive", "remove"]);
});

test("a terminal's menu offers Rename, Pin, Start again, Copy folder path, then Close", () => {
  assert.deepEqual(summary(paneMenuItems("terminal", idle)), ["Rename", "Pin to top", "Start again", "Copy folder path", "| Close"]);
  assert.deepEqual(paneMenuItems("terminal", idle).map((i) => i.action), ["rename", "pin", "start", "copy_path", "close"]);
});

test("Start again is off while the program runs, and says why", () => {
  const start = paneMenuItems("terminal", { ...idle, running: true }).find((i) => i.action === "start");
  assert.equal(start.disabled, true);
  assert.equal(start.reason, "It's still running.");
});

test("Start again is off when the tool is no longer installed", () => {
  const start = paneMenuItems("terminal", { ...idle, installed: false }).find((i) => i.action === "start");
  assert.equal(start.disabled, true);
  assert.equal(start.reason, "Codex isn't installed.");
});

test("Copy folder path is off for a workspace with no folder", () => {
  const copy = paneMenuItems("terminal", { ...idle, folder: "" }).find((i) => i.action === "copy_path");
  assert.equal(copy.disabled, true);
  assert.equal(copy.reason, "This workspace has no folder.");
});

test("Close is never turned off, so a busy terminal can always be closed (it asks first)", () => {
  const close = paneMenuItems("terminal", { ...idle, running: true, installed: false, folder: "" }).find((i) => i.action === "close");
  assert.equal(close.disabled, false);
  assert.equal(close.danger, false);
});

test("a preview's menu renames, copies its address and closes", () => {
  const terminal = { running: false, installed: true, tool: "", folder: "" };
  const items = paneMenuItems("preview", terminal, { address: "http://localhost:5173/" });
  assert.deepEqual(items.map((i) => i.action), ["rename", "pin", "copy_address", "close"]);
  const copy = items.find((i) => i.action === "copy_address");
  assert.equal(copy.disabled, false);
  const empty = paneMenuItems("preview", terminal, { address: "" }).find((i) => i.action === "copy_address");
  assert.equal(empty.disabled, true);
  assert.equal(empty.reason, "No page yet.");
});
