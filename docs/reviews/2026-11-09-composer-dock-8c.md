# Task 8c — hidden and loading dock measurements, scrolled refits

Base: `bd539f0a` on `feat/adaptive-panes`. Continues the interrupted Task 8b review using Jigga's saved `task8b/proto8c.diff` and scenarios. The untracked build plan and unrelated files remain untouched.

- A hidden dock cannot lower the window's remembered rest height to zero. The dock retains its last borrowed height until visible again.
- Rest height is learned only after the room loads, when the composer's agent row is present. ChatPane marks that state on the composer; the dock observes the marker as well as size and child changes. Borrowing stays nonnegative during loading.
- When the active map pane is off screen, a composer refit preserves the first line being read instead of revealing the active pane. It uses the previous drawn placement and scroll offset; explicit reveal and zoom still follow their existing rules. Refit scroll events retain the quiet-motion guard.

Regression evidence before implementation:

- Jigga's real-App scenario reproduced rest height 173 → 0 after Add teammate, then a 4×3 → 4×4 grid on return.
- The committed App regression failed with level 0 instead of 1 after Add teammate.
- A held `roomState` in the real ChatPane fixture exposed 33 borrowed pixels on an empty loaded composer instead of 0.
- After correcting measurement, both App sizes still failed the separate scrolled-row assertion: typing revealed the active pane and hid the last row being read.

The tests exercise production App, ChatPane, ComposerDock and PaneMap in Electron with the demo backend; no user-service messages are sent. Unit checks cover line preservation through growth and clearing in all five layouts, clamping, empty placements and nonfinite offsets.

Verification results and desktop observation are recorded below before commit.

Fresh continuation checks: `npx tsc --noEmit` and `git diff --check` pass.
The repository-prescribed `desktop:dev` command built the daemon and opened
the current app. Observed the native Electron window with two thread panes
and one shared composer targeting Tyrus, labeled `hem · No agents yet`.
The existing service mismatch remains: service `ac0326491ba9` versus app
`bd539f0a3dc1-dirty`. No messages were sent through the user's service.
This observation confirms the development UI loaded; the automated demo-App
scenarios provide the regression behavior checks. No merge, push or package.

First full run: 3,548 tests, 3,542 passed, 1 failed, 5 skipped (195.4 s).
Both App sizes, the delayed-room dock fixture, all-layout keepLine checks,
and pane interaction regressions passed. The failure was the unchanged
`phone-composer-panel.test.mjs` assertion `handle tap collapses`, after a
native simulated click. The same phone test passed three isolated reruns.
Its immediate post-click assertion is a possible timing source, not a
confirmed root cause. No phone changes are included. Logs:
`/tmp/null-8c-tests.log` and `/tmp/null-8c-phone-{1,2,3}.log`.

Final continuation run: `npm test` completed in 189.9 s: 3,548 tests,
3,542 passed, 1 failed, 5 skipped. All Task 8c regressions passed, including
both production-App window sizes and delayed room loading. The phone check
passed. The failure was `browser-view-focus-map.test.mjs`: a motion flag was
still true during the second refit loop (`main.cjs:65`). This is not a clean
full-suite pass.

Focus investigation: isolated run 1 passed the refit checks but failed the
later title-drag restore assertion; isolated run 2 passed the whole test.
The saved `~/.cache/jigga-review/base-bd539f0a` baseline also failed that same
title-drag assertion. Its PaneMap source hash matches `git show bd539f0a`.
This establishes a pre-existing intermittent title-drag failure, but does
not establish the cause of the full-run motion-flag failure. No Focus test
or unrelated implementation changes were made. Logs are preserved under
`~/.cache/jigga-review/task8c/` as `null-8c-tests-final.log`,
`null-8c-focus-{1,2}.log` and `null-8c-focus-base.log`.

Review request for Jigga: compare this commit with `bd539f0a`; verify hidden
dock and delayed-room measurements, scrolled refit preservation, and the
neighboring Focus BrowserView behavior. Reproduce with:

```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/composer-dock-app.test.mjs tests/composer-dock-browser.test.mjs tests/pane-arrangement-place.test.mjs
node --experimental-strip-types --test tests/browser-view-focus-map.test.mjs
```

Implementation is ready for review; acceptance remains with Jigga. This
finishes Task 8c's implementation and handoff, not Tasks 9–16 or the full
multi-thread composer feature. Nothing merged, pushed or packaged.
