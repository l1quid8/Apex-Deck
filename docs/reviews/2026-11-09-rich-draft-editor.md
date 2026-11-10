# Rich draft editor — Task 13

Implemented `src/RichDraftEditor.tsx` and its separately imported scoped CSS.
The exact required Task 13 props remain supported. Two optional callbacks
support host menus: `onCaretChange(caret)` runs before a matching trigger,
and `onTriggerClose()` runs when the caret leaves a query, a range is selected,
the editor blurs, composition starts, or the draft changes. The editor focuses
on mount. Subsequent metadata renders retain the native selection unless the
host supplies a different caret object.

The document contains atomic, noneditable thread/file spans in one block per
line. Beforeinput controls edits; own bounded history includes external menu
and attachment insertions, filters unknown files on undo/redo, and clears for
a new draft id. Thread chips remain in history for unresolved rendering.
Composition leaves the DOM alone until completion, and a draft reset during
composition cannot revive old text. Copy/cut supply readable names and the
validated same-draft MIME format; fallback paste stays text. Clipboard images
and dropped files use the callback. Chip dragging moves, or copies with Alt.

## Verification

`node --experimental-strip-types --test tests/rich-draft-editor-browser.test.mjs tests/slice-draft.test.mjs`
passed **21/21**, including the production editor in a dedicated Electron
fixture. Log: `/tmp/rich-editor-focused4.log`.

The scenario uses real character/key events for typing, Backspace, Delete,
arrows, undo and redo. Clipboard, composition and drag events are synthetic;
drag targets are resolved by Chromium's actual `caretRangeFromPoint`.
It checks atomic removal, grouped undo, failed-file filtering, history reset,
same-draft copy/paste and plain fallback, multiline cut and joining, Alt-copy,
busy-chip accessibility, image callback, trigger/caret/menu-close callbacks,
mount focus, metadata-render selection retention, and both browser-DOM and
synthetic composition insertion.

Observed RED→GREEN regressions included deletion coalescing, external insert
history, chip-boundary range normalization, metadata-render selection loss,
and mount focus. Initial fixture setup failures (named App export and Electron's
`Left` key name) were corrected in the test harness.

Fresh `npx tsc --noEmit` and `git diff --check` pass. The initial typecheck saw a
concurrent ChatPane `behind` key omission; it was resolved by that file's owner,
and is absent in the final run (`/tmp/rich-editor-tsc-latest.log`).

The parent owns the broad npm suite after integration. This focused verification
does not establish OS IME/dead-key device behavior, real clipboard operation,
App menu integration, batch sending, installed behavior, or release acceptance.
No branch switch, commit, build, development launch, install, or real clipboard
access was performed in this lane.
