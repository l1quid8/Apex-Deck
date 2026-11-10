# Visible multi-thread input

The user reported the composer disappearing whenever Command-click selects panes,
including with two recipients. The prior last-recipient fix did not cover this.

Root cause: `.multi-composer` and the global `.composer` have equal specificity.
The global flex display can win by bundle order. Its `align-items: flex-end` also
leaves grid children at their intrinsic width. The rich editor had no input
surface, making the narrow editor look absent. The new real-App regression
failed at both 1100 and 1920 pixels: the input measured only 94 pixels wide.

`src/MultiComposer.css` now selects `.composer.multi-composer`, explicitly sets
one stretching grid column, gives the editor the normal input surface and focus
indicator, removes the summary button's inherited fixed height, and wraps actions.

Verification: TypeScript passed. Seven real-App/editor/selection checks passed,
including one/two recipients, actual Electron text insertion, deselect/Undo,
pickers, synchronous sending, and rich editor clipboard/IME/history checks.
Inspected the captured two-pane image: full-width input and actions below it.

Installer: `release/Apex-Deck_0.9.9_composer-visible-input.pkg`. Built from the
previous dropdown-test staging copy with only MultiComposer.css, App.tsx and
useMultiDraft.ts updated (the latter two carry the earlier last-recipient fix).
The Developer ID app signature, packaged CSS and Electron ASAR integrity passed.
Service, broker and CLI hashes match the current protected installed app exactly.
No installed/protected files were replaced. Installation and live acceptance are
still pending macOS Installer authentication. No merge or push.
