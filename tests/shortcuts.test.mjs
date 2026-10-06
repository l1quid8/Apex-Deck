import test from "node:test";
import assert from "node:assert/strict";
import { cyclePane, shortcutFor, shortcutList } from "../src/shortcuts.ts";

const press = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test("on macOS the deck shortcuts use ⌘", () => {
  assert.deepEqual(shortcutFor(press("Digit1", { metaKey: true }), true), { kind: "section", section: "agents" });
  assert.deepEqual(shortcutFor(press("Digit3", { metaKey: true }), true), { kind: "section", section: "threads" });
  assert.deepEqual(shortcutFor(press("KeyT", { metaKey: true }), true), { kind: "new_terminal" });
  assert.deepEqual(shortcutFor(press("KeyN", { metaKey: true }), true), { kind: "new_thread" });
  assert.deepEqual(shortcutFor(press("KeyJ", { metaKey: true }), true), { kind: "next_attention" });
  assert.deepEqual(shortcutFor(press("BracketRight", { metaKey: true }), true), { kind: "cycle_pane", step: 1 });
  assert.deepEqual(shortcutFor(press("BracketLeft", { metaKey: true }), true), { kind: "cycle_pane", step: -1 });
  assert.deepEqual(shortcutFor(press("Enter", { metaKey: true, shiftKey: true }), true), { kind: "maximize" });
});

test("composer and window keys are left alone on macOS", () => {
  // ⌘Enter steers in the composer.
  assert.equal(shortcutFor(press("Enter", { metaKey: true }), true), null);
  // ⌘W closes the window from the macOS menu.
  assert.equal(shortcutFor(press("KeyW", { metaKey: true }), true), null);
  assert.equal(shortcutFor(press("KeyT", { metaKey: true, shiftKey: true }), true), null);
  assert.equal(shortcutFor(press("KeyT", { metaKey: true, altKey: true }), true), null);
  assert.equal(shortcutFor(press("KeyT"), true), null);
});

test("plain Ctrl keys stay with the shell; elsewhere the deck uses Ctrl+Shift", () => {
  for (const code of ["KeyW", "KeyT", "KeyN", "KeyJ", "Digit1", "BracketLeft"]) assert.equal(shortcutFor(press(code, { ctrlKey: true }), false), null, code);
  // On macOS, Ctrl is for the terminal too.
  assert.equal(shortcutFor(press("KeyT", { ctrlKey: true }), true), null);
  assert.deepEqual(shortcutFor(press("KeyT", { ctrlKey: true, shiftKey: true }), false), { kind: "new_terminal" });
  assert.deepEqual(shortcutFor(press("Enter", { ctrlKey: true, shiftKey: true }), false), { kind: "maximize" });
  assert.equal(shortcutFor(press("KeyT", { metaKey: true }), false), null);
});

test("cycling panes wraps round and starts at an end when nothing is focused", () => {
  assert.equal(cyclePane(["a", "b", "c"], "a", 1), "b");
  assert.equal(cyclePane(["a", "b", "c"], "c", 1), "a");
  assert.equal(cyclePane(["a", "b", "c"], "a", -1), "c");
  assert.equal(cyclePane(["a", "b"], null, 1), "a");
  assert.equal(cyclePane(["a", "b"], "gone", -1), "b");
  assert.equal(cyclePane([], "a", 1), null);
});

test("⌘, opens settings", () => {
  assert.deepEqual(shortcutFor(press("Comma", { metaKey: true }), true), { kind: "settings" });
  assert.deepEqual(shortcutFor(press("Comma", { ctrlKey: true, shiftKey: true }), false), { kind: "settings" });
});

test("the list shown in settings comes from the same table the keys use", () => {
  const mac = shortcutList(true);
  assert.deepEqual(mac.find((s) => s.label === "New thread"), { label: "New thread", keys: "⌘N" });
  assert.deepEqual(mac.find((s) => s.label === "Maximize or restore pane"), { label: "Maximize or restore pane", keys: "⇧⌘↩" });
  assert.deepEqual(mac.find((s) => s.label === "Settings"), { label: "Settings", keys: "⌘," });
  assert.deepEqual(shortcutList(false).find((s) => s.label === "Next pane"), { label: "Next pane", keys: "Ctrl+Shift+]" });
  // Every listed deck shortcut really fires.
  for (const s of mac.filter((s) => !s.composer)) assert.match(s.keys, /^[⌥⇧]*⌘.$/u, s.label);
});

test("thread shortcuts act on the focused thread", () => {
  const mac = (code, extra) => shortcutFor(press(code, { metaKey: true, ...extra }), true);
  assert.deepEqual(mac("KeyR", { altKey: true }), { kind: "thread", action: "rename" });
  assert.deepEqual(mac("KeyP", { altKey: true }), { kind: "thread", action: "pin" });
  assert.deepEqual(mac("KeyU", { shiftKey: true }), { kind: "thread", action: "mark_unread" });
  assert.deepEqual(mac("KeyA", { shiftKey: true }), { kind: "thread", action: "archive" });
  assert.equal(mac("KeyR", {}), null);
  assert.equal(mac("KeyT", { altKey: true }), null);
  assert.equal(mac("KeyU", {}), null);
  assert.deepEqual(shortcutFor(press("KeyR", { ctrlKey: true, shiftKey: true, altKey: true }), false), { kind: "thread", action: "rename" });
  assert.equal(shortcutFor(press("KeyR", { ctrlKey: true, shiftKey: true }), false), null);
  assert.deepEqual(shortcutList(true).find((s) => s.label === "Mark thread unread"), { label: "Mark thread unread", keys: "⇧⌘U", thread: true });
  assert.deepEqual(shortcutList(true).find((s) => s.label === "Rename thread"), { label: "Rename thread", keys: "⌥⌘R", thread: true });
  assert.deepEqual(shortcutList(false).find((s) => s.label === "Rename thread"), { label: "Rename thread", keys: "Ctrl+Alt+Shift+R", thread: true });
});

test("⌥⇧⌘O changes the project of the thread in use", () => {
  assert.deepEqual(shortcutFor(press("KeyO", { metaKey: true, altKey: true, shiftKey: true }), true), { kind: "thread", action: "project" });
  assert.equal(shortcutFor(press("KeyO", { metaKey: true, altKey: true }), true), null);
  assert.deepEqual(shortcutList(true).find((s) => s.label === "Change the thread's project"), { label: "Change the thread's project", keys: "⌥⇧⌘O", thread: true });
});
