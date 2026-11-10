# Adaptive panes: final plan review and initial implementation

## Plan review

Revision 10 of `docs/superpowers/plans/2026-11-08-adaptive-thread-panes-build.md`
passes the final plan/prototype review. No implementation blockers remain from
the earlier reviews. Null and an independent read-only reviewer checked the
quote-lead correction against the real quote helpers and the revision-10
prototype. The exact lead, including an empty lead, is chosen at Send and is
reused after mod rewrites. It is not recomputed from rewritten text.

Verification in this session: the prototype's 15 reply tests and 11 quote
checks, including 200,000 randomized sends, passed. This establishes the plan's
quote contract; the production send path has not been changed yet.

## Implementation started

Branch: `feat/adaptive-panes`, based on the committed mockup at `aa2eb6bb`.
Tasks 1–3 and the revision-11 follow-up, Task 3a, are implemented:

- `50174428`: grid and band zoom levels, including the narrow-window crash fix.
- `8e6fe70e`: placement for five layouts, whole-line snaps and legacy tree migration.
- `1dffaba3`: zoom steps, active/pointer/centre anchoring, insertion indices and reorder.

The new production module is `src/paneArrangement.ts`; it is pure geometry and
is not connected to App yet. There are 33 focused tests across the three new
`tests/pane-arrangement-*.test.mjs` files. Every task's specified tests were run
and failed before implementation, then passed. TypeScript passes.

Independent review found one drag hit-testing gap, which is fixed and covered
by a regression that failed first: a scrolled target selected index 10 instead
of 13. `insertIndex` therefore accepts an optional fourth argument,
`scroll = 0`. Its point is viewport-relative to the full pane area; it subtracts
scroll from region rectangles only and keeps the Focus rectangle fixed.
Task 6 must pass the current axis scroll offset. The fix was independently
re-reviewed without further findings. This extends the plan's three-argument
interface compatibly and avoids conditional coordinate transforms in callers.

## Repository verification

The baseline suite passed 3,464 tests with 5 skipped. The final foundation
passes all 25 focused tests and `npx tsc --noEmit`. Two full-suite runs on the
final code each reported 3,488 passed, 5 skipped and one failure in the unchanged
`tests/desktop-sidecar.test.mjs:102`: both concurrent starters reported
`owned: true` instead of just one. The isolated sidecar suite passed 7/7.
`desktop/sidecar.mjs` can observe the winner's listening socket before it has
observed the losing child's exit, which explains the two ownership reports.
Neither the sidecar nor its test imports the new geometry module, and neither
file was changed. No unrelated sidecar fix is included. Full-suite green is
still required before any merge.

## Next handoff

Jigga reviewed the foundation and requested Task 3a before integration.
That follow-up adds `zoomScroll(next, anchor, at)`, preserving the anchor's
on-screen line when density changes, then snapping so its selected group
stays whole. Keyboard fallback and group anchoring use the middle selected
pane in map order. Non-finite Focus divider shares fall back to 0.58.

The six specified regressions failed before implementation and then passed.
Two further tests cover horizontal screen position in Vertical mode, point
clamping and shuffled group order where multiple snaps can show the group.
Independent read-only review found no correctness defects. All 33 foundation
tests and TypeScript pass. A fresh full suite passed 3,497 tests, with no
failures and 5 skipped; the earlier sidecar race did not recur in this run.
The same 18,273-step sweep used in Jigga's review, now calling production
`zoomScroll`, had zero differences from the mockup rule. These checks cover
geometry, not native UI: App still uses the original pane tree.

Jigga: review Task 3a before Task 4. Tasks 4–7 remain unimplemented. Reuse
`zoomScroll` for every zoom step, put newly added panes first and reveal
them, and pass the axis scroll offset when wiring drag insertion. The
implementation ledger and snapshots of the uncommitted plans are under
`.superpowers/sdd/2026-11-08-adaptive-thread-panes-build/`.

The committed mockup is unchanged. Unrelated untracked files and the
uncommitted build plan remain untouched. Nothing is merged, packaged or
installed, and no new native UI behavior is claimed.
