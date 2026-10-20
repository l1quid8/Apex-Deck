import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const popoutCss = readFileSync(new URL("../src/popout.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("pop-out bar reserves the same traffic-light room as the main titlebar", () => {
  assert.match(styles, /\.titlebar\s*\{[^}]*padding:\s*8px 16px 8px 88px/);
  assert.match(popoutCss, /\.popout-bar\s*\{[^}]*padding:\s*10px 12px 10px 88px/);
  assert.doesNotMatch(popoutCss, /\.popout-bar\s*\{[^}]*padding:\s*10px 12px\s*;/);
});

test("pop-out title truncates instead of pushing the return button out", () => {
  assert.match(popoutCss, /\.popout-title\s*\{[^}]*min-width:\s*0/);
  assert.match(popoutCss, /\.popout-title\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(popoutCss, /\.popout-sub\s*\{[^}]*min-width:\s*0/);
  assert.match(popoutCss, /\.popout-sub\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(popoutCss, /\.popout-return\s*\{[^}]*flex:\s*none/);
  assert.match(popoutCss, /\.popout-return\s*\{[^}]*white-space:\s*nowrap/);
});

test("pop-out counts match Deck's pane-head size and swap labels for icons when narrow", () => {
  assert.match(popoutCss, /\.popout-bar \.thread-counts\s*\{[^}]*display:\s*flex/);
  assert.match(popoutCss, /\.popout-bar \.thread-counts button\s*\{[^}]*font-size:\s*11px/);
  assert.match(popoutCss, /\.popout-bar \.thread-counts button\s*\{[^}]*padding:\s*4px 8px/);
  assert.match(popoutCss, /\.popout-bar \.pane-counts:not\(:has\(button\)\)\s*\{\s*display:\s*none/);
  assert.match(popoutCss, /\.count-label\s*\{\s*display:\s*none;\s*\}\s*\.popout-bar \.count-icon\s*\{\s*display:\s*inline-block/);
});

test("a popped thread's bar wraps to two rows instead of overflowing at minimum width", () => {
  assert.match(popoutCss, /@media \(max-width: 640px\)/);
  assert.match(popoutCss, /\.popout-bar:has\(\.popout-btn\)\s*\{\s*flex-wrap:\s*wrap/);
  assert.match(popoutCss, /\.popout-bar:has\(\.popout-btn\) \.spacer\s*\{\s*flex-basis:\s*100%/);
  assert.match(popoutCss, /\.popout-bar:has\(\.popout-btn\) \.popout-title\s*\{\s*flex:\s*2 1 0/);
  assert.match(popoutCss, /\.popout-bar:has\(\.popout-btn\) \.popout-return\s*\{\s*margin-left:\s*auto/);
  // Bars without thread buttons (terminal, preview, tabs) keep one row.
  assert.doesNotMatch(popoutCss, /\.popout-bar\s*\{[^}]*flex-wrap/);
});

test("pop-out bar drags the window while the return button stays clickable", () => {
  assert.match(popoutCss, /\.popout-bar\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(popoutCss, /\.popout-bar button[^{]*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(popoutCss, /\.popout-bar input\s*\{[^}]*-webkit-app-region:\s*no-drag/);
});
