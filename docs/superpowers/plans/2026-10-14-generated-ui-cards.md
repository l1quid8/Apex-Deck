# Generated UI cards implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent contract, host and upstream tasks; review integration and verification before handoff.

**Goal:** Implement the approved generated-card spec on an unmerged feature branch.
**Architecture:** A shared bounded validator feeds text-only clients and exports. Completed, approved desktop cards use a main-owned WebContentsView with a fresh session and opaque child iframe; production execution remains disabled until packaged security evidence is approved.
**Tech Stack:** React/TypeScript, Electron 44, Node modules, Rust bot prompt constants.
**Spec:** docs/superpowers/specs/2026-10-14-generated-ui-card-design.md

## Global constraints

- Pin upstream OpenIntelligentUI to 8391a94c1c3939c679e40ddd7bfc08a9ef690e70, reuse composition/measurement/styles/prompts and ship full MIT notice.
- Generated cards require exactly nine fields. Apply the spec's UTF-8 field/combined/source limits while retaining comparison's 16,000 UTF-16 cap.
- Main revalidates, owns SHA-256 approval identity, verifies exclusive renderer process ownership before delivering code, and terminates runaway code from main.
- No generated access to Deck data, networking, file delivery, permissions, external forwarding, automatic drafts or sends. Phone/browser/history show text.
- No production build/install, merge or push. Run npx tsc --noEmit before handoff.
- Execution and generated bot guidance stay disabled with no environment override until all packaged runtime release gates pass.

## Review focus

- Unicode, JSON escapes and overlarge input must be bounded before parsing; code bytes must survive validation.
- Generated exports must show literal safe text, not execute code or leak code payloads into search.
- A changed revision, late async run response, unmount or host/thread move must revoke the old run.
- Geometry stale after scroll/overlays must hide the native view; Stop and Discuss must remain trusted controls.
- Forged child messages, shared/stale PIDs and unsupported network-policy inheritance must fail closed.

### Task 1: Contract and text compatibility

Files: shared/generatedCard.mjs and declarations; schema.ts; share.ts; schema/export fixtures and tests.
- [x] Add failing tests for required/excess fields, exact code preservation and every byte/raw boundary.
- [x] Implement shared validation and kind dispatch; extend versions, safe Markdown/PDF/search summaries, retain original JSON export.
- [x] Run comparison and generated contract/export regressions.

### Task 2: Pinned upstream adapter and prompts

Files: third_party/open-intelligent-ui; desktop/generated-ui/frame-content.mjs; view.rs; adapter/guidance tests; electron-builder.yml.
- [x] Fetch exact pinned files, retain LICENSE and record source hashes/adaptations.
- [x] Reuse document composition, resize measurement, audited theme/form/SVG styles and task-based prompt content. Remove upstream libraries and privileged bridges.
- [x] Build fixed wrapper/srcdoc bootstrap with structured init; keep guidance unselected by default.
- [x] Verify script-closing payloads, protocol source/run binding and fixture envelopes.

### Task 3: Isolated Electron host

Files: desktop/generated-ui/host.mjs, policy.mjs, protocol.mjs, preload.cjs; minimal main/preload integration; adversarial unit and runtime smoke harness.
- [x] Add tests for gate, approval hashes, message/rate validation and exclusive process ownership.
- [x] Implement memory HTTPS bootstrap, session boundary, permissions/navigation denial, main watchdog, bounded run lifetime and cleanup.
- [x] Register sender-guarded IPC and test actual Electron process/freeze behavior with isolated fixtures.
- [x] Keep runtime capability closed until complete packaged networking/escape/recovery evidence is reviewed.

### Task 4: Trusted card UI and lifecycle

Files: GeneratedAnswerCard.tsx; generatedRun.ts; generated-card.css; ThreadCard.tsx; ChatPane.tsx; electronShell.ts; lifecycle/component tests.
- [x] Add failing lifecycle tests: no auto-run, fresh click, stale callback disposal, historical/read-only fallback and trusted Discuss preview.
- [x] Dispatch generated cards without comparison storage/evaluation, wire thread/host identity, viewport bounds and stop-on-overlay/unmount.
- [x] Retain literal text summary/fallback and disabled Run when capability is closed.

### Task 5: Review and evidence

- [x] Independently inspect all delegated diffs against spec and resolve findings.
- [x] Run generated/comparison tests, relevant Rust checks and npx tsc --noEmit. Compare full suite failures with clean baseline where needed.
- [x] Record exact runtime tests and remaining packaged release gates, commit reviewed implementation, leave branch unmerged/unpushed.

## Execution rulings

- Work in the new task branch in the requested checkout, with disjoint assigned file ownership for concurrent workers; preserve existing changes and prohibit agent branch switching.
- The existing approved design and explicit implementation request authorize execution without another design/plan approval pause.

## Final evidence

Implementation and independent review are complete with production execution/guidance disabled. See `docs/superpowers/reviews/2026-10-14-generated-ui-cards.md` and the adjacent runtime JSON for exact checks and unverified release gates. The branch remains unmerged and unpushed.

Ruling: reuse the card fence parser for Preview/media discovery — raw code otherwise triggered existing Deck side effects even with execution disabled — ordinary prose previews and media remain supported.
Ruling: a code-shaped envelope with a missing/mistyped kind receives generic text fallback — it cannot satisfy the generated schema — valid permissive comparison cards retain their existing behavior.
Ruling: add a fixed trusted-wrapper-only message-flood fault — main cannot count malformed events filtered by the wrapper — the child has no forwarding authority for that message.
