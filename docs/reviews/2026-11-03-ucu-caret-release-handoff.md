# UCU caret fix and clean release handoff

Branch: `fix/ucu-brave-window-validation`. Review before merging or building a new installer.

## Installed reproduction

Using the installed `apex_computer` plugin against Brave and `tests/fixtures/ucu-native-window.html`:

1. Click **Native caret in middle**, which sets `hello world` and selection `{6, 0}`.
2. Type `big ` without an element argument: `hello big world`, reported delivered verified.
3. Type `NEXT` without an element argument: `hello big worldNEXT`, reported delivered verified.

Expected final value: `hello big NEXTworld`. This reproduces the native helper defect independently of the earlier browser implementation (`373bbec9`).

## Fix

`TypeLadder` reads the current selection, verifies inserted text, and restores and reads back the insertion point after each delivered insertion. In particular, the whole-value fallback no longer leaves the next type at the end. UTF-16 offsets match AX ranges. Unknown selection refuses before writing instead of guessing append. If text lands but caret restoration fails, the result is explicitly unverified and unsafe to retry. The continuation gate runs before restoring a caret, so Stop does not permit another write.

The regression models an app resetting its caret to the end after AXValue writes; it failed before this fix for insertion, selection replacement, and emoji, and now passes. The opt-in native test also contains the two-insertion sequence.

## Release integration

Existing branch commits to review alongside the caret change:

- `93232b28`: exact live Brave windows and headless process exclusion.
- `9f568ef7`: preserve AX-focused windows without a CG onscreen record.
- `d554e7a9`: reject signed Electron bundles without a true JIT entitlement.

Cursor persistence commit `47f77248` is already an ancestor of this branch. Preserve the unrelated edits in the shared main checkout; review and merge without carrying those edits into a release.

After review, run TypeScript on the integrated commit, merge as authorized, and remove the merged task branch. Build from a clean checkout of that single integrated commit, using the repository release build location. Rebuild UI, daemon, provenance broker and UCU helper from source; do not reuse the installed TrustedUI app or swap a helper into it. Keep existing installers intact while staging the new package.

Read back the UI/daemon build stamps and helper source commit from the actual extracted package. Require clean provenance, Developer ID signature checks, Electron fuses, the JIT entitlement gate, and a successful launch before delivery. The final installable artifact must identify the integrated source commit, rather than one component's commit. Installed acceptance must inspect the live `/Library/Application Support/Apex Deck Provenance/TrustedUI/` runtime, then rerun cursor saves, two-window Brave resolution, repeated covered-window clicks, selection replacement and the new consecutive middle-caret sequence.

No new installer is produced by this handoff. The new caret behavior has not yet passed installed-plugin acceptance.

## Validation for the caret change

- `npx tsc --noEmit`: passed.
- `npm test`: 3,332 passed, three skipped, zero failures.
- `swift test --package-path computer-helper/spike`: 154 passed, ten live tests skipped, zero failures (77 core and 87 app cases including skips).
- `git diff --check`: passed.

The first JavaScript attempt ran before worktree dependencies were installed. A second exposed concurrent lazy Electron extraction; after completing dependency installation and verifying Electron 44.5.1 starts, the complete suite passed. The installed-plugin reproduction above is observed evidence of the old behavior; unit coverage of the new behavior is not installed acceptance.
