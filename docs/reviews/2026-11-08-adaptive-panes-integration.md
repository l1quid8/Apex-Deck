# Adaptive panes: Tasks 4–7 integration

Branch: `feat/adaptive-panes`, after foundation commit `d14e0863`.
The committed mockup at `aa2eb6bb` is the design reference and is unchanged.

## Implemented scope

- `PaneMap` connects the reviewed geometry to the real App. Horizontal,
  Vertical, Even grid, Focus left and Focus right have native scrolling,
  whole-line snaps, pointer/active-pane zoom and a resizable Focus divider.
- All listed panes retain one keyed parent across layout changes, sections,
  full screen and pop-out. Offscreen panes keep their state and sessions.
- The five-choice picker saves each section's arrangement. Old split-tree
  sessions migrate; Dashboard placement and pop-out return use pane order.
  New sample, regular and forked panes go first and are revealed.
- Title dragging reorders live, scrolls at the edge, cancels on Escape and
  requests a pop-out when released outside the window.
- The 28px headers shed secondary details, keep title ellipses at rest,
  animate overflowing titles on hover/focus, respect reduced motion and
  preserve menu-triggered Rename. Double-clicking the title maximizes.

## Review corrections

Independent review found issues beyond the initial passing tests. The final
code and regressions cover each correction below:

- Restricted-device session filtering removes `arrangements`, just as it
  removes legacy `layouts`, so hidden thread IDs are not disclosed.
- App's watched/seen attention state follows actual viewport visibility,
  rather than treating every pane in the section as visible.
- A drag interrupted by section/inventory changes cannot write the old
  section's order into the new one. A disappearing Focus divider must not
  leave pane-body input disabled.
- A compact header must not hide or clip a live voice capsule with its
  ordinary artifact/change counts. It now has a separate 24px header slot;
  below 240px, its Mute/End controls move beside the composer. External hosts
  retain their existing placement.

## Verification and acceptance

The pre-correction full JS suite passed 3,516 tests with 5 skipped and no
failures. The restricted-session regression failed before its fix; the
corrected authority module passed all 9 Rust authority tests.

Final combined verification after all corrections:

- `npm test`: **3,519 passed, 0 failed, 5 skipped** (3,524 total), exit 0.
- `npx tsc --noEmit`: exit 0.
- `TMPDIR=/tmp cargo test -p apex-daemon --lib authority::tests::`:
  **9 passed, 0 failed**.
- `git diff --check` and the staged equivalent: clean.
- `git diff aa2eb6bb -- mockups/adaptive-thread-panes.html mockups/adaptive-thread-panes`:
  empty; the committed mockup is unchanged.

The final suite includes five native PaneMap scenarios, the App attention
regression and header controls at 600/350/240/239/190/120px in Classic, Glass
and Clay. The isolated Electron scenarios exercise native input and render
the five layouts at 1512×945 and 1100×650. These are component fixtures, not
installed-build acceptance. Voice controls use synthetic call markup and real
theme styles; no real call was started.

Logs: `/tmp/null-adaptive-final-verified.log` and
`/tmp/null-adaptive-authority.log`. Earlier fixture screenshots:
`/tmp/null-adaptive-shots/`.

The authorized development command was started from the repository root:
`APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
Its Rust build completed and Vite started. Computer Use repeatedly timed out
while binding the Electron app, so the live-window inspection remains
unverified. No installer was made, no installed app was replaced, and no
merge was performed.

## Handoff

Jigga should review the milestone commit before Task 8. The shared composer,
multi-thread selection/routing, queue admission and inline file chips remain
later tasks in the real-app plan; their presence in the mockup does not mean
they are implemented in the app.

The original build plan and other untracked documents/mockups/scripts remain
unstaged. The revision-12 plan snapshot and implementation ledger remain
under `.superpowers/sdd/2026-11-08-adaptive-thread-panes-build/`.
