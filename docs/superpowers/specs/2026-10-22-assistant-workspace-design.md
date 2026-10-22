# Named assistants and concurrent project coordination

## Intent and approval boundary

Replace the personal-assistant widget with named assistants in the main pane. An assistant can coordinate reusable coding agents across several projects while keeping personal memory separate from each project's shared knowledge. This document records the conversation-approved layout and the implementation decisions below. The accompanying implementation plan and browser-local mockup are review artifacts; publishing them does not implement or authorize shipping the production feature.

## Product requirements from the conversation

- Preserve the existing production **Agents** tab and its reusable worker profiles. Do not replace it with the preview's worker cards or add an Assistants top-level tab.
- Put named assistants in borderless rows under **Your team** in the left sidebar; **+** creates another. Users name an assistant and give it a work brief in Conversation; the assistant coordinates reusable workers across assigned projects. All assistants share these capabilities. Do not add a cosmetic Team Member Type selector or a new type-label field. Preserve existing legacy labels/metadata in stored records without exposing a required type choice.
- Assistant avatars default to the existing agents' colored, seeded 5×5 pixel style. Use the same applied avatar in the roster, header, conversation, and project ownership references. Permit palette colors, a custom color picker with an editable six-digit hex value, and New pattern; rename must preserve appearance. Creation and Settings also offer **Generate with AI**: enter a prompt, generate a preview, then explicitly **Apply**. Keep the current avatar until Apply; offer Cancel, Regenerate and Reset to pixel.
- Creation and Settings use the same order: Name with guidance to give the work brief in Conversation → AI model (Provider, Model, Reasoning) → Access (one Project tools control, plus Browser) → optional Avatar customization → Create/Save. Settings places Connected context and Skills & tools between Access and Avatar. A small identity preview may remain beside Name; do not add a separate work-brief field. Access includes **Full access**. Reuse existing provider/model discovery and access controls; offer reasoning values supported by the selected model. Provider/model changes must reconcile incompatible reasoning settings. These controls configure the assistant without modifying the reusable Agents profile from which it was initialized.
- Assistants open only in the main pane. Remove the assistant widget, floating overlay, Mini and alongside-work presentations after migration. Keep project/chat sessions alive when navigating.
- Conversation, Projects and Activity are assistant subviews. **Memory** and **Settings** live under the assistant header's top-right **⋯**, open in the main pane, and offer Back to the preceding subview.
- The ordinary right sidebar stays available across screens. Dashboard and Tasks remain global; preserve the selected tab and open/closed state when switching assistants, projects and settings. Details and other regular tabs retain their existing purposes.
- Use compact Dashboard/Tasks rows, meaningful assistant/project attribution, collapsible categories with saved choices, and lifecycle-based Working status that does not expire during silent work.
- Dashboard items support New Pane, External Pane, and Open in Pane using existing pane/session routing, including disabled reasons and keyboard context menus.
- Two named assistants must coordinate three projects concurrently. Every task has a known assistant, project, worker/thread, attempt and outcome. Isolation, explicit review, cancellation and restart recovery must remain trustworthy.
- Give assistants private lasting notes, projects separate shared notebooks, and workers task scratch/results. Workers may propose notes; reviewed promotion is a distinct action. Accepting work must not silently save memory.
- Preserve existing personal memories, corrections/deletions, rules, pending approvals, task histories, monitor context, worker profiles and running Dashboard work.

## Verified source baseline

Inspected canonical checkout: commit `661f847`, with additional uncommitted Dashboard/Tasks changes on 2026-10-22. At publication the shared checkout is on `fix/expandable-plan-approval`; branch names are mutable, so verify status before integration. The publication branch starts from published `origin/main` and adds only this plan and mockup; it deliberately excludes unrelated local commits and unfinished source edits. The inspected local implementation baseline remains `661f847`, so implementation must reconcile that baseline before starting. Integrators must resolve that dependency before applying the sidebar work.

| Existing foundation | Current limitation |
| --- | --- |
| `personal.rs`: durable `PersonalDocument.assistants`, `personal_create/list/get`, per-identity facts/conversation/rules/tasks | Frontend `usePersonalAssistant` picks the first record on the first populated remote host |
| `personal_settings.rs`: `personal_memory_add/correct/forget`; `personal_worker/context.rs` selects relevant facts | No personal-to-project notebook/delegation bridge |
| `monitor.rs`: project responsibility, decisions, preferences, findings and context | One monitor per workspace; replacing it can change conversation ownership and is blocked during unfinished work |
| `assistant_tasks.rs`, `assistant_service.rs`: durable coding ledger, preparations, approvals, execution threads, reviews and retries | `TaskOwner` identifies host/workspace/folder/monitor conversation, not a personal assistant |
| `assistant_isolation.rs`: worktrees, checkout protection, four jobs per host/two per canonical project | Personal helpers are no-tools research calls; they are not this coding executor |
| `Avatar.tsx`, `identicon.ts`, `HexColorPicker.tsx` | Personal `look` has color/shape but no saved seed or generated-asset reference |
| `types.ts`, `models.ts`, `providers.ts`, `AgentPicker.tsx`, `BotSettings.tsx`; host `PersonalAssistant.profile` | Model/effort/access data exists, but personal configuration does not yet expose a versioned runtime-profile update or assistant-avatar generation flow |
| `App.tsx`, `RightPanel.tsx`: global right-panel owner and persisted state | Tasks content is selected-project-only; assistant currently uses a floating `ApexAgentAll` overlay |
| Uncommitted `RightDashboard`, `dashboardNavigation`, `composerStatus` changes | Need review/integration, not reimplementation; they already address collapses, pane actions and silent Working |

These are client and host implementation findings. OpenAI's Dot backend, memory system and private instructions are not a dependency or a recovered implementation.

## Architecture decisions for the builder

These are proposed implementation choices, distinct from the user's visual decisions.

### Identity and project boundaries

Use `AssistantRef = { hostId, assistantId }`, where hostId is the durable assistant host. Assistant IDs such as `asst-1` repeat across hosts. Project identity is `ProjectRef = { hostId, workspaceId, cwd }`, with cwd canonicalized by the project host. Project host and assistant host may differ. Names, legacy labels/metadata, avatars and provider-profile IDs are never authorization or storage keys.

An assistant-project binding is an explicit persistent assignment with an allowed project-tools mode: Ask first, Full access, or Off. Assignment is a context/routing link, not new machine access. Existing machine/folder grants, provider capabilities, privacy restrictions, budgets, and action rules still apply. Full access expresses the user's existing scoped authorization; it must remain visible and must never create an implicit grant.

Retain one project monitor per workspace initially. Several assistants can reference that project without replacing its monitor. Project execution and memory stay on the project host. For different hosts, requests use the existing authenticated host routing, bind both refs and a durable idempotency key, and record uncertain/acknowledged states. Do not acknowledge a remote mutation until its durable receipt is available.

### Persistence and migration

Extend personal records additively with optional `look.seed`, `look.kind` (`pixel` or `image`), a generated `look.image` asset reference, and project bindings. Missing `look.kind` means pixel. Do not add `typeLabel` or migrate/delete existing legacy labels/metadata to remove the selector. Work briefs use the existing Conversation message flow and human-event provenance. On old records, derive missing appearance from stable host+assistant identity, preserve saved color and shape, and persist the seed on the next explicit save. Reuse `Avatar`, `createAppearance`, `legacyAppearance` and `HexColorPicker`; extend the shared avatar component to resolve applied images and use the saved pixel appearance while an image is unavailable. Configuration currently replaces `look`, so updates must preserve untouched seed/color/shape/image fields.

Keep the existing four-field `TaskOwner` and its legacy keys intact. Add optional `lineage` on new delegated records, preparations, execution entries, requests and results: owning `AssistantRef`, exact `ProjectRef`, originating personal event ID, and delegation idempotency key. New receipt/approval hashes bind lineage; old records without lineage retain their original hashes and remain visibly Legacy/unassigned. Never assign old tasks to whichever assistant is selected.

Version new payloads/capabilities. An older host must retain legacy functionality and explain why multi-assistant delegation is unavailable. Unknown fields must not be sent to existing `deny_unknown_fields` handlers without negotiated support.

### Runtime configuration and AI avatars

Use the existing `ParticipantConfig` backend/model, effort and `Access` representations for the assistant's saved runtime profile. Initialize from a compatible reusable profile as an assistant-owned snapshot; saving assistant settings must not edit that original Agents profile. Discover configured providers on the assistant's host, use actual offered text models and their capability metadata, and validate the same choices server-side. Known effort lists are authoritative; an empty list means no reasoning control. For unknown capabilities, keep Provider default (`effort: null`) unless the provider's existing discovery path establishes supported values. Never silently send a stale unsupported effort after changing provider/model. Saving without a supported runtime configuration remains unavailable with a concrete reason; old stored profiles are retained so the user can repair missing credentials or a removed model. Existing personal planning remains read-only; the saved access choice is a ceiling on allowed assisted actions, intersected with project tools mode, machine/folder grants and existing action/approval policy. Full access creates no new grant.

Image generation is a separate capability from text reasoning. Offer an explicitly configured image-capable provider/model available on the assistant host; the conversation model need not generate pictures. Reuse the existing provider credential store, image model metadata/adapter and applicable privacy/spending gates. Keep API keys, bearer tokens and signed download URLs out of assistant profiles, generation history, asset references and client logs. Store only non-secret provider/profile/model identifiers. Show provider/model and the available cost estimate or unknown-cost state before Generate; a missing or unsupported image configuration leaves pixel editing available and explains how to configure generation.

The editor owns a draft keyed by `AssistantRef` or a unique creation-draft ID. Generating creates a pending candidate, never an applied identity change. The sequence is prompt → pending → preview → explicit Apply; pending, error, cancel and retry states keep the currently applied avatar visible throughout the app. Apply selects the candidate in the editor; creation's Create or Settings' Save persists that selection with an expected assistant revision. Cancel or leaving the editor discards unsaved candidate/selection state. Regenerate starts a new explicit generation; retry after an ambiguous response first reconciles the existing request ID and cannot silently bill twice. Switching to the Pixel tab alone preserves the selected image; Reset to pixel (or Use pixel pattern/New pattern) explicitly selects the retained seed/color/shape in the editor and persists only on Create/Save. Renaming or changing runtime settings preserves the applied image and pixel fallback.

Bind every image job and candidate to its assistant or creation-draft owner, a generation ID and editor generation token. Switching assistants, cancelling, closing the editor or starting a newer generation invalidates older tokens. A late completion may update its own job receipt but cannot change another draft, the selected assistant or the applied avatar. Cancellation requests provider cancellation where supported and prevents later application; a completed provider charge remains recorded. Recovery may read an existing job/receipt, but never automatically starts a fresh paid generation. Provider failures and decode/download failures are retryable with a visible reason; Apply is disabled until a validated candidate exists.

The assistant host owns generated image bytes. Accept PNG, JPEG or WebP inputs up to 10 MiB with positive decoded dimensions no greater than 4096×4096; reject unsupported or malformed data, center-crop to square and normalize to 512×512 PNG, hash the final bytes, and write them durably before returning a candidate. Persist an asset reference `{assetId, sha256, mime, width, height}` per assistant, resolved through authenticated host routing; do not persist expiring provider URLs or base64 image data in profile JSON. Creation candidates remain in a draft namespace until Create attaches them to the new assistant. Settings Save validates and atomically persists the complete submitted name/runtime/appearance draft with one expected assistant revision; Create likewise attaches the selected candidate in its creation transaction. A conflict leaves the saved record unchanged and retains the user's editor draft for refresh/retry. Connected clients fetch/cache by host/assistant/asset/hash, verify content and retain a pixel fallback offline. Sync metadata and authenticated asset bytes through the existing host route; changing the selected assistant must never reuse another assistant's cached image. Unapplied candidates expire after 24 hours; garbage collection removes only unreferenced assets and never races an active save or deletes the current applied asset.

### Memory and context assembly

Private assistant facts stay in the existing personal store on the assistant host. Reuse Fact provenance, relevance selection, expiry, correction chains and forget semantics. Add version-checked changes for new clients without changing old approval meanings.

Add a durable project-note document, `project-memory-v1.json`, owned by the project host and indexed by canonical `ProjectRef`. Keep it independent of monitor replacement and `session.json`. Reuse Fact lifecycle semantics in a shared helper, with note IDs, per-note versions, timestamps, author/source task/attempt and supersession/deletion metadata. Existing monitor decisions/preferences remain authoritative project context; project notebook queries can expose them read-only with provenance rather than copying them into two writable stores.

Assemble each worker brief from its assignment and bounded relevant notes from the owning assistant and selected project only. Private assistant notes may be sent only to an approved project host/provider under current privacy and endpoint rules. Default to the assignment alone when private context sharing is not authorized. Another assistant's private notes, unrelated project notes and whole chat histories are excluded. Notes are untrusted context and cannot grant tools, spending, sending or machine access.

Store worker observations as task/attempt scratch. A proposal to promote includes destination project, source task/attempt and expected note version; the human explicitly reviews it. Promotion has a stable source key `[project, taskId, attempt, scratchId]`; retries with new delivery/request IDs return the original receipt. Reject stale versions, wrong project/assistant, unapproved sources and forgotten/superseded data. Forgetting removes active retrieval across correction chains; already issued task snapshots are historical evidence and are not silently rewritten or claimed erased.

### Delegation, control and recovery

Personal planning calls an explicit proposed-handoff bridge into `assistant_handoff_prepare`, preserving the original human-event provenance. Do not disguise generated text as a new human `assistant_message`. Existing scoped authorizations may allow requested starts; unsolicited suggestions remain pending for approval/dismissal. Changing selection, names, assignments, or views never approves or dispatches work.

Reuse coding execution/worktree queues and four-per-host/two-per-project limits. Serialize unsafe writes/apply operations by actual canonical checkout, regardless of assistant. Do not route coding writes through the weaker per-personal-assistant command lock. Results return exactly once to the recorded owning assistant/event/project, including when that assistant is not visible.

Define Pause honestly. Personal Pause prevents new starts for that assistant, requests a pause checkpoint for its delegated coding tasks, and shows Pausing until active noninterruptible work reaches a safe boundary. A checkpointed task can resume its existing attempt/thread; if an adapter cannot checkpoint, stop it and expose Interrupted/Retry with a new attempt instead of promising transparent resume. Manual task pauses remain manual after assistant Resume. Monitor pause remains a separate control for monitoring. Cancel targets only owned processes for one task and never deletes its worktree or automatically applies results.

Persist desired control state, idempotency keys, result-delivery receipts, scratch/promotion decisions and attempt lineage before reporting success. Reconcile service restart/disconnection without redispatching uncertain writes, spending, sending, old approvals, or completed handoffs.

### UI state and aggregation

Introduce a main-pane route separate from the existing four `AppSection` destinations. Preserve mounted workspace sessions. Keep assistant draft, reply/attachment destination, transcript position and subview state keyed by AssistantRef. Late replies refresh their original record; they cannot replace the active assistant.

Aggregate Dashboard/Tasks across existing project task snapshots and personal tasks using namespaced IDs, host, owner and source kind. Deduplicate by durable lineage, not display labels. Preserve legacy tasks and pending actions. Clicking a row opens the correct host/project/task; state changes and approvals remain exact-owner/revision-bound. Offline hosts show last-known state and freshness, with actions unavailable when their owner cannot be verified.

Keep existing production Agents profile editing, @mention rules and backend kind values. The preview's simplified Agents view illustrates separation only; it is not a replacement spec.

## Delivery order and dependencies

1. Preserve and integrate the existing Dashboard/Tasks patch separately after review.
2. Add safe identity/runtime configuration fields and project bindings, then collection/selection, pixel editing and the independently testable generated-avatar service/editor.
3. Add scoped project memory and inspected retrieval before allowing memory into delegated briefs.
4. Bridge personal planning into the existing proposed coding-task flow with durable lineage.
5. Add independent pause/cancel/recovery and cross-host receipts.
6. Move assistants into the agreed main-pane UI and aggregate global task views.
7. Prove two assistants/three projects together; ship only after the actual app is reviewed.

UI identity selection/avatar work can run alongside the memory backend after shared interfaces are accepted. Delegation depends on both. One integrator owns shared RPC/types and final verification.

## Acceptance and limits

The browser mockup is simulated and browser-local. Avatar generation must visibly say **Simulated preview — sample artwork; no provider request or charge** and use bundled sample assets; provider/model/reasoning/access choices illustrate the contract without claiming live capability discovery. Do not include live keys or billable generation calls in the mockup.

The production gate is two named assistants on distinguishable stable identities, assigned to three isolated test projects, each coordinating real registered workers. Verify private memory isolation, project-scoped shared notes, explicit promotion, stable avatars/names, supported runtime settings after save/reload, generated-asset persistence and client fetch, Apply/cancel/reset semantics, stale-generation isolation, attributable global status, safe pause/cancel/retry, offline behavior, service restart recovery and unchanged existing Agents profiles/approvals.

Use automated fixtures/stub adapters for deterministic E2E and one concise smoke test in the already-running Electron development window. Do not open a second dev session or replace the installed app for plan review. A unit test or mockup is not installed-app verification. Packaging/release is a separate authorized phase.

Out of scope: cloning Dot's private runtime, integrating a custom Dot into OpenAI's backend, changing worker transport names, replacing worker profiles, automatic semantic memory sharing, vectors/embeddings, an additional pixel-identicon engine, multiple monitors per project, and adding a new autonomous executor. AI avatar generation reuses configured image providers; it does not add a provider credential system.
