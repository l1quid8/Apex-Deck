# CLI v4 visuals implementation plan

**Goal:** Implement the approved `mockups/apex-cli-v4.html` in the existing Ratatui renderer.
**Architecture:** Keep routing, recovery, input, and welcome behavior unchanged. Render terminal-width transcript rows before scrolling, so user bands and reply indentation survive wrapping. Use the existing pixel mark at the approved free-space thresholds.
**Spec:** `mockups/apex-cli-v4.html`, approved in the room journal.
**Constraints:** Work on `feat/cli-v4-visuals` in the shared checkout as required by repository instructions. Preserve unrelated changes. No release packaging or merge in this task.

## Tasks
- [x] Add renderer tests for shaded multiline human turns, indented styled replies, restored streams/activity, responsive empty mark, and long Unicode headers.
- [x] Run tests against the old renderer and confirm failures. Implement the header fit sequence, empty-state mark, and transcript styles in `crates/apex-cli/src/ui.rs`.
- [x] Run the CLI suite and `npx tsc --noEmit`. Inspect rendered cells at 120×42, 80×24, 80×16, and tiny sizes, including long content and composer drafts.
- [x] Ask Jigga to review the scoped diff and exact verification evidence before any release work.

## Review focus
Wrapped user rows retain full-width shading; wrapped reply rows retain three-column indentation; Markdown markers spanning wraps preserve styles; long Unicode names and paths cannot hide the thread; shrinking terminal height removes decorative content before composer; restored streams keep their cursor and named activity. Tests inspect real Ratatui buffers.

## Implementation evidence and review handoff
Base: `dc0f698a0ec39ea5a0c1bcd4b6ebbb8b14d7f13d`. Branch: `feat/cli-v4-visuals`. Changes are uncommitted.

Changed product file: `crates/apex-cli/src/ui.rs`. New tests: `crates/apex-cli/tests/visuals.rs` (8 tests). This plan is the only other task file. Recovery and routing files are unchanged.

- Four initial visual tests failed against the original renderer; all pass after implementation. Short-conversation alignment also failed before bottom alignment was added.
- `cargo test -p apex-cli`: 73 passed, 2 ignored. Includes both real-transport switch-back/reconnect and cursor-resume tests. Log: `/tmp/cli-v4-suite.log`.
- `npx tsc --noEmit`: passed. `cargo build -p apex-cli`: passed. `git diff --check`: passed.
- Inspected PNG renders generated from actual Ratatui TestBackend cells for all five mockup states at `/tmp/apex-cli-v4-visuals/{empty,busy,return,small,fit}.png`. These are renderer fixtures, not Ghostty screenshots or provider-backed manual acceptance.
- Optional fixture export: `APEX_CLI_VISUAL_FIXTURES=/tmp/apex-cli-v4-visuals cargo test -p apex-cli --test visuals` exports glyph/style JSON. The PNGs use Menlo with a simulated terminal background.
- Existing dependency dead-code/unused warnings remain; no new renderer warnings observed.
- Nothing merged, installed, or packaged. Existing release archives are untouched. Unrelated dirty files were preserved.

Jigga reviewed and approved subject to correcting misleading folder abbreviation. Follow-up: shortened folders now use `…/app`; the version disappears before the thread title is truncated. The existing Unicode header test and a new title-preservation test failed before these corrections and pass afterward. A home-boundary test also checks that only paths inside HOME receive `~/` abbreviation. Fresh verification: `cargo test -p apex-cli` passed (75 passed, 2 ignored); `npx tsc --noEmit` passed. Suite log: `/tmp/cli-v4-review-suite.log`. Optional incomplete Markdown behavior remains as approved. No commit or release packaging performed.
