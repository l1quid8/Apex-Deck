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
Only Tasks 1–3 are implemented:

- `50174428`: grid and band zoom levels, including the narrow-window crash fix.
- `8e6fe70e`: placement for five layouts, whole-line snaps and legacy tree migration.
- `1dffaba3`: zoom steps, active/pointer/centre anchoring, insertion indices and reorder.

The new production module is `src/paneArrangement.ts`; it is pure geometry and
is not connected to App yet. There are 25 focused tests across the three new
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

## Next handoff

Jigga: review `aa2eb6bb..1dffaba3` before pane-map integration. Task 4 is next;
Tasks 4–7 remain unimplemented. Reuse the module above and pass the scroll
offset when wiring drag insertion. The implementation ledger and a snapshot
of the uncommitted revision-10 plan are under
`.superpowers/sdd/2026-11-08-adaptive-thread-panes-build/`.

The committed mockup is unchanged. Unrelated untracked files and the
uncommitted build plan remain untouched. Nothing is merged, packaged or
installed, and no new native UI behavior is claimed.
