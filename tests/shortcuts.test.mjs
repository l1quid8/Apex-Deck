import test from "node:test";
import assert from "node:assert/strict";
import { cyclePane, shortcutFor } from "../src/shortcuts.ts";

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
