import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/glass-theme.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/PaneLayout.tsx", import.meta.url), "utf8");

test("the outer frame matches the gap between panes", () => {
  const gap = Number(layout.match(/export const GAP = (\d+);/)[1]);
  assert.match(css, new RegExp(`--deck-gap: ${gap}px;`));
});

test("the sidebar and docked details sit inside the same frame as the panes", () => {
  const frame = css.match(/\.canvas \{ padding: var\(--deck-gap\); \}/);
  assert.ok(frame, "canvas padding uses --deck-gap");
  assert.match(css, /:is\(\.rail, \.thread-details\.docked\) \{\s*margin-block: var\(--deck-gap\);[^}]*border-radius: var\(--radius\);/);
  assert.match(css, /\.rail \{ margin-left: var\(--deck-gap\); \}/);
  assert.match(css, /\.thread-details\.docked \{ margin-right: var\(--deck-gap\); \}/);
});

test("Classic uses the same frame as the glass skins", () => {
  for (const rule of css.match(/^.*--deck-gap.*$/gm)) assert.doesNotMatch(rule, /data-deck-theme/);
});

test("the overlay details resize handle follows the inset panel edge", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-handle\.overlay \{ top: var\(--deck-gap\); bottom: var\(--deck-gap\); \}/);
  assert.match(app, /right: `calc\(min\(\$\{detailsWidth\}px, 100% - 2 \* var\(--deck-gap, 0px\)\) \+ var\(--deck-gap, 0px\)\)`/);
  assert.match(app, /width: overlayDetails \? `min\(\$\{detailsWidth\}px, 100% - 2 \* var\(--deck-gap, 0px\)\)`/);
});
