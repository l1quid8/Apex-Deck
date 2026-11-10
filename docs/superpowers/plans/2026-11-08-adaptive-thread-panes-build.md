# Adaptive Thread Panes — Real-App Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the approved adaptive-thread-panes mockup into the Deck desktop app. That means five pane layouts with zoom, one composer docked at the bottom of the window, and multi-thread sends. In a multi-thread send, each `#thread` line goes to its own thread with its own agent, command and pictures.

**Architecture:**
- **Pane placement.** The free-form split tree (`src/layout.ts`) gives way to a computed *arrangement*: layout mode, pane order, zoom and focus share. One pure module places the panes, and the browser scrolls them natively.
- **Composer.** It stays inside each `ChatPane`. In the main window's pane map, only the target thread's composer is rendered, through a portal, into one dock. So per-thread drafts and every existing send rule are kept as they are: mod hooks, server checks, media checks, the turn queue and retry. Docking is opt-in, so talk-only chats and pop-out windows keep their own composer.
- **Multi-thread sending.** This is a new window-level composer. A pure planner turns the draft into slices. Send freezes them and takes the draft in the same click, so nothing can send it twice. In that same click each slice takes its place in its thread's queue, through a small API the pane registers, and then goes through the pane's own send pipeline. App keeps the batch until every slice has gone.
- **Order.** A thread's queue is what orders its messages, wherever they come from: its own composer, a batch, a next step or a voice turn. Each takes its place when it is sent, before any file is saved or check is run. The next one's turn comes as soon as it is in the queue, never only after a long `/compact` has finished. A slice that fails before it reaches the queue keeps its place there as a failed item, so what was sent after it waits for Retry or Remove, as it waits behind a failed send today. When a pane closes, its queue closes with it, and nothing it had not yet posted ever posts. A thread pops out or moves to another machine only once its queue is empty, never both at once, and while it moves its queue takes nothing new (D11). So no message is left behind in a hidden copy or sent from a window whose thread has moved, and no machine is sent another machine's file path.
- **Who answers.** Every send reads its recipients once, from what the person typed, and the queue keeps that routing text apart from the posted text (D10). Rewrites on the way out (`//`, mods, file references, attachment lines, TL;DR) never change who answers, and a mod's rewrite never takes out a name the person typed (D12). A quote's `@name` is chosen once too, at Send, and the message posts with exactly that name in front, or with none (D12). Just before posting, the queue checks again for exactly the agents it is about to post to, so a rule changed while a message waited can't take it to an agent the checks never saw.
- **One small daemon change (Task 11a).** `room_post_to` gets an optional `keep_default` field, so an agent picked from the `→ agent ▾` menu answers this one send without becoming the thread's default (D1). A read-only `post_capabilities` command tells the app which machines support it. Phone, CLI and every existing caller keep today's behaviour, because the field is off unless sent. The picked agent is also named first in the posted message, as if typed, and a name the person typed, or a quote put in front, stays in it when a mod rewrites the words (D12), because a media agent acts only on a message that names it.
- **One small desktop-shell change (Task 16).** `snapshotDrop` reads a file dropped from Finder once, at the drop, so every thread and every retry gets the same bytes. It lives in Electron's main process and preload, not the daemon, and it reads only files that were really dropped on the window.

**Tech Stack:**
- React + TypeScript (`src/`) and Electron (`desktop/`).
- Unit tests: `node --experimental-strip-types --test` (`tests/*.test.mjs`).
- Real-component Electron scenarios through `tests/helpers/electron-test.mjs`, with real input via `webContents.sendInputEvent`, as in `tests/appearance-leave-flow.test.mjs`.
- Daemon e2e: `npm run test:e2e` (fixture daemon).
- Rust: `cargo test -p apex-core -p apex-host -p apex-daemon` for Task 11a only. Run it with `TMPDIR=/tmp`: inside Deck panes, three `codex_hook` socket tests fail on the long default temp path.

**Spec:**
- The mockup is `mockups/adaptive-thread-panes.html`, built from `mockups/adaptive-thread-panes/real-app.js` and `real-mk.css`.
- `mockups/adaptive-thread-panes/README.md` lists each approved behaviour and the browser check that proves it: 12 suites, 597 checks, all passing on 2026-11-08.
- It is committed on branch `mockup/adaptive-thread-panes` (`aa2eb6bb`).
- The mockup is the reference implementation. Tasks name the mockup function to port, as `real-app.js:<fn>`.

## Changes after the user's look at the multi composer (revision 18, 2026-11-10)

- **Only the thread chips.** The user asked to "leave only the thread chips and not the thread rows above the composer." The To line no longer opens a list of `Title → agent ▾` rows. A blocked draft names its first problem in the To line instead. Each selected pane's title bar keeps its `→ agent ▾` menu, which now drops from the title bar. Task 14 is updated.
- **Found on the way:**
  - Reopening multi-send replayed the last title-bar click, so the menu (and, before this change, the rows) opened by itself.
  - Once the To line stopped being a button, the composer was 16 px shorter than the dock's resting height, leaving a band of dock under it. It now fills the dock.
  - Tests: `multi-composer-browser`, `multi-composer-frame`.

## Changes after Jigga's review of Task 8c (revision 17, 2026-11-09)

Task 8c is `8e68d1aa` on `feat/adaptive-panes`. It finishes the interrupted Task 8b review from my saved `proto8c`. `npx tsc --noEmit` passes. The full suite, tracked test files only, ran 3,532 tests: 3,527 passed, 5 skipped, none failed. Null's runs count 3,548 because `npm test`'s glob also picks up the untracked `tests/adversarial-rounds.test.mjs`.

Evidence is in `~/.cache/jigga-review/task8c/`, with my runs under `jigga/`. The scenarios ran on frozen copies: `base-8e68d1aa/` and the prototype `proto8d/`.

**What 8c fixed, measured:**
- **A hidden dock.** Add teammate and back keeps the level and every `left`, at both sizes (Null's App test).
- **A loading room.** The rest height waits for the room to load (Null's fixture test).
- **An off-screen active pane.** In Horizontal, scrolled to row 8 with Thread 0 active, these all keep Thread 8 as the top row at 1512×945 and 1100×650: typing 9 lines, clearing, pasting 9 lines in one go, and clearing again. Typing never marks the map moving (`c1-deep-typing.cjs`).

**The Focus BrowserView failure isn't from 8c.** `browser-view-focus-map.test.mjs` fails about 1 run in 4 on both `bd539f0a` and `8e68d1aa`, running one at a time on a quiet machine. 8c's new code can't run in it: the active pane there is the Focus pane, and `place()` keeps the Focus pane out of `rects`. There are three causes:
1. **The test's reset can return before the reset happens.** `fixture.reset()` takes effect on React's next render, and the settle check can poll before that. Forcing that order fails the same line, 2 runs out of 2 (`main.cjs:65`, moving on the first grow; `diag-focus/` with `DIAG=force`).
2. **`data-moving` goes off and on again as a glide ends.** Line 1307 says it lasts until 150 ms after the last glide's `transitionend`. But the 250 ms window starts at the commit, and glides start a frame or more later. Then `transitionend` arrives a frame after the glide has finished and turns a settled map back on.
   - In the timelines (`jigga/diag-observe-*.log`), the marker went off at 262 ms with 27 glides still running and came back on at 286 ms.
   - After a title drag, it went off 20 to 87 ms before the glide's end event, in 5 runs out of 5.
   - In the app, a preview beside a gliding pane can go live for a frame, show its picture again, then go live.
3. **Drag restores sit right at the 300 ms budget.** Across ten measured restores, the divider took 270 to 306 ms and the title drag 246 to 303 ms.
   - A divider drag draws without transitions, yet every move holds the Focus picture for the 250 ms glide window.
   - A title drag's picture holds through the drop glide, but the test starts timing at the release.

**A refit keeps the top row only when the active pane is off screen.** This table shows whether the first visible pane stayed put through four steps: typing 9 lines, clearing, a one-step paste of 9 lines, and clearing again (`run-c1.sh`):

| Setup | `8e68d1aa` at 1512×945 | `8e68d1aa` at 1100×650 | Prototype, both sizes |
| --- | --- | --- | --- |
| Horizontal, row 8, active pane on screen | clearing moves it 1 row | holds | holds |
| Horizontal, row 8, active pane off screen | holds | holds | holds |
| Even grid, 40 panes, row 4, active pane on screen | clearing moves it 1 row | holds | holds |
| Vertical, column 6, active pane on screen | holds | holds | holds |
| Focus left and right, side row 7, Focus pane active | clearing moves it 2 rows up | typing moves it on 7 of 9 lines; clearing moves it 3 rows up | holds |
| Focus left, side row 6, a side pane active | clearing moves it 1 row down | holds | holds |

Two causes:
- **The other refits keep a pixel offset, not a row.** When the active pane is on screen, or there is no active rect (the Focus pane has none), the refit picks the snap nearest the old pixel offset. When every row changes height by d, row N moves by N × d. Deep in the map, a clear or a paste moves it more than half a row.
- **A stale render.** The dock's new borrowed height can render before the map has measured its own new size. `place()` then picks a level for a height that never exists: when Horizontal clears, that's 2 rows of 262 px instead of 3 of 222. The refit scrolls for that level, and the real render starts from there (`jigga/c1-trace-visible.log`).

**8c's rest rule brings back a re-tile on the first Send.** Until a thread starts, its composer shows the start tray: project, files, tools and machine. The tray is 29.6 px, plus a 4 px row gap (`ChatPane.tsx:4149`).
- The first loaded composer the dock sees is often one of these, and every demo thread is one. So rest is learned as 206 px.
- The first Send, or a switch to a started thread, drops the dock to 172.6 px, and rest follows it down. The map then picks its grid again: Horizontal goes from level 7 to 8 at 1512×945 (`c2-send-shrink.cjs`, `a2-typing.cjs`).
- Before 8c, rest came from the unloaded composer, which happened to be 173 px. So revision 16's note that the grid kept its level no longer holds.

**Prototype.** `~/.cache/jigga-review/proto8d/` (diff `task8c/proto8d.diff`, 60 changed lines) fixes findings 1 to 5 in the table below, but not the tray (6). On it:
- `run-c1.sh` holds the top row in all 14 runs.
- The timelines show no marker going off and back on, in 4 runs.
- The fixed Focus test passes 10 runs out of 10: 6 in a row, then 4 at once.
- 371 of the 373 related tests pass. The other 2 need `desktop/`, which frozen copies leave out, and they fail the same way on `8e68d1aa`.
- `a4`, `a6` and `a2` (in all five layouts) give the same results as on `8e68d1aa`.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | A refit keeps the top row only when the active pane is off screen. | Every refit keeps the top row. It moves only to keep a wholly visible active pane in view. | Task 8d |
| 2 | A stale render picks a level for a height that never exists. | Layout effects skip a pass whose size doesn't match the map's measured size. | Task 8d |
| 3 | `data-moving` goes off and on again as a glide ends. | Hold it while slot animations run. `transitionend` only extends motion that's still on. | Task 8d |
| 4 | Divider restores wait out a glide window with nothing gliding. | A divider drag uses the short window. | Task 8d |
| 5 | The Focus test's reset races, and its title drag is timed from the release. | Wait for the reset to render. Time the title drag from the end of its glide. | Task 8d |
| 6 | The start tray inflates the rest height, so the first Send re-tiles. | Learn rest without the start tray. | Task 8d |

## Changes after Jigga's review of Task 8a (revision 16, 2026-11-09)

Task 8a is `26c82b20` on `feat/adaptive-panes`. `npx tsc --noEmit` passes. The full suite ran 3,546 tests: 3,539 passed, 5 skipped, and 2 failed under load. Both failures pass alone, three runs out of three (see "Flaky under load" below).

Evidence is in `~/.cache/jigga-review/task8a/`. The scenarios run on the real App through `harness/run.mjs`, against a frozen copy of the commit (`base-26c82b20/`), so edits in the shared folder can't change what was measured.

**What 8a fixed, measured on the real App:**
- **Drops (`a1-drops.cjs`).** Each drop goes to exactly one thread, or to none:

  | Drop on (Thread 0 is the target) | `472f1fb5` | `26c82b20` |
  | --- | --- | --- |
  | Thread 2's transcript | Thread 2 | Thread 2, and the dock switches to it |
  | Thread 0's transcript | Thread 0 | Thread 0 |
  | the dock's text box, or its To line | — | Thread 0 |
  | the dock, over off-screen Thread 12's box | — | Thread 0 |
  | the Focus pane, then a side pane, in Focus left | Thread 0, Thread 3 | Thread 0, Thread 3 |
  | a title bar, a gap, the Add bot form, or above the map | nothing | nothing |
- **Typing (`a2-typing.cjs`).** 9 lines in all five layouts at 1512×945, and in Even grid, Horizontal and Focus left at 1100×650. In every case:
  - the level, columns and rows never change
  - no pane moves sideways
  - no slot transition runs
  - the map is never marked moving
- **Switching (`a3-switch.cjs`).** Click back and forth between Thread 0 and Thread 3 (empty). Thread 0 holds 5 lines, then 5 lines and a file. The grid stays 4×3 throughout while the map's height changes (683 ↔ 611 ↔ 547 px). No transition runs and nothing is marked moving.
- **Add bot (`a5-addbot-to.cjs`).**
  - It floats over the panes. The map stays 672 px tall at 1512×945 and 377 px at 1100×650.
  - The form is 78% of the map's height, scrolls inside, and stays inside the window.
  - It is `role="dialog"`, and every preview re-checks for dialogs whenever the page changes (`BrowserView.tsx:56,93-94`). So a preview under it shows its picture.
- **To line.** It shows the dot, the title and `Sample · 2 agents` in the composer's column. Clicking it brings an off-screen target back. "tab" chips have square bottom corners.
- **Zoom and resize (`a6-zoom-floor-scroll.cjs`, `a4-resize.cjs`).**
  - Zoom moves between levels as usual while a 9-line draft is open, and clearing the draft doesn't re-tile.
  - A window height change still picks the grid again: 4×3 becomes 3×2 at 700 px tall.

**Three gaps remain.** Each is measured on `26c82b20`. A prototype in `~/.cache/jigga-review/proto8b/` fixes all three (diff: `task8a/proto8b.diff`, 79 lines). On the prototype, the same scenarios pass, and so do 79 existing pane, dock, BrowserView and layout tests.

1. **The dock forgets its rest height.**
   - The rest height lives inside the dock's effect. It starts over whenever the dock hides or leaves the page (Code, Library, Agents, the new-terminal picker) and whenever its width changes (window, sidebar, details panel). If the target has a long draft at that moment, the draft counts as rest.
   - Back from Code while Thread 0 holds 5 lines and a file, the map re-tiles from 4×3 to 3×2 and 11 panes move sideways. The first click on an empty thread re-tiles it back to 4×3.
   - With that draft, a window 1400 wide shows 3×2. Clearing the draft brings 4×3 back.
   - My plan's rule caused this: "It starts over when the dock's width changes, and when the dock shows a composer again after showing none."
   - Prototype: keep the smallest height for as long as the window is open. Measured: 4×3 at every step above, with 0 sideways moves.
   - Cost: on a narrower window where the composer's own rows wrap, the remembered rest can be a little short. The map is then picked for a few more pixels than it has, so panes at rest are slightly shorter. That's harmless.
2. **Rows held at 56 px can't all be reached.**
   - When a long draft squeezes a far-out zoom below the 56 px floor, the rows no longer fit. But `place()` still ends the scroll snaps where `level.rows` rows would fit (`paneArrangement.ts:164-166`).
   - Horizontal, zoomed all the way out, 9 lines, 1512×945: the map needs 357 px of scroll, but the last snap is 256. End and scrolling both stop there, so Thread 13 stays out of sight.
   - Focus left, all the way out, 9 lines, 1100×650: Threads 9 to 13 can't be reached, with 140 px hidden.
   - Revision 15 said "If the rows don't fit, the map scrolls", but the snaps didn't follow.
   - Prototype: when `world.h − region.h` is more than half a pixel past the whole-row end, the last snap is `world.h − region.h`. `floor-unit.mjs` fails on `26c82b20` (last snaps 256 and 64) and passes on the prototype (357 and 204).
3. **Typing in a scrolled map still freezes previews.**
   - The refit doesn't mark motion, but its scroll correction does. Keeping the same row on top fires a scroll event, and `readScroll` (`PaneMap.tsx:422-428`) marks the map moving. Every docked preview then shows its picture for at least 150 ms.
   - Even grid, scrolled one row down, 6 lines typed: the map is marked moving on lines 2 to 6.
   - At the top of the map nothing scrolls. That's why the BrowserView test, which runs Focus left at scroll 0, passed.
   - Prototype: remember where a refit's own scroll correction lands, and don't mark motion for the scroll event at that spot. Measured: no moving frames on any of the 6 lines, with the same top row.

**Small:**
- **"1 agents".** The To line always says `N agents`. The mockup says `1 agent`, and `No agents yet` for none (`real-app.js:35`).
- **Four Step 1 checks have no test:**
  - switching back and forth with a 5-line draft and a file
  - Send restoring every slot
  - the 1512×700 resize
  - a preview under Add bot

  My probes above cover them by hand, and they pass. Task 8b adds the first three to the App scenario. The fourth is the generic dialog rule and needs no new test.
- **The first Send in a new thread.** The project and machine row under its box goes away, so the dock gets 33 px shorter for good and the map grows by that much. The grid kept its level in every layout. This is the rest rule working as meant, not a defect. Tests that compare rects across a Send should send once first.

**Flaky under load** (each passes alone, three runs out of three):
- **`composer-dock-browser.test.mjs`: the caret after an external insert is 4, not 16.**
  - The test dispatches the insert from a script, outside any click. React then mounts B's composer in a later task. When a frame comes first, the caret set in `requestAnimationFrame` (`ChatPane.tsx:921`) finds no text box, and the mount then puts back the old caret (`:897-906`).
  - Forcing that order in the real App gives caret 4 every time (`a9-caret-race.cjs`). In natural order it is 16, 10 times out of 10.
  - Both of the app's callers are React clicks: Files (`RightFiles.tsx:161`) and a file's preview (`FilePreview.tsx:41`). Files also only names the focused thread, which is already the target. So users don't hit this today.
  - Fix it in the app anyway, since a future caller from outside a click would hit it: give the wanted caret to the mount's restore. Discuss (`:2310`), Use tool (`:2671`) and examples (`:2812`) set the caret the same way.
- **`layout-picker.test.mjs`, Shift+Tab (`:108-110`).** It reads `aria-expanded` once, right after the key. The test is unchanged since Task 5. Wait for the state instead.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | The dock forgets its rest height when it hides or its width changes. | Keep the smallest height while the window is open. | Task 8b |
| 2 | Rows held at 56 px can't all be reached. | The last snap reaches the end of the rows. | Task 8b |
| 3 | Typing in a scrolled map freezes previews. | A refit's own scroll isn't motion. | Task 8b |
| 4 | "1 agents". | Use the mockup's wording. | Task 8b |
| 5 | Three Step 1 checks have no test. | Add them to the App scenario. | Task 8b |
| 6 | Two tests fail under load. | Caret through the mount's restore; wait for the menu's state. | Task 8b |

## Changes after Jigga's review of Tasks 7b and 8 (revision 15, 2026-11-09)

Task 7b is `472f1fb5` and Task 8 is `ab166a12`, both on `feat/adaptive-panes`. On `ab166a12`, `npx tsc --noEmit` passes, and so do the committed tests: 3,521 tests, 3,516 passed, 0 failed, 5 skipped. Null's 3,532 also counted another thread's uncommitted `tests/adversarial-rounds.test.mjs`.

**The Mac restarted at about 23:35 on 2026-11-08 and emptied `/tmp`.**
- The scratch files that revisions 11–14 name are gone: `/tmp/jigga-*` and Null's `/tmp/apex-task7a-app/`. That includes Task 7b's prototype.
- The evidence for this revision is in `~/.cache/jigga-review/`, which survives a restart:
  - `harness/run.mjs` drives the real App in a hidden Electron window, through the repo's own Vite config, on the browser demo backend. Two test hooks are patched into the demo backend in memory: `onFileDrop` keeps each pane's drop callback in `window.__drops`, and `copyAttachment` records `[room, path]` in `window.__copies`. Nothing is written to the repo.
  - Run it with `node ~/.cache/jigga-review/harness/run.mjs <scenario.cjs> <width> <height>`. `REPO=<folder>` points it at another copy of the app.
  - `base-472f1fb5/` holds `472f1fb5`'s app files, for before-and-after runs.
  - `task8/` holds the scenarios below (`s1-drop-reflow.cjs` to `s6-look.cjs`), their logs and their screenshots.

**Task 7b passes.** In the real App at 1512×945, with 14 threads:
- **Glide.** Switch Even grid → Focus right with Thread 5 active. In the first frame after the switch, at 21 ms, Thread 5 is at (316, 227) in the map, where it was drawn. It glides to (532, 0) at 723 px wide (`s2-details.cjs`, T1).
- **Divider.** In Focus left, hold the divider and move it right 20 px per frame, six times. The Focus pane is 743, 763, 783, 803, 823 and 843 px wide after each move, with no lag (`s3-switch-divider.cjs`, T2).
- **Preview.** Review Focus 32 is pinned by Null's `tests/browser-view-focus-map.test.mjs`, which passes.
- **Code.** I read it against Task 7b:
  - The glide reads the drawn rects before React changes how a slot is positioned. It animates `top` and `margin-left` on the way in, and `left` and `top` on the way out, with `element.animate()`.
  - It cancels on unmount, when a drag starts and while the divider is held. It skips full screen and reduced motion.
  - `.pane-map.resizing .pane-map-slot` weighs the same as the pinned slot's rule and comes after it, so it wins.

**Task 8 keeps drafts as planned.** Each thread keeps its own words, caret and scroll. A popped-out thread is never the target. Talk-only chats and pop-out windows keep their own composer. Five problems remain, and the first three are visible to the user.

1. **A file dragged from Finder onto a thread no longer attaches.** It only attaches if it lands exactly on the docked composer.
   - `attachDropped` (`ChatPane.tsx:2574-2584`) checks the drop point against `composer.current?.parentElement`. Before the dock, that was the whole thread (`.chat`). Now it is `.composer-dock-slot` for the target thread, and nothing for every other thread.
   - Measured with 14 threads and Thread 0 as the target (`s1-drop-reflow.cjs`):

     | Drop on | `472f1fb5` | `ab166a12` |
     | --- | --- | --- |
     | Thread 2's transcript | Thread 2 | nothing |
     | Thread 0's transcript | Thread 0 | nothing |
     | the dock | — | Thread 0 |
2. **The map rearranges itself while you write.** The dock sits under the map in one column, so every pixel the composer grows comes off the map, and the map picks its grid again from its new height.
   - Measured with 14 threads in Even grid at 1512×945 (`s1-drop-reflow.cjs` with `SKIP_DROP=1`):
     - With an empty composer, the map is 683 px tall and shows 4×3, which is 12 threads.
     - Lines 2 to 4 each make every pane 4 to 7 px shorter.
     - At the 5th line the map is 611 px tall. It re-tiles to 3×2, which is 6 threads, and every pane moves sideways: Thread 1 jumps from 308×205 at x 569 to 413×302 at x 674.
     - Send brings 4×3 back.
   - One attached file takes 64 px: 683 → 619 px.
   - Clicking between a thread with a 2-line draft and a thread with none resizes every pane on each click, 683 ↔ 671 px (`s3-switch-divider.cjs`). Near the threshold, that click re-tiles the map.
   - **Add bot in the dock is the worst case.**
     - Its "Who's in this thread?" form makes the dock 763 px tall. The map shrinks to 126 px and shows one cut-off pane (`s5-quickadd.cjs`, `s5-quickadd.png`).
     - The mockup floats this form over the panes on purpose: "grows upward over the panes. Nothing reflows" (`real-app.js:3043`).
   - **The mockup does the same, but much later.** Its composer also takes its height from the map. From the mockup's starting layout, though, the grid only re-tiles at the 7th line. With 14 threads at 1512×945, the real app sits right at the grid's 200 px comfort threshold.
3. **The To line isn't the mockup's, and it can't take you to its thread.**
   - In the mockup, the To line sits in the composer's column above the box. It shows the thread's status dot, its title and `project · N agents`, and clicking it brings the thread into view (`real-app.js:2424-2431`, `:2744`, `real-mk.css:38-46`).
   - The real line sits at the dock's left edge, shows the title and project only, and does nothing when clicked.
   - This matters because a file's Add to chat can make an off-screen thread the target: `onWantComposer` only sets focus.
4. **"tab" agent chips lose their square corners in the dock.**
   - With that chip style, the docked composer box keeps rounded bottom corners (12 px), where the tabs attach. On `472f1fb5` the corners are 0 (`s2-details.cjs`).
   - `bot-chip-styles.css:43` reads `data-bot-chip-style` from the `.chat` around the composer, and the portal leaves that element behind.
5. **The new browser test checks its own copy of the target rules, not App's.**
   - Its `Fixture` (`composer-dock-browser.test.mjs:22-25`) sets the target itself. So App's `composerTarget` and `onWantComposer` (`App.tsx:854-865`) have no test: the most-recent-thread fallback, the popped-out exclusion and the toast.
   - Step 1's Ctrl+wheel check and its chip-row refit check are missing too.

Smaller:
- **Two notices.** `showComposer()` shows "That thread is open in its own window." inside the pane whenever `onWantComposer` says no (`ChatPane.tsx:890-898`).
  - App already shows that toast, and the pane's own copy is hidden.
  - For a thread that isn't listed, the words are wrong.
  - Only App should speak.
- **Known limit, not a fix: ⌘Z forgets.** Undo history for a draft is lost when you switch threads and back, because the text box is rebuilt. The words, caret and scroll are kept.
  - In `s2-details.cjs`, ⌘Z after a switch leaves "undo-me" in place. On `472f1fb5` it removes it.
  - Keeping every composer mounted would fix it, but it would undo Task 8's one-composer design. Not worth it unless the user asks.

Checked and fine:
- **Where the dock shows.** Only in Threads. It hides when nothing is targeted: in Code, in Library, in the new-thread picker and in Agents.
- **Events from the dock.** React passes them up to the target pane's ancestors, but none of those react to typing, clicks or drags in the dock:
  - The pane's `onMouseDown` only focuses the target thread again.
  - PaneMap's capture handler ignores anything outside a slot's head.
  - PaneMap's key handlers need the map itself to be focused.
- **The `+` menu.** It opens upward over the map and stays inside the window at both sizes (`s6-look.cjs`). It is `role=menu`, so a live preview under it steps aside.
- **Look at 1512×945 with 6 threads.** A 3×2 grid, one dock, and "To: Thread 4" naming the outlined pane (`s6-big-dock.png`).
- **Look at 1100×650.** The dock is 206 px of the window's 650, so the map opens on 2 threads. That's the design's cost on a small window, not a defect.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Finder drops land nowhere unless they hit the dock. | Hit-test the thread itself: its `.chat`, clipped to the visible map, or the dock for the target. A drop on another thread makes it the target first. | Task 8a |
| 2 | The map re-tiles while you write, attach or switch threads, and Add bot squeezes it to one pane. | The map picks its grid as if the composer were at rest. Growth only makes panes shorter. The Add bot form floats over the panes. | Task 8a |
| 3 | The To line isn't the mockup's, and it can't find its thread. | Use the mockup's To line. Clicking it reveals the thread. | Task 8a |
| 4 | "tab" chips lose their square corners in the dock. | Read the chip style from the composer itself. | Task 8a |
| 5 | App's target rules have no test. | Move them into a pure function and test it. Add Step 1's two missing checks. | Task 8a |

Tasks 14 and 16 inherit Review Focus 34 and 35. The multi composer's growth must not re-tile the map, and its file list floats.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Jigga's review of Task 7a (revision 14, 2026-11-08)

Task 7a is built as `6be84694` on `feat/adaptive-panes`. On that commit the full suite passes (3,514 passed, 0 failed, 5 skipped), and so does `npx tsc --noEmit`. The seven revision-13 findings are fixed. The revision-13 scratch scenarios (`/tmp/jigga-int/`), rerun against `6be84694`:
- A fixed pop-up lands on its point in `p0`, `p5` and `p10`, and a fixed `inset: 0` layer covers the whole 1200×800 window (`scenario3.cjs`).
- The Focus pane moved in 0 of 24 drawn frames while the side panes scrolled 24 wheel steps down and back (`scenario2.cjs`). On `d775c6c1` it moved in 22 of 27.
- 12 wheel steps rendered 6 probes: only the panes that came on or went off screen. On `d775c6c1`, every mounted pane rendered once per scroll event.
- A drag-out pops out with the order `p0,p1,p2,p3`, where `d775c6c1` gave `p1,p2,p3,p0`.
- Zoom keys pressed on a pane's button do nothing.

A new sweep mounts the real `BrowserView`, with a stub `BrowserApi`, in all 14 panes (`/tmp/jigga-7a/s7a.cjs`, part T4). It covers all five layouts at every zoom level, scrolled to the start and to the end, at 1200×800 and 1100×650: 178 cases and 2,492 pane checks. In every one, no live page was outside the map, every preview fully inside the map showed live, and every live page sat at its placeholder's rect.

Three problems remain. One comes from `d775c6c1` and my last review missed it. Two follow from rules that revision 13 set. The fixes are the new Task 7b, before Task 8.

- **A pane jumps into and out of the Focus slot** (from revision 13). The sticky Focus slot is placed by its sticky inset and `margin-left`, and only `margin-left`, `width` and `height` glide (`styles.css:516`).
  - When a pane becomes the Focus pane, it jumps to the top-left corner of the map and then grows (Focus left) or slides right (Focus right). When it stops being the Focus pane, it jumps to the left edge.
  - Measured frame by frame in the fixture (`s7a.cjs`, T1):
    - Even grid → Focus right: `p5` went from (302, 269) to (0, 0) in one frame, then slid to (509, 0).
    - Even grid → Focus left: from (302, 269) to (0, 0) in one frame.
    - Focus right → Even grid: from (509, 0) to (0, 0) in one frame.
  - `d775c6c1` glided all three with its transform, and so does the mockup (`real-app.js:glide`, `:1534-1544`). Focus left ↔ Focus right still glides.
- **The Focus divider trails the pointer** (from `d775c6c1`). The 220 ms glide stays on while the divider is held, and every move starts it again.
  - Six moves of 20 px, one frame apart, left the Focus pane at 691 px while the divider asked for 711 up to 811 (`s7a.cjs`, T2). It catches up only 220 ms after the pointer stops, and the side panes trail the same way.
  - The mockup turns the glide off while a divider moves (`real-app.js:2092`: "one layout per frame, no glide").
- **A preview in the Focus pane freezes while the side panes scroll** (from revision 13). Task 7a covers a docked preview while its map is `data-moving`, and every scroll sets that.
  - The Focus pane is sticky, so it never moves during a scroll. Its live page still swaps to a picture and back twice per scroll gesture: once for the wheel, and once for the snap that ends it.
  - In the fixture, 12 wheel steps froze it for about 1 s: `hide` at 57 ms, `show` at 410 ms, `hide` at 877 ms, `show` at 1,086 ms (`s7a.cjs`, T3).
  - In the app, each swap is a `capturePage`, and a video or animation in the page stops while the picture shows.

Checked and fine:
- **Reduced motion.** The pinned slot's computed transition is `0s`, through the global rule at `styles.css:1622`.
- **The side panel's Esc listener, now in the capture phase.** Every pop-up inside the side panel that stops Esc (the review Ask menu in `DiffPanel`, `WorkBar`'s pop-ups, `AssistantHandoff`) has `role="menu"` or `role="dialog"`. The listener already leaves those alone.
- **`restoreOrder`**, read against the plan's examples.
- **The deleted split-tree code.** Nothing outside tests used it, and `restoredLayouts` still prunes old trees through `normalize`.
- **Null's full-App fixture** (`/tmp/apex-task7a-app/`): the actual App with 14 synthetic threads, a terminal and a real `WebContentsView`, all five layouts at both sizes. I looked at the 1512×945 contact sheet. It stands in for Step 5's look. The real `electron .` shell, preload and daemon haven't been looked at yet.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | A pane jumps into and out of the Focus slot. | It glides from where it was drawn. The Web Animations API animates the properties that place it: the sticky inset and `margin-left` on the way in, `left` and `top` on the way out. No transforms. | Task 7b |
| 2 | The Focus divider trails the pointer. | No glide on any slot while the divider is held. Title drags keep their glide. | Task 7b |
| 3 | A preview in the Focus pane freezes while the side panes scroll. | The map marks the Focus pane as moving only when the Focus pane itself moves, or something can pass over it. | Task 7b |

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Jigga's review of Tasks 4–7 (revision 13, 2026-11-08)

Tasks 4–7 are built as `d775c6c1` on `feat/adaptive-panes`. On that commit the full suite passes (3,519 passed, 0 failed, 5 skipped), and so does `npx tsc --noEmit`. The geometry, zoom wiring, migration, picker and title bar do what their tasks say, and the revision-12 zoom scenarios are in the suite. A scratch Electron fixture that mounts the real `PaneMap` (`/tmp/jigga-int/`: `fixture.jsx`, `run.mjs`, `scenario*.cjs`, `results*.json`) found four problems the tests don't reach, and three smaller ones. Two of them come from this plan: Task 4 said to move panes with `transform` and allowed pinning the Focus pane with "anything else" than `position: sticky`. The fixes are the new Task 7a, before Task 8.

- **Pop-ups inside a pane land in the wrong place.** Every slot is placed with `transform: translate(…)` (`src/PaneMap.tsx:340-341`). A transformed element becomes the containing block for `position: fixed` descendants, so anything inside a pane that places itself with screen coordinates is placed against its pane instead.
  - In the 1200×800 fixture, a fixed element meant for screen point (342, 329) inside `p5` (at 302, 269) drew at (644, 598). One inside `p10` drew at (1248, 1138), outside the window. A fixed `inset: 0` layer covered only its own 294×261 pane (`scenario3.cjs`, `results3.json`).
  - In the app that moves the selection toolbar, Add to chat / Explain (`ChatPane.tsx:1886,3774`, `.selection-actions`), and the right-click menu on links and paths (`RichText.tsx:88,106`, `.link-menu`). A Preview pane's full window (`PreviewPane.tsx:171`, `.preview.full-window`) fills only its pane. Only the top-left pane at scroll 0 is unaffected.
  - The old layout placed panes with `left`/`top` (`PaneLayout.tsx:16-23`), so this is new in Clay, the user's theme, and Classic. Glass already blurs `.pane` with `backdrop-filter` (`glass-theme.css:99-103`), which traps pop-ups the same way; this plan doesn't change that.
- **The Focus pane shakes while the side panes scroll.** `readScroll` moves the pinned slot from a scroll listener (`PaneMap.tsx:290-302`). The listener runs after the compositor has drawn the scrolled frame, so the Focus pane is first drawn out of place.
  - Frames captured from an offscreen window while the side region took 24 wheel steps down and back (`scenario2.cjs`): the Focus pane was out of place in 22 of 27 frames.
  - A control page under the same input: an element moved by a scroll listener was out of place in 32 of 38 frames, and a `position: sticky` one in 0 of 38.
  - The Focus divider moves the same way (`:300,345`).
- **Every scroll re-renders every pane.** `readScroll` keeps the scroll in React state (`setOffset`, `:301`). Each scroll event re-renders PaneMap, which calls `renderPane` for every mounted pane (`:335-343`), and nothing in between is memoised. So every ChatPane, terminal and preview in every section renders again.
  - In the fixture, 4 scroll events gave 64 renders: all 16 mounted panes each time, the 2 that were hidden throughout included (`results.json`, `A_rendersPerScroll`).
  - Each title-drag pointer move does the same (`setDragging`, `:97`).
  - This measures how often panes render, not how long a real ChatPane takes. But the map's wheel listener isn't passive (`:271`), so each wheel step waits for that work before the page scrolls.
- **A docked web preview draws outside the pane map.** A Preview pane's page is a native view placed over the pane's full rect (`BrowserView.tsx:45,57-63`, `browserGeometry.ts:15-22`, `desktop/browser.mjs:166,177`). Native views draw above the whole page and aren't clipped by the map. Panes never scrolled or glided before this commit, so it didn't matter. Now:
  - a preview partly scrolled out of the map, or caught mid-glide at its edge, draws over the title bar, the sidebar or the Details panel;
  - after a glide that only moves it (a reorder, a pane added first, a pop-out coming back), the view follows the first two frames and then waits for the one-second fallback (`BrowserView.tsx:78-80,95`), covering a neighbour meanwhile;
  - a dragged pane passes under it.
  - This one is from the code. No fixture has a native view, and the real app hasn't been looked at yet.

Smaller:
- **Dragging a pane out of the window keeps the reorder.** The drag reorders live, and a release outside the window pops the pane out without putting the order back (`PaneMap.tsx:139-146`). App takes the return spot from that order (`App.tsx:1504`). In the fixture, dragging `p0`'s title over `p1`–`p3` to (1230, 150) gave the pop-out the order `p1,p2,p3,p0,…`, so `p0` would come back 4th. Near the bottom edge the edge scroll can carry it to the end. Today a drag-out leaves the layout as it was.
- **Zoom keys work from any button in a pane.** Only the arrow, Page, Home and End keys check that the map itself has focus (`PaneMap.tsx:319-322`). With a pane's button focused, `-` zoomed out and `0` zoomed back (`D_keysFromPaneButton`). Task 4 says "with the region focused", and the mockup checks `e.target === mapEl` (`real-app.js:1805`).
- **Full screen loses your place.** While a pane is maximized the map scrolls to 0 (`PaneMap.tsx:170`). Restoring scrolls from 0 only as far as the active pane needs, so you can come back to different rows.

Checked and fine: the voice capsule moving between the title bar and the composer (`PaneVoicePortal`) remounts only controls, since the call lives in `useCall`'s store. `held` takes the new point each step, as the mockup's `ptrPick` does (`real-app.js:1076`). Grid → Focus keeps the zoom, as the mockup's `setLayout` does (`:2853-2857`). Restricted-session filtering drops `arrangements` (read, not rerun).

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Pop-ups placed with screen coordinates inside a pane are placed against the pane, because every slot has a `transform`. | Slots placed with `left`/`top`. Nothing between the map and a pane makes a containing block. | Task 7a, Global Constraints |
| 2 | The Focus pane and its divider are moved from a scroll listener and shake while the side panes scroll. | Sticky Focus slot. Divider outside the scroller. | Task 7a |
| 3 | Every scroll event and drag move re-renders every mounted pane. | Scroll position out of React state. Slot content memoised. | Task 7a |
| 4 | A docked preview's native view draws outside the map while panes scroll, glide or drag. | Its picture while the map moves or the pane isn't fully inside. Bounds checked again when a glide ends. | Task 7a |
| 5 | A drag-out keeps the live reorder, so the pane returns in the wrong place. | Put the order back before popping out. | Task 7a |
| 6 | Zoom keys act from buttons inside panes. | Only with the map focused. | Task 7a |
| 7 | Full screen and back loses the map's scroll. | Remember it. | Task 7a |

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Jigga's review of Task 3a (revision 12, 2026-11-08)

Task 3a is built (`a0473a75`) and does what it says. Run against the committed code, its `zoomScroll` matches the mockup on all 18,273 steps of the revision-11 sweep (`/tmp/jigga-3a/anchor-sweep-committed.mjs`), and `/tmp/jigga-found/stress.mjs` holds on 20,000 runs, the `NaN` share included. Checking it turned up one weak test, and five places where Task 4 wires zoom differently from the mockup. None of them changes `src/paneArrangement.ts`.
- **One Task 3a test doesn't test what it says.** "Zoom keeps the whole selected group visible…" passes `at = 130`, where the point alone already shows both panes. No other test reaches the group rule or the last line either. With `zoomScroll`'s `scrollFor` call replaced by the bare point rule, all 24 tests in the two files still pass (`/tmp/jigga-3a/mutate.mjs`). Task 3a Step 6 fixes the test: `at = 700`, where the point alone gives 404 and cuts `p9` off, and `p13` at `at = 0`, where it gives 1616, past the last line (1212). The fixed test fails against that mutant and passes against `a0473a75` (`/tmp/jigga-3a/tfix/`).
- **Keys ignored a pointer resting on the map.** Task 4 passed `pointerId: null` for every key. The mockup's keys use the pointer while it is over the map (`zoomBy` → `zoomFocus`, `lastPtr`, `real-app.js:1104-1107,1192-1194,1769,1781`), exactly as a wheel there does. So once the selected panes can't all fit, or the Focus pane is the active one, `-` and `=` zoom toward what is under the pointer. A port of the mockup's `zoomFocus` and `setFlatZoom` was run against the committed code, wired as Task 4 said, over 60,000 random steps and two seeds (`/tmp/jigga-3a/sweep-groups.mjs`). Task 4 as written differed from the mockup in 92% of key steps with a spread selection and the pointer on the map, and in 46% with the Focus pane active.
- **Keys with nothing to follow came out one line high.** With the Focus pane active and the pointer off the map, the mockup keeps the centre pane where the region's middle point puts it (`sx, sy = vw / 2, vh / 2`, `real-app.js:1108`, so `⌊visible / 2⌋`). Task 4 passed `at = null`, which gives `⌊(visible − 1) / 2⌋`, one line higher whenever an even number of lines is on screen: 48% of those steps. `null` stays right for the middle selected pane, which the mockup centres that way (`real-app.js:1084`).
- **A pointer over a gap had no pane.** Task 4 didn't say what `pointerId` is between panes. The mockup takes the first pane of the line under the pointer (`rowAnchorAt`, `real-app.js:1049,1058`). Reading it as `null` changed 2% of wheel steps.
- **The held target was never supplied.** `chooseAnchor` takes `held` (Task 3), but Task 4 never said where it comes from, so PaneMap would always pass `null`. The mockup keeps zooming toward the pane it picked while the pointer stays within 4 px (`ptrPick`, `real-app.js:1057-1058,1076`; README "sticky while the pointer stays still", checked by `verify-active-zoom.mjs:118`). Without it, 17.9% of 2–4-step zooms with a still pointer and a spread selection changed target partway, as columns slid another pane under the pointer (`/tmp/jigga-3a/held-steps.mjs`).
- **A ctrl-wheel over the Focus pane zoomed the side region.** In the mockup it does nothing there except stop page zoom (`real-app.js:1747`). The Focus pane has its own box, outside the map (`:1494-1495`).

With the revised wiring, the sweep matches the mockup everywhere except two cases, both kept on purpose:
- **Vertical, with the selected panes all off screen** (1,877 and 1,844 steps in the two runs). The mockup pins the middle pane's x to the screen's edge (`real-app.js:1114`), yet centres an off-screen group on the y axis. Task 4 centres on both axes. No test may be written against the mockup here.
- **The Focus pane active, keys, and the region's exact centre in an 8 px row gap** (98 and 87 steps). `centreId` takes the nearest pane, and the mockup takes the line above the gap. Both are the middle of the screen.

One more difference is on purpose, and the single-step sweep can't see it. The mockup holds its pointer pick only for a selection too spread to fit (`real-app.js:1073-1077`). Task 4 also holds it while the Focus pane is the active one, because a pane can slide under a still pointer there too.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | No test pinned `zoomScroll`'s group rule or last line. | The group test uses `at = 700` and adds `p13` at `at = 0`. | Task 3a Step 6 |
| 2 | Keys ignored a pointer resting on the map. | Keys use the resting pointer as a wheel does. | Task 4 |
| 3 | Keys with nothing to follow came out one line high. | `at` is the region's middle for the `centreId` pane. | Task 4 |
| 4 | `pointerId` over a gap was undefined. | The first pane of the line under the pointer. | Task 4 |
| 5 | `held` was never supplied. | The last pointer pick, while the pointer stays within 4 px. | Task 4 |
| 6 | A ctrl-wheel over the Focus pane zoomed the region. | It only stops page zoom. | Task 4 |

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Jigga's review of Tasks 1–3 (revision 11, 2026-11-08)

Tasks 1–3 are built on `feat/adaptive-panes` (`50174428`, `8e6fe70e`, `1dffaba3`) and do what their tasks say. Reviewing them against the mockup found the gaps below. The code changes go in the new Task 3a, before Task 4.
- **Zoom kept its anchor on screen, but not in place.** Task 3's `scrollFor(next, anchor, current)` is given only the new placement and the old scroll. Of the scrolls that show the anchor, it picks the one nearest the old scroll. Lines change size between levels, so that is often the other end of the screen. The mockup keeps the anchor's line at the same fraction of the screen (`real-app.js:setFlatZoom`, `topRow = row − ⌊visible × ay / span⌋`).
  - Example: 14 panes in 1200×800, one level in (3×3), scrolled to the end, so p6 is on the top line. Zoom in to 3×2. `scrollFor` scrolls to 404 and p6 lands on the bottom line. The mockup scrolls to 808, and p6 stays on top.
  - In 18,273 random zoom steps at random scroll positions (`/tmp/jigga-found/anchor-sweep.mjs`), 10,312 put the anchor on a different line of the screen than the mockup: 50% of steps in, 62% of steps out. A prototype of Task 3a's rule matched the mockup on all of them (`anchor-sweep-fixed.mjs`, `zoom-scroll-proto.mjs`).
- **The middle selected pane, not the first.** With no pointer, and selected panes that no longer fit, the mockup keeps the middle one in view (`act[⌊(n − 1) / 2⌋]`, centred). Revision 10 said the first. Task 3's existing test (`['p0', 'p13']` gives `p0`) has the same answer under both rules.
- **A pane you add went last, out of sight.** `validArrangement` appends the panes it finds missing. That is right for restored panes. But a pane you add would then sit below the fold once there are 13 or more, focused and unseen. Today `sync` makes room for it on screen by halving the largest pane (`addLeaf`, `src/layout.ts:129`), and the approved mockup puts a new thread in the first slot (`real-app.js:newThread`). Task 4 now does what the mockup does.
- **`insertIndex` takes the scroll** (built in `1dffaba3`). Its point is relative to the pane area as seen on screen, and an optional fourth argument is the region's scroll on `p.axis`. The Focus pane doesn't scroll. Null added this after their own review found a scrolled grid picking pane 10 instead of 13. It is recorded in Task 3, and Task 6 passes the scroll.
- **`place` threw on a `focusShare` that isn't a number.** `NaN` made the Focus width `NaN` and the side region empty, so `place` read `levels[-1]`. `validArrangement` already stops a stored one. `place` now falls back to 0.58 as well, so a divider bug can't take the pane map down.
  - This was the only failure in `/tmp/jigga-found/stress.mjs`. Otherwise, 20,000 random placements in all five layouts kept every rule: no overlaps, every pane reachable on a snap, and every drag target right.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | A zoom step kept the anchor on screen but moved it to another part of it, in about half the steps. | `zoomScroll(next, anchor, at)` ports the mockup's rule, and PaneMap uses it for every step. | Task 3a, Task 4 |
| 2 | With no pointer, zoom kept the first selected pane, not the middle one. | `chooseAnchor` step 4 takes the middle active id, in pane order. | Task 3a |
| 3 | A pane you add went last, off screen. | It goes first, and the region scrolls to it. | Task 4 |
| 4 | `insertIndex` needs the region's scroll. | An optional `scroll` argument, already built. | Task 3, Task 6 |
| 5 | `place` threw on a `NaN` focus share. | It falls back to 0.58. | Task 3a |

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's ninth review (revision 10, 2026-11-08)

The one finding was checked against the code before it was fixed, and it held. Checking it turned up a third case the review didn't name.
- **Where it comes from.** A quote's lead depends on the words beside it. `quoteLead` leads with the quoted agent only when the words name no one, and `@all` counts as naming someone (`src/reply.ts:26-28`, `hasMention` at `src/recipients.ts:52`). Revision 9 worked the lead out twice. `send()` did it from the typed words, for the routing text. `submitDraft` step 5 did it again from the mod's rewrite, for the posted text. A rewrite that names someone the typed words didn't, or takes `@all` out, makes the two disagree. (A typed agent name a mod takes out is put back first, by `keptNames`, so it can't.)
- **A lead dropped.** Quote a reply of Allison's and type `look at this`. The routing text leads with `@allison`, so Allison answers. A mod rewrites the words to `look at this @null`. Step 5 sees a name, so it leads with no one and posts `look at this @null` to Allison. Her media check finds no `@allison` and passes, with no price card.
- **A lead brought in.** Quote a reply of Allison's and type `@all look at this`. The routing text leads with no one, so everyone answers. `@all` never lets a media agent spend (`apex_core::names`, `crates/apex-core/src/mention.rs:185`). A mod takes `@all` out. Step 5 then sees no name and posts `@allison look at this`, so Allison shows a price card nobody asked for.
- **A picture with no words (found while checking).** Quote a reply of Allison's, attach a picture and type nothing. The routing text is `@allison` and the quote, so Allison answers. Step 5 builds the quote only when there are words (`named.trim() && …`), so only the picture line posts. Today drops the quote here too (`hooked.text && …`, `ChatPane.tsx:2739`). But today the picture also goes to the thread's default, because the queue routes on the posted text (`:1715`). Revision 9 sent Allison a bare picture that doesn't name her.

Evidence, in `/tmp/jigga-rev10/`:
- `proto/src/reply.ts` is a copy of `src/reply.ts` with `replyText` split into `replyLead` and `replyWith` (`reply-split.diff`). The 15 tests in `tests/reply.test.mjs` pass against it unchanged (`reply-tests-out.txt`).
- `quote-lead.mjs` runs the real `replyText`, `quoteTarget`, `mentionedWords`, `mentionFor` and `postable`, and the prototype's split. It has 10 cases, then 200,000 random sends, 134,119 of them under one or two quotes. The quotes are an agent's, your own, or a departed agent's, with and without Send to ▾. Results (`quote-lead-out.txt`):
  - Revision 9's step 5 lost a name the routing text had in 14,438 of those sends. In 5,916 it posted a name that neither the person nor the mod wrote.
  - With the fix, none of the sends do either. Each posted text starts with exactly the routing text's lead.
  - With no mod, the posted text is today's, character for character, except for a send with no words under a quote that leads with an agent.
  - The split `replyText` gives today's text on all 200,000.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Step 5 worked a quote's lead out again from the mod's rewrite. A rewrite that names someone dropped the quoted agent's `@name`, so a media agent that answers passed silently. A rewrite that takes `@all` out brought the quoted agent's `@name` in, so it showed a price card nobody asked for. | **A quote's lead is chosen once, at Send, from the typed words, and posted as it is (D12).** `replyLead` gives the `@handle ` the routing text starts with, or `''` for no one. `submitDraft` carries it as `d.lead`, and step 5 posts `replyWith(named, d.replies, d.lead)`. A rewrite can then neither drop the lead nor bring one in. With no words left, because a mod blanked them or only a picture was sent, the lead and the quote still post, as a typed name does since revision 9. `shared/media-naming.json` gets two quote cases. | D12, Tasks 11a, 12 |

**Why the text and not the agent's id.** The lead is kept as the exact `@handle ` text. It isn't kept as an id and turned back into a handle at posting. The routing text holds the same text, and the queue reads recipients from it when the message's turn comes and again just before posting. So the quoted agent can be renamed or leave while the message waits, and the routing text and the posted text still name the same agent, or no one.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's eighth review (revision 9, 2026-11-08)

Both findings were checked against the code before they were fixed, and both held.
- **Move while popped out.** The sidebar offers Project › on every thread row, popped out or not (`projectEntries`, `App.tsx:2476`), and picking a project calls `moveDraft` (`:2357-2363`). Revision 8's `moveDraft` asked `apis.get`, which has nothing for a popped-out pane, so it neither waited nor suspended anything. It couldn't have reached the right queue anyway: that queue lives in the pop-out window's own renderer (`PopoutApp.tsx:425`).
- **Pop out while moving.** `popOutPane` never looks at `moving`, and a suspended empty queue counts 0. The window it opens is given the old machine (`hostId` in its snapshot, `App.tsx:1476`), and `placeThread` deletes the old machine's copy once the new one is in (`threadMove.ts:80`). What is sent from that window in between is deleted with it.
- **Why refusing beats suspending.** A pane's pop-out window never learns a new machine. App pushes it `workspaceId` and `chatConfig`, but `hostId` only to tab windows (`App.tsx:1656-1669`), and the window posts through `hostId` (`PopoutApp.tsx:158,231-240`). So a popped-out thread that moved would go on posting to the deleted copy, even with an empty queue.
- **Media.** Under D10, who answers comes from what was typed, but what posts is the mod's rewrite (`ChatPane.tsx:2737-2739`), and the media agent looks for its name in what posts (`named_by_person`, `media.rs:114`). D10 made this case new: today the queue routes on the rewritten text (`ChatPane.tsx:1715`), so the same mod sends the message to the thread's default instead of Allison. A quote makes it worse. `quoteLead` leads with the quoted agent when the body names no one (`reply.ts:26-28`), so a quote of Null's reply would post `@null look at this` to Allison.

Evidence, in `/tmp/jigga-rev9/`:
- `exclusive.mjs` models `popOutPane`, `moveDraft` and `placeThread` over 4,000 random orderings of Pop out, Move and sends from the window. Without the two refusals, 2,589 orderings lose a message sent from the window or leave the window on the old machine. With them, none do (`exclusive-out.txt`).
- `restore.mjs` runs the real `mentionedWords`, `mentionFor` and `replyText`: 13 cases, then 100,000 random pairs of typed text and mod rewrite. Every agent the typed text names is named in what posts. When a rewrite loses no name, the posted text is revision 8's, character for character (`restore-out.txt`).
- The two existing Rust tests that pin the media rule pass on this tree. `@allison a whale` gets one `Make a video · $2.91` card, and text that names no one, or names `@all`, passes with no card (`rust-media.txt`).

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Move and Pop out weren't exclusive. The sidebar's Project › could move a popped-out thread, because `moveDraft` asked `apis.get`, which has nothing for a hidden pane: it neither waited for the window's queue nor suspended it. And Pop out worked during a move, because a suspended empty queue counts 0. A message sent from the new window was deleted with the old copy. | **Each refuses while the other is on (D11).** Both ask `ownerRefusal` before they look at the queue, from two refs read at the click: `moving` (`App.tsx:430`, today's) and `outside`, which holds a pane from the Pop out click until it is back in this window. Move then says "Close <title>'s external pane to return it to Deck first." Pop out says "Wait until <title> has moved, then open it in a new window." Each sets its own ref before its first `await`, so whichever click comes first wins. For a popped-out thread, the sidebar's Project › rows are greyed with the same reason. | D11, Tasks 12, 15 |
| 2 | D12 named only menu picks. Typing `@allison a whale`, with a mod that takes the name out, posted `a whale` to Allison, whom D10 still routes to. The media agent passed, with no price card. | **A name the person typed stays in the message (D12).** After the mod, any agent the typed text names by its own `@mention`, and the rewrite no longer names, goes back in front: `@allison a whale` posts. This happens before `replyText`, so a quote's lead comes from the same names as the routing text. `@all`, an old name and an email address name no one, so nothing is put back for them. A new shared list, `shared/media-naming.json`, holds what the app posts in each case and what the price card then shows. The app's test checks that it posts exactly that text, and the Rust test that the text reaches the card. | D12, Tasks 11a, 12 |

**Why `outside` replaces revision 8's `popping`.** `popping` let go of the pane once its window opened, and from then on only `poppedIds`, built from state, knew. A click handled before the next render could see the pane in neither. `outside` is set at the click and cleared only when the window fails to open, closes (`onClosed`, `App.tsx:1552-1564`) or is dropped as an orphan (`:1698-1709`).

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's seventh review (revision 8, 2026-11-08)

All three findings were checked against the code before they were fixed, and all three held.
- **Pop-out.** A popped-out pane stays mounted, hidden, in the main window (`App.tsx:844`), and the pop-out window makes its own `ChatPane` with its own queue (`PopoutApp.tsx:425`). Two queues then feed one thread.
- **Move.** `moveDraft` (`App.tsx:2363`) keeps the pane mounted and only changes its workspace. The queue lives on, and posts through whichever machine the pane is on now (`current`, `ChatPane.tsx:1707`).
- **Media.** A media agent answers only a person's message that names it (`named_by_person`, `crates/apex-adapters/src/media.rs:114`), and passes otherwise (`:335`).

`/tmp/jigga-rev8/queue-rev8.ts` is a prototype of the queue part of fix 1, a patched copy of revision 7's prototype (`rev7-to-rev8.diff`, and `queue-rev8.diff` against `src/turnQueue.ts`). Against it:
- 39 new checks pass (`rev8-checks.mjs`). They include Null's two fix-1 cases and the Retry order of fix 3.
- Revision 7's 37 checks and revision 6's 27 still pass.
- The 93 existing tests in the eight files that use `ParticipantQueues` still pass unchanged (`out.txt`).

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Revision 7 closed a queue only when its pane unmounted. Popping out and moving both keep the pane mounted. With a slice's picture save held, popping the pane out and sending from the new window posted that later message first. With host A's save held, moving the thread to host B posted A's attachment path to B. | **A thread pops out or moves only when its queue is empty (D11).** `ParticipantQueues.unsent()` counts everything that hasn't ended: preparing, waiting, failed or being posted. `popOutPane` and `moveDraft` refuse while it is above 0, with "Wait until <title> has sent what's waiting, or remove it, then pop it out." (or "…then move it."). That covers what was already there. Two rules cover what arrives during the change. **Pop-out:** a pane counts as popped out from the click, before the window opens. It can't be tagged, the dock skips it, and the batch gets no send API for it. **Move:** the thread's queue is suspended while the move runs. A slice sent then keeps its place as failed and is never made. The pane's own Send hands its draft back. A next step or voice turn is refused. Retry after the move makes the slice on the machine the thread is on then. The queue lives on through a move, as today, so nothing already accepted is dropped. | D11, Tasks 12, 15 |
| 2 | A pick from the `→ agent ▾` menu posted the typed text unchanged to explicit recipients. A media agent acts only on a person's message that names it with `@`, so a media agent picked from the menu passed silently, before any price card. | **A one-send pick is posted with the agent's `@name` first (D12)**, as if typed: `a whale` picked for Muck posts `@muck a whale`. `keep_default` is unchanged, so the thread's default still stays (D1). The media agent strips leading `@names` from its prompt (`media.rs:101-106`), so the price card shows `a whale`. The `@name` is added in ChatPane's dispatch, at posting, so edits and the queued line never show it. A Rust test pins that the posted form reaches the price card, and that the same text without the `@name` passes. | D12, Tasks 11a, 12, 15 |
| 3 | Re-submitting a `closed` slice through the reopened pane replaced its `ref` but kept the old `hostId`. If that re-submission then failed on host B, the next Retry hit the "moved to another machine" rule and sent nothing. | **A slice takes `ref` and `hostId` together** from the API it is sent through, on every re-submission: Retry of a `closed` slice and Send again. Retry now decides by the item's own state first. A slice in the API's current queue is retried there, whatever machine it is on. The machine only changes the wording for a slice that may have arrived (`unknown`). | Task 15 |

**Why not close the queue on a move, as a pane close does?** I started the prototype that way and dropped it before running it. Closing would drop a message the thread's own composer queued during the move: once a message is queued, the composer's draft is cleared (`ChatPane.tsx:2744-2745`), so its text would be lost. A suspended queue refuses that Send instead, and the draft stays in the box.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's sixth review (revision 7, 2026-11-08)

All three findings were checked against the code before they were fixed, and all three held. `/tmp/jigga-rev7/repro-null.mjs` reproduces each one against revision 6's prototype. `/tmp/jigga-rev7/queue-rev7.ts` is a prototype of the fix, a patched copy of `src/turnQueue.ts` (`queue-rev7.diff` beside it). Against it, 37 new checks pass (`rev7-checks.mjs`), and so do revision 6's 27 (`rev6-checks.mjs`). The 93 existing tests in the eight test files that use `ParticipantQueues` also pass against it unchanged (`out.txt`).

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Closing a pane didn't stop its queue. Task 15 treated an unregistered API as a dead queue, but the queue object lives on in its own promises. A slice still being made was pushed and posted once its save finished, and a drain already running posted whatever it reached next. Hold a save, close and reopen the pane, Send again, then release the save: two posts. | `ParticipantQueues.close()`, called once when ChatPane unmounts. After it, nothing the queue hasn't posted ever posts: an admission waiting for its turn or being made, a waiting item, a slice that failed before it was made, a refused message, and whatever a running drain would reach next. All of them read `closed`. A post already on its way ends as it ends: `posted`, or `unknown` if it fails, since it may have arrived. A failed post still kept at close also reads `unknown`. The batch keeps following the old queue until each slice has ended. A `closed` slice never left Deck, so Retry sends it through the reopened pane. Only an `unknown` one needs Send again. | Tasks 12, 15 |
| 2 | The checks ran for the agents worked out when the slice was made, but the drain asks again just before posting, as it should (`turnQueue.ts:211-213`). A rule changed in between reached an agent the checks never saw. With Who answers switched to Everyone during a held save, the message also posted to Muck, a video agent whose media check says it needs a picture. | The drain checks again just before the post, for exactly the agents it is about to post to. The check is synchronous, and it is the same `checkSend` that Send runs, so nothing can change between it and the post. A rule changed while the message waited still applies when the check passes. When the check fails, the message is refused in place. It never left, it holds back what follows it for those agents, and it shows the reason with Retry, Remove and edit. | Task 12 |
| 3 | Stop waiting was registered only once a slice was being made. A slice still waiting for its turn, behind a command that was still starting, kept reading `preparing`, ignored Stop waiting, and posted later. | `giveUp` works from the moment of the call. A slice still waiting for its turn reads `failed` ("Stopped waiting") at once. When its turn comes, it takes its place as a failed item without being made, so nothing behind it gets past anything ahead of it. Retry before then takes the give-up back, and Discard drops it. | Tasks 12, 15 |

**Found while checking finding 3: a long command held the line.** `send` lets the next message take its turn only after its own drain has returned (`turnQueue.ts:104-115`), and revision 6's `admit` copied that. A drain that posts a `/compact` or `/curate` returns only when the model has finished (`room_compact` and `room_curate`, `crates/apex-host/src/host.rs:2639,2689`). So everything sent to that thread in the meantime waited outside the queue and read `preparing`, and after 10 s the bar offered Stop waiting, though nothing was stuck. Today's composer shows the same thing: after a `/compact` sent while no agent was working, a message sent during the compact stays in the box until the compact ends (`/tmp/jigga-rev7/today-compact.mjs`).
- Now the next admission's turn comes once the one before it is in the queue, or kept there as failed.
- The composer's own `/compact`, `/curate` and `/curate undo` go through `admit` too, so a message sent during a compact is queued at once, behind it.
- `send` and `sendTo` are unchanged. Their own drain normally posts just their message, which takes one quick `room_post_to`.

The fixes change three more things:
- **The pane is told about a refusal at posting time.** The refused message may be the pane's own composer message, and by then its draft is gone. The notice is the check's own message, without today's "Check whether it arrived" advice, since the message never left.
- **A test that reads ChatPane's source has to change.** `tests/right-phone-component.test.mjs:587-600` looks for `void turnQueue.send(message).then(id => {`. Revision 6 replaced that line (Task 12) without saying so. The test is rewritten for the new send path and checks the same three things: the phone hook runs once, only for a message still queued, and after the composer is cleared. `tests/curation-notes.test.mjs:148-149` keeps passing, since the edit box's switch to `/curate` stays as it is.
- **The media check no longer waits for a price.** Today `send()` awaits `priceSend` but reads only its `missing` (`ChatPane.tsx:2726-2729`). The composer's live price is fetched separately (`:2647`), so nothing else is lost. `checkSend` uses a new `missingPicture` (`src/mediaPrice.ts`) instead, and `priceSend` uses it too.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's fifth review (revision 6, 2026-11-08)

The finding was checked against the code before it was fixed, and both of its cases held. `/tmp/jigga-rev6/repro.mjs` reproduces both with the real `ParticipantQueues` and a wrapper that follows revision 5. It then runs the same steps, and the other cases Task 12 lists, against a prototype of the fix: 24 checks pass. The prototype, `/tmp/jigga-rev6/queue-admit.ts`, is a patched copy of `src/turnQueue.ts` (`queue-admit.diff` beside it). The 61 tests in `tests/turn-queue.test.mjs` and `tests/phoneQueue.test.mjs` pass against it unchanged.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Revision 5 ordered a pane's `submit` and `command` calls, but not its own composer. `send()` went straight to the queue (Task 12's `submitDraft`), so a slice whose picture was still being saved was overtaken by a thread message sent after it. With the save held past the 600 ms swap guard, the thread's own `own text` posted before the slice's `one`. | Order comes from the thread's queue itself. The queue already accepts every message that joins its end in call order (`accepting`, `turnQueue.ts:73,104-129`): composer messages, next steps (`ChatPane.tsx:2670`), voice turns (`:1777`), More details (`:1904`) and the composer's `/compact` (`:1669`). The new `admit` takes its place in that same order when it is called, and does the slow part (saving files, the checks, the mod hook) only once everything sent before it has been accepted. Both composers send through `admit`. A thread composer whose message is waiting for its turn keeps its Send disabled, so a second click can't queue it twice. | Tasks 12, 15 |
| 2 | Revision 5's chain went on to the next call as soon as one failed. Batch 2, accepted while batch 1's picture was still being saved, posted when that save failed, and batch 1's Retry then posted after it. Disabling Send for new batches couldn't hold batch 2, which was already accepted. | A slice that fails before it reaches the queue stays in it, at its place, as a failed item that was never made. It never posts. What was sent after it to the same agents waits behind it, as messages wait behind a failed send today (`turnQueue.ts:207-209`). If its agents weren't known yet, because the machine didn't answer, the whole thread waits. Retry, from the thread or the batch bar, makes it again in place. Remove or Discard drops it and lets the rest go at once. It never left Deck, so there is nothing to check first. The thread's own composer still gets its draft back on a refusal, as today, and leaves nothing behind. | Tasks 12, 15 |

The fix also changes five things the review didn't ask for:
- **Every slice has its `QueueRef` from the click.** `submit` and `command` return it at once instead of resolving later, so revision 5's `queued` callback goes, and so does the Retry branch for "failed before it was queued, so it has no `ref`".
- **Discard removes the failed items from their threads' queues,** as each thread's trash button does. Revision 5 only let go of the batch's copies, which left a failed item in the thread holding back what came after it.
- **The files are saved after the checks and the mod hook,** so a refused slice saves nothing on the machine.
- **A thread's own Send removes only what it sent** once its message is queued. Waiting for a slice ahead of it can take seconds now, and today's `setReplies([])` (`ChatPane.tsx:2745`) would clear a quote added during that wait. Sent pictures are already removed one by one (`:2746-2747`).
- **Stop waiting.** A daemon call has no time limit: a pending call fails only when the connection drops (`src/daemon/client.ts:164-182,409-413`). Picture saves now happen while the slice holds its place in the thread's queue, so one stuck save would hold every later message to that thread. After a slice has been sending for 10 s, the bar offers Stop waiting, which fails it in its place, so Retry and Discard work as for any failure.

Revision 5's rule that a batch with a failed slice disables Send for new multi drafts stays: it is approved mockup behaviour (`real-app.js:2622`). Order no longer depends on it.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's fourth review (revision 5, 2026-11-08)

Each finding was checked against the code before it was fixed. Both held.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Send stayed live while a batch was starting. The draft was cleared only after every slice had resolved, and a slice can take minutes to resolve: the queue's `send` returns only after its drain has posted (`turnQueue.ts:113`), and `room_compact` and `room_curate` return only when the model has finished (`crates/apex-host/src/host.rs:2639,2689`). So with a `/curate` line, a second click sent the whole batch again, and anything typed in the meantime was cleared along with the sent draft. | Send takes the draft in the same click, before anything is awaited: it plans, freezes every payload, empties the draft, and only then starts the slices. A second click finds nothing to send, and what is typed afterwards is a new draft that the batch never touches. `submit` and `command` now resolve as soon as the item is in its thread's queue, and one thread's calls run in the order they were made. So a long `/curate` counts as queued, and a later Send can't overtake an earlier one. | Tasks 10, 12, 14, 15 |
| 2 | A failed read took its chips out of the draft, but the editor's Undo history, the "Removed · Undo" note and the clipboard still named the file. Drop, copy, delete the chip, then the read fails: ⌘Z or a paste brought back a chip that stayed busy for good, so Send stayed disabled, or one that pointed at nothing. | A failed read deletes the file from the draft and from its undo memory, so the draft no longer knows it. Every way back checks that. Undo and Redo leave its chips out, the "Removed · Undo" note restores the line without them, and a paste that holds it goes in as plain text, as a paste holding a file removed with × already does. `setDoc` drops unknown files' chips, whatever wrote them. Each new draft also gets a new clipboard id and an empty Undo history, as the mockup does after a send (`real-app.js:2687`). | Tasks 10, 13, 16 |

Three more changes the review didn't ask for. Fix 1 needs all three:
- **The composer that takes its place.** Taking the draft turns multi off at the click, so the focused thread's own composer appears at once, with its Send under the pointer. That composer now sends nothing, by click or by Enter, for 600 ms after it replaces the multi composer. For clicks, this is the guard the button already has for Stop turning into Send (`flippedAt`, `ChatPane.tsx:1806-1807,4146`). A held Enter (`repeat`) never sends, in either composer. Without this, the second click of a double-click would send that thread's own draft.
- **Where batches live.** `MultiComposer` unmounts when multi turns off, so it can't hold a batch. App keeps every unfinished batch, and the dock shows one bar for them above whichever composer it shows. The mockup also keeps its failure bar after leaving multi (`real-app.js:2633`).
- **A failed batch holds back the next one.** A multi draft started while a batch was still sending can't go out while that batch has a failed slice. Its Send says "Retry or discard the failed batch first." (`real-app.js:2622`). Otherwise its lines could reach a thread ahead of the failed one.

Where an older table below disagrees with this one, this table and the tasks are what count.

## Changes after Null's third review (revision 4, 2026-11-08)

Each finding was checked against the code before it was fixed. All four held. `/tmp/jigga-rev4/repro.mjs` reproduces the first two with the real helpers.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | Who answers still depended on the posted text. The planner read `Slice.routing`, but the queue read `p.text`, and a chip changes how an `@` next to it reads. Typed `alice`, a chip, then `@muck`: the routing `alice@muck` names no one (an `@` after a letter is an email), while the posted `alice[Image1: shot.png]@muck` names Muck. `@mu`, a chip, then `ck` splits the other way: `muck` against `mu`. Separately, `postable('//compact')` posts `/compact` and a mod may rewrite the whole text, so revision 3's rule that the posted text starts with the routing text would have thrown on both. | Routing is its own field. It is set once from what the person typed, and nothing works it out from the posted text again. The queue reads only that field, and the prefix rule is gone. In the routing text a chip counts as one space, so `alice▧@muck` routes to Muck in the summary and the queue. That is also how the agent reads `alice[Image1: shot.png]@muck`: across 200,000 random lines, reading a chip as a space gave the same mentions as the posted text every time (`/tmp/jigga-rev4/chip-space.mjs`). `//`, a mod's rewrite, file references, attachment lines and TL;DR change only the posted text (D10). | D10, Tasks 11, 12 |
| 2 | Two edits in a row broke a queued message. With a picture attached, `hi` edited to nothing and then to `hello` became `helloAttached image: /x`. Pictures are found only at the start of a line (`attachedImages`, `src/attachments.ts`; the media agents' `strip_prefix`, `crates/apex-adapters/src/media.rs:94`), so the picture was silently lost. | The item keeps its parts: the typed text, the attachment paths and TL;DR. An edit replaces the typed part and builds the text again with `composeWire`, the same function Send uses. Nothing is cut out of the old text, so the attachment lines always keep their own lines. An edit that empties the box of a message with no pictures keeps the old message. | D9, Task 12 |
| 3 | A dropped file's chip went in only once its read finished. A Send before then went without the picture, and the late read then put the chip into the next, cleared draft. | Every attach puts its chip in at once, marked as reading, as a thread's own tray already does (`track`, `ChatPane.tsx:2488`). Send waits until every read in the draft has finished. A read that finishes after its draft was sent or cleared is dropped. Pasted and `+` pictures work the same way, since `file.arrayBuffer()` takes a moment too. | Tasks 11, 12, 15, 16 |
| 4 | Task 8 hid the composer of every `ChatPane` that wasn't the dock's target, but talk-only chats (`src/TalkOnlyChat.tsx:116`) and pop-out windows (`src/PopoutApp.tsx:425,610`) use `ChatPane` too. Both would have lost their composer. | Docking is opt-in. Only the main window's pane map passes `dock`, and every other `ChatPane` keeps its own composer, as today. A popped-out pane stays mounted, hidden, in the main window (`App.tsx:844`), so the dock never targets it, and it can't be tagged: its own window owns its composer. That last rule is mine, not the review's. | Tasks 8, 11, 14 |

## Changes after Null's second review (revision 3, 2026-11-08)

Each finding was checked against the code before it was fixed. All six held, and so did the three layout contracts.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | `#` in a thread's composer replaced a multi draft kept after Esc. The mockup does the same: `real-app.js:applyThreadPick` overwrites `state.multiDraft`. | With a kept multi draft, `#` moves nothing. The picker says a multi-thread message is waiting and offers **Open it**. Both drafts and the kept pictures stay. | Task 14 |
| 2 | Finder files were kept as paths, so every destination and every retry read the file again (`copy_attachment`, `crates/apex-host/src/host.rs:3230`; `readLocalFile` for other machines, `src/electronShell.ts:193`). A file changed or deleted after the drop changed what was sent. | The file is read once, at the drop, with a new desktop call, `snapshotDrop`. From then on it is bytes, like a pasted picture. `FileSource` and its `path` kind are gone, and `submit` always uses `saveAttachment`. | Tasks 12, 15, 16 |
| 3 | Editing a queued message routed it on the whole wire text (`turnQueue.ts:151`; the edit box shows `item.text`, `ChatPane.tsx:3960`), and an edit dropped a one-send pick | Items keep what was typed (`routing`) apart from the lines the app adds. The edit box edits only the typed part, and the rest is kept. A one-send pick survives an edit unless the edit names an agent. Items without `routing` (the phone's, next steps, Steer) edit as today. | D9, Task 12 |
| 4 | A slice retried with the thread's own Retry, and posted, still showed as failed and then offered "Send again" | The queue reports each item's state (`status`, `watch`) and remembers posted and removed ids. The batch follows it: retried in the thread means queued, then sent; removed in the thread means "Removed from <title>'s queue", with Send again. | Tasks 12, 15 |
| 5 | Quote, Add to chat and the other actions that fill a composer wrote into a thread composer that wasn't shown | Each one asks App to show that thread's composer (`onWantComposer`). In multi mode, multi turns off with its draft kept, as Esc does, and a note says how to get it back. | Tasks 8, 14 |
| 6 | The folder check looked for a trailing `/`, which Finder paths don't have | `snapshotDrop` checks the path with `stat`. A folder is refused with "Drop folders into one thread's own composer." A real folder is tested. | Task 16 |
| L1 | `PaneMap` placed only the current arrangement's panes. A focus pane kept in a box of its own would remount whenever it changed, losing its draft, queue and terminal. | `PaneMap` mounts every listed pane (every workspace and section, popped-out ones included) as keyed children of one element that never changes. The focus pane is pinned in place, never moved to another parent. A mount-count test covers it. | Task 4 |
| L2 | `reveal()` was meant to restore a maximized pane, but `PaneMap` had no way to change `maximized` | An `onRestore()` prop. `reveal` restores first, then scrolls once the restored placement is laid out. | Task 4 |
| L3 | Keyboard zoom had no anchor when the active pane is outside the region (the Focus pane) | `chooseAnchor` falls back to the pane at the centre of the visible region, and returns `null` for an empty region. `scrollFor(…, null, …)` keeps the nearest snap. | Tasks 3, 4 |

One more fix the review didn't ask for: the phone app shares `src/turnQueue.ts` (`src/phone/PhoneApp.tsx:61`), so "Not in this plan" no longer says it shares nothing. Every queue change is additive, and the phone queue tests run with each queue task.

## Changes after Null's review (revision 2, 2026-11-08)

Each finding was checked against the code before it was fixed. All nine held.

| # | Finding | Fix | Where |
| --- | --- | --- | --- |
| 1 | An agent picked from the menu became the thread's default, both while queued and after posting | "This send only" is settled (D1): `keep_default` on `room_post_to`, plus one-off queue items that `queuedSticky` skips. Older machines grey the menu. | D1, Task 11a, Tasks 12, 14, 15 |
| 2 | Retry had neither the files' bytes nor TL;DR, and a queue number could name an item in a reopened pane's new queue | A frozen `SlicePayload` holds everything. `QueueRef` carries the queue's identity; a different queue or machine never retries automatically, and Send again is the person's call. | Tasks 12, 15 |
| 3 | `#` in a thread's composer moved the text but left its pictures and quotes behind | The whole draft moves, or nothing does: with pictures or quotes it refuses with a message, and TL;DR moves with the text | Task 14 |
| 4 | `/curate` errors were caught, so the batch would count them as sent | They reach the queue, with one notice (D8) | D8, Task 12 |
| 5 | Finder drops never reach DOM handlers | `MultiComposer` subscribes to `onFileDrop`, places the chip at the drop point, and copies by path to each machine. (Revision 3 reads the file once at the drop instead.) | Task 16 |
| 6 | The zoom-level function throws when the panes can't all fit | Start from the densest grid of live-size panes (120 × 56), with guards for 0 panes and 0 size. Same levels as the mockup in every other case. | Tasks 1, 2 |
| 7 | A file named `@muck …` could add Muck | References use the host's saved name, which has no `@`, and the queue routes on the typed text, not the wire text | Tasks 9, 11, 12 |
| 8 | Composer observers bound once broke when the composer moved into the dock | Rebind on mount; keep the caret and scroll | Task 8 |
| 9 | Migration trusted a stale `layout` field; Dashboard placement, reveal, Focus→grid zoom and Rename weren't covered | Migration reads the tree's shape. `placeInOrder`, `reveal`, and the zoom reset on switching are added, and Rename moves to ⋯ (D7). | Tasks 2, 4, 5, 7 |

The reviewers' side notes are folded in too: copy now looks up readable names (Tasks 9 and 13), and the server and media checks use the agent actually picked (Task 12).

## Global Constraints

- **Workflow**
  - Work in `~/Downloads/apex-deck` only, one branch per milestone made with `git switch -c feat/<name>`.
  - Run `git status` first and stage only your own hunks, because other agents edit this folder at the same time.
  - Before any merge: `npx tsc --noEmit` and `npm test` pass, the user says OK, and Null (or Jigga, if Null built it) has reviewed the milestone.
  - Delete the branch after merging.
- **Dev builds.** Use only the AGENTS.md command. It attaches the user's real dev data, so use it to look, never to send. Anything that sends runs against the fixture daemon (`npm run test:e2e`) or scripted agents in throwaway threads, so no real agent turns happen.
- **Look before done.** Screenshot every new control at 1512×945 and 1100×650 and look at it before calling a task done. Tests miss layout.
- **No hand-styled UI.** Reuse Deck's classes and CSS variables (`--bg`, `--panel`, `--line`, `--text`, `--radius`). Menus reuse the real ⋯ menu row styles.
- **Clipboard.** Tests never touch the real clipboard. Use synthetic `ClipboardEvent`s only.
- **Reduced motion.** With `prefers-reduced-motion`, there is no glide, no marquee and no shake. A 1 s red outline replaces the shake.
- **Removed outright, with no fallback:** "Focus top" and the split tree's drop-on-an-edge splitting.
- **Constants** (from the mockup; don't change them without the user):
  - `GAP` 8 px between panes
  - pane aspect target `PANE_AR` 1.4
  - comfortable pane at least 280 px wide × 200 px tall
  - band minimums: rows 56 px, columns 120 px
  - pane glide 220 ms
  - one zoom step per 0.18 of accumulated `log(factor)`, where `factor = exp(clamp(-deltaY × 0.0075, −0.7, 0.7))`; reset after 400 ms of quiet
  - focus share 0.58 of `(width − GAP)`, rounded, clamped to [320, width − GAP − 260]
  - title bar 28 px with 20 px buttons
  - marquee starts 0.35 s after hover or focus
  - empty-line flash about 1.2 s
- **Copy.** New text in this feature says "agent", never "bot".
- **Nothing between the pane map and a pane makes a containing block** (revision 13): no `transform`, `filter`, `backdrop-filter`, `perspective`, `contain: layout | paint | strict | content` or `will-change: transform`. Each one makes `position: fixed` pop-ups inside the pane (the selection toolbar, link menus, a Preview's full window) place themselves against the pane instead of the window.

## Decisions to confirm before Task 1

Each decision below has a recommended default. The plan follows that default unless the user says otherwise.

- **D1. Picking an agent from the `→ agent ▾` menu is for this send only.** (Settled. The user approved this rule with the mockup; an earlier draft of this plan proposed dropping it, and Null's review sent that back.)
  - Two things change the default today, and both must not:
    - **After posting.** The daemon makes every post's targets the thread's new default (`accept_post`, `crates/apex-core/src/room.rs:1211`; `accept_client_message`, `room.rs:1254`). `/compact` also picks its summarizer from that default (`summarizer`, `room.rs:912`).
    - **While waiting.** An untagged message queued behind a pinned one goes where the pinned one goes (`queuedSticky`, `src/turnQueue.ts:269`).
  - Task 11a fixes both: `keep_default` in the daemon, and one-off queue items that `queuedSticky` skips.
  - **On a machine whose daemon is older,** the menu is shown greyed, with the tooltip "Update <machine> to pick an agent for one send. Typing @name still works." Typing `@Null` keeps working as it does today and still changes the default, as typing does everywhere in Deck.
- **D2. Saved "Focus top" layouts.**
  - **Recommended:** open as Even grid. "Top" was the untouched default for most saved sessions.
  - A saved Focus left stays Focus left, but only when its pane tree still has that shape. An Even grid saved next to an out-of-date `"left"` opens as Even grid (Task 2).
- **D3. Free-form splits go away.**
  - Dropping a pane on another pane's edge to split it is removed, as in the approved mockup.
  - Dragging a title bar only reorders panes within the chosen layout.
  - Saved custom arrangements keep their pane order.
- **D4. A line naming two agents.**
  - In real Deck, `@Null @Muck do X` makes both answer (`parse_mentions` collects every name). The mockup picked only the last one.
  - **Recommended:** keep the real behaviour. The summary counts both.
- **D5. Which commands can go in a multi-thread send.**
  - **Allowed:** `/compact`, `/curate`, `/curate undo`. These are whole-thread turns the queue already runs.
  - **Refused, with the message "Run /clear in that thread on its own.":** every other command (`/clear`, `/fork`, `/export`, `/diff`, `/plan`, `/goal`, `/loop`, `/image`). `/clear` is refused on purpose: it can't be undone.
- **D6. Switching to Focus left/right puts the focused pane in the tall slot**, as `arrange()` does today. Dragging a pane into the tall slot changes it afterwards. The mockup kept order on switch; the real app's rule is kept here.
- **D7. Double-clicking a pane's name goes full screen; it no longer renames.**
  - Today the name in a pane's title bar renames on double-click (`src/ThreadName.tsx:16`, tooltip "Double-click to rename"). The approved mockup gives double-click on the title bar to full screen, and the name is most of the bar.
  - **Recommended:** in the title bar, rename starts from ⋯ → Rename (`renameRequests`, `App.tsx:434`), as it already can. The sidebar row keeps double-click rename.
- **D8. A failed `/curate` or `/curate undo` stays in the queue with Retry, like a failed `/compact`.**
  - Today a curate error shows a notice and is dropped (`ChatPane.tsx:1683-1696` catches it), while a compact error stays queued. Multi-send needs the error to reach the batch (Task 12), so curate now behaves like compact everywhere, single threads included.
  - As after a failed `/compact` today, the thread's later messages wait until you Retry or remove the failed item.
  - **Recommended:** accept. The thread shows one error notice, not two.
- **D9. Editing a queued message changes only what you typed.**
  - Today the edit box holds the whole message as it will be sent, attachment paths and the TL;DR line included (`ChatPane.tsx:3960`, `defaultValue={item.text}`), and the queue routes the edit on all of it (`turnQueue.ts:151`).
  - **Recommended:** the box holds only what you typed, quotes included. Pictures and TL;DR stay attached as they were. After each edit the message is built again from those parts, so the attachment lines always keep their own lines. To drop a picture, remove the queued message and send it again.
  - Emptying the box of a message with no pictures keeps the old message, since an empty message can't be sent. The trash button removes it.
  - This is needed so that an edit can't route on a file path (Review Focus 7) or drop a one-send pick (D1). It applies to single-thread messages too. The phone, next steps and Steer keep today's edit.
- **D10. Who answers comes from what you typed, before anything rewrites it.**
  - On its way out, a message can be rewritten in four ways: `//` loses one slash (`postable`, `src/commands.ts:71`), a mod may rewrite it (`prompt.submit`, `src/mods/host.ts:213`), chips become file references, and attachment lines and TL;DR are added.
  - Today two different texts decide who answers. `send()`'s server and media checks read the typed text (`ChatPane.tsx:2705`), but the queue reads the fully rewritten text (`ChatPane.tsx:1715`). So a mod that adds `@muck` sends to Muck, though the checks only looked at the agents the typed text reaches.
  - **Recommended:** every send works out its routing text once. It is what the person typed, plus the `@lead` a quote adds (`replyText`, `src/reply.ts:46`), and that lead is chosen once too (D12). In a multi-thread line, each chip counts as one space. That one text drives the server and media checks, the queue and the multi-thread summary. A mod can still rewrite or refuse a message, but it can't change who answers, and the agents you named stay named in it (D12).
  - An edited queued message routes on what you leave in the box (D9).
  - Nothing in this repo relies on a mod changing who answers: the only test of `prompt.submit` (`tests/mods-runtime.test.mjs:87`) appends text or refuses. A mod the user installed could; this decision is where to say so.
- **D11. Pop out and move wait until the thread has nothing left to send, and never run at once.**
  - **Pop-out today:** the thread's queue stays in the main window's hidden copy of the pane (`App.tsx:844`). Messages still queued there post later, after whatever is sent in the new window, and no one sees them go.
  - **Move today:** the queue goes along with the thread, but a picture already saved on the old machine goes along only as a path the new machine doesn't have.
  - **Recommended:**
    - Pop out and Move (Project ›, for a thread that hasn't started) are refused while anything in the thread is still waiting, being made, being posted, or failed. The notice reads "Wait until <title> has sent what's waiting, or remove it, then pop it out." (or "…then move it."). Once the queue is empty, both work as today.
    - This applies to single threads too. A thread with a message queued behind a working agent pops out once that message has gone, or once you remove it. A running `/compact` counts too.
    - While a move runs, the thread takes nothing new:
      - Its own Send keeps the draft and says "Not sent: <title> is moving to <machine>."
      - A slice keeps its place as failed. Retry sends it from the machine the thread ended up on.
    - **They also wait for each other.** While a thread moves, Pop out says "Wait until <title> has moved, then open it in a new window." While a thread is open in its own window, its Project › rows are greyed with "Close <title>'s external pane to return it to Deck first." That window keeps a queue of its own, which this window can't see, and it would go on using the old machine after a move.
  - **The alternative:** carry queued messages into the pop-out window. That window would have to take over items this window is still tracking, files still being saved among them. A batch would then lose sight of its slices.
- **D12. An agent you chose is named in the message as it is posted.**
  - **Today's rule:** a media agent makes something only for a person's message that names it with `@` (`named_by_person`, `crates/apex-adapters/src/media.rs:114`). That is how it never spends money on a message meant for someone else.
  - **Two ways this plan would break it:**
    - **A menu pick.** A pick from the `→ agent ▾` menu posts the typed text unchanged. So a media agent picked from the menu passes, and nothing is made.
    - **A mod that takes a typed name out.** Who answers comes from what you typed (D10), but what posts is the mod's rewrite. A mod that turns `@allison a whale` into `a whale` sends `a whale` to Allison, and she passes. Today the same mod sends the message to the thread's default instead, because the queue reads the rewritten text.
  - **Recommended:**
    - A one-send pick is posted with the agent's `@name` in front, as if typed: `a whale` picked for Muck posts `@muck a whale`. Who answers still comes from the pick, and the thread's default still doesn't change (D1).
    - A name you typed stays in the message. When a mod's rewrite no longer names an agent you named with its `@name`, that `@name` goes back in front of the mod's words: `@allison a whale`, rewritten to `a whale`, posts `@allison a whale`. `@all`, an old name and an email address name no one, as for the media agent, so nothing is put back for them. A mod that keeps your names changes nothing here.
    - A quote's `@name` is chosen once, when you click Send, from what you typed. The message then posts with exactly that name in front, or with none, whatever a mod does to the words. A quote of Allison's reply still posts `@allison …` when a mod adds `@null` to your words. A quote under `@all` still posts no `@allison` when a mod takes `@all` out.
      - **One visible change:** a picture sent under a quote, with no words, now posts the quote and its `@name` with the picture, to the quoted agent. Today the quote is dropped and the picture goes to the thread's usual agent, though the quote card says "Send to Allison ▾" (`quoteTo`, `ChatPane.tsx:1041,4071`).
    - The media agent drops leading `@names` from its prompt (`media.rs:101-106`), so its price card and prompt read `a whale`.
    - Your message in the thread reads `@muck a whale` or `@allison a whale`. A quote already works this way: it puts its `@name` in front of the posted message (`replyText`, `src/reply.ts:46`).
  - **The alternative:** a daemon change, where the post carries who was chosen, by the menu or by typing, and the media agent counts that as being named. The thread would then show the message exactly as typed, or as the mod left it. But a new field on `Message` touches about 20 struct literals in 14 files across 4 crates, and the transcript's wire format.

**Still open from before, and not needed by this plan:**
- where "Who's in this thread?" opens
- how far the app-wide bot→agent rename goes

## Review Focus

These are failure modes no task's happy-path test covers. Each line names the task whose tests pin it.

1. **A send to threads on two machines.** Each picture must be saved on the machine that owns that thread, never on the Mac only. Pinned in Task 16 (e2e with two hosts).
2. **A tagged thread is closed, archived, deleted or popped out while the draft still tags it.** The chip turns unresolved and Send is blocked. It must never post to a stale id, or through a hidden copy of a thread whose own window owns it. Pinned in Task 11 and Task 14.
3. **The agent is mid-turn when its slice arrives.** That slice counts as *queued*, not failed, and Retry never sends it twice. Pinned in Task 12 and Task 15.
4. **The window resizes, or Details opens, mid-zoom.** The level is recomputed from the saved zoom ratio, the active pane stays on screen, and no row is cut off. Pinned in Task 4.
5. **Typing with an input method (IME) or dead keys next to a chip.** Composition never splits, eats or duplicates a chip. Pinned in Task 13.
6. **A one-send agent pick changes who answers next.** Neither while it waits in the queue nor after it posts, and not for `/compact`'s summarizer. The `@name` the pick is posted with (D12) doesn't change it either: the daemon takes the default from a post's targets, never from its text. Pinned in Task 11a (daemon and queue) and Task 15 (e2e).
7. **Text the app adds or rewrites changes who answers.** File references, `Attached image:` lines, TL;DR, `//` and a mod's rewrite never add or drop a recipient. Recipients come from the routing text, set once from what the person typed (D10), and that stays true when a queued message is edited. Pinned in Task 11 and Task 12, with a file named `@muck screenshot.png`, a chip just before a typed `@muck`, `//compact` and a mod that rewrites.
8. **Retry sends to the wrong place.** Retry never retries an item by number in a different queue (a pane closed and reopened starts a new queue whose numbers restart at 1), and never re-sends to a different machine (a thread that moved) anything that may have arrived. It never re-sends a slice that already went or may have. The only slice it sends through a reopened pane is one whose old queue closed before sending it, which never left Deck. That slice then takes the new queue's machine along with its new `ref`, so a later failure there is retried in place, never refused as "moved". A slice retried or removed in the thread itself shows what really happened. Pinned in Task 12 and Task 15.
9. **The window is too small for the panes.** Zoom-level math never throws. With 0 panes, a 0-size area or more panes than fit, it returns a usable answer. Pinned in Task 1 and Task 2.
10. **A file changes after it was attached.** Every destination and every retry sends the bytes read at the drop, even if the original is then edited, moved or deleted. Pinned in Task 16.
11. **A pane remounts.** Changing the layout, the focus pane, the section or full screen, or popping a pane out, never remounts it. A remount loses the pane's draft and starts a new queue, and the batch then loses track of that pane's slices. Pinned in Task 4.
12. **Send is clicked while a file is still being read.** Send waits for every read in the draft. A read that finishes after its draft was sent or cleared changes nothing. Pinned in Task 16, with a read held back on purpose.
13. **A thread shown outside the main window's pane map.** Talk-only chats and pop-out windows keep their own composer, and the dock never shows a popped-out pane's. Pinned in Task 8.
14. **A queued message is edited more than once.** Its pictures and TL;DR stay attached, each on its own line, however many times it is edited, emptied included. Pinned in Task 12.
15. **Send is clicked twice, or the draft is edited, while a batch is starting.** A `/compact` or `/curate` slice can take minutes to post. Send takes the draft in the same click, so a second click or Enter sends nothing more. The thread composer that takes its place sends nothing for the rest of a double-click, and nothing typed after the click is cleared when the batch finishes. Pinned in Task 15, with every stub held back, and in Task 12.
16. **A file whose read failed comes back.** Undo, Redo, the "Removed · Undo" note and a paste never bring back a chip of a file that failed to read. Such a chip would stay busy for good or point at nothing. Pinned in Tasks 13 and 16.
17. **A later message overtakes an earlier one in the same thread.** A slice whose files are still being saved, or one that failed before it reached the queue, is never overtaken by what was sent to the same agents after it: the thread's own composer, a later batch, a next step or a voice turn. Retry keeps its place, and only Steer and re-run go first, on purpose, as today. A long `/compact` or `/curate` holds back the whole room while it runs, as today, but not the line: what is sent meanwhile takes its place behind it at once. Pinned in Task 12 (queue and component) and Task 15, with a save held back, a save that fails and a curate held back.
18. **A pane closes while its slices are on their way.** Nothing its queue hadn't posted ever posts, from the old queue or twice after the pane reopens. A post already on its way ends as it ends and stays uncertain only if it failed. Pinned in Task 12 (queue, and a real ChatPane closed and opened again) and Task 15.
19. **Who answers changes after the checks ran.** A rule changed while the message waited, a pending tag that didn't come true, or an edit can add an agent. The message is checked again for exactly the agents it goes to, just before it posts, and a rule change still applies when the check passes. Pinned in Task 12.
20. **Stop waiting at any point before a slice is made,** including while it waits for its turn behind something else in the thread. Pinned in Task 12 and Task 15, behind a command held back.
21. **A thread pops out or moves while something in it is still to send, or while the other one runs (D11).** Pop out and Move wait for an empty queue. From the click, a thread being popped out can't be tagged or sent to from this window. While a move runs, its queue takes nothing new, and what it refuses keeps its place or its draft. A thread can't pop out while it moves, and can't move while it is open in its own window, from the click on either until it is over. Nothing posts from a hidden copy or from a window whose thread moved, and no machine is sent another machine's file path. Pinned in Task 12 (the queue, a real ChatPane whose machine changes, and where App refuses) and Task 15 (the batch bar, both orders of Pop out and Move, with a stub pop-out bridge).
22. **A media agent you chose (D12),** from the menu, by typing its `@name` or by quoting it, reaches its price card, even when a mod rewrites the words. A quote's `@name` is the one chosen at Send: a rewrite never drops it or brings one in. A menu pick also leaves the thread's default as it was. `shared/media-naming.json` holds what the app posts in each case: Task 12 pins that the app posts exactly that, and Task 11a that it reaches the card or passes (Rust), and that a pick keeps the default (e2e).
23. **Zoom moves the pane you're zooming toward.** A zoom step keeps its anchor on the same part of the screen, not just somewhere on it: a pane on the top line stays on the top line, as far as whole lines allow. Pinned in Task 3a (the rule) and Task 4 (a real wheel).
24. **A pane you add lands out of sight.** It goes first in its section, and the region scrolls to it, as the mockup's New thread does. Pinned in Task 4.
25. **Zoom loses track of the pointer.** Keys zoom as a wheel would at a pointer resting on the map. A pointer held still keeps zooming toward the pane it picked, after the columns slide another pane under it. Keys with nothing to follow keep the centre pane where the mockup does, and a ctrl-wheel over the Focus pane changes nothing. Pinned in Task 4.
26. **A pop-up inside a pane lands somewhere else.** Anything inside a pane that places itself with screen coordinates, or covers the window, lands where it would without the map: the selection toolbar, the link menu, a Preview's full window. That holds in every layout, at any scroll and mid-glide. Pinned in Task 7a.
27. **The Focus pane moves while the side panes scroll.** It holds still in every drawn frame, and so does its divider. Pinned in Task 7a.
28. **Scrolling or dragging renders the panes again.** A scroll or a drag move that doesn't change which panes are on screen renders none of them, and a pane that is never on screen never renders from either. Pinned in Task 7a.
29. **A web preview draws outside the map.** While the map scrolls, glides or drags, or while its pane isn't fully inside the map, a docked preview shows its picture. Its live page is never drawn at a stale rect or outside the map. Pinned in Task 7a. The Focus pane follows 32 instead.
30. **A pane jumps into or out of the Focus slot.** It glides from where it was drawn, as every other pane does, and without a transform. Pinned in Task 7b.
31. **The divider trails the pointer.** While the divider is held, the Focus pane and the side panes follow it in the same frame. Pinned in Task 7b.
32. **A preview that isn't moving freezes.** The Focus pane's live page stays live while only the side panes scroll or zoom. It steps aside only when the Focus pane moves or resizes, or something can pass over it. Pinned in Task 7b.
33. **A dropped file goes to the wrong thread, or nowhere.** A Finder drop attaches to the thread under the pointer, or to the dock's target when it lands on the dock. Exactly one thread takes it. A thread scrolled partly under the dock never takes a drop meant for the dock. Pinned in Task 8a.
34. **Writing rearranges the panes.** Typing, attaching, quoting and switching threads never change the map's columns and rows. They only make panes shorter. Only a window resize, a width change, a zoom or a layout switch picks the grid again. Pinned in Task 8a.
35. **A form or pop-up from the composer squeezes the map.** Add bot floats over the panes and never changes the map's size, and so does Task 16's file list. Pinned in Task 8a.
36. **The dock writes to the wrong thread.** Its target follows App's rules: the focused thread, or else the most recent one that isn't popped out. Pinned in Task 8a, as a pure function and in the browser test.
37. **A long draft counts as rest.** Coming back from Code, Library, Agents or a picker, or after the window, sidebar or details panel changes width, the map's grid is still picked as if the composer were empty. The next thread switch or Send never re-tiles it. Pinned in Task 8b.
38. **A long draft hides the last rows.** When the composer squeezes rows down to 56 px, the map still scrolls all the way to its last pane. Pinned in Task 8b.
39. **Keeping the same row on top freezes previews.** When panes get shorter in a scrolled map, the scroll that keeps the same row on top isn't motion, and previews stay live. Pinned in Task 8b.
40. **Typing moves the row being read.** Typing, clearing, pasting and switching threads keep the same top row wherever the active pane is, including the Focus pane. The map only moves to keep a wholly visible active pane in view. Pinned in Task 8d.
41. **A preview flickers as a glide ends.** `data-moving` stays on until every slot glide has ended, and it never comes back on after it settles. Pinned in Task 8d.
42. **A new thread's start tray re-tiles the map.** The first Send in a new thread, or the first switch to a started one, keeps the grid's level. Pinned in Task 8d.

## Not in this plan

- The more-than-200-threads camera map: drawn cards, nested blocks, the minimap, the Scale test menu and synthetic data.
- The sunflower agent background and the agent-avatar watermark on unprompted threads.
- The New-thread form docked in the composer.
- The phone app. It shares one file with this plan, `src/turnQueue.ts` (`src/phone/PhoneApp.tsx:61`). Every queue change here is additive: new optional fields and methods, and items the phone never makes. `tests/phoneQueue.test.mjs` and `tests/turn-queue.test.mjs` run, unchanged, with each task that touches the queue.
- The daemon `client_message_id` for Work-thread posts, which would make Retry idempotent at the daemon. Today's single-thread retry has the same limit, and `turnQueue.ts:138` documents it.
- Moving a thread's own pictures or quotes into a multi-thread draft. Task 14 refuses with a message instead.
- A Stop waiting in a thread's own composer. Its message waits only for what is ahead of it in that thread, and the bar can stop waiting for any slice there. A recipient lookup that never answers hangs today's `send()` the same way (`ChatPane.tsx:2705`).
- Carrying queued messages into a pop-out window, or along with a moving thread's files. Both wait for an empty queue instead (D11).
- Telling a pane's pop-out window that its thread moved to another machine (`hostId`, which App pushes only to tab windows, `App.tsx:1656-1669`). A thread can't move while it is popped out (D11), so that window's machine can't go stale.
- A message that reaches a moving thread from somewhere this window doesn't control: the phone, the CLI, or a pop-out window closed while its message was still on its way. Today's move has the same gap. `placeThread` copies what the room held when the move began and then deletes the old copy (`threadMove.ts:52-81`), and this plan doesn't change that.
- Voice turns into a popped-out pane's hidden copy. They work as today: the voice bridge is registered by each `ChatPane` that shows the thread (`ChatPane.tsx:1761`), and this plan doesn't change how they are routed.

## File Structure

**Create:**
- `src/paneArrangement.ts`: pure. Layout modes, zoom levels, placement, scroll snaps, zoom anchor, reorder, and migration from saved trees.
- `src/PaneMap.tsx`: the scrolling pane region. Zoom input (wheel, pinch, keys), glide, the focus divider, drag-to-reorder.
- `src/PaneHead.tsx`: the pane title bar, extracted from `App.tsx`, plus shedding, marquee, double-click full screen and the route label.
- `src/headFit.ts`: pure. Which title-bar parts give way at a width.
- `src/ComposerDock.tsx`: the window-level composer slot, its "To:" line and the batch bar (Task 15).
- `src/threadSendApi.ts`: the `ThreadSendApi` type and the `useSendApis()` registry.
- `src/sliceDraft.ts`: pure. The multi draft document (lines of tokens), edits, readable text, clipboard payload.
- `src/slicePlan.ts`: pure. Reading rules, validation and the summary line.
- `src/multiSend.ts`: freezing a batch, fan-out, per-slice results that follow each queue item, failed-only retry, and `useMultiBatches`, where App keeps the batches.
- `src/RichDraftEditor.tsx`: a contenteditable editor for the token model, with atomic chips, its own undo stack, IME safety, clipboard handling and chip drag.
- `src/MultiComposer.tsx`: the multi-thread composer. Pickers, summary, rows, agent menu, Send/shake, the failure bar and the picture stack.
- `src/useMultiDraft.ts`: state for the multi draft, shared by `App` (⌘-click) and `MultiComposer`. Send takes it whole (`take`, Task 10).
- `src/wireText.ts`: pure. `composeWire`, the one function that builds a posted message from its typed text, attachment paths and TL;DR (Task 12).

**Modify (daemon, Task 11a only):**
- `crates/apex-core/src/room.rs:1207-1265`: `accept_post` and `accept_client_message` take `keep_default`.
- `crates/apex-host/src/command.rs:249,733-744`: the `RoomPostTo` field and dispatch, and the new `PostCapabilities {}`. Lines 354–390 are hashed by the VPS updater (`scripts/vps_update_compat.py`) and must not change; this task stays outside them.
- `crates/apex-host/src/host.rs:1598`: `room_post_to_with_answer_guidance` and `room_client_post_checked` pass it through.
- `crates/apex-daemon/src/authority.rs:55,538,751`: `post_capabilities` is a global read, like `voice_capabilities`.

**Modify:**
- `src/App.tsx:345-348,636-672,885-916,2568-2580,2826,2946-3028`: pane state, session, `arrange`, Dashboard placement, picker, and the grid block.
- `src/dashboardNavigation.ts`: placement works on pane order.
- `src/ThreadName.tsx`: an option to turn off double-click rename (D7).
- `src/backend.ts:142,184-186,201`, `src/commandBackend.ts:117`: `roomPostTo` options, `postCapabilities()` and `snapshotDrop()`.
- `src/electronShell.ts:70-71,216`, `desktop/preload.cjs:18-27,106-110`, `desktop/main.mjs:541`, `desktop/files.mjs`: `snapshotDrop`, which reads a dropped file once (Task 16).
- `src/LayoutPicker.tsx`: five choices.
- `src/types.ts:318,571`: session fields and the `Layout` type.
- `src/hostSession.ts:66-75`: migration.
- `src/closing.ts:120-140`: saved and restored arrangements.
- `src/popoutModel.ts:111-125,291+`: the pop-out spot becomes an index.
- `src/PaneLayout.tsx`: keep `paneStyle`. Delete `Dividers` and `usePaneDrag` once nothing uses them.
- `src/layout.ts`: keep only `validate`, `leafIds` and `normalize` for migration. Delete the rest once unreferenced.
- `src/ChatPane.tsx:480,1665-1700,1714-1729,2436-2468,2531-2558,2690-2750,3954-3983,4039-4156`: the hold reason for a message waiting behind an unmade slice, `queueContextJob`, curate errors (D8), the routing text (D10), composer observers, Finder drops, `submitDraft` through `admit`, the queued line and its edit box (D9, and unmade slices), the opt-in dock portal, and API registration.
- `src/ChatPane.tsx:878-889,1888-1895,1950,1997,2268-2273,2427-2431,2511-2524,2544-2549,2619-2621,2757-2766`: the actions that fill the composer from outside it go through `showComposer()` (Task 8).
- `src/ChatPane.tsx:1806-1807,4132-4134,4146`: Send waits while this composer's own message waits for its turn (Task 12), and the Send guard for when this composer takes the multi composer's place (Task 15).
- `src/ChatPane.tsx:1665-1670,1755-1758,2704-2729`: the composer's commands admit too, the queue closes when the pane unmounts, and `checkSend`, the one check that Send and the queue both run (Task 12).
- `src/turnQueue.ts:63-274`: queue identity, item states (`status`, `watch`), one-off items, a routing text kept apart from the posted text, edits that replace the item's parts, `admit` and the failed items it keeps, the `behind` hold, the check just before posting, `close`, `unsent`, `suspend`, and `queuedSticky`.
- `src/App.tsx:1456-1503` (`popOutPane`), `:2363-2383` (`moveDraft`) and `:2476-2490` (`projectEntries`): both wait for an empty queue and refuse while the other runs, a pane counts as popped out from the click until it is back, and a move suspends the thread's queue (D11, Task 12).
- `src/recipients.ts`: `pickLead`, the `@names` a one-send pick is posted with, and `namedIn` (D12, Task 11a); `keptNames`, the typed names a mod's rewrite lost (D12, Task 12).
- `src/reply.ts`: `replyLead` and `replyWith`, split out of `replyText`, so a quote's lead is chosen once and posted as it is (D12, Task 12). `replyText` gives exactly today's text.
- `crates/apex-adapters/src/media.rs`: a test only, that each posted text in `shared/media-naming.json` reaches the price card or passes (Task 11a).
- `src/mediaPrice.ts:96-101`: `missingPicture`, which `priceSend` and `checkSend` share.
- `tests/right-phone-component.test.mjs:587-600`: reads the new send path instead of `turnQueue.send(message).then` (Task 12).
- `src/styles.css`: new rules, under a `/* adaptive panes */` block.

**Create (shared by the app and the daemon):**
- `shared/media-naming.json`: what the app posts when an agent is chosen, from the menu or by typing, with or without a mod, and what the media agent's price card then shows. The app's test and the Rust test both read it (Tasks 11a, 12), as both read `shared/mention-names.json` today.

---

## Milestone 1 — Pane layouts and zoom (branch `feat/adaptive-panes`)

### Task 1: Zoom levels

**Files:**
- Create: `src/paneArrangement.ts`
- Test: `tests/pane-arrangement-levels.test.mjs`

**Interfaces:**
- Produces:
  - `type PaneLayoutMode = "horizontal" | "vertical" | "grid" | "left" | "right"`
  - `interface Size { w: number; h: number }`
  - `interface Level { cols: number; rows: number; w: number; h: number; shown: number }`
  - `gridLevels(count: number, area: Size): Level[]`
  - `bandLevels(count: number, area: Size, mode: "horizontal" | "vertical"): Level[]`
  - `defaultLevel(levels: Level[], areaWidth: number): number`
  - `levelIndex(levels: Level[], defaultIdx: number, zoom: number): number`
  - `zoomRange(levels: Level[], defaultIdx: number): [number, number]`
  - constants `GAP`, `PANE_AR`, `COMFORT = { w: 280, h: 200 }`, `BAND_MIN = { horizontal: 56, vertical: 120 }`, `MIN_PANE = { w: 120, h: 56 }` (the smallest live pane; the title bar keeps its × down to this size)
  - Every function returns, and never throws, for any whole `count ≥ 0` and any area. `gridLevels` and `bandLevels` give `[]` when `count < 1` or the area has no width or height; `defaultLevel([])` is `-1`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'; import assert from 'node:assert/strict';
import { gridLevels, bandLevels, defaultLevel } from '../src/paneArrangement.ts';
const shape = (ls) => ls.map((l) => `${l.cols}x${l.rows}`).join(' ');
test('grid: 14 panes in 1200×800 step from all-fit down to one pane', () => {
  const ls = gridLevels(14, { w: 1200, h: 800 });
  assert.equal(shape(ls), '4x4 4x3 3x3 3x2 2x2 2x1 1x1');
  assert.equal(defaultLevel(ls, 1200), 1);            // 4x3 = 294×261, the most panes ≥ 280×200
});
test('grid: narrow area', () => {
  const ls = gridLevels(14, { w: 530, h: 414 });
  assert.equal(shape(ls), '4x4 3x4 3x3 2x4 2x3 2x2 1x2 1x1');
  assert.equal(defaultLevel(ls, 530), 6);
});
test('grid: few panes all fit comfortably', () => {
  const ls = gridLevels(5, { w: 1200, h: 800 });
  assert.equal(shape(ls), '3x2 2x2 2x1 1x1'); assert.equal(defaultLevel(ls, 1200), 0);
});
test('bands: rows ≥ 56, columns ≥ 120, down to one', () => {
  const h = bandLevels(14, { w: 1200, h: 800 }, 'horizontal');
  assert.equal(h.length, 12); assert.equal(h[0].rows, 12); assert.equal(h.at(-1).rows, 1); assert.equal(defaultLevel(h, 1200), 9);
  const v = bandLevels(14, { w: 1200, h: 800 }, 'vertical');
  assert.equal(v.length, 9); assert.equal(v[0].cols, 9); assert.equal(defaultLevel(v, 1200), 5);
});
test('every level fills the area exactly; columns never come back; ends at 1x1', () => {
  for (const [n, w, h] of [[14, 1200, 800], [7, 900, 600], [30, 1512, 880], [2, 600, 400]]) {
    const ls = gridLevels(n, { w, h });
    for (const l of ls) {
      assert.ok(Math.abs(l.cols * l.w + (l.cols - 1) * 8 - w) < 0.01);
      assert.ok(Math.abs(l.rows * l.h + (l.rows - 1) * 8 - h) < 0.01);
    }
    ls.slice(1).forEach((l, i) => { assert.ok(l.cols <= ls[i].cols); assert.ok(l.shown < ls[i].shown); });
    assert.equal(shape(ls.slice(-1)), '1x1');
  }
});
test('more panes than fit: start from the densest grid of live-size panes, never throw', () => {
  // The mockup's flatLevels throws a TypeError for all three of these.
  const ls = gridLevels(64, { w: 530, h: 414 });
  assert.equal(shape(ls), '4x6 4x5 3x6 3x5 3x4 3x3 2x4 2x3 2x2 1x2 1x1');
  assert.equal(ls[0].shown, 24); assert.equal(defaultLevel(ls, 530), 9);
  for (const n of [100, 200]) assert.equal(shape(gridLevels(n, { w: 530, h: 414 })), shape(ls));
  assert.equal(shape(gridLevels(300, { w: 1100, h: 650 }).slice(0, 2)), '8x10 8x9');
});
test('no panes or no area gives no levels; an area smaller than one pane gives one', () => {
  assert.deepEqual(gridLevels(0, { w: 1200, h: 800 }), []);
  assert.deepEqual(gridLevels(14, { w: 0, h: 400 }), []);
  assert.deepEqual(bandLevels(0, { w: 1200, h: 800 }, 'vertical'), []);
  assert.equal(defaultLevel([], 1200), -1);
  assert.equal(shape(gridLevels(14, { w: 100, h: 50 })), '1x1');
});
test('sweep: every count and size keeps the rules', () => {
  for (const n of [1, 2, 3, 14, 48, 63, 64, 100, 200, 500, 5000]) {
    for (const [w, h] of [[1512, 880], [1200, 800], [1100, 650], [530, 414], [300, 200], [119, 55], [1, 1]]) {
      const ls = gridLevels(n, { w, h });
      assert.ok(ls.length > 0); assert.equal(shape(ls.slice(-1)), '1x1');
      ls.forEach((l, i) => {
        assert.ok(l.cols === 1 || l.w >= 120); assert.ok(l.rows === 1 || l.h >= 56);
        if (i) { assert.ok(l.cols <= ls[i - 1].cols); assert.ok(l.shown < ls[i - 1].shown); }
      });
      const d = defaultLevel(ls, w); assert.ok(d >= 0 && d < ls.length);
    }
  }
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --experimental-strip-types --test tests/pane-arrangement-levels.test.mjs`. Expected: FAIL with a module-not-found error.
- [ ] **Step 3: Implement.** Port `real-app.js:flatLevels`, `defaultLevel`, `levelFor` (→ `levelIndex`), `flatZoomRange` (→ `zoomRange`) and `bandLevels`. Rename `c`/`r` to `cols`/`rows`. `zoom` is a ratio: 1 is the default level, and `levelIndex` picks the level whose `shown` is nearest `levels[d].shown / zoom`. Three changes from the mockup, because it never had to place live panes past 200 threads or in a small window:
  - Candidates stop at `MIN_PANE` (120 × 56) instead of the mockup's 60 × 36, which was sized for drawn cards. A single column or row is always allowed.
  - The first level is the best-shaped candidate that shows the **most** panes. That is every pane when they fit, as before. The mockup took `fits[0]` from the all-fit list, which is empty when they don't fit: that is the crash.
  - Return `[]` early for `count < 1` or an empty area.
  - The new rule gives the same levels as the mockup for every example above; only the crash cases differ. The numbers were measured with the scratch port in `/tmp/jigga-review/levels.mjs`: 108 count × size runs, none failing.
- [ ] **Step 4: Run the tests and check they pass.** Same command. Expected: PASS, 8 tests.
- [ ] **Step 5: Commit** with `feat(panes): zoom levels for grid and band layouts`.

### Task 2: Placement, snaps, focus layouts, migration

**Files:**
- Modify: `src/paneArrangement.ts`
- Test: `tests/pane-arrangement-place.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `interface PxRect { x: number; y: number; w: number; h: number }`
  - `interface Arrangement { mode: PaneLayoutMode; order: string[]; zoom: number; focusShare: number }`
  - `interface Placement { levels: Level[]; levelIdx: number; defaultIdx: number; axis: "x" | "y"; region: PxRect; world: Size; rects: Map<string, PxRect>; snaps: number[]; focus: { id: string; rect: PxRect } | null }`
  - `place(arr: Arrangement, area: Size): Placement`
  - `arrangementFromSaved(tree: unknown, layout: unknown, ids: string[]): Arrangement`
  - `validArrangement(value: unknown, ids: string[]): Arrangement`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'; import assert from 'node:assert/strict';
import { place, arrangementFromSaved, validArrangement } from '../src/paneArrangement.ts';
const ids = Array.from({ length: 14 }, (_, i) => `p${i}`); const A = { w: 1200, h: 800 }; const H = 784 / 3;
const arr = (mode, x = {}) => ({ mode, order: ids, zoom: 1, focusShare: 0.58, ...x });
test('Even grid: 4×3 on screen; the short last row widens', () => {
  const p = place(arr('grid'), A);
  assert.deepEqual(p.rects.get('p0'), { x: 0, y: 0, w: 294, h: H });
  assert.deepEqual(p.rects.get('p13'), { x: 604, y: 3 * (H + 8), w: 596, h: H });
  assert.equal(p.axis, 'y'); assert.deepEqual(p.snaps.slice(0, 2), [0, H + 8]);
});
test('Horizontal: full-width rows, three on screen', () => {
  const p = place(arr('horizontal'), A);
  assert.deepEqual(p.rects.get('p1'), { x: 0, y: H + 8, w: 1200, h: H });
  assert.equal(p.world.h, 14 * H + 13 * 8);
});
test('Vertical: full-height columns, four on screen, sideways', () => {
  const p = place(arr('vertical'), A);
  assert.deepEqual(p.rects.get('p1'), { x: 302, y: 0, w: 294, h: 800 });
  assert.equal(p.axis, 'x'); assert.equal(p.world.w, 14 * 294 + 13 * 8);
});
test('Focus left/right: first pane takes 58%, the rest share the side region', () => {
  const l = place(arr('left'), A);
  assert.deepEqual(l.focus, { id: 'p0', rect: { x: 0, y: 0, w: 691, h: 800 } });
  assert.deepEqual(l.region, { x: 699, y: 0, w: 501, h: 800 }); assert.ok(!l.rects.has('p0'));
  const r = place(arr('right'), A);
  assert.deepEqual(r.focus.rect, { x: 509, y: 0, w: 691, h: 800 }); assert.deepEqual(r.region, { x: 0, y: 0, w: 501, h: 800 });
});
test('focus width clamps to [320, width − 8 − 260]; too narrow means no focus pane', () => {
  assert.equal(place(arr('left', { focusShare: 0.95 }), A).focus.rect.w, 932);
  assert.equal(place(arr('left', { focusShare: 0.1 }), A).focus.rect.w, 320);
  assert.equal(place(arr('left'), { w: 580, h: 800 }).focus, null);
});
test('one pane fills the area in every mode', () => {
  for (const mode of ['horizontal', 'vertical', 'grid', 'left', 'right']) {
    const p = place({ mode, order: ['a'], zoom: 1, focusShare: 0.58 }, A);
    assert.deepEqual(p.focus?.rect ?? p.rects.get('a'), { x: 0, y: 0, w: 1200, h: 800 });
  }
});
test('saved trees migrate: order kept; Focus left only when the tree really is one', () => {
  const L = (id) => ({ kind: 'leaf', id });
  const focusLeft = { kind: 'split', dir: 'row', sizes: [0.6, 0.4], children: [L('a'), { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [L('b'), L('c')] }] };
  // What arrange('grid') builds for three panes. It never resets the saved `layout`, so "left" can sit beside it (App.tsx:913-914).
  const evenGrid = { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [{ kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L('a'), L('b')] }, L('c')] };
  assert.deepEqual(arrangementFromSaved(focusLeft, 'left', ['a', 'b', 'c']), { mode: 'left', order: ['a', 'b', 'c'], zoom: 1, focusShare: 0.58 });
  assert.equal(arrangementFromSaved(evenGrid, 'left', ['a', 'b', 'c']).mode, 'grid');
  assert.equal(arrangementFromSaved(focusLeft, 'top', ['a', 'b', 'c']).mode, 'grid');
  const twoEqual = { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L('a'), L('b')] };
  assert.equal(arrangementFromSaved(twoEqual, 'left', ['a', 'b']).mode, 'grid');
  assert.equal(arrangementFromSaved({ ...twoEqual, sizes: [0.6, 0.4] }, 'left', ['a', 'b']).mode, 'left');
  assert.deepEqual(arrangementFromSaved('junk', 'top', ['x', 'y']).order, ['x', 'y']);
});
test('no panes, or an area with no size: an empty placement, never a throw', () => {
  for (const [order, area] of [[[], A], [ids, { w: 0, h: 0 }]]) {
    const p = place({ mode: 'grid', order, zoom: 1, focusShare: 0.58 }, area);
    assert.equal(p.rects.size, 0); assert.equal(p.focus, null); assert.deepEqual(p.snaps, [0]); assert.equal(p.levelIdx, -1);
  }
});
test('stored arrangements are checked: unknown mode → grid, bad zoom → 1, closed panes dropped, new panes appended', () => {
  assert.deepEqual(validArrangement({ mode: 'diagonal', order: ['a', 'gone'], zoom: NaN, focusShare: 2 }, ['a', 'b']),
    { mode: 'grid', order: ['a', 'b'], zoom: 1, focusShare: 0.58 });
});
```

- [ ] **Step 2: Run and check it fails.** Run `node --experimental-strip-types --test tests/pane-arrangement-place.test.mjs`. Expected: FAIL (`place` is not exported).
- [ ] **Step 3: Implement.**
  - Port `real-app.js:frameFor`, `flatWorld` and `flatRect` into `place`, without `PAD`: `area` is already the inner size.
  - Focus modes place `order[0]` as the focus pane, and the rest in `region` by the grid rules.
  - `snaps` are the starts of the lines along `axis`.
  - `arrangementFromSaved` uses `validate` and `leafIds` from `src/layout.ts`. The saved `layout` field alone can't be trusted: `arrange("grid")` builds an even grid but leaves `layout` at its old value, and the restored picker shows it (`App.tsx:641,913-914`). So the result is `left` only when both are true:
    - the saved `layout` is `"left"`
    - the tree has the shape `mainAndStack(…, "left")` builds (`src/layout.ts:274`): a `row` split with exactly two children, the first one pane with more than half the width (`sizes[0] > 0.52`), and the second one pane or a `column` split of panes. (In a wide window, `grid()` builds a three-pane `row` with equal sizes, which this rule correctly reads as a grid.)
  - Everything else is `grid` (D2). `order` is `leafIds(tree)` with closed panes dropped and new ones appended, so a real Focus-left tree keeps its tall pane first.
  - With no panes or no area, `place` returns `levels: []`, `levelIdx: -1`, empty `rects`, `snaps: [0]` and `focus: null`.
- [ ] **Step 4: Run and check it passes.** Expected: PASS, 9 tests.
- [ ] **Step 5: Commit** with `feat(panes): place panes for five layouts; migrate saved trees`.

### Task 3: Zoom steps and what zoom keeps on screen

**Files:**
- Modify: `src/paneArrangement.ts`
- Test: `tests/pane-arrangement-zoom.test.mjs`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `stepZoom(arr: Arrangement, area: Size, dir: 1 | -1): number`, the new `zoom`, exactly one level in (1) or out (−1), unchanged at either end.
  - `type ZoomAnchor = { kind: "active"; ids: string[] } | { kind: "pane"; id: string }`
  - `chooseAnchor(next: Placement, active: string[], pointerId: string | null, held: string | null, centreId?: string | null): ZoomAnchor | null`
  - `centreId(p: Placement, scroll: number): string | null`: the pane at the centre of the visible region at that scroll, or the nearest one when the centre falls in a gap. Rects are in the region's own coordinates. It is `null` when the region has no panes.
  - `scrollFor(next: Placement, anchor: ZoomAnchor | null, current: number): number`, the scroll offset on `next.axis`, always one of `next.snaps` or the end. With a `null` anchor it is the snap nearest `current`.
  - `insertIndex(p: Placement, point: { x: number; y: number }, dragged: string, scroll = 0): number`. `point` is relative to the pane area's top-left as seen on screen, and `scroll` is the region's current scroll on `p.axis`. The region's panes move by the scroll, and the Focus pane doesn't. (Revision 11 records this fourth argument, which Null added in `1dffaba3`.)
  - `reorder(order: string[], id: string, index: number): string[]`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test'; import assert from 'node:assert/strict';
import { place, stepZoom, chooseAnchor, centreId, scrollFor, insertIndex, reorder } from '../src/paneArrangement.ts';
const ids = Array.from({ length: 14 }, (_, i) => `p${i}`); const A = { w: 1200, h: 800 };
const a = { mode: 'grid', order: ids, zoom: 1, focusShare: 0.58 };
test('one step is exactly one level; the ends hold', () => {
  const inA = { ...a, zoom: stepZoom(a, A, 1) }; assert.equal(place(inA, A).levelIdx, 2);    // 3x3
  const outA = { ...a, zoom: stepZoom(a, A, -1) }; assert.equal(place(outA, A).levelIdx, 0); // all 14 fit
  assert.equal(stepZoom(outA, A, -1), outA.zoom);
});
test('active panes stay fully on screen, on a whole row', () => {
  const next = place({ ...a, zoom: stepZoom(a, A, 1) }, A);
  const anchor = chooseAnchor(next, ['p9'], null, null); assert.deepEqual(anchor, { kind: 'active', ids: ['p9'] });
  const y = scrollFor(next, anchor, 0); const r = next.rects.get('p9');
  assert.ok(r.y >= y && r.y + r.h <= y + next.region.h); assert.ok(next.snaps.includes(y));
});
test('when active panes can no longer all fit, the pointer wins, and a held target stays', () => {
  const next = place({ ...a, zoom: stepZoom(a, A, 1) }, A);
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], 'p5', null), { kind: 'pane', id: 'p5' });
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], 'p6', 'p5'), { kind: 'pane', id: 'p5' });
  assert.deepEqual(chooseAnchor(next, ['p0', 'p13'], null, null), { kind: 'pane', id: 'p0' }); // keyboard: no pointer
});
test('the focus pane is not in the region, so zoom follows the pointer', () => {
  const next = place({ ...a, mode: 'left' }, A);
  assert.deepEqual(chooseAnchor(next, ['p0'], 'p3', null), { kind: 'pane', id: 'p3' });
});
test('keyboard zoom with the Focus pane active keeps the middle of the region; an empty region has no anchor', () => {
  const left = { ...a, mode: 'left' }; const now = place(left, A);
  const dist = (r, x, y) => Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
  const cx = now.region.w / 2, cy = now.region.h / 2;
  const c = centreId(now, 0);
  assert.equal(dist(now.rects.get(c), cx, cy), Math.min(...[...now.rects.values()].map((r) => dist(r, cx, cy))));
  const next = place({ ...left, zoom: stepZoom(left, A, 1) }, A);
  assert.deepEqual(chooseAnchor(next, ['p0'], null, null, c), { kind: 'pane', id: c });   // p0 is the Focus pane, not in next.rects
  assert.equal(chooseAnchor(place({ ...a, order: [] }, A), [], null, null, null), null);
  assert.ok(next.snaps.includes(scrollFor(next, null, 37)));
});
test('drag: dropping over the third cell moves the pane there', () => {
  const p = place(a, A); const r = p.rects.get('p2');
  assert.equal(insertIndex(p, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 'p0'), 2);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
});
```

- [ ] **Step 2: Run and check it fails.** Run `node --experimental-strip-types --test tests/pane-arrangement-zoom.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Port `real-app.js:stepFlat`, `activeIdx`, `zoomFocus` and `snappedY` for zoom and scroll, and `bestIndex` for drag.
  - `chooseAnchor` order. Each id counts only if it is in `next.rects`:
    1. Use the active ids, if there are any and they all fit on screen together.
    2. Otherwise `held`.
    3. Otherwise `pointerId`.
    4. Otherwise the first active id. (Task 3a makes this the middle one, in pane order.)
    5. Otherwise `centreId`. This is keyboard zoom while the Focus pane is active: there is no pointer, and the Focus pane isn't in the region, so zoom keeps the middle of what you see.
    6. Otherwise `null`: the region has no panes.
- [ ] **Step 4: Run and check it passes.** Expected: PASS, 6 tests.
- [ ] **Step 5: Commit** with `feat(panes): one-level zoom steps, zoom anchor, drag index`.

### Task 3a: Zoom keeps its anchor in place

Revision 11. A follow-up to Task 3 (`1dffaba3`), done before Task 4.

**Files:**
- Modify: `src/paneArrangement.ts`
- Test: `tests/pane-arrangement-zoom.test.mjs` and `tests/pane-arrangement-place.test.mjs` (extend both)

**Interfaces:**
- Consumes: Task 3.
- Produces: `zoomScroll(next: Placement, anchor: ZoomAnchor | null, at: number | null): number`, the scroll after a zoom step. It ports the `topRow` rule of `real-app.js:setFlatZoom`.
  - The anchor's line is the line of `anchor.id`, or of the middle of `anchor.ids` in pane order.
  - `at` is a point on `next.axis`, in px from the start of the region as seen on screen.
    - A number keeps that point's place: `top = line − ⌊visible × clamp(at / span, 0, 0.999)⌋`.
    - `null` centres the line: `top = line − ⌊(visible − 1) / 2⌋`.
  - The result is `scrollFor(next, anchor, top × stride)`, the snap nearest `top × stride` among those that show every anchor pane. So it is always a snap, and a selected group that fits stays on screen whole.
  - With a `null` anchor it is 0.
- Changes:
  - `chooseAnchor` step 4 takes the middle active id, in pane order (the order of `next.rects`), as the mockup's `act[⌊(n − 1) / 2⌋]` does.
  - `place` treats a `focusShare` that isn't a finite number as 0.58.

- [ ] **Step 1: Write the failing tests.** The numbers were measured with the prototype in `/tmp/jigga-found/zoom-scroll-proto.mjs`. Append to `tests/pane-arrangement-zoom.test.mjs`, adding `zoomScroll` to its import. `ids`, `A` and `a` are the file's own (14 panes, 1200×800, Even grid at zoom 1):

```js
const z33 = { ...a, zoom: stepZoom(a, A, 1) }; const p33 = place(z33, A);   // 3x3, snaps 0, 269.33, 538.67
const p32 = place({ ...a, zoom: stepZoom(z33, A, 1) }, A);                   // 3x2, snaps 0, 404, 808, 1212
const near = (a, b) => Math.abs(a - b) < 0.01;
test('zooming in keeps a pane on the top line on the top line', () => {
  const s = p33.snaps.at(-1); const r = p33.rects.get('p6');                // p6 is on the top line
  const anchor = chooseAnchor(p32, ['p6'], null, null);
  assert.ok(near(zoomScroll(p32, anchor, r.y - s + r.h / 2), 808));         // scrollFor(p32, anchor, s) gives 404: the bottom line
});
test('zooming out keeps a pane on the bottom line on the bottom line', () => {
  const s = p32.snaps[1]; const r = p32.rects.get('p8');                    // scrolled to 404: p8 is on the bottom line
  assert.equal(zoomScroll(p33, chooseAnchor(p33, ['p8'], null, null), r.y - s + r.h / 2), 0); // scrollFor alone gives 538.67: the top line
});
test('a selected group that fits stays on screen whole', () => {
  const anchor = chooseAnchor(p32, ['p6', 'p9'], null, null);
  assert.deepEqual(anchor, { kind: 'active', ids: ['p6', 'p9'] });
  assert.ok(near(zoomScroll(p32, anchor, 130), 808));
});
test('no point centres the line; no anchor gives 0', () => {
  const ph = place({ ...a, mode: 'horizontal' }, A);                        // 3 rows on screen
  assert.ok(near(zoomScroll(ph, { kind: 'pane', id: 'p7' }, null), 6 * (784 / 3 + 8)));  // p7 on the middle line
  assert.equal(zoomScroll(place({ ...a, order: [] }, A), null, null), 0);
});
test('with no pointer, zoom keeps the middle selected pane', () => {
  assert.deepEqual(chooseAnchor(p32, ['p13', 'p0', 'p7'], null, null), { kind: 'pane', id: 'p7' });
});
```

  And to `tests/pane-arrangement-place.test.mjs`:

```js
test('a focus share that is not a number falls back to 0.58', () => {
  assert.deepEqual(place(arr('left', { focusShare: NaN }), A).focus.rect, { x: 0, y: 0, w: 691, h: 800 });
});
```

- [ ] **Step 2: Run and check they fail.** Run `node --experimental-strip-types --test tests/pane-arrangement-zoom.test.mjs tests/pane-arrangement-place.test.mjs`. Expected: FAIL. `zoomScroll` is not exported, `chooseAnchor` returns `p13`, and `place` throws on `NaN`.
- [ ] **Step 3: Implement.** A pane's line is `round(start / stride)`, where `start` is its rect's `x` or `y` on `next.axis` and `stride` is the level's line size plus `GAP`. `visible` is the level's `cols` on the x axis and `rows` on the y axis, and `span` is the region's size on the axis.
- [ ] **Step 4: Run and check they pass.** Same command. Expected: PASS, the 16 earlier tests in these two files and the 6 new ones.
- [ ] **Step 5: Commit** with `fix(panes): zoom keeps its anchor in place`.
- [ ] **Step 6 (revision 12): Pin the group rule and the last line.** Built as `a0473a75`, the test "zoom keeps the whole selected group visible even if its middle would move the top line" passes `at = 130`, where the point alone already gives 808, so nothing pins what `scrollFor` adds. In `tests/pane-arrangement-zoom.test.mjs`, replace that test's `assert.ok(near(zoomScroll(p32, anchor, 130), 808));` with:

```js
  assert.ok(near(zoomScroll(p32, anchor, 700), 808));                                  // the point alone gives 404, which cuts p9 off
  assert.ok(near(zoomScroll(p32, chooseAnchor(p32, ['p13'], null, null), 0), 1212));   // the point alone gives 1616, past the last line
```

  Check it: it passes against `a0473a75`, and fails when `zoomScroll`'s last line is changed to `return Math.max(0, (line - screenLine) * stride);`. Put the line back, then commit with `test(panes): pin zoomScroll's group rule and last line`.

### Task 4: PaneMap in the app

**Files:**
- Create: `src/PaneMap.tsx`
- Modify:
  - `src/App.tsx:885-916`: replace `tree`/`sync`/`rects`/`usePaneDrag`.
  - `src/App.tsx:2946-3028`: render through `PaneMap`; drop the grid `<Dividers>`.
  - `src/styles.css`
- Test: `tests/pane-map-browser.test.mjs` (Electron scenario, real `sendInputEvent` wheel and keys)

**Interfaces:**
- Consumes: Tasks 1–3a.
- Produces:
  - `PaneMap(props: { arrangement: Arrangement; mounted: string[]; onArrangement(next: Arrangement): void; active: string[]; maximized: string | null; onRestore(): void; renderPane(id: string, rect: PxRect | null, onScreen: boolean): ReactNode; onPopOut(id: string, x: number, y: number): void; handle: React.Ref<PaneMapHandle> })`
    - `mounted` is every pane App keeps mounted today: `listed` (`App.tsx:841`), which covers every workspace and every section, popped-out panes included. `arrangement.order` is the part of it placed now. A mounted pane outside the order gets `rect: null` and is hidden.
    - `onRestore()` asks App to clear `maximized`. `maximized` stays App state, as today.
  - `interface PaneMapHandle { reveal(id: string): void }`. It scrolls the region so the pane is fully on screen on a whole line (`scrollFor` with `{ kind: "active", ids: [id] }`).
    - If a different pane is maximized, it calls `onRestore()` and keeps the reveal pending. A layout effect does the scroll once `maximized` is `null` and the restored placement is laid out. Scrolling before that would measure the full-screen layout.
    - A Focus pane is already on screen, so it gets focus only.
  - `placeInOrder(order: string[], id: string, targetId?: string): string[]` in `src/paneArrangement.ts`. It replaces `placeDashboardPane` (`src/dashboardNavigation.ts:4`) with the same rules: a pane not in the order is appended, and with a target the two panes trade places ("trade positions, never identities"). An unknown target throws "That pane is no longer available."

**Behaviour:**
- The region is a native scroller on `placement.axis`, with `scroll-snap-type: <axis> mandatory` and `scroll-snap-align: start` on line starts.
- **Zoom input:**
  - Ctrl or ⌘ with the wheel, or a pinch (Chromium sends it as a ctrlKey wheel), zooms with the constants above, over the region only. Over the Focus pane it only calls `preventDefault`: the page doesn't zoom and the panes don't change, as in the mockup (`real-app.js:1747`, revision 12).
  - Register the listener with `{ passive: false }` and call `preventDefault`, so Electron's page zoom never fires.
  - Keys, with the region focused: `-` zooms out, `=` or `+` zooms in, `0` goes back to the default level.
  - **The pointer (revision 12).** PaneMap keeps the pointer's last position over the region, and forgets it on `pointerleave` (the mockup's `lastPtr`, `real-app.js:1104,1769,1781`).
    - A wheel step uses the wheel event's position.
    - A key step uses the last position while there is one. So with the pointer resting on the map, a key zooms exactly as a wheel there would (`zoomBy` → `zoomFocus`, `real-app.js:1192-1194,1105-1107`).
    - With the pointer off the region, a key step has no position.
  - Every step passes `chooseAnchor`:
    - `centre`: the `centreId` of the placement before the step.
    - `pointerId`: the pane under the position, before the step. Over a gap, the first pane of the line under the position (`rowAnchorAt`, `real-app.js:1049`). With no position, `null`.
    - `held`: the pane the last step anchored to through `held` or `pointerId`, while the position is within 4 px of where it was at that step (`ptrPick`, `real-app.js:1057-1058,1076`). Otherwise `null`. So with the pointer held still, zoom keeps heading for the same pane after the columns change and slide another pane under the pointer. The mockup holds its pick only for a selection too spread to fit (`real-app.js:1073-1077`). Task 4 also holds it with the Focus pane active, on purpose, for the same reason.
  - Every step then scrolls to `zoomScroll(next, anchor, at)` (Task 3a), never to `scrollFor` alone. `at` depends on the anchor:
    - An `active` anchor: the centre of its middle pane, where it was on screen before the step. Use the region's middle if none of the anchor's panes was on screen. (On the x axis the mockup pins an off-screen pane to the screen's edge instead, `real-app.js:1114`. Task 4 centres on both axes, on purpose.)
    - A `pane` anchor with a position: the position on the axis.
    - A `pane` anchor with no position: `null` when it is one of the `active` panes. That is the middle selected pane, centred as `real-app.js:1084` does. Otherwise the region's middle, which keeps the `centreId` pane where the mockup's centre point keeps it (`real-app.js:1108`).
- **Moving without zoom:**
  - Home and End go to the first and last line; arrow keys move one line; PageUp and PageDown move one screen.
  - In Vertical, an up/down wheel over a gap (not over a scrollable transcript) scrolls sideways.
- **Glide.** Panes move by `left`/`top` with a 220 ms transition, and none under reduced motion. Never by `transform`: a transformed slot traps the pane's fixed pop-ups (revision 13, Task 7a).
- **Focus divider.** In Focus left/right, one divider between the focus pane and the region drags `focusShare` live. A double-click resets it to 0.58. Even grid has no dividers.
- **Mounting.** Every pane in `mounted` stays mounted, as today (`App.tsx:2944-2945`: "Every pane of every workspace stays mounted so its session keeps running"). Panes off screen keep their rects. A pane outside the order, popped out, or behind a maximized pane gets `display: none`.
- **One parent, always.** Each pane is a keyed child of one container element that is never swapped, and never wrapped differently from one layout to another. React remounts a component whose parent element changes. A remounted ChatPane loses its draft and starts a new turn queue, which Task 15's retry depends on. A terminal restarts, and a preview reloads.
  - So the Focus pane is not moved into a box of its own. The container is the native scroller itself. The region's panes are placed inside it, and the Focus pane stays in it too, pinned with `position: sticky`. A scroll listener can't hold it still, because it runs after the compositor has drawn the scrolled frame (revision 13, Task 7a).
  - Changing the layout, the focus pane, the section, full screen or pop-out only changes styles.

- [ ] **Step 1: Write the failing scenario.** Mount `PaneMap` with 14 plain `<div data-id>` panes in a 1200×800 window, then assert:
  - `p0` is 294 × 261 (±1).
  - One `ctrl` wheel of `deltaY: -100` leads to `p0` being 395 wide.
  - Eight wheel events of `deltaY: -4` within 400 ms lead to exactly one more level, not two.
  - After a plain wheel and a 400 ms pause, `scrollTop` is one of the snaps.
  - In `vertical` mode, a plain wheel over the gap at x=298 means `scrollLeft > 0` and `scrollTop === 0`.
  - After a window resize to 900×650, the active pane is still fully inside the region.
  - With reduced motion emulated, the computed `transition-duration` of a pane is `0s`.
  - At the default zoom, `p13` is below the fold. `handle.reveal('p13')` puts its whole rect inside the region, and `scrollTop` is one of the snaps.
  - With `p2` maximized, `reveal('p13')` calls `onRestore` once. After the test's parent clears `maximized`, `p13`'s whole rect is inside the region and `scrollTop` is one of the snaps.
  - In Focus left, `-` and `=` with the region focused and the pointer off the region zoom around the region's centre pane (`centreId`), and nothing throws. From the default zoom (1×3, scroll 0, centre pane `p2`), `=` gives 1×2 with `scrollTop` 0, `p2` on the lower line. (`at = null` would scroll to 404.)
  - **Keys follow a resting pointer (Review Focus 25).** Pass `active={['p0', 'p13']}`. In Even grid at the default zoom (4×3), scroll 0, move the pointer to region point (975, 50), over `p3`, and press `=`. The level is 3×3 and `scrollTop` is 269.33 (±1), so `p3` stays on the top line. (Ignoring the pointer would leave it at 0.)
  - **A still pointer keeps its pane (Review Focus 25).** The same start, with the pointer at region point (630, 30), over `p2`. Press `=` three times without moving it. `scrollTop` ends at 404 (±1), with `p2` fully on screen at 2×2. (Without `held`, the second press takes `p1`, now under the pointer at 3×3, and ends at 0.)
  - **No zoom over the Focus pane (Review Focus 25).** In Focus left, a `ctrl` wheel of `deltaY: -100` over the Focus pane leaves the level and `scrollTop` unchanged, and a window `wheel` listener sees it `defaultPrevented`.
  - **Zoom keeps its anchor in place (Review Focus 23).** In Even grid one level in (3×3), scrolled to the end, with `p6` active on the top line, one `ctrl` wheel in leaves `p6` on the top line: `scrollTop` is 808 (±1).
  - **A pane you add is seen (Review Focus 24).** With 14 panes at the default zoom, scrolled to the end, adding a pane through `addPane` puts it first and focused, with its whole rect on screen and `scrollTop` 0.
  - **No remounts (Review Focus 11).**
    - Mount 16 probe panes. 14 are in the order; the other 2 stand for a pane of another section and a popped-out pane.
    - Each probe counts its mounts and holds an uncontrolled `<textarea>` with text typed into it.
    - Switch through all five layouts. Make another pane the Focus pane. Maximize and restore. Swap the order to the other 2 plus 12 of the first 14, then back, as a section switch does.
    - Every probe has mounted exactly once, and every textarea still holds its text.
  - Unit (`tests/dashboard-navigation.test.mjs`, rewritten for orders): `placeInOrder(['a','b'], 'c')` gives `['a','b','c']`; `placeInOrder(['a','b'], 'c', 'b')` gives `['a','c','b']` (the new pane takes b's place, and b is kept); `placeInOrder(['a','b','c'], 'c', 'a')` gives `['c','b','a']`; `placeInOrder(['a','b','c'], 'b')` is unchanged; an unknown target throws. `tests/dashboard-opening.test.mjs` still passes.
- [ ] **Step 2: Run and check it fails.** Run `node --experimental-strip-types --test tests/pane-map-browser.test.mjs`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement `PaneMap` and wire `App.tsx`.**
  - App state goes from `layouts: Record<string, LayoutNode>` to `arrangements: Record<string, Arrangement>`, keyed by the existing `layoutKey(null, section)`.
  - App passes `mounted={listed.map((p) => p.id)}`. `renderPane` returns today's `<section key={pane.id}>` (`App.tsx:2955-3022`) with only its style changed. The `key` and the element stay the same in every layout.
  - App passes `onRestore={() => setMaximized(null)}`.
  - `active` is `[focusedPane]` until Task 10 adds the selection.
  - Keep `maximized` as it is: the maximized pane renders full size and the others stay mounted and hidden.
  - The side panel's Dashboard rows (`dashboardTrees`, `App.tsx:887-900`) read `arrangements[key].order` instead of trees, so their "Pane N · title" targets follow the new order.
  - Dashboard placement writes through `placeInOrder`: `openDashboard` (`App.tsx:2568-2580`) sets `arrangements[key].order` instead of a tree, then calls `handle.reveal(pane.id)` so the placed pane is on screen. `src/dashboardNavigation.ts` is deleted once nothing imports it.
  - Every "go to this pane" path calls `handle.reveal`: Dashboard rows, attention jumps, the sidebar, and (from Task 14) the multi composer's row titles. A pane scrolled off screen would otherwise be focused while out of sight.
  - **A pane you add goes first (revision 11).** `addPane` (`App.tsx:1026`) puts the new pane at the start of its section's order (`layoutKey(null, paneSection(pane))`), so in Focus left/right it is the tall pane. It then calls `handle.reveal(pane.id)`. This is what the mockup's `newThread` does. New thread, the agent and Terminal buttons, the picker, the `new_thread` action and the move dialog's New all go through `addPane`. Panes that `validArrangement` finds missing (restored, unarchived, or added from another window) still go last.
  - Title-bar dragging is off between this task and Task 6. The milestone isn't merged until Task 6 lands.
- [ ] **Step 4: Run** the scenario, `npm test` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Look.**
  - Open the AGENTS.md dev build, look only, and screenshot all five layouts at both sizes.
  - Compare with `mockups/adaptive-thread-panes.html`.
- [ ] **Step 6: Commit** with `feat(panes): native scrolling pane map with one-level zoom`.

### Task 5: Five layouts in the picker, saved per section

**Files:**
- Modify:
  - `src/LayoutPicker.tsx`
  - `src/types.ts:318,571`: replace `Layout` with `PaneLayoutMode`; `AppSession.arrangements?: Record<string, unknown>`.
  - `src/hostSession.ts:66-75`
  - `src/closing.ts:120-140`
  - `src/App.tsx:347-348,640-647,667,904-916`
  - `src/styles.css`
- Test: `tests/layout-picker.test.mjs`, and extend `tests/canvas-panes.test.mjs` for migration.

**Interfaces:**
- Consumes: `arrangementFromSaved` and `validArrangement` (Task 2).
- Produces: `LayoutPicker({ value: PaneLayoutMode; disabled: boolean; onSelect(mode: PaneLayoutMode): void })`.

The choices, in this exact order:

| id | label | description |
| --- | --- | --- |
| `horizontal` | Horizontal | Wide rows, scroll down |
| `vertical` | Vertical | Tall columns, scroll sideways |
| `grid` | Even grid | Give every pane equal space |
| `left` | Focus left | One tall pane on the left |
| `right` | Focus right | One tall pane on the right |

Previews:
- `.layout-preview-horizontal { grid-template: repeat(3, 1fr) / 1fr }` and `.layout-preview-vertical { grid-template: 1fr / repeat(3, 1fr) }`, each with three `<i>`.
- `right` mirrors `left`.

The mockup's "new" pills are mockup-only; don't ship them.

- [ ] **Step 1: Write the failing tests.**
  - Render `LayoutPicker` to static markup with `value: 'vertical'`. Assert:
    - five `role="menuitemradio"`, in the order above
    - exactly one has `aria-checked="true"`, and it is Vertical
    - the trigger's label is `Pane layout: Vertical`
    - there is no `aria-haspopup` on any choice
  - Session migration: `{ layout: 'top', layouts: { ':threads': tree(a,b,c) } }` becomes `arrangements[':threads']` = `{ mode: 'grid', order: ['a','b','c'], zoom: 1, focusShare: 0.58 }`, and the saved session no longer has `layouts`.
  - Session migration of an Even grid saved beside `layout: 'left'` gives `mode: 'grid'`, and the restored picker shows Even grid (the picker reads the arrangement, never the old `layout` field).
  - Zoom on switching, with `arrange` driven from the picker:
    - Zoom in once in Focus left, then switch to Even grid. `zoom` is 1, and `scrollTop` is 0.
    - Zoom in once in Even grid, then switch to Horizontal. `zoom` is 1.
    - Zoom in once in Focus left, then switch to Focus right. `zoom` and `focusShare` are kept.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
  - `arrange(mode)` keeps `order`.
  - For `left`/`right` it moves the focused pane to `order[0]` (D6).
  - Switching **into** Horizontal, Vertical or Even grid from any other layout, Focus left/right included, resets `zoom` to 1 and scrolls to the start. That is what `real-app.js:setLayout` (`:2853-2857`) does. A Focus layout's zoom counts levels of the narrower side region, so carrying it over would land on a surprising level. Focus left ↔ Focus right keeps both `zoom` and `focusShare`.
- [ ] **Step 4: Run** the tests, `npm test` and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(panes): Horizontal, Vertical, Even grid, Focus left, Focus right`.

### Task 6: Drag to reorder, pop-out by index

**Files:**
- Modify:
  - `src/PaneMap.tsx`
  - `src/popoutModel.ts:111-125,291+`
  - `src/App.tsx`: pop-out and return.
  - `src/PaneLayout.tsx`: delete `usePaneDrag`.
- Test: `tests/popout-model.test.mjs` (extend) and `tests/pane-map-browser.test.mjs` (extend).

**Interfaces:**
- Consumes: `insertIndex` and `reorder` (Task 3). Pass `insertIndex` the region's current scroll on `placement.axis` as its fourth argument, and the pointer relative to the pane area as seen on screen.
- Produces:
  - `PaneSpot = { workspaceId: string; index: number; before: string[] }`
  - `restoreOrder(order: string[], paneId: string, spot: PaneSpot): string[]`

**Behaviour:**
- On pointerdown on a title bar (not on its buttons), the pane follows the pointer, and the others glide to make room at `insertIndex`. Nothing snaps.
- Near a scroll edge, the region auto-scrolls (`real-app.js:edgePan`).
- Esc cancels and the pane glides back.
- Releasing outside the window pops the pane out, as today.

- [ ] **Step 1: Write the failing tests.**
  - `restoreOrder(['b','c'], 'a', { workspaceId: 'w', index: 0, before: ['a','b','c'] })` gives `['a','b','c']`.
  - With `index: 5` (past the end), the pane is appended.
  - Scenario:
    - Drag the head of `p0` to the centre of `p3`'s cell and release. The order then starts with `p1,p2,p3,p0`.
    - Start the same drag again and press Esc mid-drag. The order is unchanged.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(panes): live drag to reorder; pop-outs return by position`.

### Task 7: PaneHead — 28 px title bar that sheds parts, marquee, double-click full screen

**Files:**
- Create: `src/PaneHead.tsx` and `src/headFit.ts`
- Modify: `src/App.tsx:2962-2998` (render `<PaneHead>`) and `src/styles.css`
- Test: `tests/head-fit.test.mjs` and `tests/pane-head-browser.test.mjs`

**Interfaces:**
- Produces:
  - `type HeadPartId = "dot" | "project" | "title" | "host" | "status" | "server" | "counts" | "maximize" | "menu" | "close"`
  - `headFit(width: number, parts: { id: HeadPartId; width: number }[]): Set<HeadPartId>`, the hidden parts.
  - `PaneHead(props: { pane: Pane; workspace: Workspace | undefined; status: string; attention: Signal | undefined; statusText: string; server: string | undefined; host: { id: string; name: string } | null; maximized: boolean; onMaximize(): void; onMenu(anchor: DOMRect, opener: HTMLElement): void; onClose(): void; onRename(title: string): void; renameRequest: number | undefined; onDragStart(e: React.PointerEvent): void; onOpenServer(): void })`, carrying exactly what `App.tsx:2962-2998` reads today. Task 14 adds `route`.
  - `ThreadName` gets `editOnDoubleClick?: boolean` (default `true`, so the sidebar row is unchanged). `PaneHead` passes `false` and its own tooltip, "Double-click for full screen" (D7).

**Shedding order, first to go → last:**
1. status words
2. server chip
3. host chip
4. counts
5. project chip
6. maximize □
7. menu ⋯

The title shrinks with an ellipsis before any of these. The dot, title and × stay.

- [ ] **Step 1: Write the failing tests.**
  - `headFit(190, parts)` hides everything except `dot`, `title`, `maximize`, `menu` and `close`.
  - `headFit(125, parts)` leaves exactly `dot`, `title` and `close`.
  - Test fixture widths. These are fixed test inputs, not measurements:
    - head padding 8 each side, gap 4 between visible parts
    - dot 8, project 70, title 56 (its minimum), host 50, status 60, server 40, counts 34
    - each button 20
  - With those widths, the order above gives exactly the two results stated.
  - Scenario:
    - Double-clicking the head toggles maximize; the double-click lands on the title text, not a button. Esc restores, unless a menu is open, in which case Esc closes the menu first.
    - When the title is cut off, hovering for 400 ms gives the inner span a running `animation-name` other than `none`. Leaving resets it to `none`.
    - Under reduced motion, it is always `none`.
  - Rename (D7):
    - Double-clicking the title text toggles full screen and opens no editor.
    - ⋯ → Rename opens the editor in the head with the old name selected. Typing a name and pressing Enter calls `renamePane` once.
    - Esc in the editor cancels the edit only: a maximized pane stays maximized.
    - While the editor is open, no marquee runs and dragging the head doesn't start.
    - The sidebar row still renames on double-click.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.** Port `real-app.js:fitSteps`, `setTitleText` and `fitHead`, plus the `mk-marquee` CSS from `real-mk.css:129-134` (renamed without `mk-`).
- [ ] **Step 4: Run** the tests, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Look.** Screenshot heads at 600, 190 and 125 px wide and compare with the mockup.
- [ ] **Step 6: Commit** with `feat(panes): compact pane title bar`.

### Task 7a: Fixes from the review of Tasks 4–7 (revision 13)

**Files:**
- Modify:
  - `src/PaneMap.tsx` and `src/styles.css`
  - `src/BrowserView.tsx`
  - `src/App.tsx`: `arrange` (`:901-910`) and the full-screen side panel's Esc (`:523-533`)
  - `src/popoutModel.ts`: `restoreOrder` (`:132`)
- Delete what nothing outside tests uses any more, with those tests:
  - `src/PaneLayout.tsx`
  - `savedLayouts` (`closing.ts`), and `takePaneOut`, `restorePane` and `LegacyPaneSpot` (`popoutModel.ts`)
  - from `src/layout.ts`, everything but `validate`, `leafIds` and `normalize`
  - the CSS for `.pane.lifted`, `.drop-preview` and `.grid.adjusting`, and Clay's two `.grid:has(…)` selectors
- Test:
  - `tests/helpers/pane-map-browser.jsx`, `tests/helpers/pane-map-electron.cjs` and `tests/pane-map-browser.test.mjs`
  - `tests/popout-model.test.mjs` and `tests/layout-picker.test.mjs`
  - The scratch fixture in `/tmp/jigga-int/` shows how to capture drawn frames (`scenario2.cjs`) and place fixed pop-ups (`scenario3.cjs`).

**Behaviour:**
1. **Panes placed without transforms.**
   - A slot is `position: absolute` at `left`/`top` in the scroller's content (the scroller moves it), with `width` and `height`. The glide transitions those four for 220 ms, and none under reduced motion.
   - The lifted pane follows the pointer with `left`/`top` too.
   - Global Constraints lists what else may not sit between the map and a pane.
2. **The compositor holds the Focus pane.**
   - `.pane-map-space` becomes `position: absolute` at (0, 0), still sized to the scroll range. The Focus slot is the only in-flow child: `position: sticky; top: 0`, with its x set by `margin-left`. Checked in Electron 44: a sticky pane laid out this way didn't move in any of 34 frames drawn while its scroller moved 1,080 px (`scenario4.cjs`, variant 1).
   - The divider moves out of the scroller, into a wrapper that doesn't scroll. The wrapper is the same element in every layout, and the scroller stays every pane's one parent.
   - Nothing is moved from a scroll listener.
3. **Panes render only when their own inputs change.**
   - The scroll position isn't React state. On scroll, PaneMap works out which panes are on screen and sets state only when that list changes.
   - Each slot's content is a memoised component. Its props are `renderPane`, the id, the rect's four numbers and `onScreen`. So a PaneMap render that changes none of those renders no pane: a scroll that keeps the same panes on screen, a drag move that doesn't reorder, a divider hover.
   - App's own renders still render the panes, as today, because App passes a new `renderPane` each time.
4. **A docked preview steps aside while the map moves.**
   - PaneMap marks its scroller `data-moving` from the first scroll event, zoom step, reorder, returning pane or divider move, until 150 ms after the last scroll event and the last glide's `transitionend`.
   - `BrowserView` counts a pane as covered while its nearest `[data-pane-map-region]` is `data-moving`, or while its placeholder isn't fully inside that region's rect. Covered already means: hide the native view and show its picture, as for an open menu (`BrowserView.tsx:47-55`).
   - `BrowserView` also looks again on `transitionend` and `scrollend`, so once the map settles the live page shows at the final rect.
5. **A drag-out leaves the order as it was.** Releasing outside the window puts `drag.original` back first, then calls `onPopOut`.
6. **Zoom keys need the map itself focused** (`event.target === el`), as the arrow keys do.
7. **Full screen keeps your place.** Maximizing remembers the scroll. Restoring scrolls back to it, then runs `scrollFor` for the active pane from there.
8. **Small fixes:**
   - Picking the layout already in use changes nothing, zoom included, as in the mockup (`real-app.js:2856`).
   - `restoreOrder` puts a pane back after the nearest pane that came before it in `spot.before` and is still in the order. Failing that, it goes before the nearest one that came after it, and failing that at `spot.index`. So panes come back beside their old neighbours, in whatever order they return, and after a new pane went first.
   - App's Esc for a full-screen side panel calls `preventDefault`, so the same Esc doesn't also restore a maximized pane (`PaneHead.tsx:99` checks it).

- [ ] **Step 1: Write the failing tests.** Each one fails on `d775c6c1`. The fixture is 1200×800, in Even grid at the default zoom (4×3), unless a line says otherwise.
  - **Fixed pop-ups (Review Focus 26):**
    - A `position: fixed` element meant for screen point (342, 329), inside `p5`, has its rect at (342, 329) ±1. On `d775c6c1` it is at (644, 598).
    - A `position: fixed; inset: 0` element inside `p5` is 1200×800 at (0, 0). On `d775c6c1` it is 294×261 at (302, 269).
    - The same two in Focus left, inside the Focus pane and inside a side pane, and inside `p5` during a glide.
  - **Focus pane holds still (Review Focus 27).** Use an offscreen window (`webPreferences.offscreen`, its `paint` event and `image.toBitmap()`), Focus left, and a Focus pane of one solid colour.
    - Over the side region at (region.x + 60, 400), send 24 wheel steps of 45 px down and 24 back up, 16 ms apart.
    - In every drawn frame, the Focus pane's top and bottom edges, read down its middle column, are within 1 px of where they are at rest. On `d775c6c1`, 22 of 27 frames had moved.
    - In every drawn frame the divider is at the same x and covers the full height.
  - **Renders (Review Focus 28).** Probe panes count their renders.
    - During 12 plain wheel steps of 50 px, the two panes that are never on screen render 0 times. Every other pane renders at most once per time it comes on or goes off screen. On `d775c6c1`, every mounted pane rendered once per scroll event.
    - Six pointer moves of a title drag that stay inside `p0`'s own cell render no probe.
  - **Preview (Review Focus 29).** A `BrowserView` in a probe pane, with a stub `BrowserApi` that records `show`, `bounds` and `hide`:
    - At rest and fully inside the map, the last call shows it at its placeholder's rect.
    - During a wheel scroll that moves it half out of the map, `hide` is called with a picture, and no `show` or `bounds` call has a rect that reaches outside the map's rect.
    - After a reorder glide moves it one cell, the last call shows it at its new rect within 300 ms of the glide's end.
  - **Drag-out.** Dragging `p0`'s title over `p1`–`p3` to (1230, 150) and releasing calls `onPopOut` once, and at that call the order starts `p0,p1,p2,p3`. On `d775c6c1` it starts `p1,p2,p3,p0`.
  - **Keys.** With `p3`'s probe button focused, `-` leaves the level at 1, the default. With the map focused, `-` takes it to 0.
  - **Full screen.** With `active` `['p5']`, scroll to the last snap (269.33), maximize `p5`, then restore. `scrollTop` is 269.33 ±1. On `d775c6c1` it is 0.
  - **Small:**
    - `layout-picker`: zoom in once in Even grid, then pick Even grid. The zoom doesn't change.
    - `popout-model`: from `['a','b','c','d']`, pop out `b` and then `c`, and bring back `b` and then `c`. The order is `['a','b','c','d']`. Then pop out `c`, put a new `n` first, and bring `c` back. The order is `['n','a','b','c','d']`.
- [ ] **Step 2: Run and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the PaneMap scenarios, `npm test` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Look, in the real app.** This is the look Task 4 still owes.
  - Use a throwaway data folder, never the user's real data. The AGENTS.md dev command attaches the real dev data. Instead, run Vite and `electron .` with `APEX_DECK_DEV_URL` and a throwaway `APEX_DECK_DATA_DIR`, and drive it over CDP.
  - Seed 14 threads with long transcripts, one terminal and one docked Preview.
  - At 1512×945 and 1100×650:
    - Screenshot all five layouts.
    - Select text in a pane that isn't top-left. The toolbar sits on the selection.
    - Right-click a path in a transcript. The menu opens at the pointer.
    - A Preview's full window fills the window.
    - In Focus left, scroll the side panes. The Focus pane holds still.
    - Scroll so the Preview pane passes the map's top edge. Its page never covers the title bar.
    - Drag a pane out of the window, then close its window. It comes back where it was.
- [ ] **Step 6: Commit** with `fix(panes): fixed pop-ups, sticky focus pane, render cost and previews in the pane map`.

### Task 7b: Fixes from the review of Task 7a (revision 14)

**Files:**
- Modify: `src/PaneMap.tsx`, `src/styles.css` and `src/BrowserView.tsx`
- Test: `tests/helpers/pane-map-electron.cjs` with `tests/pane-map-browser.test.mjs`, and `tests/helpers/browser-view-map.jsx` with `tests/helpers/browser-view-map-electron.cjs`
- A working prototype of all three fixes, with the probes that measured them, is in `/tmp/jigga-7a/`:
  - `proto7b.diff` against `6be84694`, and the patched files in `proto7b-copy/`
  - `fixture7a.jsx` (the committed code) and `fixture7b.jsx` (the prototype), both run by `s7a.cjs`
  - On the prototype: no jump in T1, 0 px of lag in T2, no call for the Focus pane's preview in T3, and 0 problems in the T4 sweep at 1200×800 (92 cases).
  - Use it as a reference, but write your own.

**Behaviour:**
1. **A pane glides into and out of the Focus slot.**
   - PaneMap remembers where its last layout drew each pane: that placement, and the scroll when the next change starts.
   - When the Focus pane's id changes, and neither layout is full screen and motion isn't reduced:
     - The pane coming in starts where it was drawn. Animate its sticky `top` from its old y to 0, and its `margin-left` from its old x to its Focus x.
     - The pane going out starts where the Focus pane was drawn. Animate its `left` and `top` from that point, in the scroller's content coordinates at the new scroll, to its new rect.
     - Both take 220 ms with `ease`, as the CSS glide does. `width` and `height` keep their CSS glide.
   - Use `element.animate()` on those properties, never on `transform`. A pop-up opened mid-glide must still land on its point (Review Focus 26).
2. **No glide while the divider is held.**
   - `.pane-map` gets a `resizing` class while the divider is held. With it, every slot, the pinned one included, has `transition: none`.
   - Don't reuse `adjusting` for this: title drags set it too, and their panes must keep gliding aside.
   - Moving the divider with the arrow keys keeps the glide.
3. **The Focus pane's preview stays live while only the side panes move.**
   - PaneMap sets a second marker on the scroller, `data-focus-moving`. It is set only when the Focus pane itself moves or resizes, or something can pass over it:
     - a change of Focus pane, or of its rect: a layout switch, a divider move, a window resize
     - full screen and back
     - every move of a title drag
   - Scrolling and zoom set only `data-moving`, as today. Both markers clear by today's rules.
   - Inside `[data-pinned]`, `BrowserView` reads `data-focus-moving`. Everywhere else it reads `data-moving`. The fully-inside check doesn't change. Add the new attribute to its `MutationObserver` filter.
   - A lifted pane loses `data-pinned` (`PaneMap.tsx:391`). So when the Focus pane itself is dragged, it reads `data-moving`, and its preview steps aside.

- [ ] **Step 1: Write the failing tests.** The fixture is 1200×800 with 14 panes, unless a line says otherwise.
  - **The glide (Review Focus 30).** Sample the slot's rect on every frame for 360 ms after each switch.
    - In Even grid with `p5` active, switch to Focus right with `p5` first. In the first frame after the switch, `p5` is within 60 px of (302, 269). It ends at (509, 0). On `6be84694` the first frame has it at (0, 0).
    - The same for Even grid → Focus left, which ends at (0, 0), and for Focus right → Even grid, which starts within 60 px of (509, 0).
    - Under reduced motion, the first frame already shows the final rect.
    - A fixed pop-up inside `p5`, placed mid-glide, lands on its point.
  - **The divider (Review Focus 31).**
    - In Focus left, press the divider and move it right 20 px per frame, six times. After each move, the Focus slot's drawn width equals `place()`'s Focus width ±1: 711, 731 and so on up to 811. On `6be84694` it stays at 691.
    - During a title drag, a pane that moves aside still has a `transition-duration` above 0.
  - **The Focus pane's preview (Review Focus 32).** Put a `BrowserView` with a stub `BrowserApi` in `p0`, the Focus pane, and in `p1`, the first side pane, in Focus left. Send 12 wheel steps of 45 px over the side region, 16 ms apart, then let the map settle.
    - `p0` gets no `hide`, `show` or `bounds` call. On `6be84694` it is hidden twice.
    - `p1` is hidden with a picture from the first step. No call for either pane has a rect that reaches outside the map.
    - A switch to Focus right, a divider move and a title drag each hide `p0` with a picture. After each, it shows again at its new rect within 300 ms of the end.
- [ ] **Step 2: Run and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the PaneMap and BrowserView scenarios, `npm test` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Look** in the full-App fixture at both sizes:
  - Switch Even grid → Focus left → Focus right → Even grid, and screenshot each switch mid-glide.
  - Drag the divider.
  - With a Preview as the Focus pane, scroll the side panes.
- [ ] **Step 6: Commit** with `fix(panes): glide into the Focus slot, live divider and Focus preview`.

**Milestone 1 done when:**
- Tasks 1–7b are merged by the user's OK after Null's review.
- The user has tried the five layouts and zoom in the dev build.

---

## Milestone 2 — One composer at the bottom (branch `feat/composer-dock`)

### Task 8: ComposerDock with per-thread drafts

**Files:**
- Create: `src/ComposerDock.tsx`
- Modify:
  - `src/ChatPane.tsx:4039-4156`: when the `dock` prop is set, render the composer subtree (the `.composer` block, agent chip row included) through `createPortal(…, dock.slot)` if this pane is the target, and nothing otherwise. Without `dock`, render it in place, exactly as today.
  - `src/ChatPane.tsx:878-889,1888-1895,1950,1997,2268-2273,2427-2431,2511-2524,2544-2549,2619-2621,2757-2766`: the actions that fill the composer from outside it call `showComposer()`.
  - `src/App.tsx`: one `<ComposerDock>` under the pane region, the `composerTarget` state, and `dock` passed by the pane map only.
  - `src/styles.css`
- Unchanged, and tested to stay so: `src/TalkOnlyChat.tsx`, `src/PopoutApp.tsx` and `src/AgentsSection.tsx`.
- Test:
  - `tests/composer-dock-browser.test.mjs`, built on the real-ChatPane harness in `tests/chat-attach-component.test.mjs`
  - `tests/talk-only-chat-surface.test.mjs` (extend; it mounts the real `TalkOnlyChat`)
  - `tests/composer-dock-contract.test.mjs` (new, a source contract in the style of `tests/popout-thread-controls.test.mjs`)

**Interfaces:**
- Produces:
  - `ComposerDock(props: { target: { paneId: string; title: string; project: string } | null; slotRef: (el: HTMLDivElement | null) => void; children?: ReactNode })`
  - `ChatPane` props `dock?: { target: boolean; slot: HTMLElement | null }` and `onWantComposer?(paneId: string): boolean`, which returns false when the dock can't show that pane
- **Docking is opt-in.** Four other places render a `ChatPane`, and none of them passes `dock` or `onWantComposer`, so each keeps its own composer, as today:
  - talk-only chats (`src/TalkOnlyChat.tsx:116`), which send through `onChatSend`
  - the pop-out window's thread (`src/PopoutApp.tsx:425`)
  - the pop-out window's hidden ChatPane behind a details tab (`src/PopoutApp.tsx:610`)
  - the Agents library (`src/AgentsSection.tsx:19`), which has no composer in `profileMode` anyway
  - Without `onWantComposer`, `showComposer()` only focuses the pane's own input, as today.
- `composerTarget` is the focused chat pane. When a terminal or preview has focus, it is the most recent chat pane (`recentThreads[0]`). Zoom, scroll, drag and layout switches never change it. `onWantComposer(id)` sets it to `id`.
- **It is never a popped-out pane.** A popped-out pane stays mounted, hidden, in this window (`App.tsx:844`), so it gets `dock` like every pane in the map, but its own window owns its composer. If the focused or most recent chat pane is popped out, the target is the most recent one that isn't, or none.
  - Popping out doesn't move focus (`popOutPane`, `App.tsx:1456`), and the Files tab adds to the focused pane (`App.tsx:3167`). So Add to chat can still name a popped-out pane. `onWantComposer` then returns false and changes nothing, and `showComposer()` skips the write and says "That thread is open in its own window." Today the text lands in that pane's hidden composer here, where no one sees it.

- [ ] **Step 1: Write the failing scenario.**
  - Two real ChatPanes, A and B.
  - Focus A and type `alpha`. Focus B and type `beta`. Focus A again.
  - Expected:
    - the textarea value is `alpha` with its caret at 5
    - the dock's "To:" line names A
    - `document.querySelectorAll('.composer-input').length === 1`
  - Ctrl+wheel over the panes leaves the target as A.
  - **Coming back to an unchanged multiline draft:**
    - In A, type three lines and put the caret in the middle of line 2. Note the textarea's height, `scrollTop` and selection.
    - Focus B, resize the window by 200 px, then focus A again.
    - The value, height (±1 px), `scrollTop` and selection are the same as before, and the agent chip row is refitted to the new width. No chip overflows the row.
  - **Filling a composer that isn't shown.** With A focused, dispatch `INSERT_COMPOSER_EVENT` for B with the text `` `src/App.tsx` ``, as a file's Add to chat does. The dock now targets B, and B's textarea holds the text with the caret after it. (A click in B, as for Quote, already makes B the target by focusing it. Task 14 tests Quote in multi mode, where a click inside the selection doesn't leave it.)
  - **Popped-out panes.** Pop A out through a stub `window.apexDeck.popout` bridge, then give a terminal focus while A is `recentThreads[0]`.
    - The dock targets the next recent thread, never A, and A's hidden copy renders no `.composer-input`.
    - `INSERT_COMPOSER_EVENT` for A changes no draft, leaves the dock's target as it was, and shows "That thread is open in its own window."
  - **Composers outside the dock** (Review Focus 13):
    - `tests/talk-only-chat-surface.test.mjs`: the chat's own `textarea[aria-label="Message the room"]` is inside its section, there is no `.composer-dock`, and typing `hi` then Enter calls `onChatSend` once with `hi`.
    - In `tests/composer-dock-browser.test.mjs`, a real `ChatPane` mounted with exactly the pop-out's props (`PopoutApp.tsx:425`; no `dock`) shows its composer in place. Typing `hi` and pressing Enter makes the in-memory service receive `room_post_to` with `hi`.
    - `tests/composer-dock-contract.test.mjs`: `dock=` appears in `src/App.tsx`'s pane map and nowhere in `TalkOnlyChat.tsx`, `PopoutApp.tsx` or `AgentsSection.tsx`.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
  - List what positions itself against the pane today, then check each one inside the dock and fix its CSS:
    - the replies/quote bar
    - the `+` menu
    - the runner panel
    - voice controls
    - quick-add dock
  - Keep `aria-label="Message the room"`.
  - **Mounting.** The composer subtree now mounts and unmounts every time the target changes. Effects that bind to its elements once, with `[]`, would keep watching a detached node or never bind at all. Example: the chip row's `ResizeObserver` at `ChatPane.tsx:2455-2468`.
    - Rebind each one when its element mounts: use a callback ref, or key the effect on the element.
    - Audit every `useEffect`/`useLayoutEffect` in `ChatPane.tsx` whose ref lives inside the composer subtree. `chatBody` (`:2436-2444`) is outside it and stays as it is.
  - **Caret.** On unmount, keep the selection and `scrollTop` in a ref, and restore them in a layout effect on mount, before paint. The text is already state.
  - **Filling a composer that isn't shown.** Today every pane shows its own composer, so an action that writes into it is always visible. With one dock, only the target's composer is mounted, and these actions would fill a hidden draft:
    - Quote (`:1997`) and Add to chat on picked text (`:1888`)
    - a file's Add to chat from Files or a preview (`INSERT_COMPOSER_EVENT`, `:878`)
    - Revert (`:1950`), Discuss on a card (`:2268`) and Add to message on a code run (`:2427`)
    - Ask for review (`:2511`), attaching from Files (`:2544`), Use tool (`:2619`) and examples (`:2757`)
  - Each of them calls one helper, `showComposer()`, before it writes. It calls `onWantComposer(pane.id)`, and then focuses the input once it is mounted (a layout effect, not `input.current?.focus()` straight away, since `input.current` is `null` until then). Audit the other `input.current?.focus()` calls in `ChatPane.tsx`: one inside the composer subtree is fine as it is.
  - When `onWantComposer` returns false (a popped-out pane), `showComposer()` returns false, the action writes nothing, and the notice above shows. Without `onWantComposer` (no `dock`), `showComposer()` returns true and only focuses the input.
- [ ] **Step 4: Run** the scenario, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Look.** In the dev build, type into two threads and switch between them. Open a talk-only chat and pop a thread out, and check that both still have their own composer. Don't send. Take screenshots.
- [ ] **Step 6: Commit** with `feat(composer): one composer dock with per-thread drafts`.

### Task 8a: Fixes from the review of Task 8 (revision 15)

**Files:**
- Create: `src/composerTarget.ts`
- Modify: `src/ChatPane.tsx`, `src/ComposerDock.tsx`, `src/App.tsx`, `src/PaneMap.tsx`, `src/paneArrangement.ts`, `src/styles.css` and `src/bot-chip-styles.css`
- Test:
  - `tests/composer-dock-browser.test.mjs`
  - `tests/composer-target.test.mjs` (new)
  - `tests/pane-arrangement-place.test.mjs`
  - `tests/helpers/pane-map-electron.cjs`
  - a full-App scenario, on the pattern of `tests/helpers/appearance-app.mjs`
- `~/.cache/jigga-review/task8/` has the scenarios that measured each problem on the real App: `s1-drop-reflow.cjs`, `s2-details.cjs`, `s3-switch-divider.cjs` and `s5-quickadd.cjs`. Use them as references, but write your own.

**Behaviour:**
1. **A Finder drop attaches to the thread it lands on.**
   - A thread takes a drop at (x, y) when the point is inside its `.chat` box, clipped to the visible box of its `[data-pane-map-region]`. The dock's target also takes a drop inside the `.composer-dock` box.
   - Outside a pane map (pop-out windows and talk-only chats), a thread keeps today's box: the composer's parent.
   - A hidden thread has an empty box and never takes a drop. That covers popped-out copies and threads in other sections.
   - When the thread taking a drop isn't the target, it calls `showComposer()` first, so the dock switches to it, and then attaches the file. If `showComposer()` refuses, nothing is attached.
   - Exactly one thread takes any drop point.
2. **The map keeps its grid while the composer grows.**
   - `ComposerDock` measures how much height its composer has borrowed from the map: the dock's height minus its *rest height*.
     - The rest height is the smallest height the dock has had, with a composer in it, at the current width.
     - It starts over when the dock's width changes, and when the dock shows a composer again after showing none.
   - The dock reports `onBorrowed(px)` in whole pixels, only when the value changes. App passes the value to `PaneMap` as `borrowed`.
   - `place(arr, area, borrowed = 0)` picks the levels, the default level and the zoom level for `{ w: area.w, h: area.h + borrowed }`. Then it lays the panes out in `area`: the same columns and rows, only shorter.
     - A pane is never shorter than `MIN_PANE.h` (56 px). If the rows don't fit, the map scrolls.
   - A change of `borrowed` on its own re-fits the panes at once. It doesn't glide (the slots' 220 ms transition, `styles.css:521`) and it doesn't mark the map moving, so previews stay live and take their new rects.
   - A window resize or a width change still picks the grid again, as today.
3. **Add bot floats over the panes.**
   - In the dock, the "Who's in this thread?" form opens above the composer box, over the map, as the mockup's add menu does (`real-app.js:3043-3066`). The dock's height doesn't change.
   - The form is at most 78% of the map's height, between 260 and 560 px (the mockup's `--mk-qa-max`), and it scrolls inside.
   - It is already `role="dialog"` (`ChatPane.tsx:3442`), so a live preview under it shows its picture (`OVERLAYS` in `browserGeometry.ts`).
   - Outside the dock, it opens in place, as today.
4. **The mockup's To line.**
   - It sits in the composer's column, above the box, and shows `To`, the thread's status dot, its title, and `project · N agents` (`real-app.js:2424-2431`, `real-mk.css:38-46`).
   - Clicking it calls `paneMap.reveal(target)` (`real-app.js:2744`).
5. **"tab" chips in the dock.** The composer's own root carries `data-bot-chip-style`, and `bot-chip-styles.css:43` becomes `[data-bot-chip-style="tab"] .composer-box`.
6. **App's target rules in one tested place.**
   - Move the `composerTarget` rule (`App.tsx:854-856`) into `src/composerTarget.ts` as `dockTarget({ focused, recent, candidates, popped })`. It returns the target id, or null. App calls it.
   - `onWantComposer` stays in App and is the only place that shows the notice. Remove the `notify` from `showComposer()` (`ChatPane.tsx:891-894`).

- [ ] **Step 1: Write the failing tests.**
  - **Drops (Review Focus 33).** In `composer-dock-browser.test.mjs`:
    - Set up the backend stub as `~/.cache/jigga-review/harness/run.mjs` does for the demo backend. Its `onFileDrop` keeps the callbacks, and its `copyAttachment` records `[room, path]`.
    - Put the panes inside a `[data-pane-map-region]` box with `overflow: hidden`, with the lower part of B below that box, under the dock.
    - With A as the target, drop on B's transcript. The file is copied to B only, and the To line names B.
    - Drop on A's transcript: A only. Drop on the dock: the target only.
    - Drop on the dock, at a point inside B's unclipped box: the target only.
    - On `ab166a12`, the first two drops are copied to no thread.
  - **The grid holds (Review Focus 34).** In the full App, with 14 threads in Even grid at 1512×945, as in `s1-drop-reflow.cjs`:
    - Type 9 lines with Shift+Enter. After each line, the map still shows 4×3, and every slot keeps its `left`. Only heights change. On `ab166a12`, it re-tiles at the 5th line.
    - Send. Every slot is back to its rect from before typing, ±1 px.
    - Attach a file, then click back and forth between a thread with a 5-line draft and a thread with none. The map stays 4×3 and no slot moves sideways.
    - Repeat in Horizontal and Focus left, checking their row counts.
    - Resize the window to 1512×700. The grid is picked again, as on `472f1fb5`.
    - Unit test for `place()`: for 14 panes at 1240 px wide, `place(arr, { w: 1240, h: 531 }, 152)` gives the same level and columns as `place(arr, { w: 1240, h: 683 })`, and every rect fits within 531 px.
    - Put a `BrowserView` with a stub `BrowserApi` in a bottom-row pane. Typing 9 lines gives it `bounds` calls only, and no `hide`.
  - **Add bot (Review Focus 35).**
    - Open Add bot in the dock. The map stays 683 ±1 px tall and 4×3. The form's top is above the dock's top, and the whole form is inside the window.
    - A stub preview under the form is hidden with a picture, and it shows again after the form closes.
  - **To line.** Scroll the map until the target is off screen, then click the To line. The target is on screen again.
  - **tab chips.** With `botChips.style: "tab"`, the bottom corners of the docked `.composer-box` are 0.
  - **Target rules (Review Focus 36).**
    - In `tests/composer-target.test.mjs`, `dockTarget` returns:

      | Situation | Target |
      | --- | --- |
      | A thread has focus | that thread |
      | A preview has focus | the most recent thread |
      | The most recent thread is popped out | the next most recent |
      | No recent thread | the first candidate |
      | No candidates | null |
    - The browser test chooses its target with `dockTarget`, not with a rule of its own.
    - Add Task 8's two missing Step 1 checks:
      - Ctrl+wheel over the panes doesn't change the target.
      - After the 200 px resize, the chip row is refitted and no chip overflows it.
- [ ] **Step 2: Run and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the dock, PaneMap and BrowserView scenarios, `npm test` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Look** at both sizes. Type 9 lines, attach a file, open Add bot and click the To line. Take screenshots.
- [ ] **Step 6: Commit** with `fix(composer): drops, steady map and the mockup's To line`.

### Task 8b: Fixes from the review of Task 8a (revision 16)

**Files:**
- Modify:
  - `src/ComposerDock.tsx`, or `src/App.tsx` if App owns the rest height
  - `src/paneArrangement.ts`
  - `src/PaneMap.tsx`
  - `src/ChatPane.tsx`
- Test:
  - `tests/pane-arrangement-place.test.mjs`
  - `tests/composer-dock-app.test.mjs`
  - `tests/helpers/browser-view-focus-map.jsx` and `tests/helpers/browser-view-focus-map-electron.cjs`
  - `tests/composer-dock-browser.test.mjs`
  - `tests/layout-picker.test.mjs`
- Reference: `~/.cache/jigga-review/task8a/proto8b.diff` and the scenarios next to it (`a3-switch.cjs`, `a6-zoom-floor-scroll.cjs`, `a7-floor-grid.cjs`, `a9-caret-race.cjs`). Use them as references, but write your own tests.

**Behaviour:**
1. **The rest height outlives the dock.**
   - It is the smallest height the dock has had with a composer in it, for as long as the window is open. It only ever goes down.
   - Hiding the dock, unmounting it and changing its width don't reset it.
   - The prototype keeps it at module level in `ComposerDock.tsx`. A ref that App owns and passes in is fine too.
2. **Rows held at 56 px stay reachable.** In `place()`, when the rows can't fit at 56 px, the last snap is `world.h − region.h`. When they fit, the snaps stay whole rows, as now.
3. **A refit's own scroll isn't motion.** When a refit moves the scroll to keep the same row on top, that scroll event updates which panes are on screen, but it doesn't mark the map moving. Any other scroll still does.
4. **The To line's wording** follows the mockup: `1 agent`, `N agents`, and `No agents yet` for none.
5. **A caret set from outside survives the mount.** When an action fills a composer that isn't mounted yet, the mount's restore applies the caret that action wants, after the saved selection. A frame callback alone isn't enough. This covers Add to chat (`ChatPane.tsx:921`), Discuss (`:2310`), Use tool (`:2671`) and examples (`:2812`).

- [ ] **Step 1: Write the failing tests.**
  - **`tests/pane-arrangement-place.test.mjs`** (Review Focus 38), with 14 panes:
    - `place({ mode: "horizontal", order, zoom: 0.01, focusShare: 0.58 }, { w: 1240, h: 531 }, 152)` ends its snaps at `world.h − region.h`, which is 357.
    - `mode: "left"` at `{ w: 860, h: 236 }` with 152 borrowed ends at 204.
    - Where the rows fit, the last snap doesn't change. Example: grid at `{ w: 1240, h: 531 }` with 152 borrowed still ends at 0.
    - On `26c82b20` the first two end at 256 and 64.
  - **`tests/composer-dock-app.test.mjs`, at both sizes** (Review Focus 34 and 37):
    - **Leaving Threads.** Thread 0 holds 5 lines and a file. Go to Code and back: the map keeps its level and every slot's `left`. Click Thread 3 (empty), then Thread 0: the same. On `26c82b20`, coming back re-tiles 4×3 to 3×2.
    - **A width change.** Hold that same draft, make the window 112 px narrower, then clear the draft. Clearing keeps the level and every `left`. The resize itself may pick a new grid, since it is a width change. On `26c82b20`, clearing re-tiles.
    - **Switching.** Click back and forth between Thread 0 (5 lines and a file) and Thread 3, three times. The level and every `left` stay.
    - **Send.** Send once first, so the thread is started and its project row is gone. Note every slot's rect, type 9 lines and press Enter on the demo backend. Every rect is back, ±1 px.
    - **Resize.** Resize to 1512×700, or 1100×500 on the small run. The grid is picked again: 4×3 becomes 3×2 at 1512.
    - **The floor.** In Horizontal, zoomed all the way out (press `-` until the level stops changing), with 9 lines: End shows the last pane in full.
    - **Wording.** The To line says `2 agents` for the sample threads. Add a one-agent thread for `1 agent`, if the demo backend allows it. Otherwise test the wording function on its own.
  - **BrowserView harness** (Review Focus 39). Scroll the map to its second snap, with a preview pane still on screen; add a helper to set the order if needed. Grow the composer 9 times. The map is never marked moving, and the preview gets `bounds` calls and no `hide`. On `26c82b20` the map is marked moving. In the real App, every typed line that changed the height marked it.
  - **`tests/composer-dock-browser.test.mjs`.** Make the insert's frame callback run before React mounts B's composer, as `a9-caret-race.cjs` does: replace `requestAnimationFrame` with a microtask while dispatching. The caret ends after the inserted text. On `26c82b20` it ends at 4.
  - **`tests/layout-picker.test.mjs:108-110`.** Wait for `aria-expanded="false"` after Shift+Tab instead of reading it once.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.** The prototype diff shows one way to do 1–3.
- [ ] **Step 4: Run** the dock, PaneMap and BrowserView scenarios, then `npm test` twice, with no failure on either run, and `npx tsc --noEmit`.
- [ ] **Step 5: Look** at 1512×945. Give Thread 0 a long draft, go to Code and back, and switch threads. Take screenshots.
- [ ] **Step 6: Commit** with `fix(composer): rest height, reachable rows and quiet refits`.

### Task 8c: Hidden and loading docks, scrolled refits (`8e68d1aa`)

Null finished the interrupted Task 8b review with this commit. The handoff is `docs/reviews/2026-11-09-composer-dock-8c.md`.
- A hidden dock doesn't lower the rest height to 0.
- Rest is learned only after the room loads (`data-room-ready`).
- When the active pane is off screen, a refit keeps the first visible line (`keepLine`).

Reviewed in revision 17. Task 8d finishes the refit rule.

### Task 8d: Fixes from the review of Task 8c (revision 17)

**Files:**
- Modify:
  - `src/paneArrangement.ts`
  - `src/PaneMap.tsx`
  - `src/ComposerDock.tsx`
  - `src/ChatPane.tsx` or `src/ThreadComposer.tsx`, to mark the start tray
- Test:
  - `tests/pane-arrangement-place.test.mjs`
  - `tests/composer-dock-app.test.mjs`
  - `tests/pane-map-browser.test.mjs`, or a new PaneMap Electron check
  - `tests/helpers/browser-view-focus-map-electron.cjs`
- Reference: `~/.cache/jigga-review/task8c/proto8d.diff`, `c1-deep-typing.cjs` with `run-c1.sh`, `c2-send-shrink.cjs`, `c3-tray.cjs` and `diag-focus/`. Use them as references, but write your own tests.

**Behaviour:**
1. **Every refit keeps the top row.** A refit is the same arrangement at the same width, with a new height or a new borrowed height.
   - It keeps the first visible line (`keepLine`).
   - It moves only when an active pane that was wholly on screen wouldn't be wholly on screen at that line. It then moves to the fitting snap nearest that line.
   - An off-screen active pane, the Focus pane, and no active pane all keep the line.
   - The prototype's `refitScroll(old, next, at, active)` does this.
2. **No layout pass for a stale size.** Sometimes a render's `area` doesn't match the map's measured size. The usual case is a new borrowed height that renders before the map's own measurement. The scroll effect, the Focus effect and the `fitted` record then skip that pass. The measurement renders again before paint.
3. **Motion lasts as long as the glide.** `data-moving` stays on while any side slot has a running animation, and `data-focus-moving` stays on while the pinned slot has one. A slot's `transitionend` extends motion only while the marker is still on. It never turns a settled map back on.
4. **A divider drag uses the short window.** It draws without transitions, so nothing glides after the release.
5. **Rest leaves out the start tray.** The dock learns rest from a loaded composer minus the start tray, which means the tray's height plus the box's row gap. A new thread's composer then borrows the tray's height. ChatPane marks the tray, for example with `data-dock-extra`, and the dock subtracts what's marked.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/pane-arrangement-place.test.mjs`** (Review Focus 40). Use 14 panes at 1200×800, grow by 152 px and then shrink back:
    - In Horizontal at line 8, with Thread 9 active and wholly on screen, the line stays 8 both ways.
    - The same with Thread 0 active, off screen: the line stays 8.
    - In Focus left at side line 7, with no active rect: the line stays 7. On `8e68d1aa`, the pixel-nearest snap gives a different line.
    - With Thread 10 active at the bottom of the screen, when its row no longer fits: the result is the fitting snap nearest line 8.
  - **`tests/composer-dock-app.test.mjs`, at both sizes** (Review Focus 40 and 42):
    - **Deep typing.** Test two setups: Horizontal at row 8 with the active pane on screen, and Focus left at side row 7 with the Focus pane active. Type 9 lines, clear, paste 9 lines in one insert, then clear again. The first visible pane never changes. On `8e68d1aa`, Focus left moves 2 rows at 1512×945, and moves on 7 of 9 typed lines at 1100×650.
    - **The first Send.** With a new thread as the dock's first target, Send once. The level and every `left` stay the same. On `8e68d1aa`, Horizontal goes from level 7 to 8.
  - **Motion** (Review Focus 41). In the PaneMap harness, reorder the panes. Then hold the main thread for 60 ms in the next frame, so the glides start late. Sample every frame until the map has been settled for 300 ms.
    - `data-moving` is on in every frame where a slot transition runs.
    - Once it goes off, it never comes back on.
    - On `8e68d1aa`, it goes off before the last `transitionend`, then comes back on.
  - **The Focus test.**
    - `reset()` waits until the fixture has rendered the reset arrangement (a new `arrangement` object). Only then does it wait for motion to settle.
    - The title drag waits for the slots' animations to end, then allows 150 ms. The other restores keep 300 ms.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.** The prototype shows one way to do 1–4.
- [ ] **Step 4: Run** these checks:
  - `run-c1.sh` at 1512×945 and at 1100×650
  - the dock, PaneMap and BrowserView tests
  - `npm test` twice, with no failure on either run
  - `npx tsc --noEmit`
- [ ] **Step 5: Look** at 1100×650 in Focus left. Scroll the side panes down, type 9 lines in the Focus pane, then clear it. The side panes don't move. Take screenshots.
- [ ] **Step 6: Commit** with `fix(panes): keep the top row on every refit and hold motion through glides`.

**Milestone 2 done when:** reviewed, merged with the user's OK, and the user has typed in it.

---

## Milestone 3 — Multi-thread sends (branch `feat/thread-slices`)

### Task 9: The multi draft document

**Files:**
- Create: `src/sliceDraft.ts`
- Test: `tests/slice-draft.test.mjs`

**Interfaces:**
- Produces:
  - `type Token = { kind: "text"; text: string } | { kind: "thread"; paneId: string; hostId: string } | { kind: "file"; fileId: string }`
  - `type DraftDoc = Token[][]` (lines)
  - `interface Caret { line: number; offset: number }`, with the offset counted in tokens' visible characters; a chip counts as 1.
  - `addThreadLine(doc: DraftDoc, ref: { paneId: string; hostId: string }): { doc: DraftDoc; caret: Caret | null }`, where `caret` is non-null only when `doc` was empty (then it sits after the first tag).
  - `interface RemovedSlice { lines: { index: number; tokens: Token[] }[]; replaced: { index: number; tokens: Token[] }[] }`, where `lines` are the lines taken out and `replaced` the lines rewritten (with their old tokens)
  - `removeThread(doc: DraftDoc, paneId: string): { doc: DraftDoc; removed: RemovedSlice | null }`
  - `restoreRemoved(doc: DraftDoc, removed: RemovedSlice): DraftDoc`
  - `threadIds(doc: DraftDoc): string[]` and `fileIds(doc: DraftDoc): string[]`, each in first-appearance order
  - `interface DraftNames { thread(id: string): string; file(id: string): { label: string; name: string } | null }`
  - `readableText(doc: DraftDoc, names: DraftNames): string`, which gives `#Title` and `[Image1: name.png]` with the names as the person sees them. It is for the clipboard and other apps only, never for sending.
  - `fileReference(label: string, name: string): string`, the text a chip becomes in an outgoing message: `[Image1: <attachmentName(name)>]`. `attachmentName` (`src/attachments.ts:33`) is the same plain-ASCII name the host saves the file under, and it can't contain `@`, so a file name can never read as a mention (Review Focus 7).
  - `encodeClipboard(doc: DraftDoc, draftId: string, names: DraftNames): { plain: string; json: string }` (`plain` is `readableText`) and `decodeClipboard(json: string, draftId: string, known: { thread(id: string): boolean; file(id: string): boolean }): DraftDoc | null`
  - MIME type `application/x-apex-deck-draft+json`.

- [ ] **Step 1: Write the failing tests.**
  - Adding A to an empty doc gives `[[A]]` with caret `{ line: 0, offset: 1 }`.
  - Adding B, C and D after that gives `[[A],[B],[C],[D]]`, with caret `null` each time.
  - Adding E after the group line `[[A, B, text " hi"]]` gives a new line `[E]`.
  - `removeThread` on A's line `[A, text " what is the status"]`:
    - The line is gone.
    - `removed` holds it.
    - `restoreRemoved` puts it back at the same index.
  - Removing A from the group line `[A, B, text " hi"]` gives `[B, text " hi"]`; the shared text stays.
  - Removing A from a split line `[A, text " one ", B, text " two"]` (A owns "one", B owns "two") leaves `[B, text " two"]`.
  - Removing A from an ambiguous line changes nothing and returns `removed: null`. The UI then says "Resolve the ambiguous line before removing a destination."
  - Clipboard:
    - A round trip with the same `draftId` returns the same tokens.
    - A different `draftId`, or an unknown file, returns `null`.
    - `plain` is `#Linux Desktop App run the dev server`, with the title looked up through `names`.
  - File references:
    - `fileReference('Image1', '@muck screenshot.png')` is `[Image1: muck-screenshot.png]`, and `mentionedWords` of it is `[]`.
    - `readableText` of that chip still shows `[Image1: @muck screenshot.png]`, because the clipboard isn't sent.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.** Port the token handling in `real-app.js:removeThreadFromDraft`, `syncSelectionFromDraft` and `toggleMulti`. Use real token objects instead of `⟦thread:…⟧` strings.
- [ ] **Step 4: Run and check it passes.**
- [ ] **Step 5: Commit** with `feat(threads): multi draft document`.

### Task 10: Selecting several panes

**Files:**
- Create: `src/useMultiDraft.ts`
- Modify: `src/App.tsx` (pane `onMouseDown` and the global Esc handler), `src/PaneHead.tsx` and `src/styles.css`
- Test: `tests/multi-select-browser.test.mjs`

**Interfaces:**
- Consumes: `addThreadLine`, `removeThread`, `restoreRemoved` and `threadIds` (Task 9).
- Produces: `useMultiDraft(): { doc: DraftDoc; on: boolean; selected: string[]; tldr: boolean; overrides: Map<string, string>; draftId: string; toggle(paneId: string, hostId: string): void; exit(): void; setDoc(doc: DraftDoc): void; undoRemove(): void; lastRemoved: RemovedSlice | null; current(): MultiDraftState; take(): MultiDraftState }`, where `MultiDraftState = { on: boolean; doc: DraftDoc; tldr: boolean; overrides: Map<string, string>; draftId: string }`. Task 16 adds `files`.
- `selected` is `on ? threadIds(doc) : []`. The tags *are* the selection.
- `overrides` are the one-send agent picks (D1, Task 14). They are kept with the draft, so they survive Esc as the draft does.
- **The draft lives in a ref**, copied into React state for rendering. `current()` reads the ref, so an event handler sees what an earlier handler left, even before React renders again.
- **`take()`** returns the whole draft and puts an empty one in its place, in one synchronous step: multi off, no lines, no picks and no "Removed · Undo" note. TL;DR stays as it was, as it does in a thread's own composer.
  - The new draft gets a new `draftId`. It is a random id per draft, used by the clipboard (Task 9) and the editor's Undo (Task 13). The mockup makes a new one after each send too (`real-app.js:2687`).
  - Send uses `take()` (Task 15). Anything typed after it belongs to the new draft.

**Rules (approved):**
- ⌘-click (Ctrl-click on other platforms) on a title bar or on empty transcript space toggles a pane. Links, buttons and text selection behave normally.
- If the multi draft is empty, the first ⌘-click also tags the pane you were already in, on line 1 (`real-app.js:toggleMulti`). So the selection starts as [focused pane, clicked pane]. A kept draft (after Esc) is reused as it is.
- A plain click inside the selection keeps it and only moves focus. A plain click outside turns multi off and keeps the draft, as Esc does (`real-app.js:select`, `clearMulti`).
- Selected panes get the `multi-selected` outline.
- Selection survives zoom, scroll and layout switches.
- **Esc order:** pickers and menus close first, then the add form, then the ⋯ menu, then the layout picker, then full screen. After those, Esc turns multi off but keeps `doc`.
- The next ⌘-click turns it back on and adds its tag line.

- [ ] **Step 1: Write the failing scenario.**
  - Plain-click p0, then ⌘-click the heads of p2, p3 and p1.
    - `selected` is `['p0','p2','p3','p1']`.
    - Four panes have `.multi-selected`.
  - ⌘-click p3 again: three remain, `['p0','p2','p1']`.
  - Esc with no menu open:
    - no outlines
    - `doc` is unchanged
  - ⌘-click p5: four lines, and the outlines are back.
  - A plain click on the transcript of p9 (not selected) removes the outlines, and `doc` is still there.
  - **`take()`.** ⌘-click p2 and p3 again, then call `take()`. It returns the lines as they were. Afterwards `doc` is `[]`, `on` is false, no pane has the outline and `draftId` has changed. A `current()` call straight after it, in the same task, already sees the empty draft.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the scenario, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(threads): select several panes with ⌘-click`.

### Task 11: Planning a send

**Files:**
- Create: `src/slicePlan.ts`
- Test: `tests/slice-plan.test.mjs`

**Interfaces:**
- Consumes: Task 9; `parseComposer` (`src/commands.ts:27`); `mentionTarget` and `mentionedWords` (`src/recipients.ts`).
- Produces:
  - `interface ThreadInfo { paneId: string; hostId: string; title: string; open: boolean; agents: { id: string; handle: string; name: string }[]; defaultAgentIds: string[] }`. `open` is false for a thread that is closed, archived or deleted, and for one popped out into its own window (Task 14), from the click on Pop out (Task 12).
  - `interface Slice { paneId: string; hostId: string; text: string; routing: string; files: string[]; command: "compact" | "curate" | "curate_undo" | null; to: string[] | null; group: boolean }`, where:
    - `text` is what is posted: tags removed, and chips turned into `fileReference(label, name)` (Task 9)
    - `routing` is the same text with **each chip read as one space**: only what the person typed (D10). Commands, typed mentions, `unknown-agent` and the summary all read `routing`, and the queue later routes on exactly this string (Task 12). Nothing works recipients out from `text`.
    - A chip counts as a space because it separates the words on either side, as it does on screen. `alice`, a chip, then `@muck` is a mention of Muck, as `alice @muck` is. The agent reads the posted `alice[Image1: shot.png]@muck` the same way: across 200,000 random lines, a chip read as a space and a chip posted as a file reference gave the same mentions every time (`/tmp/jigga-rev4/chip-space.mjs`). Leaving the chip out instead, as revision 3 did, makes `alice@muck`, which is an email address and names no one.
    - `to` is the dropdown override's agent ids; `null` means the thread's own rule (typed `@` included)
  - `type Problem` is one of:
    - `duplicate` (paneId, lines)
    - `unresolved` (line)
    - `untagged` (line)
    - `ambiguous` (line)
    - `empty` (paneId)
    - `unknown-agent` (paneId, name)
    - `no-agents` (paneId)
    - `command-not-allowed` (paneId, command)
    - `command-with-text` (paneId)
    - `file-to-command` (paneId)
    - `file-reading` (fileId): a file on a tagged line is still being read (Task 16)
  - `planSend(input: { doc: DraftDoc; threads: Map<string, ThreadInfo>; overrides: Map<string, string>; files: Map<string, { label: string; name: string; reading: boolean }> }): { slices: Slice[]; problems: Problem[] }`
  - `summaryLine(slices: Slice[], threads: Map<string, ThreadInfo>): string`

**Reading rules (approved, exact):**
1. Tags next to each other on a line form a group. The line's text goes to every tag in the group, whether it sits before, after or around the group.
2. Tags spread through a line:
   - If the line starts with a tag, each tag owns the text after it.
   - If the line ends with a tag, each tag owns the text before it.
   - Anything else is `ambiguous`.
3. A new line starts fresh.
4. Once the doc has a tag, a nonempty line without one is `untagged`.

**Combining:**
- The same thread on different lines gets one combined payload, joined with a blank line.
- The same thread twice on one line is `duplicate`, and both copies are reported.

**Rules for what each slice sends:**
- **Tags are removed** from the outgoing text. Chips become `fileReference(label, name)`, such as `[Image1: shot.png]`.
- **Commands.** A slice's command comes from `parseComposer` on its own `routing` text.
  - Group text is never added to a command slice.
  - Prose on another line for the same thread gives `command-with-text`.
  - A file on a command slice gives `file-to-command`.
  - Commands outside D5's list give `command-not-allowed`.
- **Mentions and overrides.**
  - A typed `@name` that matches no agent in that thread (and isn't `all`, `everyone` or inside a word or email) gives `unknown-agent`.
  - A typed mention beats the override; the row then shows "from text".
- **Problems.**
  - A thread with no agents gives `no-agents`.
  - A tag for a thread that is closed, missing or popped out gives `unresolved`.
  - A tagged thread with neither text nor a picture gives `empty`. A line with only a picture sends the picture, as the mockup does (`real-app.js:computeMultiPlan` counts the file reference as text) and as a thread's own composer does.
  - A file still being read, on any tagged line, gives `file-reading`. `summaryLine` then reads `Reading shot.png…`.

- [ ] **Step 1: Write the failing tests.** Use the user's own example (A–D are four open threads, each with agents Null and Muck):

```
#Multiple thread pane management what is the status
#Linux Desktop App @Muck run the dev server
#Delegate Refactor create a plan to help implement this feature to completion
#t3 code /compact
```

  - **Four slices:**
    - A: `what is the status`
    - B: `@Muck run the dev server`, with `to` null
    - C: the plan text
    - D: `command: 'compact'`, text `/compact`
    - no problems
  - **Summary:** `summaryLine` gives `To 4 threads · Null ×2, Muck · 1 command`, when A and C default to Null.
  - **Group with a command:**
    - `#A #B here is context` plus `#B /compact`
    - A gets `here is context`; B gets only `/compact`
  - **Problem cases:**
    - `what #A text #B more` is ambiguous.
    - A line with no tag after a tagged line is untagged.
    - `#A #A hi` is a duplicate with both chips reported.
    - `#A @nobody hi` gives `unknown-agent` with `nobody`.
    - `#A /clear` gives `command-not-allowed`.
    - A tag line with nothing after it gives `empty`.
    - A tag whose thread has `open: false` gives `unresolved`.
  - **Pictures:**
    - `[Image1]` on lines A and C means A's and C's `files` are `['f1']`.
    - `[Image1]` on D's `/compact` line gives `file-to-command`.
    - A file named `@muck screenshot.png` on A's line: A's `text` contains `[Image1: muck-screenshot.png]`, A's `routing` has a space where the chip was and no file reference, A has no problems, and the summary still counts Null for A (Review Focus 7).
    - **A chip beside a typed `@`** (Review Focus 7):
      - A's line is `alice`, an `Image1` chip, then `@muck run it`. A's `routing` is `alice @muck run it`, its `text` is `alice[Image1: shot.png]@muck run it`, and the summary counts Muck for A.
      - A's line is `@mu`, a chip, then `ck run it`. That gives `unknown-agent` with `mu`, and Send is blocked. It is never read as Muck.
      - A typed email, `ask t@example.com`, names no one in both `routing` and `text`.
    - **Pictures alone.** A's line holds only an `Image1` chip: no `empty`, A's `files` are `['f1']`, and A's `text` is `[Image1: shot.png]`.
    - **A file still being read.** With `f1` marked `reading`, `[Image1]` on A's line gives `file-reading` for `f1`, and `summaryLine` reads `Reading shot.png…`. The same file on no line gives no problem.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
  - Port `real-app.js:parseThreadSlices` and `computeMultiPlan`.
  - Swap the mockup's `explicitMentions` (last name wins) for `mentionTarget` (every name answers, D4).
- [ ] **Step 4: Run and check it passes.**
- [ ] **Step 5: Commit** with `feat(threads): plan a multi-thread send`.

### Task 11a: A one-send agent pick keeps the thread's default (daemon and queue)

This is the only daemon change in the plan (D1). It is additive: callers that don't send the new field get exactly today's behaviour, so the phone, the CLI and older apps are unaffected.

**Files:**
- Modify:
  - `crates/apex-core/src/room.rs:1207-1265`
  - `crates/apex-core/src/concurrent.rs:303-322` (`begin_post_with_commit`, the caller of `accept_post`)
  - `crates/apex-host/src/command.rs:249,733-745`
  - `crates/apex-host/src/host.rs:1598-1650`
  - `crates/apex-daemon/src/authority.rs:55,538,751`
  - `src/turnQueue.ts`, `src/backend.ts:142,149`, `src/commandBackend.ts:117-119`, `src/hostBackends.ts:20`
  - `src/ChatPane.tsx:1678-1729`: the queue's post callback passes `oneOff` on, and a one-off item is posted with its agents' `@names` in front (D12).
  - `src/recipients.ts`: `pickLead` and `namedIn`.
- Create: `shared/media-naming.json` (D12). Task 12's component test reads it too.
- Test:
  - Rust unit tests beside `accept_post` in `room.rs`, and `crates/apex-host/src/chat_delivery_tests.rs`
  - `crates/apex-adapters/src/media.rs` (tests module): each posted text in `shared/media-naming.json` reaches the price card or passes (D12, Review Focus 22)
  - `tests/mentions.test.mjs` (extend): `pickLead` and `namedIn`
  - `tests/turn-queue-one-off.test.mjs`
  - `tests/e2e/thread-slices.e2e.mjs` (Task 15 adds the rest of this file)

**Interfaces:**
- Produces:
  - Daemon: `RoomPostTo` gains `#[serde(default, alias = "keep_default")] keep_default: bool`. When it is true, `accept_post` and `accept_client_message` leave `last_targets` as it was. So the thread's default for untagged messages (`untagged_responders`, `room.rs:1314`) and `/compact`'s summarizer (`room.rs:912`) don't change. The post itself goes to exactly `targets`, as now.
  - Daemon: `PostCapabilities {}` replies `{"keep_default_v1": true}`. It is a global read like `VoiceCapabilities` (`command.rs:745`; `authority.rs:55,538,751`).
  - `command.rs:354-390` is hashed by the VPS updater and is not touched. Its `RoomPostTo{..}` patterns already ignore new fields. Before merging, run the `scripts/vps_update_compat.py` check on the tree anyway.
  - App: `Backend.roomPostTo(id, text, targets, interactiveAnswers?, voice?, keepDefault?: boolean)` and `Backend.postCapabilities?(): Promise<{ keep_default_v1: boolean }>`, forwarded per machine in `hostBackends.ts:20`. `commandBackend.ts` sends `keep_default: true` only when it is set.
  - Queue: `ParticipantMessage.oneOff?: true` and `ParticipantQueues.sendOnce(text: string, to: string[], meta?: ItemMeta): Promise<number>` (`ItemMeta` as in Task 12). It is like `sendTo` (pinned, never re-asked) and also marks the item `oneOff`. How an edit treats it is in Task 12. The post callback receives `oneOff`, and ChatPane's dispatch passes it to `roomPostTo` as `keepDefault`.
  - `queuedSticky` (`turnQueue.ts:269`) skips `oneOff` items: an untagged message queued behind a one-send pick goes where the thread's default goes, not to the picked agent.
  - **The pick is named in the posted text (D12).** `pickLead(to: string[], people: readonly Mentionable[]): string` in `src/recipients.ts` gives `@` plus `mentionFor(person)` (`src/slug.ts:37`) for each id in `to`, joined by spaces, then one space. It gives `''` when none of them is a participant. `mentionFor` is the mention the daemon matches (`mention_for`, `crates/apex-core/src/mention.rs:66`), and `shared/mention-names.json` already keeps the two equal.
    - For a one-off item, ChatPane's dispatch posts `pickLead(to.filter(id => !namedIn(text, participants).includes(id)), participants) + text` with `keepDefault: true`: each picked agent the text doesn't already name, so a mod that wrote the name in leaves one copy. The lead is added there, at posting, and is never stored on the item. So the queued line, the edit box (D9) and an edit's routing never see it. An edit that names an agent ends the pick (Task 12), and with it the lead.
    - `namedIn(text: string, people: readonly Mentionable[]): string[]`, also in `src/recipients.ts`, is the app's copy of `apex_core::names` (`crates/apex-core/src/mention.rs:185`), the rule the media agent uses. It gives the ids whose own mention (`mentionFor`) is among `mentionedWords(text)`, in the order first named. `@all` and `@everyone` name no one, and so does an old name or an `@` right after a letter (an email address). `mentionTarget` can't stand in for it: it returns `"everyone"` for `@all` and drops the names beside it. Task 12 uses it for typed names a mod takes out.
  - **`shared/media-naming.json` (D12, Review Focus 22).** `{ "about": string, "cases": { name: string; typed: string; picked?: string[]; quote?: { id: string; name: string; text: string }; mod?: string; tldr: boolean; posted: string; card: string | null }[] }`. Each case says how the person sent it (`typed`; `picked`, an agent picked from the menu; `quote`, a reply quoted in the composer; `mod`, what a mod's `prompt.submit` returns) and exactly what the app then posts (`posted`). `card` is the prompt the media agent's price card ends with, or `null` when it passes. Allison is the media agent in every case. The cases:

    | Case | Typed | Picked | Mod returns | Posted | Card |
    | --- | --- | --- | --- | --- | --- |
    | A menu pick, with TL;DR on | `a whale at dawn` | `allison` | | `@allison a whale at dawn`, a blank line, then `TLDR_LINE` (`src/tldr.ts:5`) | `a whale at dawn` |
    | A typed name, no mod | `@allison a whale` | | | `@allison a whale` | `a whale` |
    | A typed name a mod takes out | `@allison a whale` | | `a whale` | `@allison a whale` | `a whale` |
    | A typed name a mod keeps | `@allison a whale` | | `@allison a big whale` | `@allison a big whale` | `a big whale` |
    | `@all`, which a mod takes out | `@all a whale` | | `a whale` | `a whale` | `null` |
    | Named by no one | `a whale` | | | `a whale` | `null` |
    | A quote of Allison's, with a mod that adds a name | `look at this`, under a quote of Allison's reply `the first cut` | | `look at this @null` | `@allison look at this @null`, a blank line, `> Allison wrote:`, `> the first cut` | `look at this @null`, a blank line, `> Allison wrote:`, `> the first cut` |
    | `@all` under a quote of Allison's, which a mod takes out | `@all look at this`, under the same quote | | `look at this` | `look at this`, a blank line, `> Allison wrote:`, `> the first cut` | `null` |
    - The two quote cases pin revision 10's fix. Before it, the first posted no `@allison`, so she passed, and the second posted `@allison look at this`, so a card showed. The media agent's prompt keeps the quote's lines, as it does today for any quoted reply (`latest_ask`, `media.rs:76-107`). `/tmp/jigga-rev10/quote-lead.mjs` works out both rows with a copy of that rule.
    - Who answers is still exactly `to`, and the thread's default still stays: `room_post_to`'s targets are explicit, and `accept_post` takes `last_targets` from them, never from the text (`room.rs:1211`).
    - The media agent drops leading `@names` from its prompt (`crates/apex-adapters/src/media.rs:101-106`). Its price card therefore shows what was typed.

- [ ] **Step 1: Write the failing tests.**
  - **Rust, `room.rs`:**
    - A room with agents `a` and `b` whose `last_targets` is `[a]`. `accept_post(…, targets [b], keep_default true)` leaves `last_targets` as `[a]`, `untagged_responders()` as `[a]` and `summarizer()` as `a`.
    - The same with `keep_default` false gives `[b]`, today's behaviour.
    - The same pair of checks for `accept_client_message`.
  - **Rust, `chat_delivery_tests.rs`:**
    - `{"command":"room_post_to","id":"r","text":"@b hello","targets":["b"],"keepDefault":true}`, then `room_targets` for `""` gives `["a"]`. The text names `b`, as a pick's posted text does (D12), and the default still stays.
    - Without `keepDefault`, it gives `["b"]`.
    - `{"command":"post_capabilities"}` replies `{"keep_default_v1": true}`.
    - The authority test list (`authority.rs:751`) includes `post_capabilities` as a global read.
  - **Queue (`tests/turn-queue-one-off.test.mjs`)**, with policy `mention`, people Null and Muck, and the thread default Muck:
    - While Null is working, `sendOnce('check this', ['null'])`, then `send('and this')`.
    - The second item's `to` is `['muck']`, from `targets()`, not `['null']`.
    - The post callback sees `oneOff: true` for the first item only.
  - **e2e (fixture daemon):** in a room whose default is Muck, post through `sendOnce` to Null. After it posts, `roomTargets(room, "")` is still `["muck"]` (Review Focus 6). The human message in the transcript reads `@null ` followed by the text sent (D12).
  - **Rust, `media.rs` (D12, Review Focus 22, Null's second revision-7 and revision-8 cases):** `chosen_agents_reach_the_price_card` reads `shared/media-naming.json` with `include_str!`, as `crates/apex-cli/src/commands.rs:45` reads `composer-commands.json`. For each case, the human message is `posted`, run through `run_job_answering(false, …, &video_model(), …)`:
    - With a `card`, exactly one Spend card, `Make a video · $2.91`, whose detail ends with a blank line and then `card`.
    - With `null`, `PASS_TOKEN` and no card. Before this fix, a pick and a typed name a mod took out both posted text that ends here.
    - It passes from the start, since the media agent doesn't change. It pins the texts the app must post, and Task 12 checks the app posts them. The existing `every_job_asks_with_its_price_and_a_no_spends_nothing` and `only_a_persons_message_naming_the_bot_can_spend` already pass on this tree (`/tmp/jigga-rev9/rust-media.txt`).
  - **`pickLead` (`tests/mentions.test.mjs`):** `pickLead(['muck'], people)` is `'@muck '`. Two ids give both names, in order. An id that isn't a participant gives `''`. A renamed agent gives its new name's mention, the one `mention-names.json` pins.
  - **`namedIn` (`tests/mentions.test.mjs`):** for every `routing` row of `mention-names.json`, `namedIn(text, bots)` equals `to`. The one exception is `@all thoughts?`, whose `everyone` names no one, so it gives `[]`. Old names, `@atlasbot`, the email address and the repeated `@Atlas` are all among those rows. `@everyone go` gives `[]` too. `/tmp/jigga-rev9/namedin-shared.mjs` runs this against the real `mentionedWords` and `mentionFor`: all 13 rows match.
- [ ] **Step 2: Run and check they fail.** `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon -p apex-adapters`, then `node --experimental-strip-types --test tests/turn-queue-one-off.test.mjs tests/mentions.test.mjs`.
- [ ] **Step 3: Implement.** Thread `keep_default` through `room_post_to_with_answer_guidance` (`host.rs:1598`), `prepare_post` and `begin_post_with_commit`, and through `room_client_post_checked`, down to the two acceptance functions. On a failed commit, both already restore `last_targets`; keep that restore correct when nothing was replaced. JSON field names follow the enum's `rename_all_fields = "camelCase"` (`command.rs:20`), so the wire name is `keepDefault` and `keep_default` is the alias.
- [ ] **Step 4: Run** the Rust tests, the queue test, `npm run test:e2e`, `npm test` and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(daemon): keep the thread's default for a one-send agent pick`.

### Task 12: The send API each thread registers

**Files:**
- Create: `src/threadSendApi.ts` and `src/wireText.ts`
- Modify:
  - `src/turnQueue.ts:63-274`
  - `src/ChatPane.tsx:1665-1670`: split out `queueContextJob(command, kind, keep): number`, which admits the command (see "Taking a place in the queue") and must not clear the pane's own draft. The composer's own `/compact`, `/curate` and `/curate undo` (`contextJob`) admit through it too, with `keep: false`, instead of `turnQueue.send`, so a long one never holds the line.
  - `src/ChatPane.tsx:1678-1700`: curate and curate-undo failures reach the queue (D8).
  - `src/ChatPane.tsx:1714-1729`: the queue reads recipients from each item's routing text (D10), runs `checkSend` just before each post, and shows a refusal's own message.
  - `src/ChatPane.tsx:1755-1758`: beside the voice bridges' cleanup, an effect on `[turnQueue]` whose cleanup calls `turnQueue.close()`.
  - `src/ChatPane.tsx:2690-2750`: split `send()` into a state reader plus `submitDraft()`, which admits the message. The server and media checks become `checkSend`, run for the recipients the queue worked out. On success `send()` removes only what it sent.
  - `src/ChatPane.tsx:480,3954-3983`: the queued line and its edit box show only what was typed, and an edit rebuilds the message from its parts (D9). A slice that failed before it was made, or a message refused just before it posted, gets its own line, and what it holds back says why (`behind`).
  - `src/ChatPane.tsx:4132-4134,4146`: Send and Enter wait while this composer's own message waits for its turn.
  - `src/mediaPrice.ts:96-101`: `missingPicture(sends)`, which `priceSend` then uses for `missing`.
  - `src/App.tsx`: the registry.
  - `src/App.tsx:1456-1503` (`popOutPane`) and `:2363-2383` (`moveDraft`): both wait for an empty queue and refuse while the other runs, a pane counts as popped out from the click until it is back, and a move suspends the thread's queue while it runs (D11). `:1552-1564` and `:1698-1709`: a pane that comes back leaves `outside`. `:2476-2490` (`projectEntries`): the rows are greyed for a popped-out thread.
  - `src/recipients.ts`: `keptNames` (D12).
  - `src/reply.ts:44-57`: `replyLead` and `replyWith`, split out of `replyText`, which then calls one with the other (D12).
- Test:
  - `tests/reply.test.mjs` (extend): `replyLead` and `replyWith`
  - `tests/thread-send-api.test.mjs`: `ownerRefusal` and `leaveRefusal`
  - `tests/turn-queue-status.test.mjs`
  - `tests/turn-queue-admit.test.mjs`
  - `tests/turn-queue-close.test.mjs`
  - `tests/turn-queue-suspend.test.mjs`
  - `tests/composer-dock-contract.test.mjs` (extend, Task 8's source contract): where `popOutPane` and `moveDraft` check and suspend
  - `tests/wire-text.test.mjs`
  - `tests/thread-send-api-component.test.mjs`, a real ChatPane with the in-memory service, as in `tests/chat-attach-component.test.mjs`.
  - `tests/turn-queue.test.mjs`, `tests/phoneQueue.test.mjs` and the six other files that make a `ParticipantQueues` (`phone-voice`, `voice-thread-bridge`, `host-availability`, `phone-thread-identity`, `thread-pane-status`, `phoneSessionEdits`) pass unchanged: the phone shares the queue. All 93 tests do against the prototype.
  - `tests/right-phone-component.test.mjs:587-600` is rewritten for the new send path (see the revision 7 table).

**Interfaces:**
- Consumes: `sendOnce`, `oneOff` and `postCapabilities` (Task 11a).
- Produces:
  - **Queue identity.** `ParticipantQueues.instance: string`, a random id made when the queue is constructed. ChatPane makes its queue in `useState` (`ChatPane.tsx:1714`), so a pane that is closed and opened again gets a new queue whose item ids start at 1 again. An id alone can therefore name an unrelated item.
  - `interface QueueRef { queue: string; id: number }`
  - **Item states.** `type ItemState = "preparing" | "waiting" | "posting" | "failed" | "posted" | "removed" | "closed" | "unknown"`.
    - `ParticipantQueues.status(id: number): ItemState`, and `ParticipantQueues.watch(id: number, cb: (state: ItemState, error?: unknown) => void): () => void`. `watch` calls back with the current state at once, then on every change, until it is stopped. It keeps working after `close`, so the batch hears how each slice ended.
    - `preparing` has its place but isn't made yet: it waits for its turn, its files, checks and mod hook are running, or Retry is making it again (`admit`, below). `waiting` is in the queue. `posting` is being posted: `drain` takes it out of `items` while the post runs (`turnQueue.ts:238`). `failed` is kept with Retry: a post that failed, a slice that failed before it was made or was given up, or a message refused just before it posted. `posted` went out.
    - `removed` left without posting: the person removed it, `/clear` emptied the queue, a voice turn was cancelled, or a failure the queue doesn't keep (`retainFailed` false).
    - `closed`: the queue closed before it posted (below), so it never will. It never left Deck.
    - The queue remembers the last 1,000 posted, removed or closed ids. So a Retry or a removal done in the thread itself reaches the batch (Task 15). Ids it no longer remembers, or never had, are `unknown`. So is a post that may have arrived but can no longer be retried, because its queue closed (below).
    - The thread's own Retry button (`retry(id)`, `turnQueue.ts:140`) is unchanged for a failed post: it moves the item back to `waiting`, and `watch` reports each step after that. An item that failed before it was made is made again (below).
  - **Taking a place in the queue (Review Focus 17).** `ParticipantQueues.admit(a: Admission): { id: number; done: Promise<number> }`, where `interface Admission { kind: TurnKind; routing: string; servers?: string[]; to: string[] | null; label: string; keep: boolean; prepare(to: string[]): Promise<{ text: string; parts?: WireParts }> }`.
    - `admit` gives the item its id at the call and takes its turn in the queue's acceptance order, `accepting` (`turnQueue.ts:73`), at once. `send` and `sendTo` already take their turns there, so everything that joins the end of a thread's queue is accepted in call order: the thread's own composer, a batch's slices and commands, next steps (`ChatPane.tsx:2670`), voice turns (`:1777`), More details (`:1904`) and the composer's `/compact`, `/curate` and `/curate undo` (`:1669`).
    - When its turn comes, the queue works out who it is for, `a.to ?? targets(a.routing)`, as `send` does. Then it calls `a.prepare(to)`, which saves files, runs the checks and the mod hook, and builds the posted text (`submitDraft`, below). Then it pushes the item and drains, as `send` does, and `done` settles as `send`'s promise does today. Until the push, `status(id)` is `preparing`.
    - **The next turn comes once this item is in `items`,** or kept there as failed, or dropped. It doesn't wait for the drain. `send` and `sendTo` hold the line until their own drain has returned (`turnQueue.ts:104-115`), and they stay that way. If `admit` did the same, a drain that posts a `/compact` or `/curate` would hold the line until the model had finished (`crates/apex-host/src/host.rs:2639,2689`), and everything sent meanwhile would read `preparing` outside the queue. So the composer's own commands admit too, and whole-room order still holds: a drain that posts a whole-room item awaits it before going on (`turnQueue.ts:240`), so nothing posts during it.
    - With `a.to`, the item is pinned and one-off (D1). `sendOnce` (Task 11a) becomes `admit` with `to` and a `prepare` that returns its text, so Task 11a's tests pass unchanged. The made item keeps `routing` and `servers`, and `parts` from `prepare`, as `ItemMeta` does.
    - **A refusal with `keep: false`** (the thread's own composer): `done` rejects with the reason, nothing stays in the queue, and the next message's turn comes. The draft is still in the composer, as today. `status` is `removed`.
    - **A failure with `keep: true`** (a batch slice, whose draft was already taken): the item stays in `items`, at the end. That is its place, since everything accepted before it is there already and nothing after it has been. It is `failed` and `unmade`, and keeps `a`, the recipients if they were worked out, `kind`, `oneOff` and the error's message, and shows `a.label`. `done` rejects too, but the batch follows `watch` instead (Task 15). The queue's `failed` callback isn't called: only a batch admits with `keep: true`, and the batch bar reports the failure (Task 15). A refusal just before posting is different, since it may be the pane's own message (below).
    - **An unmade item never posts.** In `drain` it holds back later items to its recipients, as a failed post does (`turnQueue.ts:207-209`). With no recipients, or a whole-room kind, it holds back everything after it. It doesn't use `paused`, so an agent's own hold and the person's Stop stay as they were, and Resume can't release it.
    - **Retry** (`retry(id)`) makes it again in place. It is `preparing` while that runs, and holds back the same messages. The recipients are worked out again unless pinned, and `prepare` runs again, so the files are saved again from the same bytes and the checks see whatever has changed. On success it becomes an ordinary item at the same place, and the queue drains. On failure it is `failed` again, with the new error. A second Retry while it runs does nothing.
    - **Remove** (`remove(id)`, the trash button) drops it and drains, so what it held goes at once.
    - **`giveUp(id)` works from the moment `admit` returns (Review Focus 20),** whatever the item is waiting for: its turn, its files and checks, or a Retry making it again. The admission's cancel hook is registered in `admit`, not when it is made. A daemon call has no time limit of its own (`src/daemon/client.ts:164-182`), so this is the way out of a save that never answers.
      - **Still waiting for its turn,** behind a command that is still starting, say: it reads `failed`, "Stopped waiting", at once. Its turn still comes after everything ahead of it, and then it takes its place as an unmade item without `targets` or `prepare` being called. So nothing behind it gets past anything ahead of it. With no recipients worked out, it holds back everything after it, as an unmade item does.
      - **Being made, or made again:** it fails at once with "Stopped waiting" and keeps its place, and the next message's turn comes. A `prepare` that finishes later changes nothing.
      - **Before its turn,** Retry takes the give-up back: it reads `preparing` and is made when its turn comes. Remove drops it: it reads `removed` at once and is skipped when its turn comes.
    - `edit` and `steerQueued` do nothing on an unmade item: it has no message to edit yet.
    - `holdOf(item)` returns a new hold, `"behind"`, for an item that an unmade or refused item ahead of it holds back.
    - **Steer, re-run and steering a queued message** still go to the front (`steer`, `turn`, `steerQueued`), ahead of an unmade item too. That is what they are for.
    - A voice turn spoken right after a multi-thread Send waits until that thread's slice is made, normally well under a second. If the slice then fails and is for the same agent, the voice turn waits behind it, as it would behind a failed send today.
    - `/tmp/jigga-rev7/queue-rev7.ts` is a prototype of `admit`, `status`, `watch`, `giveUp`, `close`, the check just before posting, the unmade and refused items, and `behind`. It leaves out `oneOff`, `instance`, `meta` and its edits, and the 1,000-id limit. `/tmp/jigga-rev8/queue-rev8.ts` adds `unsent` and `suspend` to it (below).
  - **Checked again just before posting (Review Focus 19).** The drain asks again who an unpinned item is for, just before posting it, so a rule changed while it waited still applies (`turnQueue.ts:211-213`). Revision 6 then posted to that answer, though the checks had run in `prepare` for the recipients of that earlier moment. Now:
    - `ParticipantQueues` takes an optional last constructor argument, `check: ((to: string[], item: ParticipantMessage) => string | null) | null`. For a `message` item with `routing`, the drain calls it right before the post, with the recipients it is about to post to: the fresh answer for an unpinned item, `to` for a pinned one. It is synchronous, so nothing can change between the check and the post.
    - A reason refuses the item in place. It is `failed`, with `refused` set to the reason, and it never left. Like an unmade item, it holds back later items to its recipients, through `blocked` rather than `paused`, so Resume can't release them. Their hold is `behind`. The queue calls `failed` with an `Unsent` error, because the item may be the pane's own composer message, whose draft is gone by then. ChatPane's notice is the reason on its own, without today's "Check whether it arrived" advice.
    - Retry clears the refusal, and the drain asks and checks again. Remove drops it and drains. An edit is a new try: it clears the refusal, and the message is checked again when it posts.
    - When the check passes, the message goes to the fresh answer, as today.
    - Items without `routing` aren't checked, as today: the phone's, next steps, Steer, re-run and voice turns. A voice turn is pinned and runs its own server check first (`ChatPane.tsx:1773-1775`). Commands aren't checked either, though they now admit with `routing`: the checks are about a message's words and pictures, and a `/compact` in a thread whose default agent makes videos must not be refused for having no picture.
    - ChatPane's `check` is `(to, item) => item.routing === undefined ? null : checkSend(to, item.servers ?? [], (item.parts?.paths ?? []).some(isImage))`. `checkSend` (below) reads the pane's current agents, server lists and models through a ref, because the check runs long after the render that queued the message.
    - `ItemMeta` gains `servers: string[]`, the server names the message asks for (`parseServerRequests`, `src/serverRequests.ts:31`). They are read when the message is sent, from what was typed, as `send()` reads them today (`ChatPane.tsx:2707`), and read again from the edit box on an edit. Reading them from the routing text instead would also count a `!name` inside a quoted reply. The queue keeps `servers` like `routing` and `parts`, and never reads it.
  - **Closing (Review Focus 18).** `ParticipantQueues.close(): void`. ChatPane calls it once, from the cleanup of an effect on `[turnQueue]`, so only when the pane unmounts. Deck renders without StrictMode (`src/main.tsx:27`), so that is when the pane really goes. Before this, a closed pane's queue lived on in its own promises: a slice still being made was pushed and posted once its save finished, and a drain already running posted whatever it reached next.
    - After `close`, nothing the queue hasn't posted ever posts: an admission waiting for its turn or being made, a waiting item, an unmade or refused item, and anything a running drain would reach next. They all read `closed`. `drain` checks before each post and after each await, and `make` and `remake` drop what a late `prepare` returns. An admission still waiting for its turn is never prepared.
    - A post already on its way ends as it ends: `posted`, or `unknown` if it fails, since it may have arrived and nothing can retry it now. A failed post still kept at close reads `unknown` too.
    - `send`, `sendTo` and `admit` reject with `QueueClosed`, and an admission made after close reads `closed`. Retry, Resume, Steer, `turn`, edits and `giveUp` do nothing, and Idle or coming back online posts nothing. `status` and `watch` keep answering, and `changed` is no longer called.
    - Today a pane closed with messages still queued drops them, since the queue lives only in the pane. That stays as it is, except that nothing dropped can still post later.
  - **A queue changes hands only when it is empty (D11, Review Focus 21).** A popped-out pane stays mounted, hidden, in this window (`App.tsx:844`), and the pop-out window makes a `ChatPane` of its own, with its own queue (`PopoutApp.tsx:425`). A move keeps the pane mounted and only changes its machine (`moveDraft`, `App.tsx:2363`). In both cases `close` never runs. Revision 7 let what was waiting post later: a held slice posted after a message sent in the new window, or posted on B with a path saved on A.
    - `ParticipantQueues.unsent(): number` counts everything that hasn't ended. Removed and dropped items don't count. It counts:
      - a `send` or `sendTo` from its call until it is in `items`
      - an admission waiting for its turn or being made, a given-up one included, since it holds a place
      - every item in `items`: waiting, failed, unmade or refused
      - a post on its way
    - `ParticipantQueues.suspend(reason: string): () => void`. Until the returned release is called, the queue takes nothing new and posts nothing:
      - An `admit` takes its id and its place, and is never made. With `keep: true` it is failed and unmade, with `reason`, and Retry after the release makes it. With `keep: false`, `done` rejects with `Unsent(reason)`, and nothing stays.
      - `send` and `sendTo` reject with `Unsent(reason)`.
      - An admission that was being made stops at once and keeps its place, as with Stop waiting. One whose turn comes during the suspension is placed unmade without being made.
      - Retry, Steer, steering a queued message and re-run do nothing. `drain` posts nothing.
      - Releasing drains. A slice refused during the suspension still waits for Retry.
      - `status`, `watch`, `unsent` and Remove keep working. A second call of the same release does nothing.
    - `ThreadSendApi` gains `unsent(): number` and `suspend(reason: string): () => void`, which are this pane's queue's.
    - `leaveRefusal(api: ThreadSendApi | undefined, title: string, then: "pop it out" | "move it"): string | null`, in `src/threadSendApi.ts`. It gives "Wait until <title> has sent what's waiting, or remove it, then <then>." when `api.unsent() > 0`, and null otherwise. It is asked only about a pane in this window, after `ownerRefusal` (below), so `apis.get` gives the pane's own API there. A pane here with no API isn't mounted, so it has no queue, and nothing waits.
    - **Move and Pop out exclude each other (revision 9).** Revision 8 asked `leaveRefusal(apis.get(id))` and nothing else. For a popped-out pane, `apis.get` has nothing, so a move from the sidebar's Project › went ahead unchecked. And during a move, a suspended empty queue counts 0, so Pop out went ahead too.
      - `ownerRefusal(op: "pop out" | "move", title: string, now: { outside: boolean; moving: boolean }): string | null`, in `src/threadSendApi.ts`. For `"move"` with `outside`, it gives "Close <title>'s external pane to return it to Deck first." For `"pop out"` with `moving`, it gives "Wait until <title> has moved, then open it in a new window." Otherwise null.
      - Both functions ask it before `leaveRefusal` and before setting their own ref, with `now` read from two refs at the call: `moving` (`App.tsx:430`, today's) and `outside`.
      - `outside: Set<string>` holds a pane from the Pop out click until it is back in this window. `popOutPane` adds it before `bridge.open`. It leaves when `bridge.open` rejects, when the window closes (`onClosed`, `App.tsx:1552-1564`, whether or not the pane goes back into the layout) and when its record is dropped as an orphan (`:1698-1709`). It is mirrored in state, and `poppedIds` covers it. It replaces revision 8's `popping`, which let go of the pane once its window opened: a click handled before the next render could then see it in neither.
      - Each function sets its own ref before its first `await`: `moving` in `moveDraft`, `outside` in `popOutPane`. The page runs one click handler at a time, so of two clicks, the first wins and the second is refused, whichever order they come in.
      - **Why refuse rather than suspend the window's queue.** That queue lives in the pop-out window's own renderer (`PopoutApp.tsx:425`), out of this window's reach. And the window never learns a new machine: App pushes a pane's window `workspaceId` and `chatConfig`, but `hostId` only to tab windows (`App.tsx:1656-1669`), and the window posts through `hostId` (`PopoutApp.tsx:158,231-240`). A popped-out thread that moved would go on posting to the copy the move deletes (`threadMove.ts:80`).
      - **Project ›** (`projectEntries`, `App.tsx:2476-2490`): for a thread in `poppedIds`, every row is greyed with the Move reason, started or not. A started thread's pick moves nothing, but it opens its "Open it somewhere else" prompt (`moveAsk`, `choose`, `:2357-2361`) in this window's hidden copy (`ChatPane.tsx:4055`), and the pop-out window has no such prompt, so today it opens where no one sees it. The greyed rows are what the person sees. The check in `moveDraft` is what holds, whatever calls it: these rows, the work bar's pickers (`WorkBar.tsx:126,130,156`) or a menu drawn before the pane popped out.
    - **`popOutPane`** asks, after its own refusals: `ownerRefusal("pop out", pane.title, …)`, then `leaveRefusal(apis.get(id), pane.title, "pop it out")`. A refusal shows as a toast, and nothing opens.
      - Its first check, `poppedIds.has(paneId)` (`App.tsx:1462`), reads `outside.current` instead, so a second click while the window opens does nothing.
      - Then, before `bridge.open`, it adds the pane to `outside`. So from the click, the `#` picker and `ThreadInfo.open` (Tasks 11 and 14), the dock (Task 8) and `apis.get` treat the pane as popped out.
      - `apis.get` returns nothing for a pane in `outside`, so no batch can submit, Retry or Send again through its hidden copy.
      - If `bridge.open` rejects, the pane leaves `outside` and is back. If it resolves, it is recorded in `poppedOut`, as today, and stays in `outside`.
      - Every way in goes through `popOutPane`: the ⋯ menu, a drag out of the window (`App.tsx:883`), Dashboard's "external" destination (`:2569`) and the startup restore (`useRestorePopouts`, `:1538`).
    - **`moveDraft`** asks, after its `moving` check (`App.tsx:2365`): `ownerRefusal("move", pane.title, …)`, then its reachability checks, then `leaveRefusal(apis.get(pane.id), pane.title, "move it")`, all before `moving.current.add`. A refusal shows as a toast, as its reachability refusals do.
      - Then, still before its first `await`, it calls `release = apis.get(pane.id)?.suspend(\`Not sent: ${pane.title} is moving to ${hostNameFor(toHost)}.\`)`. It calls `release?.()` in its `finally`, whether the move landed or failed.
      - So nothing posts to A while A's room is copied and then deleted (`placeThread`, `src/threadMove.ts:52-81`). A message posted in that gap would be deleted with the room.
      - The queue lives on through the move, as today (`ChatPane.tsx:1706`). Each thing refused during it keeps what it needs:
        - the pane's own composer keeps its draft and shows the reason
        - a slice keeps its place as failed, with Retry
        - a next step or a voice turn is refused, as it is when the machine is offline
      - Closing the queue instead, as × does, would lose a composer message queued just before the move finished, because its draft is cleared once it is queued (`ChatPane.tsx:2744-2745`).
    - **What a queue's work runs on.** `prepare` (`submitDraft`, below) saves files and checks through `current.current` (`ChatPane.tsx:1707`) when it runs. That is the backend the queue posts with. So a slice refused during a move, and retried after it, saves its bytes on the machine the thread moved to and posts there. Nothing made on the old machine is still in the queue by then: the move waited for an empty queue and suspended it.
    - `useSendApis(hidden: (paneId: string) => boolean)`. App passes `id => outside.current.has(id)`. `get` returns nothing for a hidden pane, and `subscribe` also fires when `hidden`'s answer changes.
  - **Routing text (D10).** Who answers is read from a text kept apart from the posted text, and no rule ties the two together. (Revision 3 required the posted text to start with the routing text. `postable('//compact')` and any mod that rewrites the start broke that, so those sends would have thrown.)
    - `interface WireParts { typed: string; paths: string[]; tldr: boolean }` is the posted text in parts. `typed` is the message body after `//`, a mod's rewrite and quote formatting, and before the attachment lines and TL;DR. The queue stores the parts and never reads them.
    - `interface ItemMeta { routing: string; parts: WireParts; servers: string[] }`, where `routing` is the text recipients are read from, and `servers` the server names the message asks for, which only the check just before posting reads (above).
    - `ParticipantQueues.send(text, kind?, meta?)`, `sendOnce(text, to, meta?)` and `edit(id, text, kind?, meta?, keepTo?)`:
      - With `meta`, `send` and `edit` ask `targets(meta.routing)`, and `drain` asks `ask(item.routing)` before posting an item that isn't pinned. All three are kept on the item (`ParticipantMessage.routing?: string; parts?: WireParts; servers?: string[]`), with `refused?: string` for a refusal just before posting. Recipients are never read from `text` for an item that has `routing`.
      - Without `meta`, all three behave exactly as today. The phone, next steps, Steer and voice turns never pass it.
    - `composeWire(body: string, paths: string[], tldr: boolean): string` in `src/wireText.ts` is `withTldr(withAttachments(body, paths), tldr)`, the expression `send()` inlines today (`ChatPane.tsx:2739`). `send()`, `submit` and the edit box all build the posted text with it, so `text === composeWire(parts.typed, parts.paths, parts.tldr)` holds for every item with `parts`.
    - **What the routing text is:**
      - In a thread's own composer: `replyWith(parsed.text, replies, lead)`, where `lead` is `replyLead(parsed.text, replies, participants)`. Both are worked out once in `send()` from the typed text, before the mod hook (see `submitDraft` below), and the routing text is exactly today's `replyText(parsed.text, replies, participants)`. It includes a quote's `@lead`, which the posted text then reuses as it is (step 5). Quote blocks are context, and `replyWith` turns their `@` into `＠`, as `replyText` does today (`src/reply.ts:51`).
      - In a multi-thread slice: `Slice.routing` (Task 11), carried in the payload.
      - After an edit: what is left in the edit box, trimmed.
    - **What never changes it:** `postable`'s `//` (a typed `//compact` posts `/compact` and routes on `//compact`; neither names anyone), a mod's rewrite, file references, attachment lines and TL;DR.
    - Today the queue routes on the whole posted text (`ChatPane.tsx:1715` asks `roomTargets(pane.id, message)`). A Finder file keeps its own name when the host copies it (`copy_attachment`, `host.rs:3230`), so an `Attached image:` path with `@muck` in it could add Muck (Review Focus 7).
    - The server-request and media checks use the recipients the queue worked out for the item from its routing text (`submitDraft`, step 1), so the checks and the queue look at the same agents. Today the checks read the raw `text` (`ChatPane.tsx:2705`), which misses a quote's `@lead`.
  - **Editing a queued message (D9),** on an item with `parts`:
    - The edit box's `defaultValue` is `parts.typed`. The queued line shows the same, plus a quiet note for what the app added, such as `+ 1 picture · TL;DR`.
    - On blur with a changed value that `parseQueueEdit` reads as text `t`:
      - If `t` is blank and `parts.paths` is empty, nothing changes. An empty message can't be sent, so the old one stays, and the trash button removes it.
      - Otherwise ChatPane calls `turnQueue.edit(id, composeWire(t, parts.paths, parts.tldr), "message", { routing: value.trim(), parts: { ...parts, typed: t }, servers: parseServerRequests(value).map(s => s.name) }, keepTo)`.
    - The message is built again from its parts on every edit, and nothing is cut out of the old text. So the attachment lines always keep their own lines. For example, `hi` with a picture, edited to nothing and then to `hello`, posts `hello`, a blank line, then the `Attached image:` line (Review Focus 14).
    - **A one-send pick** (`oneOff`, D1): ChatPane passes `keepTo` when the edit names no agent (`hasMention`, `src/recipients.ts`). The item then keeps its `to` and stays one-off. When the edit names an agent, the queue asks `targets(meta.routing)` and the item stops being one-off, the way typing `@name` always does.
    - Turning the message into `/compact`, `/curate` or `/curate undo` through the edit box works as today (`ChatPane.tsx:3966-3969`). The item drops its `routing` and `parts`, and the attachments are left behind, as today.
    - Items without `parts` (the phone's, next steps through `sendTo`, Steer) edit exactly as today.
  - `interface PendingFile { id: string; label: string; name: string; bytes: Uint8Array | null; previewUrl: string | null }`. A file in the multi composer is always bytes. A Finder file is read once, at the drop (Task 16), so every destination and every retry sends the same bytes. `bytes` is `null` only while the file is still being read; a payload never holds such a file.
  - `interface SlicePayload { text: string; routing: string; files: PendingFile[]; to: string[] | null; tldr: boolean }`, everything needed to send the slice again with no draft left. `text` and `routing` are Task 11's `Slice.text` and `Slice.routing`, before attachment lines and TL;DR.
  - `interface ThreadSendApi { paneId: string; hostId: string; queue: string; canPickAgent: boolean; agents(): { id: string; handle: string; name: string }[]; defaultTargets(): Promise<string[]>; submit(p: SlicePayload): QueueRef; command(name: "compact" | "curate" | "curate_undo"): QueueRef; status(ref: QueueRef): ItemState; watch(ref: QueueRef, cb: (state: ItemState, error?: unknown) => void): () => void; retry(ref: QueueRef): "retried" | "gone"; remove(ref: QueueRef): void; giveUp(ref: QueueRef): void; unsent(): number; suspend(reason: string): () => void; draft(): { text: string; tldr: boolean; attachments: number; quotes: number }; clearDraft(): void }`
    - `unsent` and `suspend` are this pane's queue's (D11, "A queue changes hands only when it is empty" above). `hostId` follows the pane: after a move, the pane registers its API again with the new machine and the same `queue`.
    - `queue` is this pane's `turnQueue.instance`. With `ref.queue !== queue`, `status` is `unknown`, `watch` calls back once with `unknown`, and `retry` returns `"gone"`. Nothing is posted.
    - `retry` returns `"retried"` only when the item was `failed` in this queue, and `"gone"` otherwise.
    - `remove(ref)` removes the item when it is `failed` in this queue, as the trash button does, and does nothing otherwise. `giveUp(ref)` is the queue's `giveUp` for an item in this queue.
    - **`submit` and `command` return the item's `QueueRef` at the call.** They admit with `keep: true`, so the slice has its place in this thread's queue before anything is saved or checked, and a failure keeps that place (above). Nothing waits for `done`: an idle agent's post is awaited inside the drain (`turnQueue.ts:113`), and `room_compact` and `room_curate` return only when the model has finished (`crates/apex-host/src/host.rs:2639,2689`). The batch follows the item with `watch` instead (Task 15).
    - `canPickAgent` is false when this pane's machine doesn't answer `postCapabilities` with `keep_default_v1` (D1).
  - `useSendApis(hidden: (paneId: string) => boolean): { register(paneId: string, api: ThreadSendApi | null): void; get(paneId: string): ThreadSendApi | undefined; subscribe(cb: () => void): () => void }`. `subscribe` calls back when a pane registers or unregisters, and when `hidden`'s answer changes, so the batch sees a pane close, reopen, move or pop out. `get` returns nothing for a hidden pane: App's `hidden` is "popped out, or being popped out" (D11).
  - `ChatPane` prop `onSendApi(paneId: string, api: ThreadSendApi | null): void`

**`submitDraft`, which `send()` and `submit` share:**
- `submitDraft(d: { body: string; routing: string; lead: string; servers: string[]; replies: ReplyQuote[] | null; paths: string[]; files: PendingFile[]; tldr: boolean; to: string[] | null }, keep: boolean): { id: number; done: Promise<number> }` calls `turnQueue.admit({ kind: "message", routing: d.routing, servers: d.servers, to: d.to, label: d.body, keep, prepare })` and returns at once. With `d.to` the item is one-off, so the pick doesn't become the default (Task 11a). `prepare(to)` runs these steps in order, once the message's turn comes:
  1. **Recipients** are `to`, which the queue worked out: `d.to`, or `targets(d.routing)`, which is `stickyFor(d.routing) ?? roomTargets(pane.id, d.routing)` (`ChatPane.tsx:1715`). They come from the routing text only (D10), and the checks and the queue now use one answer, worked out once.
  2. **Checks:** `checkSend(to, d.servers, pictures)`, where `pictures` is whether `d.paths` or `d.files` hold an image, runs against **those** recipients. A reason throws as the error. The drain runs the same check again just before the post, for the recipients it posts to (above).
  3. **Mods:** the mod hook runs on `d.body`. A refusal throws the mod's message.
  4. **Files:** each of `d.files` is saved (see `submit`), and its path goes after `d.paths`. They are saved only now, so a refused message saves nothing.
  5. **Posted text:** `body = postable(hooked.text)`, then `named = keptNames(d.body, body, participants) + body`, then `typed = (named.trim() || d.lead) && replyWith(named, d.replies ?? [], d.lead)`. It returns `{ text: composeWire(typed, paths, d.tldr), parts: { typed, paths, tldr: d.tldr } }`.
     - `keptNames(typed: string, rewritten: string, people: readonly Mentionable[]): string`, in `src/recipients.ts`, is `pickLead` (Task 11a) of each agent that `namedIn(typed)` names and `namedIn(rewritten)` doesn't, in the order typed. Those are the names the person typed that a mod took out (D12). With no mod, or a mod that keeps every name, it is `''` (`/tmp/jigga-rev9/restore.mjs`).
     - **The quote's lead is `d.lead`, the one `send()` chose from the typed words. It is never worked out again here (Null's ninth review).**
       - `quoteLead` leads with the quoted agent only when the words name no one, and `@all` counts (`src/reply.ts:26-28`). So a rewrite that adds a name, or takes `@all` out, changes it. Revision 9 asked `replyText(named, …)` here, which could drop the quoted agent's `@name` or bring it in.
       - With `d.lead`, the posted text starts with exactly the routing text's lead, or with none. The typed names a mod took out come right after it.
       - With no mod, the text is today's, character for character. The one exception is a send with no words under a quote that leads with an agent (below). `/tmp/jigga-rev10/quote-lead.mjs` checks all of this on 200,000 random sends.
     - The names and the lead go into `parts.typed`, so the queued line and the edit box show them, as today's queued line shows a quote's lead. A menu pick's lead is added only at posting (Task 11a), because in the edit box it would turn the pick into a typed name, and that changes the default.
     - **No words left.**
       - A mod that blanks the words keeps the names and the lead. `@allison a whale`, rewritten to nothing, posts `@allison`, as if just that had been typed.
       - Under a quote whose lead is `@allison `, a blank rewrite posts that lead and the quote, `replyWith('', d.replies, d.lead)`, as the routing text has them.
       - A send of only a picture under such a quote posts the same, with the picture (D12's one visible change).
       - With no names lost and no lead, a blank rewrite posts only the attachment lines, as today.
     - **`replyLead` and `replyWith`** (`src/reply.ts`) are today's `replyText` in two parts:
       - `replyLead(text: string, quotes: readonly ReplyQuote[], people: readonly Mentionable[]): string` is the `@handle ` that `replyText` puts in front, from `quoteTarget(text.trim(), quotes, people)` as today, or `''` for no one.
       - `replyWith(text: string, quotes: readonly ReplyQuote[], lead: string): string` is the trimmed text when there are no quotes. Otherwise it is `lead`, the trimmed text, a blank line, then the quote blocks.
       - `replyText(text, quote, people)` becomes `replyWith(text, quotes, replyLead(text, quotes, people))` and gives exactly today's text. So More details (`moreDetailsText`), the phone's `outgoingText` (`src/phone/messageTools.ts:44`), the talk-only send (`ChatPane.tsx:2699`) and the recipient preview (`:2589`) don't change. The 15 tests in `tests/reply.test.mjs` pass against the split unchanged (`/tmp/jigga-rev10/proto/`).
       - The lead is kept as its exact text, not as an id turned back into a handle at posting. The queue reads recipients from the routing text, which holds the same text, so a renamed or departed agent changes both alike.
  6. **Host-can-mutate,** as today. The queue checks the connection again after `prepare`.
- `checkSend(to: string[], servers: string[], pictures: boolean): string | null` is today's two checks, unchanged in what they refuse and how they say it, reading the pane's current `participants`, `serverLists` and `providerModels` through a ref:
  - Server requests: when every recipient's server list is known, a name none of them has gives `No server, app or plugin called "<name>" for <agents>` (`ChatPane.tsx:2706-2708`).
  - Pictures: `missingPicture(mediaSendsFor(to, participants, providerModels, pictures))` gives `<name> needs a picture: attach one to animate.` (`:2726-2729`). `missingPicture` is the line `priceSend` already uses for `missing` (`src/mediaPrice.ts:97`), so no price is fetched to decide.
- `send()` reads the pane's state and handles mod commands, slash commands and runner mode as today. For a message, it then calls `submitDraft({ body: parsed.text, routing: replyWith(parsed.text, replies, lead), lead, servers: parseServerRequests(text).map(s => s.name), replies, paths, files: [], tldr, to: null }, false)` with no `await` before it. `parsed` is today's `parseComposer(text.trim())` result (`ChatPane.tsx:2719`), and `lead` is `replyLead(parsed.text, replies, participants)`, worked out once at the click.
  - **While its message waits for its turn,** from the click until `done` settles, the composer's Send is disabled with the title "Sending…", and Enter does nothing. Typing is allowed. A slice ahead of it can take seconds to save its pictures, and today a second click in that wait would queue the same draft again: the draft is cleared only once the message is queued (`ChatPane.tsx:2744-2745`).
  - **On success** it removes only what it sent: the text if it is unchanged (as today), the quotes it sent, and the pictures it sent (as today). Today's `setReplies([])` would also clear a quote added while the message waited.
  - **On a refusal** the draft is still there, and the reason shows as a notice, as today. Nothing is left in the queue.

**How `submit` works:**
- It calls `submitDraft({ body: p.text, routing: p.routing, lead: '', servers: parseServerRequests(p.routing).map(s => s.name), replies: null, paths: [], files: p.files, tldr: p.tldr, to: p.to }, true)` and returns `{ queue: turnQueue.instance, id }` at once. `command` returns the same from `queueContextJob(name, kind, true)`, which admits `{ kind, routing: command, to: null, label: command, keep, prepare: async () => ({ text: command }) }`.
- The composer's own `contextJob` clears the text and quotes as today, then calls `queueContextJob(command, kind, false)`. A refusal still shows its notice (`ChatPane.tsx:1669`), and nothing is left in the queue.
- **Files** are saved in step 4, each with the backend the queue posts with when `prepare` runs, `current.current.saveAttachment(pane.id, attachmentName(name), bytes)` (`ChatPane.tsx:1707`), as a pasted picture is today. So each lands on the machine that owns the thread at that moment, under a name with no `@`. A Retry saves them again from the same bytes, on the machine the thread is on then (D11).
  - So recipients come from `p.routing`, exactly what the planner read and the summary showed (D10). `p.text` holds file references, and the posted text adds attachment lines and TL;DR, but none of that is read for recipients.
  - The checks run against the agent actually picked. Today's `send()` checks the thread default from the raw text (`ChatPane.tsx:2705-2726`), so a picked agent that lacks a server or needs a picture would slip through.
  - An edit of the queued slice routes on what is left in the box (D9), read by the same rules as `p.routing`: in the box, a file reference's brackets separate words as the chip's space did.
- It never touches the pane's own draft, replies or attachment tray.
- `defaultTargets()` is `backend.roomTargets(pane.id, "")`.

**Curate failures (D8).** `dispatch` for `curate` and `curate_undo` (`ChatPane.tsx:1683-1700`) still shows its notice and reloads the curation notes, then rethrows. The error is marked as already shown, so the queue's own "Could not send…" notice (`ChatPane.tsx:1724`) skips it.

- [ ] **Step 1: Write the failing tests.**
  - **Queue states (`tests/turn-queue-status.test.mjs`):**
    - `send` to an idle agent resolves only after the post itself settles (`await this.drain()`, `turnQueue.ts:113`), so the batch can first see an item in any state. With a post that fails once: once `send` resolves, `status(id)` is `failed`, and `watch(id)` calls back with `failed` and the error straight away.
    - Then the queue's own `retry(id)`, as the thread's Retry button calls it, with a post that now succeeds: that `watch` reports `waiting` or `posting`, then `posted`, and `status(id)` stays `posted`.
    - The post function was called twice for that item and once for a second item that was not retried.
    - An item queued behind a working agent: `send` resolves at once, and `status(id)` stays `waiting` until that agent goes idle and the item posts. Then it is `posted` (Review Focus 3).
    - `remove(id)` of a queued item, and of a failed one, gives `removed`. An id the queue never had is `unknown`. After 1,001 more posts, the first id is `unknown`.
    - Two queues have different `instance` values. Queue 2 has a failed item 1 of its own; `retry` with `{ queue: <queue 1>, id: 1 }` returns `"gone"` and leaves queue 2's item failed and unposted (Review Focus 8).
  - **Taking a place (`tests/turn-queue-admit.test.mjs`, Review Focus 17).** Agents Null and Muck, the thread default Null, and a post that records its text and then reports the agent idle. `/tmp/jigga-rev7/rev6-checks.mjs` runs each of these against the revision 7 prototype:
    - `admit` returns its id at the call, and `status(id)` is `preparing` until `prepare` resolves.
    - **Call order (Null's first case).** `admit` A, `keep: true`, with its `prepare` held. 700 ms later, `admit` B, `keep: false`, as the thread's own composer does. Nothing posts until A's `prepare` resolves. Then A posts, then B.
    - **Other ways in.** `admit` A with its `prepare` held, then `sendTo('next step', ['null'])` and `send('more')`. They post after A, in that order.
    - **A held failure (Null's second case).** `admit` A, `keep: true`, whose `prepare` rejects once, then `admit` B. A is `failed` and never posts. B is `waiting`, and `holdOf(B)` is `behind`. `retry(A)` calls A's `prepare` again, and then A posts and B posts, in that order. Both read `posted`.
    - **Discard.** The same, but `remove(A)`: B posts at once, and A is `removed`.
    - **A refusal.** `keep: false` with a `prepare` that throws: `done` rejects with its reason, nothing is left in `items`, and a later `admit` posts.
    - **Other agents go on.** A, for Null, fails in `prepare`. A later `@muck hi` posts; a later message to Null waits.
    - **Recipients unknown.** `targets` rejects for A, `keep: true`. A later `@muck hi` waits too.
    - **A whole-room command.** A `compact` admission whose `prepare` rejects, `keep: true`, holds back a later `@muck hi` too.
    - **It never posts its label.** During A's Retry, with `prepare` held, an `idle` and a `roomIdle` post nothing, and a second `retry(A)` doesn't call `prepare` again. Once `prepare` resolves, A posts once.
    - **Not editable or steerable.** `edit(A, …)` and `steerQueued(A)` leave A as it was.
    - **Steer still goes first.** With A failed, `steer('null', 'now')` posts `now`.
    - **Stop waiting.** `admit` A with its `prepare` held, then `admit` B. `giveUp(A)`: A is `failed` and unmade, at its place, and B is accepted and waits behind it. Resolving A's old `prepare` afterwards changes nothing. `remove(A)` then posts B.
    - **Stop waiting before its turn (Review Focus 20, Null's third revision-6 case).** A `curate` admission whose `targets` lookup is held, then slice S, then message T. `giveUp(S)`: `watch(S)` reports `failed` with "Stopped waiting" at once. Release the lookup: the curate posts, S's `prepare` is never called and S never posts, S is unmade at its place, and T's hold is `behind`. `retry(S)` then posts S, then T.
    - **Taken back or dropped before its turn.** A with its `prepare` held, then B. `giveUp(B)` then `retry(B)`: B reads `preparing`, and once A is released, A posts, then B. In a second run, `giveUp(B)` then `remove(B)`, with the thread's own C admitted after B: B reads `removed` at once, C waits for A, and once A is released, A and C post and B's `prepare` is never called.
    - **A long command doesn't hold the line.** Admit `/curate` on an idle room, with its post held. Then admit slice S: S reads `waiting` and is in `items` while the curate runs, and it posts once the curate is released. A composer `/compact` admitted with `keep: false`, then a composer message: the message's `done` settles while the compact runs, and the message is in `items`, behind it.
    - **`done` still waits for its own post.** To an idle agent, with the post held: `done` hasn't settled when the post starts, and settles once it is released, as `send`'s promise does.
    - **Checked again just before posting (Review Focus 19, Null's second revision-6 case).** `targets` and `ask` answer `['null']` until the rule changes, then `['null', 'muck']`. `check` refuses Muck when the item has no picture.
      - Admit A with its `prepare` held, which records the recipients it was made for. Change the rule, then release: nothing posts, `watch(A)` reports `failed` with Muck's reason, and the `failed` callback got one `Unsent`. A later B to Null waits, with hold `behind`. Change the rule back and `retry(A)`: A posts to Null, then B.
      - The same with a picture: A posts to Null and Muck. A rule changed while it waited still applies.
      - A one-send pick to Muck is checked for `['muck']`. `send` and `sendTo` items have no `routing` and are never checked. Nor is a `/compact` admission, even when every check would refuse.
      - A refused item holds back a `sendTo` to the same agent. `remove` lets that go at once. An edit of a refused item, after which the check passes, posts it.
    - **Closing (`tests/turn-queue-close.test.mjs`, Review Focus 18, Null's first revision-6 case):**
      - Admit S with its `prepare` held. `close()`: `watch(S)` reports `closed` at once. A new queue for the same room admits S again and posts it. Release the old `prepare`: the old queue posts nothing, so the room got exactly one post.
      - X's post held, with Y admitted to another agent after it. `close()`, then release X: X reads `posted`, Y reads `closed`, and Y never posts.
      - X's post held, then `close()`: X reads `posting`. Fail X's post: X reads `unknown`.
      - At `close()`, a failed post kept with Retry reads `unknown`, and an unmade slice reads `closed`.
      - After `close()`: `admit`'s `done`, `send` and `sendTo` reject with `QueueClosed`. `idle`, `resume` and `retry` post nothing.
      - A with its `prepare` held, then B. `close()`, then release A: neither posts, and B's `prepare` is never called.
      - An item waiting for a working agent: `idle` starts a drain whose `ask` is held. `close()`, then the `ask` answers: nothing posts.
    - These files pass unchanged against the prototype: `tests/turn-queue.test.mjs`, `tests/phoneQueue.test.mjs`, and the six other files that make a `ParticipantQueues`. That is 93 of 93 tests. `/tmp/jigga-rev7/rev7-checks.mjs` runs each case above against the prototype, 37 checks in all.
    - **Empty, and suspended (`tests/turn-queue-suspend.test.mjs`, D11, Review Focus 21, Null's first revision-7 finding).** `/tmp/jigga-rev8/rev8-checks.mjs` runs each of these against the revision 8 prototype, which also passes all of the above unchanged.
      - **`unsent` counts:**
        - It is 0 for a new queue.
        - A `sendTo` counts from its call, before it is in `items`.
        - An item waiting for a working agent counts, and so does a made slice waiting behind it.
        - An unmade slice kept as failed counts.
        - A post on its way counts, until it has posted.
        - A slice given up before its turn still counts. Once it is removed before its turn, it doesn't.
        - Removing everything brings it back to 0.
      - **Pop-out (Null's case).** A main queue admits slice S with its file save held: `unsent()` is 1, so App would refuse. Release the save: S posts, and `unsent()` is 0. A second queue for the same room, standing for the pop-out window, then sends `there`. The room got S first, then `there`.
      - **Move (Null's case).** S's prepare saves on whichever machine the pane is on when it runs. With S's save held on A, `unsent()` is 1, so the move is refused. Released, S posts on A with A's path, and B never gets it.
      - **Suspended during a move.** With an empty queue, `suspend(reason)`:
        - An admitted slice reads `failed` with `reason` at once, and its `prepare` is never called.
        - The composer's admission (`keep: false`) rejects with `Unsent(reason)` and reads `removed`.
        - `sendTo` rejects with `Unsent`.
        - Retry does nothing. Nothing is saved or posted.
        - Then the pane's machine becomes B and the release is called. Nothing posts by itself. Retry makes the slice on B and posts it there.
        - A second release does nothing.
      - **A move that fails.** The same, but the machine stays A: after the release, Retry posts on A.
      - **Suspending a queue that isn't empty** (App never does, but the queue stays safe):
        - A slice being made stops at once and keeps its place, unmade.
        - A slice waiting for its turn behind it is placed unmade when that turn comes.
        - Nothing posts after the release until Retry, and two Retries post them in their order.
        - An item waiting for a working agent doesn't post when the agent goes idle while suspended. It posts after the release.
        - Steer and re-run do nothing while suspended.
  - **Queue routing and edits (`tests/turn-queue-status.test.mjs`):**
    - `send(text, "message", { routing: 'hi', parts })` with text `hi\n\nAttached image: /tmp/@muck/shot.png`: `targets` is asked about `hi` only. Queued behind a working agent, the item's `ask` at posting time is about `hi` only too.
    - **Routing wins over text.** `send('ping @muck', "message", { routing: 'ping', parts })` asks about `ping` only, and the item goes to the thread default.
    - **No prefix rule.** `send('/compact', "message", { routing: '//compact', parts })` queues normally as a message.
    - `edit(id, text2, "message", { routing: 'hello', parts: p2 })` asks about `hello` only and stores `routing` and `parts` as given.
    - Policy `mention`, default Muck: `sendOnce('check this', ['null'], meta)`, then `edit(…, keepTo true)` to `check this again`. `to` stays `['null']`, the item stays one-off, and the post callback sees `oneOff: true`.
    - The same item edited to `@muck check this`, without `keepTo`, has `to` `['muck']`, and the post callback sees no `oneOff`.
    - An item sent with no `meta` edits as it does today: `tests/turn-queue.test.mjs` passes unchanged.
  - **`composeWire` (`tests/wire-text.test.mjs`):** it equals today's inline `withTldr(withAttachments(…))` for an empty and a nonempty body, with 0 and 2 paths, with TL;DR on and off. `composeWire('', [], true)` is `''`, as today.
  - **Component:**
    - `submit({ text: 'hi', routing: 'hi', files: [], to: null, tldr: false })` returns a `QueueRef` whose `queue` is the pane's before any service call, and the service then receives `room_post_to` for this room with text `hi`.
    - With `to: ['muck']`, the targets are `['muck']`, the command carries `keep_default: true`, and its text is `@muck hi` (D12). The thread's default (`room_targets` for `""`) is unchanged afterwards.
    - **A queued pick, edited (D9, D12).** While Muck is working, `submit` `hi` with `to: ['muck']`. The queued line and its edit box show `hi`, with no `@muck`. Edit it to `hi again` and blur, then let Muck go idle: one `room_post_to`, text `@muck hi again`, targets `['muck']`, `keep_default: true`. In a second run the edit is `@null hi again`: it posts `@null hi again` to `['null']` with no `keep_default`, as typing `@null` does.
    - With a file, `save_attachment` is called on this room first, with the `attachmentName` of its name, and the posted text ends with `Attached image: <that path>`.
    - **Queued edit box (D9).** While the agent is working, send `hi` with a picture and TL;DR from the pane's own composer. The queued line's edit box holds `hi` only, with no path and no TL;DR line. Change it to `hello` and blur: the item's text is `hello`, then the same attachment line and the TL;DR line.
    - **Edited twice (Review Focus 14).** The same message, edited to nothing and then to `hello`:
      - After the blank edit, the text is the `Attached image:` line, a blank line and the TL;DR line. `attachedImages(text)` still finds the picture, and the edit box now holds nothing.
      - After the second edit, the text is `hello`, a blank line, the attachment line, a blank line and the TL;DR line. `attachedImages` finds the picture, and `splitTldr(text).tldr` is true.
      - A queued `hi` with no picture, edited to nothing, still reads `hi`.
    - **`//` and mods (D10):**
      - `submit({ text: '//compact', routing: '//compact', files: [], to: null, tldr: false })` posts the text `/compact` as a message, not a compact turn, to the thread default. Nothing throws. A typed `//compact` in the pane's own composer does the same, as today.
      - A stub mod's `prompt.submit` turns `what is the status` into `@muck what is the status`, and the thread default is Null. `submit` of `what is the status` posts the mod's text to `['null']`. The same text from the pane's own composer also goes to `['null']`.
      - A mod that refuses makes `watch(ref)` of a `submit` report `failed` with its message. Nothing posts, and no file is saved. From the pane's own composer, the same mod shows its message, leaves the draft, and leaves nothing in the queue.
    - **A typed name a mod takes out (D12, Null's second revision-8 finding).** Allison is a video agent, and the thread default is Null. A stub mod's `prompt.submit` turns `@allison a whale` into `a whale`.
      - From the pane's own composer: one `room_post_to`, with targets `['allison']` and text `@allison a whale`. Sent while Allison is working, the queued line and its edit box show `@allison a whale`.
      - `submit({ text: '@allison a whale', routing: '@allison a whale', files: [], to: null, tldr: false })` posts the same.
      - **With a quote.** Quote a reply of Null's and type `@allison look at this`, which the mod turns into `look at this`. The text starts with `@allison look at this`, not `@null`, and the targets are `['allison']`.
      - A mod that returns `@allison a big whale` posts exactly that, with no second `@allison`.
    - **A quote's lead, kept as chosen at Send (D12, Review Focus 22, Null's ninth review).** Allison is a video agent, and the thread default is Null. The room holds a reply of Allison's whose text is `the first cut`, quoted with its Quote action.
      - **Not dropped.** Type `look at this`, with a stub mod that returns `look at this @null`. One `room_post_to`, with targets `['allison']` and text `@allison look at this @null`, a blank line, then `> Allison wrote:` and `> the first cut`. Revision 9 posted it with no `@allison`. With a mod that returns `@all look at this`, the text starts `@allison @all look at this`, and the targets are still `['allison']`.
      - **Not brought in.** Type `@all look at this`, with a stub mod that returns `look at this`. The targets are every agent in the thread, and the text is `look at this`, a blank line, then the quote, with no `@allison`. Revision 9 posted `@allison look at this`.
      - **A Send to ▾ choice.** With Send to Null picked on the quote, type `look`, with a stub mod that returns `look @muck`. The text starts `@null look @muck`, and the targets are `['null']`.
      - **No words left.** A stub mod that returns `''` for `look`: the text is `replyText('', [quote], people)`, which is `@allison `, a blank line, then the quote. The targets are `['allison']`.
      - **A picture, no words (D12's one visible change).** No mod. Attach a picture, type nothing, and Send. One `room_post_to`, with targets `['allison']`. Its text is `@allison `, a blank line, the quote, a blank line, then the `Attached image:` line. Today posts only the picture line, to Null.
      - Sent while Allison is working, the queued line and its edit box show the posted words with their lead, as `parts.typed` holds them.
    - **`replyLead` and `replyWith` (`tests/reply.test.mjs`, extend).**
      - For every `replyText` case already in the file, `replyWith(text, quotes, replyLead(text, quotes, people))` gives the same text.
      - Under a quote of Allison's, `replyLead` gives `'@allison '` for `look`. It gives `''` for `@all look` and for `@null look`.
      - With Send to Null on the quote it gives `'@null '`. For a quote of your own message, or of an agent that has left, it gives `''`.
      - `replyWith('look @null', [allisonQuote], '@allison ')` starts with `@allison look @null`. `replyWith('look', [allisonQuote], '')` starts with `look`. `replyWith('  hi  ', [], '@allison ')` is `hi`.
    - **The shared list (`shared/media-naming.json`, Review Focus 22).** For every case, the app posts exactly `posted`. Allison is a video agent, and the thread default is Null, except in the case named by no one, whose default is Allison. A case with `picked` goes through `submit` with `to: picked` and its `tldr`. The rest are typed in the pane's own composer, with a stub mod that returns `mod` when the case has one. A case with `quote` is typed under that quote, taken with the Quote action from a reply in the room with that speaker and text. Task 11a's Rust test runs the same texts through the media agent, so between them the two tests cover the whole way to the price card.
    - **Chip beside a typed `@`.** `submit({ text: 'alice[Image1: shot.png]@muck run it', routing: 'alice @muck run it', … })` posts to `['muck']`, the agent the summary showed.
    - **Quote.** With default Muck, quote a Null reply and type `thanks`. `targets` is asked about the `replyText` result, which starts with `@null`, and the server-request check runs against Null.
    - Thread default Null; a file named `@muck screenshot.png`, with the fake save returning `/tmp/@muck/muck-screenshot.png`. The posted targets are `['null']` (Review Focus 7).
    - With `to: ['muck']`, a file, and text `!figma do x`, where only Null has the `figma` server: `watch(ref)` reports `failed` with the server message that names Muck. Nothing posts, and `save_attachment` was never called.
    - With `to: ['picture-agent']` and no picture: `watch(ref)` reports `failed` with "<name> needs a picture: attach one to animate.", as `send()` would show it.
    - A machine whose `post_capabilities` fails gives `canPickAgent: false`.
    - The pane's own textarea keeps `draft-in-progress` throughout.
    - `command('compact')` queues kind `compact`, and the textarea still holds the draft.
    - A fake `roomCurate` that rejects makes `watch(ref)` of `command('curate')` report `failed`; exactly one error notice shows; the item stays failed with Retry. The same holds for `curate_undo`.
    - **Returned at the call (Review Focus 15).** With `roomCurate` held back, `command('curate')` returns its `QueueRef` at once, and `status(ref)` is `posting` while the curate runs. Releasing it gives `posted`. `submit` with `room_post_to` held back does the same.
    - **Two slices in call order.** Two `submit` calls to one pane, the first with a file whose `save_attachment` is held back and the second with none. The second makes no service call until the first is released, and the first's `room_post_to` arrives before the second's.
    - **Both composers in call order (Review Focus 17, Null's first case).** `submit` a slice with a file whose `save_attachment` is held back. 700 ms later, click the pane's own Send, with `own text` already in its composer. No `room_post_to` happens until the save is released, and then the slice's arrives before `own text`'s. Until then the pane's Send is disabled with the title "Sending…" and `own text` is still in the box. Afterwards the box is empty.
    - **A slice that fails before it is made (Review Focus 17, Null's second case).** `submit` S1 with a held `save_attachment`, then `submit` S2 with no file, then fail S1's save.
      - `watch(S1)` reports `failed` with the save's error. S2 is `waiting`, and no `room_post_to` has happened.
      - The pane's queued list shows S1 as "Didn't send", with its error, Retry and Remove, and no edit box. S2's line says "waits for the unsent message above", with no Resume.
      - `retry(S1)`, with the save now succeeding: `save_attachment` is called again with the same bytes, then S1's `room_post_to` arrives, then S2's.
      - In a second run, `remove(S1)` posts S2 at once.
    - **Two clicks while it waits.** With a slice's save held back, click the pane's own Send twice, 150 ms apart, after the 600 ms guard. Once the save is released, exactly one `room_post_to` for `own text` arrives.
    - **A quote added while it waits.** With a slice's save held back, send `own text` from the pane's own composer, then quote a reply before releasing the save. Afterwards the text is gone and the new quote is still in the composer.
    - **Closed and opened again (Review Focus 18, Null's first revision-6 case).** Mount ChatPane for room R and `submit` slice S with a picture, with `save_attachment` held. Unmount it, as × does, and mount a new ChatPane for R.
      - The old `watch(S)` reported `closed`. The new pane registers an API with a different `queue`.
      - `submit` S's payload through the new API, then release the old save: R received exactly one `room_post_to`, from the new pane.
      - In a second run, hold `room_post_to` instead and unmount while it is held. The old `watch(S)` reports `posting`, then `posted` once it is released, and nothing else posts.
    - **Who answers changes while a save is held (Review Focus 19, Null's second revision-6 case).** Who answers is Null's. Muck is a video agent whose model needs a picture.
      - `submit` a slice holding a PDF, with `save_attachment` held. Switch Who answers to Everyone, then release. No `room_post_to` is made, and `watch(ref)` reports `failed` with "Muck needs a picture: attach one to animate." One notice shows it.
      - Switch back, then `retry(ref)`: one `room_post_to`, to Null.
      - The same from the pane's own composer, while Null is working: the message is queued, and the switch to Everyone comes before Null finishes. The queued line shows "Didn't send" with Muck's reason, Retry and Remove, and the notice has no "Check whether it arrived".
      - A queued message whose edit adds `!figma`, a server no recipient has, is refused the same way when it comes to post.
    - **Stop waiting behind a command still starting (Review Focus 20, Null's third revision-6 case).** Hold `room_targets` for `/curate`, then `command('curate')` and `submit` slice S. `giveUp(S)`: `watch(S)` reports `failed` at once. Release the lookup: the curate runs, and S never calls `save_attachment` or `room_post_to`. `retry(S)` then posts S after the curate.
    - **The composer's own `/compact` doesn't hold the line.** With `room_compact` held, type `/compact` in the pane's own composer and Send, then type `continue` and Send. The box is empty straight away, and the queued list shows `continue` waiting. Release the compact: `continue` posts after it. Today `continue` stays in the box until the compact ends.
    - **A thread moved to another machine (D11, Review Focus 21, Null's first revision-7 finding).** Two in-memory services, A and B. Mount ChatPane on A's backend, as App renders a pane whose workspace is on A.
      - **Waiting for the queue.** `submit` slice S with a picture, with A's `save_attachment` held. `api.unsent()` is 1, and `leaveRefusal(api, 'R', 'move it')` reads "Wait until R has sent what's waiting, or remove it, then move it." Release: A gets one `room_post_to`, ending with A's path.
      - **Suspended while it moves.** On an empty queue, `const release = api.suspend('Not sent: R is moving to B.')`.
        - `submit` S2 with a picture: `watch` reports `failed` with that reason at once, and neither service gets `save_attachment` or `room_post_to`.
        - Type `own text` and click Send: the notice reads the reason, and `own text` is still in the box.
        - Render the same ChatPane with B's backend, as App does once `moveDraft` has changed the pane's workspace. Then call `release()`.
        - The registered API reports `hostId` B and the same `queue` as before.
        - Nothing has posted. `api.retry(ref)` then calls B's `save_attachment` with S2's bytes, and B's `room_post_to` ends with B's path. A got nothing after the release.
        - Send `own text` again: it posts on B.
      - **A move that fails.** The same, but the pane keeps A's backend. After the release, Retry saves and posts S2 on A.
    - **App's call sites (`tests/composer-dock-contract.test.mjs`).** In `src/App.tsx`:
      - `popOutPane` calls `ownerRefusal("pop out"`, then `leaveRefusal`, then adds the pane to `outside`, all before `bridge.open`, and its rejection handler deletes the pane from `outside`.
      - `moveDraft` calls `ownerRefusal("move"`, then `leaveRefusal`, then `moving.current.add` and `suspend`, all before its first `await`, and calls the release in its `finally`.
      - `onClosed` and the orphan cleanup delete the pane from `outside`.
      - `projectEntries` greys its rows for a pane in `poppedIds`.
      - `useSendApis` is given `outside.current.has`.
    - **`ownerRefusal` and `leaveRefusal` (`tests/thread-send-api.test.mjs`).**
      - `ownerRefusal('move', 'T', { outside: true, moving: false })` is "Close T's external pane to return it to Deck first."
      - `ownerRefusal('pop out', 'T', { outside: false, moving: true })` is "Wait until T has moved, then open it in a new window."
      - Each op gives null when its own flag is false, whatever the other flag is.
      - `leaveRefusal` gives its message for an API whose `unsent()` is 1, and null for 0 or for no API.
      - Task 15 runs both with real input.
    - **The phone hook (`tests/right-phone-component.test.mjs:587-600`, rewritten).** It still reads ChatPane's source, now in `send()`'s handling of `done`, and checks the same three things: `chatQueued` appears once, it runs only when the item is still in `turnQueue.items`, and it comes after the composer is cleared.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(threads): per-thread send API reusing the pane's own pipeline`.

### Task 13: The rich draft editor

**Files:**
- Create: `src/RichDraftEditor.tsx`
- Test: `tests/rich-draft-editor-browser.test.mjs`

**Interfaces:**
- Consumes: Task 9.
- Produces: `RichDraftEditor(props: { doc: DraftDoc; onChange(doc: DraftDoc, caret: Caret): void; caret: Caret | null; chip(token: Token): { label: string; title: string; problem?: boolean; flash?: boolean; busy?: boolean }; draftId: string; names: DraftNames; known: { thread(id: string): boolean; file(id: string): boolean }; onAttachFiles(files: File[], at: Caret): void; onTrigger(kind: "#" | "@", query: string, at: DOMRect): void })`. Copy and cut pass `names` to `encodeClipboard`, so the plain text reads `#Linux Desktop App`, not an id.

**Behaviour:**
- **Structure.** One `div[contenteditable]`, one block per line. Chips are `span[contenteditable=false][data-token]`. A `busy` chip (a file still being read, Task 16) has `aria-busy="true"` and a spinner where its thumbnail goes.
- **Input.** `beforeinput` decides every edit, and Backspace or Delete next to a chip removes the whole chip.
- **Undo.** The editor keeps its own undo stack (≤ 100 snapshots) for ⌘Z and ⇧⌘Z. Native `historyUndo` and `historyRedo` are prevented.
  - Undo and Redo apply each snapshot through `known`. A chip whose file `known.file(id)` is false is left out, and a step that then leaves the doc as it is gets skipped. So a file whose read failed can't come back through history (Task 16, Review Focus 16). Thread chips stay, and show as unresolved if their thread has gone (Task 11).
  - Both stacks start empty when `draftId` changes, so ⌘Z after a Send can't bring back what was sent.
- **IME.** Between `compositionstart` and `compositionend` the DOM is never rewritten.
- **Copy and cut** write `text/plain` and `application/x-apex-deck-draft+json`.
- **Paste:**
  - A payload from the same draft whose ids are all known gives tokens.
  - Anything else gives plain text.
  - `clipboardData.files` with images go to `onAttachFiles`.
- **Chip drag.** Dragging a chip drops it at `document.caretRangeFromPoint`. It moves by default and copies with ⌥.

- [ ] **Step 1: Write the failing scenario** (real keys; synthetic clipboard events only).
  - Type `hello` after a thread chip, then press Backspace six times. The chip is gone, and the doc is `[[]]`.
  - ⌘Z brings back the chip and `hello`.
  - **History and unknown files.** Insert an `f1` chip, type `x`, then delete the chip. Make `known.file('f1')` false. ⌘Z doesn't bring the chip back, and stops at the doc as it was before the chip went in. ⇧⌘Z doesn't bring it back either.
  - Changing `draftId` empties both stacks: ⌘Z then changes nothing.
  - **IME:**
    - Dispatch `compositionstart`, `insertCompositionText` with `に`, then `compositionend` next to a chip.
    - The chip count is unchanged, and the text holds `に` once.
  - **Clipboard:**
    - A synthetic copy, then paste on line 2, gives a second chip with the same `fileId`.
    - Pasting plain `Image1` stays text.
  - Dragging a file chip between two words moves it there.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.** Port `real-app.js:richText`, `richCaret`, `placeRichCaret`, `syncRichEditor` and `makeChip`, and the copy, cut, paste and drag handlers.
- [ ] **Step 4: Run** the scenario, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(threads): rich draft editor with atomic chips`.

### Task 14: The multi-thread composer

**Files:**
- Create: `src/MultiComposer.tsx`
- Modify:
  - `src/ComposerDock.tsx`: show `MultiComposer` when `useMultiDraft().on`.
  - `src/composerMenu.ts:29` and `src/ChatPane.tsx` (menu items): the `#` trigger in a thread's own composer.
  - `src/PaneHead.tsx`: add the `route` prop.
  - `src/styles.css`
- Test: `tests/multi-composer-browser.test.mjs`, with stub `ThreadSendApi`s.

**Interfaces:**
- Consumes: Tasks 9–13.
- Produces:
  - `MultiComposer(props: { draft: ReturnType<typeof useMultiDraft>; threads: Map<string, ThreadInfo>; onFlash(paneIds: string[]): void; routeRequest?: { paneId: string; anchor: DOMRect; seq: number } })`
  - `PaneHead` prop `route?: { label: string; problem: boolean; onOpen(anchor: DOMRect): void }`

**Behaviour (approved, from the mockup):**
- **Selection.** Selecting panes adds one tag per line, in click order, with the caret after the first tag. Deselecting a pane whose line has text shows "Removed · Undo".
- **`#` picker:**
  - With no query, it lists only the tagged threads, each greyed out with "✓ tagged".
  - Typing also lists other threads under "Other threads · adds to selection".
  - Rows show the project name, never ids. Same-titled threads add their agent names.
  - Rows use the real ⋯ menu row styles.
  - A thread popped out into its own window is listed but disabled, with "In its own window". A tagged thread that pops out turns its chip unresolved with the title "<title> is in its own window. Send to it there." (Review Focus 2). Its window owns its composer and its queue (Task 8), and a second queue for the same thread here would post past it.
- **`@` picker.** It lists the agents of the caret line's threads.
- **`#` in a thread's own composer** (single mode) opens the same picker.
  - Picking a thread moves the whole draft or nothing. A thread's own draft can hold text, TL;DR, pictures and quotes:
    - **A multi-thread message is already waiting** (kept after Esc or a click outside, so `doc` isn't empty): nothing moves. The picker says "A multi-thread message is waiting. Open it to add this thread there." and has an **Open it** button, which turns multi on with the kept draft as it was. The thread's own draft, the kept draft and the kept draft's pictures are all unchanged. Merging the two drafts was the other choice; it could quietly send old lines along with the new one.
    - **Pictures or quotes in it:** nothing moves, and the picker says "Send or remove this thread's pictures and quotes first, or ⌘-click panes to start a multi-thread message." The tray only keeps each picture's path on this thread's machine (`Attachment`, `src/attachments.ts:7`). That isn't enough to send the picture to a thread on another machine. A quote names this thread's agents, so it can't go elsewhere either.
    - **Otherwise:** the text moves into the multi draft, with the picked tag where `#` was typed, and the multi draft's TL;DR takes the thread's TL;DR. The thread's composer is then cleared with `api.clearDraft()`. Both changes land in one React update, so no render shows the text in both places or in neither.
  - Only tagged threads receive the message (`real-app.js:applyThreadPick`). For example, `please check this #Lin` + Linux Desktop App sends "please check this" to that thread.
  - This needs `#` in `findTrigger` (`src/composerMenu.ts:29`) and four new `ChatPane` props:
    - `tagThreads: { paneId: string; hostId: string; title: string; project: string }[]`, the picker rows
    - `onTagThread(fromPaneId: string, picked: { paneId: string; hostId: string }, draft: { text: string; tldr: boolean }, triggerStart: number, triggerEnd: number): void`, which App turns into the multi draft. ChatPane only calls it when `multiWaiting` is false and its tray and quotes are empty.
    - `multiWaiting: boolean`, true while multi is off and the kept `doc` isn't empty
    - `onOpenMulti(): void`, for the Open it button
  - App checks `multiWaiting` again when `onTagThread` arrives, and drops the call if it has become true. Nothing moves then.
- **A thread asks for its composer** (`onWantComposer`, Task 8). Quote, Add to chat and the other actions that fill a composer can happen in a pane while multi is on: a plain click inside the selection doesn't leave it.
  - Multi turns off with the draft kept, as Esc does, and the dock shows that thread's own composer with the quote or text.
  - The note "Your multi-thread message is kept. ⌘-click panes to get it back." shows, as after Esc.
  - Nothing is added to the multi draft. Quotes name one thread's agents (see above), so they can't go in it, and a file path added to chat belongs to one thread's project.
- **Only the thread chips (the user, 2026-11-10).** No thread rows sit above the box.
  - **To line.** It shows `summaryLine(...)`, with no ▾ and nothing to open.
  - When there are problems other than `empty`, the To line names the first one in red, e.g. `To 1 thread · duplicate: Thread A`. The chips and title bars show where.
- **Agent menu `→ Null ▾`.** It appears on selected panes' title bars only, drops from the title bar, and lists only that thread's agents. A pick, Esc or a click elsewhere closes it. Reopening multi-send never replays an old click.
  - A pick sets that slice's `to` for this send only (D1). The slice goes into the thread's queue as a one-off item (Task 11a; `admit` with `to`, Task 12), so the thread's default is the same afterwards. The title bar keeps showing the pick until the send.
  - On a machine where `api.canPickAgent` is false, the menu is greyed, with the tooltip "Update <machine> to pick an agent for one send. Typing @name still works."
  - For a thread with an unknown typed `@muck`, picking Null rewrites that mention in the draft to `@Null`, visibly. This is typed text, so it routes, and changes the default, the way typing `@Null` always has.
- **Send:**
  - One click when there are no problems.
  - Send is disabled for any problem except `empty`.
  - With `empty`, Send stays enabled. Clicking it shakes the button and flashes each empty thread's pane and tag red for about 1.2 s (`real-app.js:rejectEmptySlices`, `flashMissing`). Nothing is sent.
  - While a file is being read (`file-reading`, Task 16), Send is disabled with the title "Reading shot.png…", and comes back by itself when the read finishes.
  - While a batch has a failed slice, Send is disabled with the title "Retry or discard the failed batch first." (`real-app.js:2622`). It comes back once that batch is retried or discarded (Task 15).
  - A click or Enter claims the batch at once, and Send takes the draft in that same step (Task 15). Enter sends only on a fresh press: an Enter `keydown` with `repeat` set does nothing.

- [ ] **Step 1: Write the failing scenario.**
  - Select four panes and type the four-line example. Then Send. The stubs receive:
    - A: `submit` with `what is the status`
    - B: `submit` with `@Muck run the dev server`, `to: null`
    - C: `submit` with the plan text
    - D: `command('compact')`, and no `submit`
  - Before sending, the summary text is exactly `To 4 threads · Null ×2, Muck · 1 command`.
  - **Empty line:**
    - Clear line B's text and click Send.
    - No stub is called; `.composer-send` gets the `shake` class; B's pane and chip get `flash`; the button stays enabled.
  - Typing `#A #A` on one line disables Send and gives both chips `.problem`.
  - `#` with no query lists only the four tagged threads, all disabled.
  - Closing a tagged pane gives its chip `.problem` and disables Send. Nothing is posted to it (Review Focus 2).
  - Popping out a tagged pane does the same, and the chip's title is "Linux Desktop App is in its own window. Send to it there." With a query, the `#` picker lists that thread disabled, with "In its own window".
  - In single mode, typing `please check this #Lin` and picking Linux Desktop App gives a multi draft `[[text "please check this ", Linux]]`, and that thread's own composer is empty.
  - The same with TL;DR on: the multi composer's TL;DR is on.
  - The same with a picture in the thread's tray: the message above shows, no multi draft starts, and the thread's text, picture and TL;DR are all unchanged. The same holds with a quote.
  - **A kept multi draft.** Select A and B, type `one` and `two` after their tags, attach a picture on line 2, then press Esc. In C's own composer, type `please check this #Lin` and pick Linux Desktop App.
    - The picker shows the waiting message. The kept `doc` and its picture are unchanged, and C's text is still `please check this #Lin`.
    - Open it turns multi on with exactly the kept lines and picture, and C's draft is still there.
  - **Asking for a composer in multi mode.** Multi on with A and B tagged and text on both lines. Quote a message in A.
    - Multi is off, `doc` is unchanged, the dock shows A's own composer with the quote, and the note shows.
    - The same for Add to chat on text picked in B, and for `INSERT_COMPOSER_EVENT` for B.
  - Picking Null from B's agent menu: B's stub `submit` gets `to: ['null']`. The title bar shows `→ Null` until the send.
  - A stub with `canPickAgent: false`: its title bar's menu button is disabled and has the tooltip.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.** Port `real-app.js:renderComposer`, `openAtPicker`, `applyThreadPick`, `applyAgentPick`, `openAgentMenu`, `syncRoutes` and `syncMultiOutlines`. Don't port `applyThreadPick`'s `state.multiDraft=ui.input.value` when a kept draft exists (`real-app.js:563`): that is the overwrite the kept-draft rule above prevents.
- [ ] **Step 4: Run** the scenario, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Look.** Screenshot the composer, a title bar's open agent menu, the `#` picker and the shake, at both sizes. Compare with the mockup.
- [ ] **Step 6: Commit** with `feat(threads): multi-thread composer`.

### Task 15: Sending, results and failed-only retry

**Files:**
- Create: `src/multiSend.ts`
- Modify:
  - `src/MultiComposer.tsx`: Send claims the batch.
  - `src/ComposerDock.tsx`: the batch bar.
  - `src/App.tsx`: `useMultiBatches`, and `dock.since`.
  - `src/ChatPane.tsx:1806-1807,4132-4134,4146`: the Send guard for when this composer takes the multi composer's place.
- Test:
  - `tests/multi-send.test.mjs` (unit, fake APIs)
  - `tests/multi-composer-browser.test.mjs` (extend, with stubs held back until the test releases them)
  - `tests/composer-dock-browser.test.mjs` (extend, real ChatPanes)
  - `tests/e2e/thread-slices.e2e.mjs` (fixture daemon)

**Interfaces:**
- Consumes: Tasks 10, 11, 11a, 12 and 14.
- Produces:
  - `interface BatchSlice { paneId: string; hostId: string; title: string; command: Slice["command"]; payload: SlicePayload | null; state: "sending" | "queued" | "sent" | "failed"; ref?: QueueRef; reason?: string; sendAgain?: boolean }`
    - `payload` is frozen when Send is clicked and holds everything: text, routing, the files with their bytes, `to` and `tldr`. It is `null` for command slices, which need only `command`.
    - `ref` names the exact queue and item, and `hostId` the machine of the API it was sent through. `startBatch` sets both in the click, so every slice has them. Re-submitting the slice, by Retry of a `closed` slice or by Send again, replaces both together, from the API it goes through. A slice that keeps its queue keeps its `hostId`, even after a move: the machine only words an uncertain slice (Retry, below).
  - `type SendApis = ReturnType<typeof useSendApis>` (Task 12), with `get` and `subscribe`
  - `freezeBatch(slices: Slice[], files: Map<string, PendingFile>, tldr: boolean): BatchSlice[]`. Pure and synchronous. Every slice starts as `sending`. It throws if a slice's file has no bytes yet. That can't happen from the composer, which disables Send while a file is being read (Task 16), so a throw means a bug, and it comes before the draft is taken.
  - `startBatch(batch: BatchSlice[], apis: SendApis, changed: (batch: BatchSlice[]) => void): void`. It calls each slice's `submit` or `command`, which give the slice its place in its thread's queue and return its `ref` (Task 12), starts watching it, and returns. Nothing in it awaits. `changed` is called each time a slice's state changes.
  - `retryFailed(batch: BatchSlice[], apis: SendApis): Promise<BatchSlice[]>`. It reads only `batch`, never the draft, which Send already took.
  - `sendAgain(batch: BatchSlice[], paneId: string, apis: SendApis): Promise<BatchSlice[]>`, for slices marked `sendAgain`
  - `useMultiBatches(apis: SendApis): { batches: BatchSlice[][]; start(batch: BatchSlice[]): void; retry(): Promise<void>; discard(): void; giveUp(): void; sendAgain(paneId: string): Promise<void>; sending: BatchSlice[]; failed: BatchSlice[] }`. App keeps it. `batches` holds every unfinished batch, oldest first. `start` calls `startBatch`, `retry` and `discard` act on the failed slices of every batch, and `giveUp` on the slices still `sending`. Like `useMultiDraft`, it keeps its state in a ref, so a click handler reads `failed` as it is now, not as of the last render.
  - `ChatPane`'s `dock` prop (Task 8) gains `since: number`: when the dock last stopped showing the multi composer.
  - `MultiComposer` (Task 14) gains the prop `batches: ReturnType<typeof useMultiBatches>`, and its Send goes through the steps below instead of calling the stubs one by one.

**Send claims the batch in the same click (Review Focus 15).** A slice can take minutes to resolve, because an idle agent's post is awaited inside the queue's drain (`turnQueue.ts:113`), and `room_compact` and `room_curate` return only when the model has finished (`crates/apex-host/src/host.rs:2639,2689`). Revision 4 cleared the draft only after that, so a second click sent the whole batch again, and anything typed meanwhile was cleared with it. Now the click handler, and Enter, do all of this before their first `await`:
1. Read the draft with `draft.current()` (Task 10), never from the render. A second click that lands before React renders again then sees what the first one left.
2. Plan it, and refuse as Task 14 says: the shake for `empty`, and nothing for any other problem, or while a batch has a failed slice, since Send is disabled then.
3. Freeze the batch with `freezeBatch`, file bytes included.
4. Call `draft.take()`, which empties the draft and turns multi off.
5. Call `batches.start(batch)`. Each slice takes its place in its thread's queue here, so when the click handler returns, every slice is ahead of anything sent to its thread after the click (Task 12, Review Focus 17).

So a second click, or Enter, finds an empty draft and sends nothing. Anything typed after the click goes into a new draft that the batch never touches, and nothing clears it later: the draft the batch came from is already gone. When nothing fails, the person sees what revision 4 showed once a batch had finished, only straight away: no selection, and the focused thread's own composer in the dock, holding that thread's own draft.

**The composer that takes its place.** It appears under the pointer, with its Send where the multi composer's was, and it may hold a draft of its own.
- For 600 ms after `dock.since`, that composer sends nothing, by click or by Enter. The click half is the guard its Send button already has for Stop turning into Send (`flippedAt`, `ChatPane.tsx:1806-1807,4146`), now also started by the swap.
- An Enter `keydown` with `repeat` set never sends, in this composer (`ChatPane.tsx:4132-4134`) or in the multi composer.
- So the second click of a double-click, a quick second Enter or a held Enter can't send that thread's own draft.

**Where batches live.** `MultiComposer` unmounts when multi turns off, so it can't hold a batch. App keeps every unfinished batch in `useMultiBatches`, oldest first. The dock shows one bar for all of them, above whichever composer it shows. The mockup also keeps its failure bar after leaving multi (`real-app.js:2633`).
- If a slice is still `sending` 0.5 s after the click, the bar names what is still sending, for example `Sending to t3 code…` or `Sending to 4 threads…`. A slice is `sending` while its item is `preparing`: it waits for its turn behind something still being made in that thread, its files are being saved, or its checks or mod hook are running. The line goes away once no slice is `sending`, so most sends never show it. A slice behind a long `/compact` or `/curate` is already in its queue, so it is `queued`, not `sending`, and the bar says nothing about it (Task 12).
- Once a slice has been `sending` for 10 s, that line also offers **Stop waiting**. It calls `api.giveUp(ref)` for each slice still sending, and each becomes `failed` with "Stopped waiting for <title>. Retry tries again." That works whatever the slice is waiting for, its turn included (Task 12). Until then, everything sent to that thread after the click waits behind it, including the thread's own composer.
- Failures read as in the rules below, counted across batches. Retry and Discard act on all of them, oldest batch first.
- While any batch has a failed slice, the multi composer's Send is disabled (Task 14), and ⌘-click and `#` don't start a new multi draft (end of the rules). A multi draft started while a batch was still sending keeps its text. This is the approved mockup's rule (`real-app.js:2622`), not what keeps order. A batch sent before the failure is already in its threads' queues, and each queue holds its slices behind the failed one until Retry or Discard (Task 12).

**Rules:**
- Every slice has its `ref` from the click and follows `api.watch(ref)`:

  | Item state | Slice |
  | --- | --- |
  | `preparing` | `sending` |
  | `waiting`, `posting` | `queued` |
  | `posted` | `sent` |
  | `failed` | `failed`, with Retry. A post that failed, a slice that failed before it was made, such as a picture that couldn't be saved, or a message refused just before it posted (Task 12). Each holds back what came after it in that thread. |
  | `removed` | `failed` with `sendAgain: true`: "Removed from <title>'s queue. Send again sends it once more." |
  | `unknown` | `failed` with `sendAgain: true`: "Check <title>: it may have arrived. Send again sends it once more." |
  | `closed` | `failed`, with Retry: "<title> closed before this was sent. Retry sends it." Its queue closed before posting it, so it never left Deck. |

  So the batch follows what the person does in the thread itself. After the thread's own Retry, the slice goes back to `queued` and then `sent`, and after Remove it says so.
- **A pane closes or reopens (Review Focus 18).** The batch keeps watching the old queue after the pane's API unregisters, until each slice there has ended. Closing ends them (Task 12): what the queue never posted reads `closed`, and a post already on its way ends as `posted`, or as `unknown` if it fails. So nothing the old queue held can post later, and the batch knows which slices may have arrived. `apis.subscribe` tells the batch whether the thread is open now, which decides what Retry can do. Revision 6 marked every unfinished slice `sendAgain` here. That left the person to check by hand, and it didn't stop the old queue from posting.
- **A thread pops out or moves (D11, Review Focus 21).** Neither can start while the thread's queue holds anything, so no slice of an unfinished batch is in it then (Task 12). Neither can start while the other runs, and a thread open in its own window can't move at all. From the click on Pop out, `apis.get` has nothing for that pane, so Retry and Send again wait for it to come back to this window. A thread that moves keeps its queue. A slice sent to it while it moved is refused in place, and Retry makes it on the new machine.
- When some slices fail, the bar keeps the batch, for example `1 of 4 didn't send: t3 code — Retry · Discard · Show`. Nothing in any composer changes when a batch finishes: Send already took the draft.
- The batch keeps every slice's frozen payload and `ref` until it is resolved: every slice is `sent`, or the person clicks Discard. Then it releases them and revokes their thumbnails' object URLs.
- **Discard,** for each `failed` slice: stop its watch, then call `api.remove(ref)`. The item leaves its thread's queue, as it does with the thread's trash button, so the thread is never left holding a failed item the batch has forgotten.
  - A slice that failed before it was made then lets what it held go at once.
  - After a failed post, the thread keeps today's rule: what waits behind it for the same agents stays paused, with Resume (`turnQueue.ts:244`, `ChatPane.tsx:3975`), because that message may have arrived.
  - A slice whose pane is closed or popped out, or whose `ref` names another queue, has nothing to remove.
- **Retry,** for each `failed` slice. The item's own state decides. The machine only changes what an uncertain slice says (revision 8, finding 3).
  - **No API for its pane** (closed, or popped out, D11): it stays failed, with "Open <title> in this window to retry."
  - **Its `ref.queue` is `api.queue`:** it goes by `api.status(ref)`. That holds whatever machine the thread is on now. A thread that moves keeps its queue (D11), and a slice refused while it moved is made again on the new machine.
    - `failed`: `api.retry(ref)`. A failed post goes back to `waiting`. A slice that failed before it was made is made again in its place, with its files saved again from the frozen bytes, so it reads `preparing` and the slice `sending`. Either way it follows its watch.
    - `preparing`, `waiting` or `posting`: it was already retried in the thread. Nothing is sent; it follows its watch.
    - `posted`: it is `sent`. Nothing is sent.
    - `removed` or `unknown`: nothing is sent, and it is marked `sendAgain` as in the table above.
  - **Its `ref` names another queue,** because its old queue closed with its pane. It goes by what the old queue says:
    - `closed`: Retry re-submits it through the pane's current API, the frozen payload with `submit` or the command with `command`. The slice then takes **both** its new `ref` and `hostId = api.hostId`. It never left Deck, so this can't send it twice. The payload carries its own bytes, and they are saved on whichever machine has the thread now. Retry acts oldest batch first, so two such slices for one thread keep their order. If this re-submission fails in its turn, the next Retry finds it in `api.queue` (above), whatever machine that is.
    - `unknown` (its post failed, or was on its way, when the pane closed): nothing is sent. It stays failed with `sendAgain: true`. The message is "<title> moved to another machine. Check it there before sending again." when `api.hostId` differs from the slice's `hostId`, and otherwise "Check <title>: it may have arrived. Send again sends it once more." The queue said a lost acknowledgement may already have committed (`turnQueue.ts:138-139`), so only the person can decide.
    - `posted`: it is `sent`.
  - `queued` and `sent` slices are never sent again.
- **Send again** re-submits one slice's frozen payload after the person has checked the thread. Like Retry of a `closed` slice, it sets `ref` and `hostId` together, from the API it went through.
- While a failed batch is waiting, ⌘-click and `#` don't start a new multi draft. They say "Retry or discard the failed batch first. Your own draft is kept." (`real-app.js:toggleMulti`, `applyThreadPick`)

- [ ] **Step 1: Write the failing tests.**
  - **Unit:**
    - Four fake APIs. C's `submit` returns its ref, and C's watch then reports `failed` with `host offline`.
    - The states are `queued, queued, failed, queued`, and the reason is `host offline`.
    - `retryFailed` calls only C's `retry`, and never `submit`.
    - A, B and D are each called once in total.
    - A slice whose watch says `waiting` counts as `queued`, and one whose watch says `preparing` counts as `sending`. `retryFailed` calls neither (Review Focus 3).
    - **Complete payload:** C's slice has a picture and TL;DR on, and Send has taken the draft. After C's pane reopens, `sendAgain` gives C's `submit` the same bytes, file name, text, routing, `to` and `tldr: true`. A Retry in the same queue saves the same bytes again (Task 12).
    - **Discard:** with C failed, `discard()` calls C's `remove(ref)` once and stops C's watch, so a later `removed` from it changes nothing. A, B and D are not touched.
    - **Stop waiting:** C's watch stays `preparing`. `giveUp()` calls C's `giveUp(ref)` and no one else's. When C's watch then reports `failed`, the reason reads "Stopped waiting for t3 code. Retry tries again."
    - **Retried in the thread:** C's watch reports `failed`. Then C's queue `retry(id)` is called directly, as the thread's Retry button does, and the post succeeds. C becomes `sent` with no batch action, `changed` was called, and a later `retryFailed` calls nothing for C.
    - **Removed in the thread:** C's failed item is removed from its queue. C shows "Removed from t3 code's queue. Send again sends it once more." with `sendAgain: true`, and `retryFailed` sends nothing for it.
    - **Pane closed (Review Focus 18):** C is `queued` behind a working agent. C's API unregisters, and C's watch reports `closed`. C becomes `failed` with "Delegate Refactor closed before this was sent. Retry sends it." Nothing is sent by itself.
      - While no API is registered for C's pane, `retryFailed` sends nothing for C and says "Open Delegate Refactor in this window to retry."
      - Once a new API registers, with a different `queue` and a different `hostId`, `retryFailed` calls its `submit` once with C's frozen payload. C takes the new `ref` and the new API's `hostId` together, and follows that `ref` to `sent`. A, B and D aren't touched.
    - **Pane reopened after a failed post:** C's post failed in queue q1, which then closed, so C's watch reports `unknown`. C's API now reports `queue: 'q2'`, whose own item 1 is failed too. `retryFailed` calls neither `api.retry` nor `submit` for C, and C ends `failed` with `sendAgain: true`. Then `sendAgain` calls C's `submit` once, with the frozen payload.
    - **Thread moved (D11).** C was refused in place while its thread moved. It is unmade, with the reason "Not sent: t3 code is moving to Hetzner." C's API now reports `hostId` B and the same `queue`. `retryFailed` calls C's `retry(ref)` once and never `submit`. C's watch then reports `preparing`, then `posted`, and C ends `sent`. No reason names a move.
    - **Uncertain on the old machine.** C's post failed in queue q1 on A, and q1 then closed, so C reads `unknown`. C's API reports `queue: 'q2'` on B. `retryFailed` sends nothing for C. The reason is "t3 code moved to another machine. Check it there before sending again.", with `sendAgain: true`.
    - **Re-submitted, then failed (Null's third revision-7 finding).** C reads `closed` in q1 on A, and its pane reopens as q2 on B. `retryFailed` calls q2's `submit` once, and C's slice now has `ref.queue` q2 and `hostId` B. q2's watch then reports `failed`. A second `retryFailed` calls q2's `retry(ref)` once and sends nothing else, and no reason names a move. `sendAgain` likewise leaves `ref` and `hostId` both from the API it used.
    - **Popped out (D11).** While C's pane is hidden (popped out), `apis.get` returns nothing for it. `retryFailed` and `sendAgain` send nothing for C, and the reason is "Open t3 code in this window to retry."
    - **Release:** once every slice is `sent`, the batch is resolved, its watches are stopped, and the stub `URL.revokeObjectURL` was called for each thumbnail.
    - `freezeBatch` with a file whose `bytes` is `null` throws, and no API is called.
  - **Scenario (`tests/multi-composer-browser.test.mjs`).** The four-line example with `/curate` on D's line instead of `/compact`. Every stub's slice stays `preparing` until the test releases it (Review Focus 15):
    - **Two clicks in one task.** Call `click()` on Send twice with no `await` between them. Each stub's `submit` or `command` was called exactly once. From the same draft again, two Enter `keydown`s in the editor with no `await` between them do the same.
    - Straight after the click, the multi composer is gone and no pane has `.multi-selected`. 0.5 s later the bar reads `Sending to 4 threads…`.
    - **Typing while the slices start.** ⌘-click A and B, and type `next` after A's tag. Then release the stubs, D's last. The new draft still holds `next` and both tags, no stub received `next`, and the bar has gone.
    - **Stop waiting.** With C's slice held `preparing`, on a fake clock: the bar's sending line has no Stop waiting at 9 s and has it at 10 s. Clicking it calls C's `giveUp(ref)`. Once C's stub reports `failed`, the bar reads `1 of 4 didn't send: Delegate Refactor — Retry · Discard · Show`, and Show gives "Stopped waiting for Delegate Refactor. Retry tries again."
    - **A failure after a new draft started.** The same, but C's watch reports `failed` once the new draft exists. The bar reads `1 of 4 didn't send: Delegate Refactor — Retry · Discard · Show`. The new draft is unchanged, and its Send is disabled with "Retry or discard the failed batch first." Retry calls C's `retry` once. Once C's watch reports `posted`, the bar goes and the new draft's Send is enabled.
  - **Real thread composers (`tests/composer-dock-browser.test.mjs`, Task 8's harness):**
    - ChatPanes A and B, with `own text` in A's own composer. Start a multi draft on A and B with `one` and `two`, then double-click Send with real input events: click counts 1 and 2, 150 ms apart. A's composer is back in the dock, still holding `own text`, and the in-memory service received exactly one `room_post_to` per room, `one` and `two`.
    - The same with Enter, followed by Enter `keydown`s with `repeat` set, then a fresh Enter 200 ms later.
    - 700 ms after the swap, a click on A's Send sends `own text`. The guard covers only the gesture that sent.
    - **The thread's own composer goes after the slice (Review Focus 17, Null's first case).** `own text` is in A's own composer. Send a multi draft whose line for A holds a picture, with A's `save_attachment` held back. 700 ms after the swap, click A's Send: it is disabled with "Sending…" until the save is released. Then A's transcript gets the slice's message, then `own text`.
    - **A later batch waits behind a failed slice (Review Focus 17, Null's second case).** Send batch 1 with a picture on A's line and `b1` on B's, with A's `save_attachment` held back. ⌘-click A and B again, type `two` on A's line and `b2` on B's, and Send. It is enabled, since batch 1 has no failure yet. Then fail A's save.
      - B's transcript gets `b1`, then `b2`. A's gets nothing.
      - A's queued list shows batch 1's slice as "Didn't send" and `two` waiting behind it, and the bar reads `1 of 2 didn't send: A — Retry · Discard · Show`.
      - Retry, with the save now succeeding: A's transcript gets batch 1's message, then `two`.
      - In a second run, Discard instead: A's transcript gets only `two`, and A's queued list is empty.
    - **A pane closed while its slice is on its way (Review Focus 18, Null's first revision-6 case).** Send a batch whose A line holds a picture and whose B line is `b1`, with A's `save_attachment` held. Close pane A with ×.
      - The bar reads `1 of 2 didn't send: A — Retry · Discard · Show`, and Show gives "A closed before this was sent. Retry sends it." Retry says "Open A in this window to retry."
      - Open A again from the sidebar and click Retry: A's transcript gets the message once.
      - Release the old save: A's transcript still has it once, and the in-memory service received one `room_post_to` for A in all.
    - **Stop waiting behind a command still starting (Review Focus 20, Null's third revision-6 case).** A's own composer sends `/curate`, with A's `room_targets` for `/curate` held. Then send a batch whose A line is `hi`.
      - 10 s later the bar offers Stop waiting. Clicking it gives `1 of 1 didn't send: A — Retry · Discard · Show`, and Show gives "Stopped waiting for A. Retry tries again."
      - Release the lookup: A runs the curate, and `hi` doesn't post. Retry: `hi` posts after the curate.
    - **Sent behind a long command.** With A's `room_curate` held, send a batch with a line for A. 0.5 s later the bar shows no `Sending to A…`, and A's queued list shows the slice waiting. Release the curate: the slice posts.
    - **Pop out while a slice is being made (D11, Review Focus 21, Null's first revision-7 case).** Use the stub `window.apexDeck.popout` bridge from Task 8.
      - Send a batch whose A line holds a picture, with A's `save_attachment` held. Click A's ⋯ → Pop out. The toast reads "Wait until A has sent what's waiting, or remove it, then pop it out." The bridge's `open` was never called, and A is still in the map.
      - Release the save: A's transcript gets the slice. Pop out again: `open` is called once.
      - A ChatPane mounted with the pop-out's props for A then sends `there`. A's transcript has the slice, then `there`, and the in-memory service received exactly two `room_post_to` for A.
      - The same toast shows for a single thread with a message queued behind a working agent, and for a drag out of the window.
    - **Popped out from the click (D11).** Hold the stub bridge's `open`, and click Pop out on A with an empty queue. In the same task, ⌘-click A: A isn't added to a multi draft. A `#` picker opened then lists A as "In its own window", and `apis.get('A')` is undefined. Reject `open`: A is back, and ⌘-click adds it.
    - **Pop out while the thread moves (D11, Null's first revision-8 finding).** Two in-memory machines, A and B, and an unstarted thread T in project P1 on A. Hold B's `room_import`, then pick P2, a project on B, in T's work bar.
      - Click T's ⋯ → Open in new window. The toast reads "Wait until T has moved, then open it in a new window.", and the stub bridge's `open` was never called. Dragging T's title bar out of the window gives the same toast.
      - Release the import. The move lands, and A no longer has T. Open in new window now calls `open` once, with `hostId` B in its snapshot.
      - A ChatPane mounted with that snapshot's props sends `there`. B's transcript has it, and A never received a `room_post_to` for T.
    - **Move while popped out (D11).** Pop T out, with `open` held. T's sidebar ⋯ → Project › rows are greyed with "Close T's external pane to return it to Deck first." They stay greyed once `open` resolves, and neither machine has received `room_import`.
      - Close T's window: the stub fires `onClosed`. The rows are live again, and picking P2 moves T to B.
      - In a second run, T has started. Its rows are greyed the same way while it is popped out, so no "Open it somewhere else" prompt opens in its hidden copy.
  - **e2e** (fixture daemon, two rooms with scripted agents):
    - Send `#R1 one` and `#R2 two`.
    - R1's transcript has exactly one human message, `one`. R2's has exactly one, `two`.
    - `#R1 /compact` makes R1 run a compact turn and adds no human message.
    - **One-send pick (D1, D12):** R1's default is Muck. Send `#R1 one` with Null picked from the agent menu. Null answers, R1's human message reads `@null one`, and afterwards `roomTargets(R1, "")` is still `["muck"]`. A follow-up untagged single-thread message in R1 goes to Muck (Review Focus 6).
- [ ] **Step 2: Run and check it fails.** Run `node --experimental-strip-types --test tests/multi-send.test.mjs`, the two browser tests above, then `npm run test:e2e`.
- [ ] **Step 3: Implement.** Port `real-app.js:sendMulti`, `deliverMockSlice`, `finishMockBatch` and `retryFailed`, replacing the mock delivery with the real APIs. `finishMockBatch` clears the draft once delivery is over. Here that clearing moves to the click, as `take()`, and so does each slice's place in its thread's queue: nothing between the click and `batches.start` awaits.
- [ ] **Step 4: Run** the unit, browser and e2e tests above, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(threads): send slices, keep failures, retry only those`.

**Milestone 3 done when:**
- It is reviewed and merged with the user's OK.
- The user has sent a four-line multi-send in throwaway threads with scripted agents.

---

## Milestone 4 — Pictures in lines (branch `feat/line-images`)

### Task 16: Image chips in the multi composer

**Files:**
- Modify:
  - `src/MultiComposer.tsx`
  - `src/useMultiDraft.ts`: files, an undo memory kept until send or clear, the draft generation, and deleting a file whose read fails.
  - `src/styles.css`
  - `desktop/files.mjs`: `snapshotFile`
  - `desktop/main.mjs:541`: a `shell:snapshotDrop` handler beside `shell:readLocalFile`
  - `desktop/preload.cjs:18-27,96-110`: the drop listener keeps recent dropped paths; `shell.snapshotDrop`
  - `src/electronShell.ts:70-71,216` and `src/backend.ts:201,940`: `snapshotDrop` on the shell and the backend, and a stub in the in-memory backend
- Test:
  - `tests/desktop-files.test.mjs` (extend, real temp files)
  - `tests/multi-composer-browser.test.mjs` (extend)
  - `tests/finder-drop-electron.test.mjs` (new, on `tests/helpers/electron-test.mjs`)
  - `tests/e2e/thread-slices.e2e.mjs` (extend, with two hosts as in `tests/e2e/multi-host.e2e.mjs`)

**Interfaces:**
- Consumes: `PendingFile` (Task 12); `fileIds`, `readableText` and `fileReference` (Task 9); `RichDraftEditor.onAttachFiles` (Task 13); `Backend.onFileDrop` (`src/backend.ts:201`).
- Produces:
  - `RichDraftEditor` gains `caretAt(x: number, y: number): Caret | null`, which maps `document.caretRangeFromPoint` into the token model, so a drop can land between words.
  - `type DropSnapshot = { kind: "file"; name: string; bytes: Uint8Array } | { kind: "folder"; name: string } | { kind: "too-big"; name: string }`
  - `snapshotFile(file: string, limit: number): Promise<DropSnapshot>` in `desktop/files.mjs`. It runs `fs.promises.stat` first: a directory gives `folder` and a size over `limit` gives `too-big`, and neither reads the file. Otherwise it reads the file once.
  - `Backend.snapshotDrop?(path: string): Promise<DropSnapshot>`, desktop only, from `shell.snapshotDrop`. It always reads this Mac's file, whichever machine the thread is on. Main answers it with `snapshotFile(path, 20 MB)`.
  - The preload's drop listener keeps the paths of real drops from the last 60 seconds in its own scope, which the page can't reach. `snapshotDrop` refuses any other path with "Only a file dropped on this window can be read." Without that, the page could read any file on this Mac. (A synthetic drop can't add a path: `webUtils.getPathForFile` gives `""` for a file that isn't on disk.)

**Finder drops.** The preload takes every Finder file drop for the whole window (`desktop/preload.cjs:18-27`). It reads the paths, calls each subscriber with `(paths, x, y)` and stops the event, so DOM `drop` handlers never see files from Finder. Each ChatPane subscribes and keeps only drops on its own composer (`ChatPane.tsx:2531-2557`). In multi mode, no thread composer is mounted, so without a subscriber of its own a drop on the multi composer would silently do nothing.
- `MultiComposer` subscribes with `backend.onFileDrop` while it is mounted, and keeps only drops inside the dock's box.
- The drop point is worked out at the drop: `caretAt(x, y)`. If the point isn't over a line, it is the current caret, or else the end of the last line.
- **Each path is read once, at the drop,** with `backend.snapshotDrop(path)`. The chip goes in at the drop point straight away, marked as reading (see "Reading takes a moment" below), and the read then fills it in:
  - `file`: the chip's `PendingFile` gets those bytes, exactly like a pasted picture, and a picture gets a thumbnail from them. Every destination and every retry sends these bytes, so editing, moving or deleting the original afterwards changes nothing (Review Focus 10). A thread's own composer takes a dropped file at the drop too: it copies it straight away (`ChatPane.tsx:2538`).
  - `folder`: the chip goes, and the composer says "Drop folders into one thread's own composer." Finder paths have no trailing slash, so `isFolder` (`src/attachments.ts:30`, which is for saved folders) can't tell; `stat` can.
  - `too-big`: the chip goes, and the composer says "<name> is over 20 MB."
  - A failed read: the chip goes, and the composer says "Couldn't read <name>: <reason>".
- Pasted and `+` pictures arrive as `File`s. Their size is known before reading, so the 20 MB check now covers every file before anything is sent.

**Reading takes a moment (Review Focus 12).** Revision 3 put a dropped file's chip in only once its read finished. A Send before then went without the picture, and the late read then put the chip into the next, cleared draft. Now every attach works the way a thread's own tray already does (`track`, `ChatPane.tsx:2488`). That covers a Finder drop (`snapshotDrop`), a pasted picture and `+` (both `file.arrayBuffer()`).
- The chip goes in at once, at the drop point or the caret, with its label and `bytes: null`. It shows as busy (`aria-busy`, a spinner where the thumbnail goes). The chip is placed at the drop, so typing during the read never moves where it lands.
- `useMultiDraft` keeps a draft generation, a number that goes up each time the draft is sent (`take()`, Task 10) or cleared. Each read remembers the generation and the file id it started with.
- When the read finishes:
  - If the generation has changed, or the file is in neither the draft nor the undo memory, the result is dropped. Nothing is added, saved or shown.
  - Otherwise the result goes to that file's entry, wherever it is. A chip deleted during the read leaves its file in the undo memory, so ⌘Z still brings back a file with its bytes.
  - A folder, a file over 20 MB or a failed read ends the file for this draft (Review Focus 16). Revision 4 only took its chips out of the doc, but the editor's Undo history, the "Removed · Undo" note and the clipboard still named it. So drop, copy, delete the chip, then a failed read, let ⌘Z or a paste bring back a chip that stayed busy for good (Send stayed disabled) or one that pointed at nothing. Now:
    - Every chip of it leaves the doc, with no undo entry, and its message shows.
    - The file is deleted from the draft's files and from the undo memory, and its thumbnail URL is revoked. `known.file(id)` is false from then on.
    - Undo and Redo leave its chips out (Task 13), and `undoRemove` restores a removed line without them. A paste that holds it goes in as plain text, because `decodeClipboard` sees an unknown file, as for a file removed with × (Task 9).
    - `setDoc` drops the chips of any file the draft doesn't know, whatever wrote them. So a way back that this list misses still can't restore one.
- `take()` hands the draft's files to the batch, which revokes their thumbnails once it is resolved (Task 15). The new draft starts with no files and an empty undo memory.
- While any file on a tagged line is still reading, the planner reports `file-reading` (Task 11), so Send is disabled with "Reading shot.png…" (Task 14). Reads are quick, so Send comes back by itself.

**Rules (approved):**
- **Attaching.** Attaching (with `+`, a pasted picture or a Finder drop) puts an `Image1` chip at the caret, or at the drop point, at once, while the file is still being read. Labels count up and are never reused within a draft.
- **The chip is the attachment.**
  - When a file's last chip leaves the draft, the file goes too: there is no warning and no "unplaced" state.
  - Undo or paste can bring it back until the draft is sent or cleared, unless its read failed.
- **Sharing.** The same chip on two lines means each of those threads gets its own copy.
- **The stack.**
  - Thumbnails 28 px tall sit in the bottom action row, left of TL;DR.
  - Clicking the stack opens a popover above the composer that never covers the text.
  - The composer box is the same height with 0 and 2 files.
- **Not accepted:** folders and files over 20 MB. The messages are "Drop folders into one thread's own composer." and "<name> is over 20 MB."

- [ ] **Step 1: Write the failing tests.**
  - **Scenario:**
    - The `.composer-box` height is the same, ±1 px, with 0 and 2 files at both 1512×945 and 1100×650.
    - Deleting the only `Image1` chip removes its thumbnail; ⌘Z restores both.
    - A pasted picture gives a new chip at the caret.
    - **Finder drops.** A synthetic DOM drop can't stand in: its files have no Finder path, so the preload lets it through. Drive the `onFileDrop` callback the stub backend captured, with a stub `snapshotDrop`:
      - `(['/tmp/shot.png'], x, y)` with the point between two words on line 2 puts a chip there, holding the stub's bytes, with a thumbnail.
      - A point outside the dock adds nothing, and `snapshotDrop` isn't called.
      - A stub answer of `folder` adds nothing and shows "Drop folders into one thread's own composer." A stub answer of `too-big` adds nothing and shows "shot.png is over 20 MB."
      - In single mode, the same drop still reaches the thread's own tray, as today (`copy_attachment`), and `snapshotDrop` isn't called.
    - **A read held back on purpose (Review Focus 12).** The stub `snapshotDrop` returns a promise that the test resolves by hand.
      - Drop `/tmp/shot.png` between two words on line 2. The chip is there at once with `aria-busy`, Send is disabled with "Reading shot.png…", and clicking Send calls no stub.
      - Type on line 2 before the drop point, then resolve the read. The chip is still between the same two words and has its thumbnail. Send is enabled, and Send gives line 2's thread a `submit` whose file holds the stub's bytes.
      - **A late read.** Drop again and leave the read pending. Delete that chip and Send the rest. Then resolve the read: no chip appears in the new draft, the stack is empty, and no `save_attachment` call happens.
      - **Deleted, then undone.** Drop, delete the chip, resolve the read, then press ⌘Z. The chip is back, with its bytes.
      - A read that rejects takes the chip out and shows "Couldn't read shot.png: …".
      - **Failed after it was deleted, then Undo (Review Focus 16).** Drop `/tmp/shot.png` between two words on line 2 and leave the read pending. Copy line 2 with a synthetic copy event, delete the chip, then reject the read. ⌘Z brings no chip back: `fileIds(doc)` is empty, nothing in the composer has `aria-busy`, and Send isn't disabled for reading. ⇧⌘Z doesn't bring it back either.
      - **…then paste.** Paste the copied payload on line 3. It goes in as plain text, no chip appears and the stack stays empty.
      - **Removed with its pane.** Drop on B's line and leave the read pending. ⌘-click B to take its line out, reject the read, then click Undo in "Removed · Undo". B's line comes back without the chip.
      - The Undo case once more, with the stub answering `folder` instead of rejecting.
      - A pasted picture whose `arrayBuffer()` is held back the same way also keeps Send disabled until it resolves.
  - **Snapshot (`tests/desktop-files.test.mjs`, real temp files):**
    - `snapshotFile` of a real folder, named with no trailing slash, gives `{ kind: 'folder' }`.
    - Of a 21 MB file, it gives `too-big`.
    - Of a small file, it gives its bytes. Writing new bytes to the file afterwards doesn't change the bytes it returned.
    - Of a missing path, it rejects, and the message names the path.
  - **Electron (`tests/finder-drop-electron.test.mjs`):**
    - `window.apexDeck.shell.snapshotDrop` of a path that was never dropped, such as `/etc/hosts`, rejects with "Only a file dropped on this window can be read."
    - Make a real Finder-style drop on the multi composer with the DevTools protocol's `Input.dispatchDragEvent` (through `webContents.debugger`), whose `data.files` holds a real temp file. The chip's bytes equal the file's. Overwrite the file, then Send with a scripted agent: the bytes saved on the host are the original ones (Review Focus 10).
    - If this Electron can't make a drop with real paths that way, say so in the task report. Don't replace it with a DOM event, which proves nothing here.
  - **e2e:**
    - Put `Image1` on lines for R1 (on host A) and R2 (on host B), then send.
    - Each host's attachment folder for that room holds the same bytes.
    - Each posted text contains `[Image1: shot.png]` and an `Attached image:` line with its own host's path.
    - The same with a dropped file, through the stub snapshot: `save_attachment` runs once per host with the snapshot's bytes, and nothing calls `copy_attachment`.
- [ ] **Step 2: Run and check it fails.**
- [ ] **Step 3: Implement.** Port `real-app.js:insertAttachment`, `addMockAttachment` (real bytes replace the mock), and the attachment-panel parts of `renderComposer`.
- [ ] **Step 4: Run** the tests, the e2e, `npm test` and `tsc`. Expected: pass.
- [ ] **Step 5: Look.** Screenshot the stack and its popover at both sizes.
- [ ] **Step 6: Commit** with `feat(threads): pictures placed by line`.

**Milestone 4 done when:** it is reviewed and merged with the user's OK, and the user has sent one picture to two threads.
