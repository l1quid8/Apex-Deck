import test from "node:test";
import assert from "node:assert/strict";
import { paneMenuItems } from "../src/paneMenu.ts";

const idle = { running: false, installed: true, tool: "Codex", folder: "/Users/tyler/apex-deck" };
const summary = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}${i.danger ? " (danger)" : ""}`);

test("a thread's menu offers Rename, Pin, Share as PDF, Fork, Export, then Delete thread…", () => {
  assert.deepEqual(summary(paneMenuItems("chat", idle)), ["Rename", "Pin to top", "Share as PDF", "Fork", "Export", "| Delete thread… (danger)"]);
  assert.deepEqual(paneMenuItems("chat", idle).map((i) => i.action), ["rename", "pin", "share_pdf", "fork", "export", "delete"]);
  assert.equal(paneMenuItems("chat", idle, { address: "" }, { pinned: true }).find((i) => i.action === "pin").label, "Unpin");
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
