import test from "node:test";
import assert from "node:assert/strict";
import { paneMenuItems } from "../src/paneMenu.ts";

const idle = { running: false, installed: true, tool: "Codex", folder: "/Users/tyler/apex-deck" };
const summary = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}${i.danger ? " (danger)" : ""}`);

test("a thread's menu offers Rename, Fork, Export, then Delete thread… in danger text", () => {
  assert.deepEqual(summary(paneMenuItems("chat", idle)), ["Rename", "Fork", "Export", "| Delete thread… (danger)"]);
  assert.deepEqual(paneMenuItems("chat", idle).map((i) => i.action), ["rename", "fork", "export", "delete"]);
});

test("a terminal's menu offers Rename, Start again, Copy folder path, then Close", () => {
  assert.deepEqual(summary(paneMenuItems("terminal", idle)), ["Rename", "Start again", "Copy folder path", "| Close"]);
  assert.deepEqual(paneMenuItems("terminal", idle).map((i) => i.action), ["rename", "start", "copy_path", "close"]);
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
