# Inline attachments and selection lines — 2026-11-08

Design-only standalone artifact: `../adaptive-thread-panes.html`. No production implementation, commit, merge or release build.

Pane selection now appends stable thread tags on separate lines in click order, including after a manually grouped line. The initial caret stays after the first tag. A browser regression failed on the prior same-line behavior before the fix.

Mock files have reusable stable references rendered as noneditable ImageN chips. The composer + button inserts at the caret. Dragging an inline chip moves it between words; dragging from the preview copies its reference. Destinations derive from each reference's parsed line, and previews show readable references and files. Repeated references attach each file once per destination. Deleting the last chip removes the attachment entirely; deleting one shared reference preserves the remaining destinations. Removed metadata stays in a draft session cache for keyboard Undo and pane-removal Undo. There is no unplaced warning or attachment Send to all button. Missing references and files targeting commands still block Send.

The 28px preview stack shares the bottom action row beside TL;DR. The expanded preview is a fixed popover above the composer and does not overlap the prompt. At both test viewports the composer has identical height with zero and two attachments; the three-thread measurement is 132px in both states.

Latest lifecycle checks: inline attachments 60/60, native drag and preview checks 30/30; routing 86/86, collapsed review 12/12 and selection tags 36/36, multi-selection 57/57 and fill/zoom 94/94. TypeScript passed. Repository tests passed 3,464 with 5 skipped and 0 failures.

Earlier verification (before the lifecycle and action-row changes):

Browser suites passed at 1512×945 and 1100×650 where applicable:

- Inline attachments and selection lines: 40/40 (real Cmd-clicks, caret, Down, native Backspace, group additions, reusable chips, explicit all-destination insertion, missing placement, command blocking, layout and confirmed mock delivery).
- Selection tags: 36/36.
- Thread picker: 20/20.
- Slice routing: 86/86 (including partial failure and failed-only retries).
- Escape precedence: 9/9; replaced an obsolete test using plain @thread titles and the hidden textarea.
- Multi-selection: 57/57. At the smaller viewport, a selected pane can be virtualized outside the visible area as the composer grows. Selection assertions now inspect selected IDs; rendered title bars must all retain their route.
- Fill/zoom: 94/94. An animation timing check failed under concurrent load; the full rerun passed.

Total: 342 passing browser checks. Screenshots inspected at both viewport sizes. JavaScript syntax check and `npx tsc --noEmit` passed.

`npm test`: final full rerun passed 3,464 tests, 5 skipped, 0 failed (3,469 total). The first run had one failure in `desktop exit leaves its shared daemon alive and simultaneous startup reuses the winner` (`desktop-sidecar.test.mjs`); its isolated 7-test suite and the full rerun both passed. No daemon code changed.

Actual file uploads, real thumbnails, provider payload serialization and native installed behavior remain outside this mockup's verification.
