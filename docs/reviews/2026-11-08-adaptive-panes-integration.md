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

## Task 7a: revision-13 review corrections

- Pane slots now glide with `left`/`top`, keeping fixed selection actions,
  link menus and full-window previews in window coordinates.
- Focus uses compositor-managed sticky positioning. Its divider sits outside
  the scroller. Scroll offsets are refs; memoized pane content changes only
  for its render callback, geometry or visibility.
- A moving or clipped docked browser shows its snapshot, then restores its
  native view at settled bounds. Full-window previews retain live content
  and ordinary menu coverage.
- Drag-out restores the original order before App snapshots the return spot.
  Return spots retain external neighbours and restore beside surviving ones.
- Zoom keys require map focus; fullscreen restores scroll; reselecting the
  current layout preserves zoom. Side-panel Escape consumes the event first.
- Removed the unused split-tree renderer and live editing helpers; retained
  saved-session validation and migration, and the sidebar resize input guard.

The six original PaneMap review scenarios failed on the integration baseline
before their fixes. Corrected checks cover pop-ups in grid and Focus, mid-glide
placement, same-cell drag render counts, native drag-out snapshot order,
fullscreen scroll restoration, and zoom keys from focused buttons. A native
offscreen paint capture checked Focus and divider edges in 25 drawn frames
while scrolling more than one side pane; neither moved. Reduced-motion Focus
is also checked.

The new BrowserView tests use a stub BrowserApi with actual Chromium layout,
including actual PreviewPane markup for full-window mode. Their five scenarios
cover clipping, moving attributes, transitionend, scrollend, and full-window
entry/return with menus. Tests use isolated data and never the real clipboard.

The isolated full-App fixture mounts the actual App, ChatPane, TerminalPane
and PreviewPane with 14 synthetic long-transcript threads, a demo PTY and a
real WebContentsView displaying a synthetic page. At exact 1512×945 and
1100×650, all 28 interaction checks passed: selection toolbar and path-menu
placement in all five layouts; full-window native preview; pinned Focus
scrolling; native preview clipping; drag-out/child-window-close return order;
and TerminalPane rendering. The terminal is on Code, as in the real product.
Pop-out content is a synthetic child; App's opening/return callbacks and
order readback are real. No production daemon or provider was used.

Screenshots, runner and results: `/tmp/apex-task7a-app/`. Root inspected the
large grid, small Vertical, selected-text toolbar and path menu; the acceptance
helper inspected all ten layout captures. Electron's page screenshots omit
native child compositing, so native visibility and bounds were read separately.

This is full-App UI fixture validation, not a packaged or installed release;
Task 8 remains pending Jigga's review.

Final Task 7a verification:

- `npm test`: **3,514 passed, 0 failed, 5 skipped** (3,519 total), exit 0.
  The count includes the new regressions and removal of obsolete split-tree
  tests. The first run found five callback-extraction test harnesses missing
  the new helper bindings; those harnesses now use App's real helpers.
- `npx tsc --noEmit`: exit 0.
- `git diff --check`: clean.
- Mockup readback against `aa2eb6bb`: unchanged.
- Independent read-only reviews of PaneMap/styles and preview movement
  integration found no remaining blocking issue.

Logs: `/tmp/null-7a-final-full.log`, `/tmp/null-7a-final-tsc.log`,
`/tmp/null-7a-red.log`, `/tmp/null-7a-drag-paint.log`. No merge, package,
installed-app replacement or production-service acceptance was performed.

## Task 7b: revision-14 Focus corrections

- Entering and leaving Focus now animates the pane's drawn position using
  sticky insets/margins or absolute left/top. No transform or new containing
  block is introduced; fixed pop-ups retain window coordinates mid-glide.
- Divider drags disable slot transitions immediately. Title drags still let
  neighbouring panes glide. Lifting a pane cancels its own animation.
- Focus previews use a separate movement marker. Side scrolling and zoom
  leave the stationary native page live; actual Focus movement, resizing,
  maximize/restore and title dragging use its picture until settled.
- Review caught two interrupted-animation cases: a lifted former Focus pane
  was animated away from its pointer, and a quick layout change retained an
  old animation destination. Regressions cover both. A side zoom during entry
  also extends the Focus snapshot guard through the rebased animation.

The new glide/divider checks failed before implementation; the preview marker
check failed on side scrolling. The interrupted-glide and snapshot-lifetime
checks also failed before their corrections. Native pointer-up delivery is
asynchronous, so the preview restoration deadline starts when the drag's DOM
state actually clears, not when the test enqueues the OS event. Reversal
samples start after the new layout commits, avoiding a stale pre-command
measurement.

Full-App synthetic checks at 1512×945 and 1100×650 passed all ten scenarios:
six normal-speed transitions have intermediate frames, eight divider samples
have zero geometry error, and both Focus-preview side scrolls produce zero
native hide/show/bounds calls. Source hashes match the final run. Evidence:
`/tmp/apex-task7b-app/results.json`, `acceptance-report.md` and both
`acceptance-contact-*.png` boards, visually inspected. The fixture uses six
messages per thread; a dense 48-message diagnostic missed intermediate frames
during a scheduling gap. This is not a dense-transcript performance claim.
Main-window screenshots exclude live native child compositing; separate page
captures and attached/shown/bounds records establish the native page's state.

The real Electron dev command was also launched from the repository root and
its native window inspected with Computer Use. The new PaneMap rendered and
the local host reported Connected. The window showed service build
`ac0326491ba9` versus source app `6be84694e2f6-dirty`. DevTools readback did not
produce a usable response; this is visual shell evidence, not matching-build
end-to-end acceptance. The agent's dev process was stopped after inspection.
No real messages were sent or provider approvals exercised.

An intermediate unrestricted full-suite run had three failures:
`pinned BrowserView follows Focus motion and switches guards when lifted`
(printed success but the Electron process outlived its deadline),
`desktop exit leaves its shared daemon alive and simultaneous startup reuses
the winner` (the previously observed startup race, two starts instead of one),
and `PaneMap review regression: focus-interruptions` (the pre-command position
comparison described above). Final verification is recorded below.

Final Task 7b verification:

- `npm test -- --test-concurrency=4`: **3,518 passed, 1 failed, 5 skipped**
  (3,524 total). All 22 PaneMap/BrowserView scenarios pass. The sole remaining
  failure is the unchanged shared-daemon startup race named above, again two
  starts instead of one. This is not a fully green suite.
- `node --experimental-strip-types --test tests/desktop-sidecar.test.mjs`:
  **7 passed, 0 failed**, including that same startup test on isolated rerun.
- `npx tsc --noEmit`: exit 0; staged/unstaged whitespace checks are clean.
- Independent final review approved after the interruption and marker fixes.
- Mockup diff against `aa2eb6bb` is empty. Only Task 7b source, tests and this
  handoff are staged; the untracked plan and unrelated files remain untouched.

Logs: `/tmp/null-7b-verified-full.log`, `/tmp/null-7b-verified-tsc.log`,
`/tmp/null-7b-sidecar-recheck.log`. Initial red cases are in
`/tmp/null-7b-red.log` and `/tmp/null-7b-interruptions-red.log`.
Jigga should review this commit before Task 8. No merge or package was made.
