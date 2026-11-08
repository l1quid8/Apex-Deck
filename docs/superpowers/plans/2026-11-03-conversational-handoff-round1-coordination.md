# Conversational handoff Round 1 coordination

Execution contract for the user-authorized Round 1, based on the [approved v11.1 plan](2026-11-03-conversational-handoff-v11-1.md). The product contract and Jigga's approval amendments in that plan remain binding.

## Baseline and scope

- Integration branch: `feat/assistant-handoff-round1`, created in the shared `/Users/tylercaldwell/Downloads/apex-deck` checkout from `47f77248ad90b0f77e206b6ae6e1b04a8ce10bd0`.
- Round 1 only: Tasks 1, 2, 3, 4a, 6 and 7. No handover, follow-up delivery, composer mode controls, historical branching, release merge, installer or installation.
- Baseline `npx tsc --noEmit`: passed, exit 0 on 2026-11-03. Host, integration and native acceptance are pending; this baseline is not feature verification.
- Existing unrelated changes must remain untouched: `crates/apex-host/src/personal_worker/browser/work.rs`, its `work/tests.rs`, `tests/phone-composer-history.test.mjs`, `build/unified-computer-use/`, and older untracked mockups. The approved plan and v11.1 reference are included in the coordination commit.
- Work stays on this integration branch. Workers do not switch/reset the shared checkout or commit another worker's files. Run `git status` before edits. Commit only the explicit files/hunks belonging to the slice.

## Owners and independent work

| Owner | Deliverable | Can start independently | Shared-file dependency |
| --- | --- | --- | --- |
| Forge | Task 1 durable private saved reply, reference-only launch gate, outbound privacy filtering and recovery; Task 3 new-thread admission/watchdog coverage | Task 1 and its regressions now | Owns the host writer baton first. Task 3 follows the agreed draft/control contract and uses the durable preparation revision. |
| Deepgeek | Tasks 2 and 4a: routing drafts, ordered teams, exact human controls, confirmations, confirmed Stop and pause-preserving questions | Isolated classifier/draft/control modules and tests; review wire contract | Acquire shared Rust files after Forge releases them; do not independently patch the launch transaction. |
| Muck | Task 7 slim native React UI plus Task 6 client projection/model | Components, pure view models and component tests against the contract below | Host-backed controls stay unexposed until supported. Own all TypeScript changes requested by other slices. |
| Gronk | Independent Round 1 integration/browser/daemon fixture coverage and native acceptance record | Test matrix, fixture setup and tests against agreed contracts | Own `tests/assistant-conversation-browser.test.mjs` and `tests/e2e/assistant-delegation.e2e.mjs`; run integrated cases when host/UI are ready. |
| Null | Task 6 host progress/lifecycle projection; contract decisions, shared glue, integration, read-back and verification | Coordination, contract review and fixture review | Take the shared host baton after Forge/Deepgeek admission and controls settle. No concurrent hot-file edits. |
| Jigga | Independent review of the concrete Round 1 integration | Review the owner/contract split for omissions | Receive final baseline/head, full diff, test evidence and native limitations after integration; plan approval is not implementation approval. |

The shared Rust hot files are `personal.rs`, `personal_worker.rs`, `assistant_tasks.rs`, `assistant_delegation.rs`, `assistant_service.rs`, `personal_handoff.rs`, `host.rs`, `command.rs`, `lib.rs`, related personal response wrappers and protocol capability lists. Forge initially owns changes to these. Deepgeek and Null explicitly request and receive the baton before modifying them. If Forge needs another pass for Task 3, serialize it with Deepgeek's work rather than overlapping writes. Isolated new modules/tests may proceed in parallel; their shared registrations are made by the baton holder.

Muck owns `src/assistantHandoffModel.ts`, `src/AssistantHandoff.tsx`, `src/assistantTaskModel.ts`, `src/assistantConversation.ts`, `src/assistantFloat.ts`, `src/personalAssistant.ts`, `src/usePersonalAssistants.ts`, `src/daemon/transport.ts`, the affected assistant views/CSS and their component/model tests. Host owners send Muck required wire/interface changes rather than editing those files concurrently. Gronk owns the browser/e2e fixtures; Muck requests shared fixture changes through Gronk. Avoid broad `cargo fmt` or bulk reformatting of another owner's files.

## Contract handshake before integration

Use the approved plan's proposed contracts as the single starting point; owners record any necessary correction here before consumers rely on it.

1. Freeze actual serialized Rust/TypeScript field names and enum spellings together. Existing record fields are camelCase; do not assume enum values follow the same convention. Keep ids, host/project scope, request ids, revisions, attempt ids and question ids authoritative. Names are display data.
2. Forge publishes the private `PersonalEvent.saved_reply`, public `PersonalAssistantView`, immutable gate/reference and reconciliation interfaces first. Project tasks never contain the saved reply text or private commit envelope. Capture and reuse preparation owner/revision, including a crash before the first child exists.
3. Deepgeek publishes `PendingHandoff`, ordered selections, the exact whole-message `PlainHandoffReply` classifier, control payloads/receipts and question-bound confirmations. Continue cannot approve or start work. Unclear replies and closing forms leave the actual worker paused.
4. Null publishes attempt/participant-bound progress and durable lifecycle event shape with Muck: a reported checklist is optional, incompatible agent totals are never summed, and ready-for-review remains distinct from done. A historical selection never changes execution or creates output evidence.
5. The capability is `assistant_conversation_handoff_v1`; command provenance and both hello capability lists must agree. Advertise it only when its supported commands are wired and tested. Per-task `available_handoff_actions` expose only working Round 1 actions. Older-host fallback retains existing task UI.
6. Muck wires real snapshot/command contracts rather than a prototype state machine. Keep the one-sentence handoff, small pill, hover/focus/touch-accessible Stop and view-only popover. Retry requires confirmed settled Stop and fresh admission checks. Keep the 24px composer auxiliary space empty; Shift+Enter remains newline and Tab remains navigation.

## Slice reports and integration order

Each owner returns: exact commit ids or scoped diff, owned files, public interface changes, regression commands with results, known limitations and a clear statement of whether the shared-file baton is released. Preserve red/green evidence for execution-authority and recovery regressions. Do not equate passing unit tests with native acceptance.

1. Forge lands the durable launch/storage slice and publishes its contract. Deepgeek and Muck may have isolated work ready concurrently.
2. Deepgeek integrates routing and confirmed controls under the host baton. Forge then integrates remaining new-thread admission changes under an explicit baton handoff, including saved-revision recovery coverage.
3. Null integrates actual host progress/lifecycle receipts after execution/control identities settle; Muck finishes the real client wiring and Gronk finishes integrated fixtures.
4. Null reads the combined diff and Git state, runs required checks, fixes attributable failures and records any baseline failures separately.
5. Gronk/Null exercise the permitted existing development app without disturbing unrelated chats, using isolated harmless test data; record actual output/receipt read-back and relaunch evidence. Production builds are allowed only from `release`; this round does not request a DMG. If native execution is unavailable, record the concrete limitation rather than calling acceptance passed.
6. Null sends Jigga the concrete integration review package. Address blocking findings, rerun affected checks and request a scoped re-review. No release/main merge is authorized by this coordination step.

## Required verification and Jigga review package

- Fresh `npx tsc --noEmit` on the integrated branch, relevant host/task/conversation/stop/watchdog tests and affected UI/model tests.
- Browser fixture checks for slim pill/popover, hover/focus Stop without shift, agent order/lead, filtered arrows/Enter, checkbox multiselect, explicit Start, Escape dismissal, needs-OK/needs-you/failure/no-total/offline states and older-host fallback.
- Durable recovery barriers: before first child, partial batch, before/after publication, before release and before dispatch; zero model replay or computer-action replay, no invisible start, no private payload in on-disk project tasks or outgoing personal responses. Explicitly cover `restart_new_thread_preserves_preparation_revision`.
- Stop/paused controls: negated instructions, quoted/plain/unclear answers, deliberately wrong model classifications, multiple active tasks, stale confirmations/questions, timeout/cleanup, completion race and retry-before-settlement.
- New-thread replay: one room/task/attempt, exact ordered workers, current grants/approval/budget/profile validation and unchanged paid-monitor settings.
- Progress: late old attempts cannot update the current run, missing totals stay missing, no summed team lists, one lifecycle/result projection across replay, no fabricated file counts.
- Review package: approved plan and this owner map; integration baseline/head and scoped commit list; full diff including new files; test commands/results; coverage gaps/native observations; migration/privacy/provenance/lock-order decisions; explicit Round 2 exclusions.

## Execution status

- The initial coordination commit established the branch, ownership and passing TypeScript baseline. It did not claim feature implementation.
- Round 1 implementation slices and integration corrections are recorded in the [integration review package](../reviews/2026-11-03-assistant-handoff-round1-integration.md), including exact commits, verification and retained acceptance limits.
- Host admission/recovery, routing/control, new-thread/watchdog, progress and real client wiring are integrated. Round 2 handover, notes and composer modes remain excluded.
- Jigga's implementation review and installed-app acceptance remain pending; neither plan approval nor isolated fixture success replaces them. No release merge or installer is authorized.

Ruling: shared Rust edits are serialized while independent UI/modules/tests proceed in parallel — the approved tasks overlap in their storage/execution files, so unrestricted parallel edits would create integration races.

Ruling: preserve the shared checkout and unrelated modifications on one task branch — the user's repository instructions and explicit team-coordination request govern the workspace; no stashing, resets or branch switching by individual workers.
