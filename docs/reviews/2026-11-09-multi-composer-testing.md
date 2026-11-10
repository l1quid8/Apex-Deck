# Multi-thread composer testing handoff

The integrated development app is running from the repository root with the
prescribed `APEX_DECK_DATA_DIR` and `npm run desktop:dev` command. The daemon
binary compiled successfully. The installed service was not replaced or restarted.

The shared composer now connects App selection, the rich draft editor, send
planning, thread queue admission, batch retry, single-to-multi conversion and
native attachment snapshots. Cmd-click a pane header to add thread chips.
Escape or Keep draft returns to the single-thread composer.

Final integration fixes connect header agent pickers, preserve newlines during
single-to-multi conversion, show typed mention recipients ahead of dropdown
overrides, protect picker clicks from replacing newer text, and keep Enter on
review controls from submitting a batch. The native-drop App test now returns
undefined rather than trying to clone a function through Electron's bridge.

Fresh verification:

- `npx tsc --noEmit`: exit 0.
- `git diff --check`: exit 0.
- Integration checks: 4 passed, 0 failed (`/tmp/null-finish-integration.log`).
- Editor, real ChatPane queue admission, batch retries, routing, draft planning,
  native-drop bridge and wire text: 76 passed, 0 failed
  (`/tmp/null-finish-final-focused.log`).
- Native UI observation: the running localhost:5173 Electron window displayed
  two real thread chips and the shared multi-thread editor after Cmd-clicking
  a header. No message was sent to the user's service during this check.

The initial focused run exposed three failures; all three pass after the fixes
above. No full repository suite was rerun for this handoff. Existing broader
suite limitations remain documented in the preceding handoffs. The app initially
displayed a service/build mismatch; one-send agent dropdown capability depends
on the connected service. End-to-end delivery through that live service is not
claimed. Current UI and component checks use the final source, with component
sends verified against isolated backends.

The shared checkout remains on `release/ios-1.1-27` with concurrent unrelated
changes. Nothing was merged, pushed, packaged, or committed in this continuation.
