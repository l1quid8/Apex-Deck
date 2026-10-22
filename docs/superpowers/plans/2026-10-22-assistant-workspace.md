# Named Assistant Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple named assistants with configurable runtime models, pixel or explicitly applied AI-generated avatars, scoped memory and real project-worker delegation through the approved main-pane UI.

**Architecture:** Extend existing durable personal identities and coding-task ledgers rather than replace them. Bind assistant and project identity explicitly, store private and project notes separately, and route proposed coding work through the existing executor. Preserve existing Agents and global right-panel ownership.

**Tech Stack:** Existing React/TypeScript, Rust apex-host daemon, JSON-backed durable records, Node tests, existing Electron development app; dependency-free HTML/CSS/JS review mockup.

**Spec:** [Assistant workspace design](../specs/2026-10-22-assistant-workspace-design.md)

## Global Constraints

- Preserve the existing production **Agents** tab and its reusable worker profiles. Do not replace it with the preview's worker cards or add an Assistants top-level tab.
- Assistants open only in the main pane. Memory and Settings remain under the assistant's top-right **⋯**.
- The ordinary right sidebar stays available across screens; preserve selected tab and open/closed state.
- Users name assistants and give work briefs in Conversation; assistants coordinate reusable workers across assigned projects. Do not add a cosmetic Team Member Type selector or a new type-label field. Preserve existing legacy labels/metadata.
- Assistant avatars default to the existing agents' colored, seeded 5×5 pixel style. Creation and Settings also offer Generate with AI: prompt → preview → explicit Apply; preserve the current avatar until Apply, plus Cancel, Regenerate and Reset to pixel.
- Creation and Settings use the same order: Name with Conversation work-brief guidance → AI model (Provider, Model, Reasoning) → Access (one Project tools control, plus Browser) → optional Avatar customization → Create/Save. Settings places Connected context and Skills & tools between Access and Avatar. A small identity preview may remain beside Name; add no separate work-brief field. Access includes Full access. Offer only supported reasoning values and preserve the original reusable Agents profile.
- Store generated assets durably on the owning host and persist non-secret asset references per assistant. The mockup uses visibly simulated sample artwork with no provider request or charge.
- Preserve all existing personal memories, correction/deletion chains, rules, pending approvals, tasks, monitor context and running Dashboard work.
- Reuse worktrees/checkout protection and four jobs per host/two per canonical project; do not add an executor or infer authorization from memory.
- Keep unsolicited work proposed until explicit approval/dismissal. Existing Full access remains visible and scoped by existing permissions.
- No production implementation, merge, installation, release build or new Electron development session is part of publishing this plan.

## Review Focus

1. Same `asst-1`, task ID or message ID on different hosts: never merge identities or route a result to the selected assistant. Covered in Tasks 1, 2 and 8.
2. Assistant/project switch during an async send, upload, approval or avatar generation: original owner receives the outcome and draft/attachment/candidate state stays separate. Covered in Tasks 2, 6 and 6A.
3. Legacy records, older hosts or unavailable model capabilities: preserve approvals/hashes and old profiles; reject unsupported settings and clearly disable unavailable additions. Covered in Tasks 1, 4 and 6A.
4. Concurrent project-note edits and stale approval/result delivery after restart: reject lost updates and never duplicate a mutation or dispatch. Covered in Tasks 3, 4, 5 and 8.
5. Silent working, paused adapters and offline machines: show lifecycle and uncertainty accurately without affecting unrelated tasks. Covered in Tasks 5, 7 and 8.

## Source map and dependency check

The implementation baseline is commit `661f847` plus the separate uncommitted Dashboard/Tasks patch in the shared checkout (currently `fix/expandable-plan-approval`). This publication branch starts from published `origin/main` and adds only the plan and mockup; it carries neither unrelated local commits nor that unfinished patch. Re-read AGENTS.md and current Git status before implementation. Independently review/integrate Dashboard work first; do not cherry-pick somebody else's dirty files into this branch.

| Responsibility | Existing files to reuse/modify | Proposed focused files |
| --- | --- | --- |
| Durable identity/runtime config and RPC | `crates/apex-host/src/personal.rs`, `personal_settings.rs`, `command.rs`, `events.rs`; `src/personalAssistant.ts`, `src/types.ts`, `src/models.ts`, `src/providers.ts` | `src/assistantIdentity.ts` |
| Registry and routing | `src/App.tsx`, `src/phone/PhoneApp.tsx`, `src/assistantRegistry.ts`, `src/assistantTaskModel.ts` | `src/usePersonalAssistants.ts` |
| Pixel editing and generated-avatar lifecycle | `src/Avatar.tsx`, `src/identicon.ts`, `src/HexColorPicker.tsx`, `src/PersonalPanels.tsx`, `src/media.ts`, `src/mediaPrice.ts`; existing provider adapter/credential storage | `src/assistantAvatar.ts`, `src/AssistantAvatarEditor.tsx`, `crates/apex-host/src/assistant_avatar.rs` |
| Runtime settings UI | `src/AgentPicker.tsx`, `src/BotSettings.tsx`, `src/models.ts`, `src/providers.ts` | Reuse existing discovery/control helpers in the assistant editor |
| Project memory | `personal_worker/context.rs`, `personal_settings.rs`, `monitor.rs`, `storage.rs`, `host.rs` | `crates/apex-host/src/project_memory.rs`; `src/projectMemory.ts` |
| Personal-to-coding bridge | `personal_worker.rs`, `assistant_service.rs`, `assistant_tasks.rs`, `assistant_conversation.rs`, `assistant_isolation.rs` | `crates/apex-host/src/assistant_delegation.rs` |
| Main view | `src/Sidebar.tsx`, `src/ApexAgentAll.tsx`, `src/PersonalPanels.tsx`, `src/App.tsx`, `src/types.ts`, existing personal CSS | `src/AssistantWorkspace.tsx`, `src/assistantWorkspaceModel.ts` |
| Global task feed | `src/RightPanel.tsx`, `src/RightDashboard.tsx`, `src/ApexAgentTasks.tsx`, `src/App.tsx`, `src/PopoutApp.tsx` | `src/workspaceTasks.ts`, `src/WorkspaceTasks.tsx` |

New names and RPCs below are implementation contracts, not already available APIs. Wire Rust fields with existing camelCase serialization and default/omit absent optional fields. Register new host modules in `lib.rs` and capability discovery beside the existing assistant capabilities.

### Task 1: Add stable identity, runtime configuration, appearance and explicit project bindings

**Files:** Modify personal/config/RPC/event files above and `src/personalAssistant.ts`; create `src/assistantIdentity.ts` and `tests/assistant-identity.test.mjs`; add Rust tests next to the changed host types.

**Interfaces:**
- `AssistantRef = { hostId: string; assistantId: string }` and `ProjectRef = { hostId: string; workspaceId: string; cwd: string }` in `assistantIdentity.ts`, with matching Rust structs.
- `assistantIdentityKey(ref: AssistantRef): string` uses JSON tuple `[hostId, assistantId]`; `projectIdentityKey(ref: ProjectRef): string` uses `[hostId, workspaceId, cwd]` after host-side canonicalization.
- `AssistantProjectBinding = { project: ProjectRef; tools: 'ask' | 'full' | 'off' }`.
- `AssistantAvatarAsset = {assetId:string; sha256:string; mime:'image/png'; width:number; height:number}`. Extend `PersonalSettings`/Rust settings with optional `look.seed`, `look.kind:'pixel'|'image'` and `look.image:AssistantAvatarAsset`; missing kind means pixel. Retain pixel seed/color/shape as fallback when image is selected.
- Expose the existing saved `profile:ParticipantConfig|null` in `PersonalAssistantRecord`; backend/model/effort/access remain the existing types. Runtime configuration stores an assistant-owned profile snapshot and non-secret provider/profile identifiers, never raw credentials. Keep name/style, legacy metadata and project bindings intact; no type-label field.
- New capability `assistant_workspace_v4`; versioned `personal_workspace_configure({assistantId,expectedRevision,settings?,profile?,projects?})` validates then atomically saves all supplied fields and returns the updated personal record. `settings` is `Partial<PersonalSettings>`; `profile` is a validated compatible `ParticipantConfig`, not a mutation of the reusable Agents record. Task 6A adds an optional owner-checked avatar selection to this transaction. Old `personal_configure` remains unchanged for legacy clients.

- [x] Add failing serialization/migration tests: old records retain facts/rules/approval hashes, saved look.color/shape and existing legacy labels/metadata after configuration saves; same assistant ID on different hosts has different keys; legacy display metadata never changes capabilities or identity; malformed refs cannot resolve a project; active project assignment cannot be removed.
- [x] Add failing runtime-setting tests: save/reload selected provider/backend/model/effort/access including `full`; reject effort outside a known model list; use null for empty/unknown effort capability; provider/model change cannot reuse a stale effort. Preserve the saved profile when discovery is unavailable, reject raw credentials, and leave the original reusable Agents profile unchanged. A stale revision or invalid submitted field leaves the complete saved name/profile/look/projects record unchanged and retains the editor draft.
- [x] Run `node --experimental-strip-types --test tests/assistant-identity.test.mjs` and `cargo test -p apex-host personal` to confirm the new assertions fail before implementation.
- [x] Implement additive settings and bindings. Validate name 1–64 trimmed characters. Preserve existing name/style fields and legacy labels/metadata without rewriting or deleting them; add no type-label setting. Canonicalize project paths on their owning host, validate explicit existing grants, and use expectedRevision. Keep legacy `TaskOwner` and keys unchanged.
- [x] Generate appearance once with `createAppearance`; legacy fallback uses stable host+assistant key while preserving saved color. Include all retained look fields in new versioned saves; preserve the existing replacement-style `personal_configure` behavior for legacy clients.
- [x] Implement versioned runtime profile updates using existing provider/model discovery and host compatibility validation. Validate effort metadata and access server-side, retain existing read-only personal reasoning calls, and intersect allowed actions with profile access, project tools mode, grants and existing approval rules. Full access never creates a machine/folder grant or auto-approves pending proposals.
- [x] Run the tests above plus `node --experimental-strip-types --test tests/identicon.test.mjs`; commit only this task's files.

**Deliverable:** Old records load unchanged; each assistant saves its own supported runtime settings, appearance and authorized local project assignments. Verified in `f41befd`; remote authority, unavailable catalogues and new image attachment fail closed as documented in [validation](../../assistant-workspace-validation.md).

### Task 2: Discover and select every durable assistant

**Files:** Create `src/usePersonalAssistants.ts`, `tests/personal-assistants.test.mjs`; modify `src/personalAssistant.ts`, `src/App.tsx`, `src/phone/PhoneApp.tsx`, existing bridge/push tests.

**Interfaces:** `usePersonalAssistants(options): { assistants: PersonalAssistantSummary[]; selected: AssistantRef | null; select(ref: AssistantRef): void; lane(ref: AssistantRef): PersonalLane | null; refresh(): Promise<void> }`; summary includes ref/name/look/offline/revision. Use existing `PersonalLane` operations with an immutable captured ref. Retain a compatibility adapter for phone callers until migrated in this task.

- [x] Add failing cases for two hosts both returning `asst-1`, multiple assistants on one host, unsupported/offline host, persisted selection, deleted selection and late replies after switching. Assert draft, attachment, reaction, approval, memory and machine-bridge arguments remain bound to their original identity.
- [x] Run `node --experimental-strip-types --test tests/personal-assistants.test.mjs tests/personal-bridge.test.mjs tests/personal-push.test.mjs` before implementing.
- [x] Replace first-host/first-record discovery with a collection keyed by AssistantRef. Support already-capable local and remote hosts without silently creating a local assistant. Deduplicate polling/bridge execution per identity; keep discovery active with assistant view closed.
- [x] Persist last valid selection in session state; use a visible existing fallback if an identity is removed, and retain offline identity rows with last-known freshness. Capture ref and request generation before async operations; update only that record on completion.
- [x] Route notification opens to their assistant ref and preserve the phone's existing conversation, push and command bridge behavior.
- [x] Run the same tests plus `npx tsc --noEmit`; commit scoped files.

**Deliverable:** Explicit, stable selection; changing the visible assistant never changes who owns an in-flight operation. Verified through `9d276ac`, including per-identity client-session draft retention; see [validation](../../assistant-workspace-validation.md).

### Task 3: Expose scoped project notes and inspectable memory operations

**Files:** Create host `project_memory.rs`, frontend `projectMemory.ts`, `tests/project-memory.test.mjs`; modify host module/command registration, `personal_settings.rs`, shared lifecycle helpers, monitor source reads and `src/PersonalPanels.tsx`. Add `project_memory_service.rs` for host authorization and delegation-context assembly; the tool-free personal prompt stays unchanged.

**Interfaces:**
- `ProjectNote` has `{id, project, text, kind, version, createdAt, updatedAt, author: AssistantRef|null, source:{taskId?,attempt?,runId?,scratchId?,messageId?}, expiresAt?,supersededBy?,deletedAt?}`. Manual human edits have null author and no fabricated task source.
- New capability `assistant_project_memory_v1`. Full/global RPCs `project_memory_list({assistant,project})`, `project_memory_save({assistant,project,id?,expectedVersion?,text,kind,expiresAt?})`, `project_memory_forget({assistant,project,id,expectedVersion})`; responses carry exact owner, current version and provenance. expectedVersion is required on edits, forbidden on creates. Reads revalidate assignment, canonical workspace/folder identity and current grants. Remote assignments fail closed until authenticated owning-host authority exists.
- Add durable `ProjectScratch` records via explicit `project_memory_stage({assistant,project,taskId,attempt,runId,expectedTaskRevision,text,kind})`. The host snapshots only an exact excerpt of the current completed attempt result, with immutable source bytes/IDs, capturedTaskRevision and 24-hour expiry. Explicit re-review may advance expectedTaskRevision before promotion while preserving source ID and expiry; already-promoted receipts stay immutable. Bring optional `AssistantTask.lineage` forward from Task 4 without changing TaskOwner or legacy hashes; unassigned legacy tasks cannot claim assistant provenance.
- New `project_memory_promote({assistant,project,taskId,attempt,runId,scratchId,expectedTaskRevision,expectedVersion?,promotionId})` accepts reviewed scratch only. The durable source key is `[project, taskId, attempt, scratchId]`; retrying with a different promotionId still returns the original receipt and cannot create another note. promotionId is a request/delivery identifier, not the note deduplication key.
- Host `assemble_delegation_context(assistant, project, brief, targetProfile)` returns bounded notes plus source IDs/versions; policy comes from validated host/privacy/action configuration, never a model-supplied grant. Quote notes as JSON evidence and enforce the total serialized character budget, including assignment, escaping and provenance, after per-scope selection. Private facts use at most 1/5 of the character budget, project notes 1/4, monitor sources 1/10; unknown destination providers receive no private facts.
- Per project: 500 active notes, 5000 historical notes, 2000 Unicode characters/note, 1000 current scratch records, 5000 retained scratch IDs and 10000 delivery IDs. Reject capacity overflow without dropping dedup history. Forget erases text across the complete correction chain and retained scratch copies; receipts contain no note text.

- [x] Add/run regression tests for assistant-private isolation; no unrelated project reads; authorized same-project sharing; unknown/offline owner; stale edits; correction-chain forget; no writes during reads; duplicate promotion of the same scratch returns its original receipt even when a retry has a fresh promotionId.
- [x] Add a test that untrusted memory text cannot grant capabilities and a test that private notes are excluded when target host/provider is not allowed. Assert monitor decisions remain project-scoped read-only sources, not duplicated writable notes.
- [x] Run focused RED checks for missing store/RPC/client behavior, then the full host and JavaScript suites after implementation; detailed RED and fixture caveats are recorded in validation and the ledger.
- [x] Persist project notes independently in `project-memory-v1.json` with the host's serialized durable mutation mechanism and per-note expected versions. Share existing Fact lifecycle helpers. Do not move private facts or existing monitor decisions. Default old personal facts to their original private identity.
- [x] Extend new personal-memory mutation requests with optional expected assistant revision; new UI supplies it, legacy clients retain existing behavior. Serve note ID/version/timestamps/source in the existing Memory panel, ready for its main-pane migration in Task 6.
- [x] Build bounded retrieval from assignment + permitted owning-assistant notes + selected-project notes. Workers retain scratch and cannot call durable mutation/promotion directly. Reject stale or mismatched promotion; accepting task completion is separate.
- [x] Run `npm test`, TypeScript, full `apex-host` and `apex-daemon` suites (including personal settings/worker regressions); commit scoped files.

**Deliverable:** Verified scoped notebook IDs/read results and versioned writes. 2,045 JavaScript tests and 727 Rust tests passed, with five existing explicitly ignored live/destructive checks. Independent source review found no remaining Important/Critical issue. Same-host-only authority, no production worker injection/promotion UI yet, and full main-pane migration in Task 6 are explicit phase boundaries; see [validation](../../assistant-workspace-validation.md).

### Task 4: Bridge personal plans into proposed coding tasks

**Files:** Create host `assistant_delegation.rs` and `tests/assistant-lineage.test.mjs`; modify `personal_worker.rs`, `assistant_service.rs`, `assistant_tasks.rs`, `assistant_conversation.rs`, `events.rs`, `command.rs`, `src/assistantTaskModel.ts`, `src/assistantRegistry.ts`.

**Interfaces:**
- `AssistantLineage = {assistant: AssistantRef; project: ProjectRef; sourceEventId: string; delegationId: string}`; optional/omitted `lineage` on old records and immutable on new ones.
- New versioned `personal_project_delegate({assistantId,project,sourceEventId,delegationId,brief,destination,mode,reviewCriteria,expectedRevision})` creates a durable proposal and returns `{taskId,project,lineage,status,receiptId}`.
- Internally call `assistant_handoff_prepare` with verified human origin and owner. Do not synthesize a human `assistant_message`.
- Owner tuple stays unchanged; new pending-request keys append encoded AssistantRef only when lineage is present. Old keys remain byte-for-byte compatible.

- [ ] Add failing tests: selected assistant cannot claim another's task; same-project tasks from two assistants remain distinguishable; legacy unassigned tasks retain approvals; retries deduplicate delegationId; a stale/wrong source event/project/monitor revision is rejected.
- [ ] Add a test that a proposed task stays proposed across restart and cannot execute without its required authorization. Test Full access only within the existing granted project/action scope; Off prevents delegation.
- [ ] Run `cargo test -p apex-host assistant_delegation`, `cargo test -p apex-host assistant_conversation`, and `node --experimental-strip-types --test tests/assistant-lineage.test.mjs tests/assistant-task-model.test.mjs tests/assistant-registry.test.mjs` before implementation.
- [ ] Validate bindings on assistant host and exact project owner on project host. Reuse existing authenticated routing, with durable delegation/result receipts and explicit uncertain status after ambiguous delivery. New payload/hash versions bind lineage; legacy requests omit it and retain existing behavior.
- [ ] Reuse worker eligibility, named destinations, registered profiles, scoped budgets, worktree executor and checkout/apply gate. Preserve original human request and selected note snapshot/source IDs. Do not route coding work to the research-only helper.
- [ ] Return each completion once to its recorded assistant event/project with provenance. Result delivery must work while another view/assistant is selected and survive duplicate notifications/reconnect.
- [ ] Run the same tests plus `cargo test -p apex-host assistant_service`; commit scoped files.

**Deliverable:** An assistant proposes real project coding work with auditable ownership; approved work uses the existing executor.

### Task 5: Implement independent pause, cancel, retry and restart reconciliation

**Files:** Modify `assistant_tasks.rs`, `assistant_service.rs`, `assistant_isolation.rs`, personal control/worker code, event/command schemas and frontend task types; extend host tests and `tests/assistant-task-model.test.mjs`.

**Interfaces:** Add task control metadata `{desiredState:'running'|'paused'|'cancelled', pauseReason:'assistant'|'manual'|null, controlRevision:number}` and actions `pause`/`resume` on the existing versioned task-action interface. Derive display states Pausing/Paused/Interrupted from durable control + adapter execution acknowledgment; never overwrite the legacy ledger status without a compatible migration.

- [ ] Add failing tests that pausing assistant A blocks A's new starts but leaves B and other projects running; manual pauses survive assistant Resume; queued tasks do not launch after pause; cancel only owns its task/process tree; retries create a new attempt and preserve old receipts/worktree.
- [ ] Add recovery tests for service restart during Pausing, an uncertain remote write, duplicate result delivery and stale resume/approval. No test may assert transparent resume for an adapter that cannot checkpoint.
- [ ] Run `cargo test -p apex-host assistant_tasks`, `cargo test -p apex-host assistant_isolation`, and the task-model tests before implementation.
- [ ] Request adapter safe checkpoints and acknowledge Paused only at a verified boundary. Unsupported checkpoint paths stop safely into Interrupted/Retry; show the reason. Personal pause remains prevention of new starts, monitor pause remains monitoring-only, and cancellation does not delete/apply work.
- [ ] Use canonical checkout locking across assistants and existing isolation queue limits. Persist control intent/receipt before acknowledgment and reuse `recover_interrupted` rather than rerun uncertain side effects.
- [ ] Run the tests above plus relevant personal pause/cancel/restart cases; commit scoped files.

**Deliverable:** Controls affect the identified work only; restart cannot silently start proposals or repeat uncertain operations.

### Task 6: Build Your team, main-pane assistants and runtime/pixel controls

**Files:** Create `src/AssistantWorkspace.tsx`, `src/assistantWorkspaceModel.ts`, `tests/assistant-workspace-model.test.mjs`; modify `src/Sidebar.tsx`, `src/App.tsx`, `src/ApexAgentAll.tsx`, `src/PersonalPanels.tsx`, `src/types.ts`, personal CSS and existing component tests. Reuse Avatar/HexColorPicker.

**Interfaces:** `MainView = {kind:'workspace'} | {kind:'assistant'; assistant:AssistantRef; section:'conversation'|'projects'|'activity'|'memory'|'settings'}`; `AssistantWorkspace` consumes selected PersonalLane, project bindings, scoped task snapshots and navigation callbacks. `ProjectSidebar` receives assistant summaries, selected ref, onOpenAssistant and onCreateAssistant.

- [ ] Add failing state tests for assistant selection, per-ref draft/scroll/attachment state, Memory/Settings Back, empty/error/offline roster and no changes to global panel.open/panel.active during navigation.
- [ ] Add form checks for name validation/save/reload and absence of a Team Member Type selector. Verify existing legacy labels/metadata survive a settings save and do not affect worker delegation or permissions. Verify a work brief sent in Conversation retains the owning assistant and original human-event provenance.
- [ ] Add runtime-control checks for both creation and Settings: Provider filters compatible configured providers; Model uses that provider's offered text models; Reasoning uses the selected model's supported levels or Provider default only when unknown; changing provider/model reconciles stale effort. Access includes Full access and save/reload retains the actual backend/model/effort/access. Missing provider/credentials or invalid settings block save with a concrete reason and preserve the existing record.
- [ ] Add avatar checks: valid six-digit hex input and the color picker update the same preview and persist; invalid hex blocks saving without altering the last valid color; rename retains seed/color; changing color retains seed; New pattern retains color; save/reload retains both; legacy look fields survive configuration. Reuse identicon tests rather than snapshotting a duplicate renderer.
- [ ] Run `node --experimental-strip-types --test tests/assistant-workspace-model.test.mjs tests/identicon.test.mjs tests/personal-panels-component.test.mjs tests/apex-agent-all-component.test.mjs` before implementation.
- [ ] Add borderless Your team rows and + using real records; retain the four production AppSection destinations and unchanged AgentsSection/profile workflow. Route assistants within the main canvas while keeping existing workspace sessions mounted.
- [ ] Parameterize `ApexAgentAll`'s singleton personal destination and conversation routing. Render Memory/Settings as main-pane subviews under ⋯; use the existing editor/actions. Order creation and Settings as Name with Conversation work-brief guidance → AI model (Provider, Model, Reasoning) → Access (one Project tools control, plus Browser) → Avatar + HexColorPicker + New pattern editor → Create/Save. Settings places Connected context and Skills & tools between Access and Avatar. Keep any small identity preview beside Name; add the Task 6A generation editor in the final Avatar section when its service contract is ready. Use Conversation for work briefs and coordination; add no separate work-brief field or type selector.
- [ ] Retire widget/floating/full-screen/mini state only after routing migration; migrate any relevant open selection without dropping conversations. Keep unused internal ApexAgent class/file names where renaming would be churn.
- [ ] Run tests above plus `npx tsc --noEmit`; review the already-running Electron window after backend dependencies are available; commit scoped files.

**Deliverable:** The agreed layout uses actual durable assistants, supported saved runtime settings and the existing pixel avatar design.

### Task 6A: Generate, preview and persist assistant avatars

**Files:** Create `crates/apex-host/src/assistant_avatar.rs`, `src/assistantAvatar.ts`, `src/AssistantAvatarEditor.tsx`, `tests/assistant-avatar.test.mjs`; modify host module/command/capability registration, `personal.rs`, `personal_settings.rs`, `src/personalAssistant.ts`, `src/Avatar.tsx` and Task 6's creation/Settings editor. Reuse existing media adapters, cost records, provider discovery and credential storage.

**Interfaces:**
- `AvatarDraftOwner = {kind:'assistant'; assistant:AssistantRef} | {kind:'creation'; hostId:string; draftId:string}`. `draftId` is a new random ID per creation editor; jobs never use a selected-row index or assistant name as owner.
- New capability `assistant_avatar_generation_v1`. `personal_avatar_options({owner})` returns configured image-capable `{providerProfileId,modelId,label,estimatedCostMicros:number|null}` options on that host; no compatible option explains the disabled Generate action without blocking pixel editing.
- `personal_avatar_generate({owner,generationId,editorToken,providerProfileId,modelId,prompt})` durably starts or returns the same job; `personal_avatar_status({owner,generationId})` reads it; `personal_avatar_cancel({owner,generationId})` marks it cancelled and requests provider cancellation. Job result `{owner,generationId,editorToken,state:'pending'|'preview'|'error'|'cancelled',candidate?:AssistantAvatarAsset,error?:string}` is owner-bound. Unknown remote outcome reconciles this ID; Regenerate uses a fresh ID after an explicit user action.
- Extend `personal_workspace_configure` with `avatar?:{kind:'image';generationId:string;assetId:string}|{kind:'pixel'}`. Settings Save after the editor's explicit Apply action validates owner/preview/hash and atomically persists submitted settings/profile/projects plus the selected candidate under one expected revision; absent avatar leaves the current image untouched. Creation's versioned `personal_create` accepts `{avatarDraftId,avatarGenerationId,avatarAssetId}` only after editor Apply and atomically attaches that candidate to its newly created assistant. Reset submits `{kind:'pixel'}` to clear the image reference while preserving seed/color/shape; clients cannot set arbitrary look.image references directly.
- `personal_avatar_asset({assistantId,assetId,sha256})` streams authenticated bytes from the owner host. Pending creation-preview reads require the matching authenticated draft owner and generation ID. The client creates a temporary object URL and revokes it on editor/cache disposal; profiles never store that URL.
- `AvatarEditorState` in `assistantAvatar.ts` tracks owner, editorToken, generationId, status, candidate and selected draft appearance. `reduceAvatarEditor(state,event)` rejects mismatched owner/token/generation; `AssistantAvatarEditor` emits an applied draft selection but does not save the assistant itself.

- [ ] Add failing host tests: text-only/unconfigured image model rejected; privacy/spend policy checked; duplicate Generate with one ID causes one provider call; error/cancel/ambiguous retry keeps the applied avatar; cancelled or stale-generation completion cannot be applied; cross-owner asset reads/apply rejected; stale expectedRevision leaves the current image untouched.
- [ ] Add failing storage tests: inputs other than PNG/JPEG/WebP, payloads over 10 MiB, zero or greater-than-4096 edge dimensions, malformed decode and hash mismatch rejected; accepted inputs normalize to 512×512 PNG; durable byte write precedes reference save; creation candidate attaches only on Create; saved asset survives restart and is fetched by another client; offline/cache-miss uses the saved pixel fallback. Garbage collection after 24 hours removes unreferenced candidates only and cannot race an active attach/save.
- [ ] Add failing editor tests: prompt → pending → preview needs explicit Apply in creation and Settings; current avatar remains until Apply; Cancel/close discards unsaved candidate/selection; Regenerate invalidates the previous token; switching assistant during generation never replaces the other editor; rename/runtime changes preserve the image; Pixel-tab navigation alone preserves the selected image, while Reset to pixel/Use pixel pattern/New pattern explicitly selects pixel and persists on Create/Save. A conflicting full-form save changes no saved fields and preserves the draft for refresh/retry.
- [ ] Run `cargo test -p apex-host assistant_avatar` and `node --experimental-strip-types --test tests/assistant-avatar.test.mjs tests/assistant-workspace-model.test.mjs tests/identicon.test.mjs` to confirm the new assertions fail before implementation.
- [ ] Implement the host job ledger and durable candidate store under the existing assistant data directory, with a draft namespace for unsaved assistants and content-hashed asset bytes. Validate/normalize the image as specified, record reported/estimated/unknown cost in existing cost records even if the user cancels after provider dispatch, and resolve credentials only through the existing store. Never restart a paid call automatically after an uncertain outcome or service restart.
- [ ] Implement the reducer/editor and shared Avatar image resolution with pixel fallback. Display selected image provider/model and estimate/unknown cost before Generate; show pending/error/cancel/retry states, disable Apply without a valid candidate, and capture immutable owner/token/generation arguments on every async operation. Settings Save/creation Create persist only the explicitly applied selection; leave saved look untouched on error or cancellation.
- [ ] Run the tests above plus `npx tsc --noEmit`; verify a fixture-generated asset's saved reference and authenticated bytes after reload; commit scoped files. Use stub image adapters for all automated checks and plan review, without live provider billing.

**Deliverable:** Both editors support optional AI generation with explicit selection and durable per-assistant assets; pixel editing remains available independently.

### Task 7: Aggregate global Dashboard/Tasks without changing sidebar ownership

**Files:** Create `src/workspaceTasks.ts`, `src/WorkspaceTasks.tsx`, `tests/workspace-tasks.test.mjs`; modify `src/App.tsx`, `src/PopoutApp.tsx`, `src/RightDashboard.tsx`, `src/ApexAgentTasks.tsx`, `src/assistantRegistry.ts`, panel CSS/tests after the separate Dashboard patch lands.

**Interfaces:** `WorkspaceTaskRow = {key:string; source:'personal'|'project'; assistant:AssistantRef|null; project:ProjectRef|null; taskId:string; title:string; status:string; updatedAt:number; offline:boolean}`; `collectWorkspaceTasks(personalSnapshots, projectSnapshots): WorkspaceTaskRow[]` uses durable identity/lineage keys and keeps legacy rows visible.

- [ ] Add failing tests for all three projects visible regardless of focused pane; duplicate local IDs on distinct hosts; legacy unassigned rows; assistant/project/text filters; exact-owner detail/action routing; stale/offline sources retained with freshness.
- [ ] Test global right-panel open/selection and collapsed groups through Agents → assistant → project → Memory → Settings → popout. Test silent thinking/queued work stays Working, while actual waiting/approval/completion states take precedence.
- [ ] Run `node --experimental-strip-types --test tests/workspace-tasks.test.mjs tests/right-panel-model.test.mjs tests/right-panel-component.test.mjs tests/thread-pane-status.test.mjs tests/dashboard-navigation.test.mjs tests/dashboard-opening.test.mjs` before implementation.
- [ ] Aggregate existing live stores without embedding the assistant composer in Tasks. Open selected task detail through its owning backend/project and retain exact revision-bound review/actions. Avoid showing one delegated task twice as a personal and project result.
- [ ] Reuse existing collapse persistence, lifecycle status and dashboardNavigation/MenuList behavior including popouts, keyboard context menus, unavailable destinations and session reuse/swap. Keep the existing global RightPanel owner outside page branches.
- [ ] Run the same tests plus right-dashboard/assistant-tasks component checks and `npx tsc --noEmit`; commit scoped files.

**Deliverable:** A trustworthy whole-workspace sidebar, independent of which assistant or project is open.

### Task 8: Prove concurrency and preservation, then hand off one smoke test

**Files:** Extend `tests/e2e/assistant-delegation.e2e.mjs` and `tests/e2e/multi-host.e2e.mjs`; add `docs/assistant-workspace-validation.md` with evidence and known limits.

**Interfaces:** Exercise the exact RPCs and contracts from Tasks 1–7, including Task 6A, against temporary fixture stores and registered deterministic worker/image adapters. No live production memory, billable image generation or repository mutation is needed for automated verification.

- [ ] Add an E2E fixture with two assistants, three canonical project roots, same local ID on different hosts, private facts per assistant, project-only notes, and three active approved isolated worker tasks. Assert each sees only its authorized assignment/context and receives its own result.
- [ ] Pause/cancel/retry one owner while other projects progress. Restart the daemon and reconnect a host. Assert retained attempts, stable IDs/avatars, no duplicated dispatch/result, pending approvals intact and uncertain operations not rerun.
- [ ] Have a worker propose scratch, reject promotion without review, accept one reviewed promotion, repeat its request and verify one note/version. Reject stale concurrent edits and validate correction/forget retrieval.
- [ ] Save supported runtime settings for each assistant, create one stub-generated avatar through preview/Apply/Create, edit the other's avatar through preview/Apply/Save, and fetch both after restart from a second client. Assert independent asset hashes, stale completion rejection, cancel/reset behavior, pixel fallback offline and unchanged source Agents profiles.
- [ ] Run `npx tsc --noEmit`, `npm test`, `cargo test -p apex-host`, then `npm run test:e2e`. Run `git diff --check`. Stop to fix relevant failures; record unrelated baseline failures explicitly rather than claiming the suite passed.
- [ ] Independently review ownership, migrations, shared schemas and main-pane/sidebar behavior. Record exact source commit, test output, application process path and which evidence is automated versus observed.
- [ ] Perform one concise smoke test in the existing Electron development window: select/create/rename two assistants, save Provider/Model/Reasoning/Full access and pixel/generated avatars using a fixture image adapter, delegate across three test projects, inspect scoped memory and pending approval, pause one owner, navigate all screens with Tasks open, then verify restart recovery. Compare durable records before/after; no data reset or paid generation is required for this gate.
- [ ] Publish the validation report for user review. Installed-app replacement, release packaging, merge and shipping remain separate from this plan publication.

**Deliverable:** Verified concurrent behavior and preservation, with one clear reviewable artifact and no claim that a simulated preview proves production behavior.

## Coordination and integration

- Null owns shared interfaces, scope, integration and independent final verification. Deepgeek can implement/review a bounded backend memory/delegation task after the interface gate, in an isolated branch; UI tasks can proceed separately after Task 1/2 contracts stabilize.
- Do not let two workers edit `App.tsx`, RPC schemas or common task types concurrently. Integrate shared contracts first; each task includes meaningful tests and a scoped commit.
- Existing Dashboard work is a prerequisite patch, not part of this documentation push. Preserve it in its current checkout and review it independently.
- The included `mockups/apex-dot` is the visual/interaction reference only. Its simplified Agents screen and browser-local simulation are explicitly not implementation instructions for replacing current components or runtime semantics. Avatar generation uses bundled samples and visibly says **Simulated preview — sample artwork; no provider request or charge**; its illustrative provider/model/reasoning choices do not prove live capability discovery.
- No OpenAI Dot service, private memory endpoint or captured system prompt is required.
