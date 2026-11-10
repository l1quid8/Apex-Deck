# Parallel multi-thread composer implementation

Base: bot-copy snapshot `8d14d700`, containing Task 8c `8e68d1aa`.
The user requested parallel implementation. Three agents implemented the draft
document (Task 9), send planner (Task 11), and one-send routing (Task 11a).
Null implemented pane selection (Task 10), integrated the lanes and ran checks.
Changes stay uncommitted in the bot copy for Deck to fold back; no branch
changes, merge, push, installer or development launch here.

## Implemented boundaries

- Task 9: typed thread/file/text tokens, destination removal and Undo,
  readable clipboard fallback and validated same-draft clipboard format.
- Task 10: retained multi draft with synchronous `current()`/`take()`,
  tag-order selection, modified header/empty-transcript clicks, outlines,
  Escape/plain outside click to exit, and selected-group zoom anchoring.
  `setTldr` and `setOverride` supply the later composer integration.
- Task 11: pure send planning, grouped/split ownership, command restrictions,
  typed mention routing, file references and summaries. It does not post.
- Task 11a: additive one-send queue routing and capability protocol,
  including default preservation through delegated continuations.

The rich multi editor, per-thread send API, admission queue, batch execution,
single/multi composer conversion and native image-drop integration remain
Tasks 12–16. The current dock still contains the existing single composer;
these changes do not establish end-to-end multi-thread sending.

## Interface rulings for subsequent tasks

- Tags at both ends surrounding prose are ambiguous, matching the approved
  mockup, rather than arbitrarily choosing a split direction.
- `RemovedSlice.inserted?: number[]` records additional result rows when
  removing a split destination would otherwise collapse remaining owners
  into a group or ambiguous line. Undo deletes those result rows before
  restoring removed/replaced original rows. Later edits/additions clear
  the removal note so its Undo cannot overwrite newer words.
- `summaryLine(slices, threads, files?, problems = [])` adds optional file
  metadata and plan problems. Task 14 should pass both to name a reading
  file even when shared context is suppressed from every command slice.
- Problems use `kind` and zero-based line indexes. Duplicate `lines` lists
  each offending occurrence, including two copies on the same line.
  Missing file metadata and a chip naming an old host are `unresolved`.
- Shared group context, including its pictures, is omitted from a thread's
  dedicated command slice, matching the mockup. Multiple command lines for
  one thread block; they are never silently reduced to one command.

## Verification

The App selection scenario uses production App/PaneMap/PaneHead and the real
draft hook through the existing isolated demo-backend Electron harness.
Its test-only Vite transform exposes the hook; production has no test global.
No real clipboard or user-service messages are used.

Initial selection check failed before implementation. Follow-up regressions
failed for title clicks and Undo overwriting later edits, then passed with
fixes. Cross-review also found split removal could silently change remaining
ownership; three new regressions failed and passed with the inserted-row fix.

Additional integration fixes:

- Modified title clicks no longer start a drag or accidentally maximize on
  a double click. The native Electron scenario verifies modified selection
  without reordering, alongside same-task state reads and retained drafts.
- The App evaluation harness now runs the real draft hook instead of
  returning undefined for its new import. All 32 affected checks pass.
- Vite's entry paths and Git working directory use `fileURLToPath`, so the
  bot copy's `Application Support` path is decoded correctly. A temporary
  directory containing spaces reproduces the old failure and passes with
  the fix. The authority test's script path uses the same conversion; its
  10 checks pass. Authority implementation is unchanged.
- Delegated execution-thread continuation also forwards `keep_default`;
  otherwise it bypassed normal post preparation. The new continuation
  regression failed before that fix and passes for true and false.

The first broad JavaScript run finished with 3,603 tests: 3,521 passed,
77 failed and 5 skipped. Failures included the new-hook harness omissions
and existing path/loader assumptions in this bot-copy location. That run
is not a passing suite; the final run after those corrections is below.
The native selection scenario separately timed out while the loader was
broken; it passed after the path correction, including real native input.

Fresh focused combined checks: 172 passed (draft/planner/one-off queue,
mentions, command backend and host routing). Cross-review independently
ran 208 existing queue, phone queue and routing checks successfully.
TypeScript and whitespace checks pass. The fixture-daemon test uses
`sendOnce`, checks the actual posted mention and preserved default, but
reproduces the dispatch lead rather than rendering ChatPane; real component
send coverage remains Task 12.

The VPS compatibility check remains blocked by a baseline mismatch: its
guarded admission hash and phone hash match HEAD byte-for-byte, but the
admission hash is absent from the checker's accepted list. No updater or
protected admission code was changed. This is not a passing VPS check.

Final JavaScript suite: **3,604 tests, 3,598 passed, 1 failed, 5 skipped**
in 186.6 seconds (`/tmp/null-parallel-suite-final.log`). The sole failure is
the existing narrow dock scenario's assertion "typing keeps the row being
read when the active pane is off screen". It passed in a bounded first-attempt
isolated run (`/tmp/null-dock-narrow-isolated.log`); no root cause or baseline
attribution is established. No third broad rerun was performed.

The final focused document/planner/native-selection/path checks pass **47/47**
(`/tmp/null-parallel-final-focused.log`), including modified double click
staying in the map. TypeScript and `git diff --check` pass on the final source.
The final-source fixture-daemon test passes **1/1** after its fixture rebuild.

The required four-package Rust run passed the complete core and adapter
suites (**270 core passed; 570 adapter passed, 11 ignored**), then stopped
in daemon with **219 passed, 2 failed, 4 ignored**.
The failures are `trust_host::tests::explicit_no_reboot_rotates_epoch_even_without_a_boot_id`
and `trust_host::tests::normal_trust_requires_a_changed_readable_boot_id`, both
reporting "cannot safely stop the owner" of their `/tmp/trust-host-*` fixture.
`trust_host.rs` is unchanged; no baseline reproduction was attempted.
The full run is not green. Log: `/tmp/apex-one-send-full-rust.log`.

Focused Rust checks pass: one-send host routing/capability/continuation 3/3,
existing chat delivery 18/18, continuation guidance 1/1, capability authority
9/9, and the shared eight-case media fixture.

Because the four-package run stopped before host, the complete host package
was run separately once. It finished with **1,161 passed, 1 failed, 14 ignored**
in 109 seconds. Its sole failure was the command-registry expected count,
237 before adding `post_capabilities`, 238 afterwards. The count and explicit
capability assertion were corrected; its focused rerun passes 1/1. The entire
host suite was not rerun after that test-only update. Log:
`/tmp/apex-one-send-full-host.log`. The previously skipped host integration
targets were then run separately: **45 passed**, and host doctests passed.
The full e2e suite and daemon targets after its failed library were not run.

Ready for review as Tasks 9–11a implementation, with the broad-suite
limitations above. No merge or release acceptance is claimed.
