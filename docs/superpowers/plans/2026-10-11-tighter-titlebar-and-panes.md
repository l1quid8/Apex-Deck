# Tighter Title Bar and Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task by task. Steps use checkboxes for tracking.

**Goal:** Remove the title bar's background, make its buttons 25% smaller, and enlarge the panes so the whole window looks tighter.

**Architecture:** CSS only. One set of custom properties (`--tb-scale`, `--deck-gap`) drives the sizes so the 25% and the pane growth are each changed in one place. The title bar loses its fill, border, blur and shadow in both the plain and glass themes; nothing in TSX changes.

**Tech Stack:** React/TypeScript, plain CSS (`src/styles.css`, `src/glass-theme.css`).

## Global Constraints

- Only `.titlebar` buttons shrink. Buttons inside panes, composer and dialogs keep their size.
- 25% smaller means every title bar button's width, height, padding and font-size is 0.75x the current value.
- Glass theme and the plain theme must both match. Do not edit `glass-ui-kit/index.html`.
- Other bots edit this folder at the same time: `git status` before committing, and stage only your own hunks. `src/ChatPane.tsx`, `src/ApexAgentMessageActions.tsx`, `src/personalSpeech.ts` and `src/apex-agent-message-actions.css` currently hold someone else's uncommitted work, so don't touch them.

## Review Focus

- Narrow window (<= 900px): the title bar wraps (`styles.css` ~979, 2074-2077). Shrunk buttons must still wrap cleanly and the section tabs stay on their own centred row.
- Title bar text and icons on a transparent bar must stay readable over every glass skin and over the plain theme's `--bg`.
- Window dragging: if `.titlebar` is the Electron drag region, removing the background must not remove the drag area (keep the element's size; only drop paint).
- Overlay sidebar and thread-details use `--deck-gap` for their offsets; they must still line up with the panes after the gap shrinks.
- Click targets: 0.75x of a 34px icon button is about 26px. Confirm it is still hittable; do not go below 24px.

---

### Task 1: Transparent title bar

**Files:**
- Modify: `src/styles.css:136-143` (`.titlebar`)
- Modify: `src/glass-theme.css:112-121` (glass `.titlebar`)
- Test: `tests/titlebar-tighter.test.mjs`

- [ ] **Step 1: Write the failing test** (match how other `tests/*.test.mjs` read CSS; read one first, e.g. `tests/apex-agent-voice-and-actions.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const plain = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const glass = readFileSync(new URL("../src/glass-theme.css", import.meta.url), "utf8");
const block = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block missing`);
  return css.slice(start, css.indexOf("}", start));
};

test("title bar paints nothing in the plain theme", () => {
  const b = block(plain, "\n.titlebar");
  assert.match(b, /background:\s*transparent/);
  assert.doesNotMatch(b, /border-bottom:\s*1px solid/);
});

test("title bar paints nothing in the glass theme", () => {
  const b = block(glass, ':root[data-deck-theme="glass"] .titlebar');
  assert.match(b, /background(-color)?:\s*transparent/);
  assert.match(b, /box-shadow:\s*none/);
  assert.doesNotMatch(b, /backdrop-filter:\s*blur/);
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node --test tests/titlebar-tighter.test.mjs`

- [ ] **Step 3: Implement**

`src/styles.css`, replace the `.titlebar` block:

```css
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: transparent;
}
```

`src/glass-theme.css`, replace the glass `.titlebar` block (keep the comment, reword it to say the bar is unpainted):

```css
:root[data-deck-theme="glass"] .titlebar {
  position: relative;
  z-index: 1;
  background: transparent;
  border-bottom: 0;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: none;
}
```

Also search for any other `.titlebar` background or border rule: `grep -n "titlebar" src/*.css`, and clear any that paint the bar itself (not its buttons).

- [ ] **Step 4: Run the test, expect PASS.** Then `npm run build` (or the repo's typecheck/build script from `package.json`) to confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add tests/titlebar-tighter.test.mjs src/styles.css src/glass-theme.css
git commit -m "Remove the title bar background"
```

### Task 2: Title bar buttons 25% smaller

**Files:**
- Modify: `src/styles.css` (add scoped rules after the `.titlebar` block; also `.section-button` at ~153)
- Modify: `src/glass-theme.css:140-148` (`min-width`/`min-height: 34px` on `.titlebar button.icon`)
- Test: `tests/titlebar-tighter.test.mjs`

**Interfaces:**
- Produces: `--tb-scale: 0.75` on `.titlebar`, used by every title bar button size below.

- [ ] **Step 1: Add the failing test**

```js
test("title bar buttons are scaled to 0.75 and nothing else is", () => {
  assert.match(plain, /\.titlebar\s*{[^}]*--tb-scale:\s*0\.75/);
  assert.doesNotMatch(glass, /\.titlebar button\.icon\s*{[^}]*min-width:\s*34px/);
  assert.match(glass, /min-width:\s*calc\(34px \* var\(--tb-scale\)\)/);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `--tb-scale: 0.75;` to the plain `.titlebar` block, then append:

```css
.titlebar button {
  padding: calc(7px * var(--tb-scale)) calc(12px * var(--tb-scale));
  font-size: calc(1em * var(--tb-scale));
}
.titlebar button.icon {
  padding: calc(2px * var(--tb-scale)) calc(7px * var(--tb-scale));
  font-size: calc(15px * var(--tb-scale));
}
.titlebar .section-button {
  gap: calc(8px * var(--tb-scale));
  padding: calc(7px * var(--tb-scale)) calc(16px * var(--tb-scale));
}
```

In `glass-theme.css`, change the icon rule to `min-width: calc(34px * var(--tb-scale)); min-height: calc(34px * var(--tb-scale));`.

Check the rendered result for things this CSS does not cover: SVG/emoji icon sizes inside buttons (`grep -n "titlebar" src/*.tsx` to find the components, then size any fixed `width`/`height` on their icons with the same scale), and the brand mark, which is not a button and stays as is unless the human says otherwise.

- [ ] **Step 4: Run the test, expect PASS.**

- [ ] **Step 5: Look before committing.** Run the app against its own data folder (`APEX_DECK_DATA_DIR=/tmp/deck-tb npm run desktop:dev`, see the dev-shares-prod-data note) or render offscreen; screenshot plain and glass at wide and narrow widths, and view the PNGs. Do not use real-data screenshots in anything that gets committed.

- [ ] **Step 6: Commit**

```bash
git add tests/titlebar-tighter.test.mjs src/styles.css src/glass-theme.css
git commit -m "Make title bar buttons 25% smaller"
```

### Task 3: Bigger panes

**Files:**
- Modify: `src/glass-theme.css:97-105` (`--deck-gap: 14px`)
- Modify: `src/styles.css` (`.canvas` padding and pane gaps; find with `grep -n "canvas\|\.pane\b\|pane-grid\|layout" src/styles.css`)
- Test: `tests/titlebar-tighter.test.mjs`

- [ ] **Step 1: Failing test**

```js
test("panes sit closer to the window edge and to each other", () => {
  assert.match(glass, /:root\s*{\s*--deck-gap:\s*(\d+)px/);
  const gap = Number(glass.match(/--deck-gap:\s*(\d+)px/)[1]);
  assert.ok(gap <= 8, `--deck-gap is ${gap}px, expected 8px or less`);
});
```

- [ ] **Step 2: Run, expect FAIL** (gap is 14).

- [ ] **Step 3: Implement.** Set `:root { --deck-gap: 8px; }`. Because the title bar no longer has a fill, also trim its vertical padding from `12px 16px` to `8px 16px` so the panes start higher (that is the "bigger panes" gain on the vertical axis). Do the same for any plain-theme pane gap that does not use `--deck-gap`. App.tsx adds `--deck-gap` to the sidebar handle offset, so confirm the handle still sits against the sidebar edge after the change. Take 8px as the starting value; if it looks cramped in the screenshot, try 10px and say which you chose.

- [ ] **Step 4: Run the test, expect PASS.** Run the full suite with `TMPDIR=/tmp npm test` (3 `codex_hook` tests fail inside Deck panes without it).

- [ ] **Step 5: Look before committing.** Screenshot 1-pane, 2-pane and 4-pane layouts, plain and glass, with the sidebar docked and as an overlay, and thread details open. Check that pane borders and the glass edge highlight are not clipped at the window edge.

- [ ] **Step 6: Commit**

```bash
git add tests/titlebar-tighter.test.mjs src/styles.css src/glass-theme.css
git commit -m "Tighten pane gaps so panes fill more of the window"
```

### Task 4: Hand back for review

- [ ] Send Null the commit range and the screenshots from Tasks 2 and 3 for review before anything is installed. Do not install the build until Null signs off and the human has looked at the screenshots.

## Self-Review

- Spec coverage: background removal (Task 1), 25% smaller buttons (Task 2), bigger panes (Task 3).
- Assumptions to confirm with the human if Luna sees a visual problem: "top nav bar" means `.titlebar` (brand, tabs, + New, icon buttons); "increase the size of the panes" means shrinking the gaps and the title bar height rather than changing the pane layout.
