# Apex Assistant: simplify the task, not just the tabs

## Settings feature parity: prototype v4

The earlier mockup also reduced Settings too far: provider selection was absent, avatar editing was a placeholder, and the advanced preferences supported in `PersonalPanels.tsx` were not represented. V4 restores the following without changing the live app:

- General: name and the same shared pixel/color/AI avatar editor used during creation, including preview/use/discard.
- Model: configured provider, offered model, supported reasoning. Provider changes reconcile model and reasoning.
- Project tools and a direct projects/folder-access route. Folder grants remain separately confirmed; Full access stays explicit.
- Reply style, timezone, quiet hours, daily spend limit, unknown-cost preference, local-only privacy, allowed endpoints, and context budget.
- Shared regular-chat voice settings, private memory and project notebooks.
- Machine/service connections, Read/Write/Send/Spend action modes, and add/remove standing rules. Spending is not silently enabled; standing rules can only tighten requirements.
- Cost history with reported/estimated/unknown amounts kept distinct, and routes for schedules and notices. The prototype does not load actual costs, schedules, connection states, or notices, and does not simulate a live authentication exchange.
- One visible Save/Discard bar for the main settings draft. Main form settings do not apply just because an avatar is selected or a subview is opened. Tool/rule actions remain visibly separate. Preserve existing expected-revision, owner, and host checks in implementation.

Settings draft checks passed in the rendered prototype: change name/provider/reasoning, select an AI avatar preview, open projects, open memory, return to Settings, and retain all draft values. The visible assistant identity stays unchanged until Save. Discard resets the main draft. Provider reconciliation, rule editing, rule-mode retention when switching Connections/Rules, and main Save were also exercised. A clipped sticky save bar was corrected and its bounds checked inside the viewport. The prototype script passed syntax checking and browser logs showed no warnings/errors during those flows.

Source anchors: `src/AssistantEditor.tsx` for the current named Settings form; `src/AssistantAvatarEditor.tsx` for avatar capabilities; `src/PersonalPanels.tsx` for advanced settings, action modes, standing rules, connections, costs, schedules, and notices. This inventory is a capability-preservation requirement, not a claim that the mockup is a functioning settings backend.

## Add teammate feature parity: prototype v3

The original prototype reduced creation to Name and Model. This was an omission, not an agreed removal of capabilities. V3 restores visible Provider, Model, Reasoning, Project tools, optional First brief, and expandable Machine & folder controls, plus a visible Customize avatar entry point.

Customize avatar includes pixel color, pattern shuffle, AI image-provider selection, a prompt, preview, use, and discard. ChatGPT Images remains an available image-generation route alongside a configured image provider. All generation is simulated and labeled as an example in this prototype. Selecting a preview preserves the name, first brief, model, and access draft.

Checked the installed Add teammate modal as well as source: Provider, Model, Reasoning, access, First brief, and Machine/Folder are still available there. Its avatar control currently offers only New avatar pattern. `git show 9f4e226:src/AssistantEditor.tsx` confirms that the earlier creation form mounted `AssistantAvatarEditor`, with pixel color and AI generation. The shortened creation form introduced in `b68aab6` omits that editor, while Settings still mounts it. This is a concrete creation-time avatar regression to restore in implementation.

Production parity requirements:

- Retain configured, compatible provider discovery, text-model filtering, supported reasoning options, and owning-machine validation; do not populate unsupported choices just to lengthen the list.
- Keep Full access explicit, bounded by the granted folder. Make the selected machine, folder, and access visible in the creation summary, including when advanced options are collapsed.
- First brief becomes a composer draft after creation. Do not silently send or dispatch it.
- Preserve draft values while customizing an avatar or changing provider. Reconcile model/reasoning choices against the selected provider; bind image jobs to their original creation owner and machine.
- Keep both pixel customization and the full AI avatar preview/apply/discard flow available before creation. Closing cancels/discards the creation draft according to the existing lifecycle.
- Connect existing projects through the existing exact-folder grant and assignment flow; do not grant access implicitly when creating a teammate.

Prototype checks: creation-time AI image options, generating a labeled sample preview, selecting it, preserving the entered name and first brief, and exposing machine/folder settings. The live Add teammate modal was closed without creating anything. No real image generation, assistant, access grant, or first-brief dispatch occurred.

## User refinements incorporated in prototype v2

- **No left borders on any cards.** Remove decorative side accents entirely. Card, notice, and browser surfaces use a fill and spacing, with no left border. This applies to every task status and both themes.
- **Cancel and delete tasks across their lifecycle.** Each Work row and task detail has a task-specific actions menu. Pending, blocked, result-ready, and queued work can be cancelled without deletion. Pending/active deletion explicitly cancels first, then removes the task from Chat and Work. Finished, old, and already-cancelled tasks offer Delete directly. Undo and Deleted tasks provide restoration. Restoring a task cancelled by deletion must not restart it. This is a reversible deletion design, not a permanent purge of audit records. Existing project files and saved project notes are not deleted.
- **Use regular chat's default voice model and UX in assistant chat.** Reuse the existing voice engine/model selection, app-wide default, call coordinator, mic/send behavior, call bar or saved appearance, mute, voice picker, and End controls. An unset voice follows the shared default; a deliberate call-time override affects only this chat. Do not create a second assistant-specific voice setup. The prototype simulates these controls and requests no microphone access.
- **Open the browser in a mini popup inside Chat by default.** Keep the chat composer and draft available. Expand the same browser tab into the main pane on demand, then shrink it back. Tab, profile, cookies, navigation, and control ownership must remain the same across both views. Closing the view must not close the task or silently return control to the assistant.

Additional source evidence for voice parity: `src/ApexAgentAll.tsx` currently launches `PersonalCall`, which uses `src/personalSpeech.ts` and system/browser speech. Regular chat uses `src/voice/VoiceCallControls.tsx`, `coordinator.ts`, and `settings.ts`. The production change must bridge the assistant conversation into that shared stack rather than merely relabel the old voice screen. The saved app default is authoritative; `am_michael` is only the fallback in source, not a verified current user preference.

The v2 task examples include pending, result-ready, blocked, finished, old cancelled, and queued work. The action menus and Deleted tasks share one in-memory task list so deletion and counts agree across views.

V2 browser interactions checked: popup opening in Chat; Take over; expansion into the main pane; shrinking to the popup; control ownership and typed chat draft preserved; closing the view without returning control. Voice interactions checked: shared-default picker, mute/unmute state, End, and empty-composer mic versus typed-message Send. Task interactions checked: pending Cancel and delete, Undo/restore without restarting, and separate deletion of completed and old cancelled tasks. These checks apply to the simulated prototype only.

Design review of the running installed application on October 23, 2026. Read-only native navigation, source inspection, and a separate interactive prototype. No task, permission, assistant setting, project file, or installed build was changed.

## What I observed

The current app already has Chat and Work. That is a useful starting point, but different task systems still show different detail screens, actions, status, and return paths.

| Priority | Observed problem | User cost | Proposed change |
| --- | --- | --- | --- |
| Critical | A delegated task says Needs you. Its detail offers Pause, Cancel, and Review task in project. The actual startup failure is buried under Worker result. | There is no obvious way to resolve the reason it stopped. | Lead with Couldn't start, plain-language cause, whether execution started, and Review options. Show only recovery choices verified as supported on that machine. |
| Critical | In this session, Review task in project left the assistant and displayed the existing Forge FIX chat while the side panel remained on Dashboard. | The user loses task context and lands on unrelated visible content. | Open the same task detail from Chat, Work, project views, and notifications. Opening a project must be a distinct secondary action. |
| High | Work showed the blocked task while its project card said Not connected and No active assignments. | The same task appears to exist and not exist. | Use one owner-verified task snapshot for rows, project totals, header, and sidebar. Loading, stale cached data, and offline are separate states. |
| High | Opening Review in Work inserted a large task detail inside the Projects section below the still-visible attention list. | The title, request, status, and task appear more than once. | Task detail replaces the Work list, with a precise Back to Work or Back to Chat. Do not embed task detail inside a project card. |
| High | Local command task links opened another detail interface inside Chat, with both Chat and Tasks back buttons. | Users have to understand the internal distinction between personal and delegated tasks. | Share one task detail shell. Operation-specific content belongs inside it. Preserve source navigation and drafts. |
| High | Old delegated results appeared as App messages containing raw workspace/task IDs, attempt numbers, Rust-style status, and full previous reports. | Operational history overwhelms the named assistant's conversation. | Present one linked task card and a concise current update attributed to the saved assistant identity. Keep raw receipts and previous attempts under task history. Do not delete evidence or falsify authorship. |
| High | The blocked task used a separate-copy mode unsupported by its selected Codex worker. | The user approved a plan that could not run. | Preflight worker, mode, folder, trust, and owning-machine availability before offering Start. Never bypass trust or quietly downgrade an edit request to read-only. |
| Moderate | Settings → Personal notes → Back displayed a Chat label but returned to Settings. | Back navigation does not match its label. | Use actual source history for label and destination, or always offer one explicit route back to Chat. |
| Moderate | Browser is located under Settings and says Borrow a tab even though the existing implementation launches a separate assistant browser. | The user cannot predict which tabs and logins it will use. | Put Browser in the assistant tools menu and link the active task tab from its task. Clearly show profile, tab, access, and who has control. The shared-browser implementation remains a separate engineering task. |
| Moderate | Task rows use internal worker IDs such as null instead of the saved display name. | IDs look like errors and obscure who is doing the work. | Resolve display names through the matching host/profile identity. Keep IDs in diagnostics and handle deleted/unavailable profiles explicitly. |
| Moderate | Settings has no visible removal path in the inspected build. | Users cannot manage the team they created. | Propose a reversible Remove assistant flow, with history retained and active tasks handled explicitly. This requires lifecycle/backend design; do not fake it by hiding a row locally. |

## Proposed everyday flow

1. **Ask in Chat.** A request stays in the named assistant conversation. Ordinary answers remain chat; only work requiring a task produces a plan. No forced task form for a normal question.
2. **Review one plan when approval is required.** Show the goal, project, machine, scope, compatible suggested worker, and relevant completion criteria. One explicit Approve and start. Avoid Save proposal followed by a second equivalent approval for a direct human request; retain the existing policy for assistant-initiated proposals.
3. **Keep one task identity.** Worker conversations and retries remain attached to it. They do not populate regular sidebar chats unless the user explicitly chooses to keep one there.
4. **Show the next action.** Use Review plan, Answer question, Review options, or Review result according to the actual state. Avoid calling everything Review.
5. **Open one detail screen.** Reason/result first, then the action. Worker IDs, original request, attempt history, provenance, command output, and worktree details are available below, progressively disclosed.
6. **Finish honestly.** Read-only results can be marked reviewed. Editable results require the existing checks and explicit acceptance of the exact revision. Saving project knowledge and applying code are separate actions.

## State and action contract

| Actual state | Primary action | Required behavior |
| --- | --- | --- |
| Proposed | Review plan | Approval is bound to exact owner, project, worker, scope, and current revision. |
| Needs clarification | Answer question | Show the actual question and answer in the task; preserve its identity. |
| Startup blocked | Review options | Show the reason, supported choices, and a new explicit approval for a changed plan. Do not offer a generic retry that repeats the same incompatibility. |
| Running / queued | View task | All rows are openable. Show real progress and meaningful pause/cancel behavior. |
| Paused | Resume | Do not count paused work as executing. Distinguish task pause from assistant pause. |
| Result ready | Review result | Render the result, scope limitations, changes, and checks. No success claim based only on exit code. |
| Done | View result | Keep finished work accessible rather than rendering inert rows. |
| Offline | Reconnect machine | Keep cached task information visible and labeled. Disable commands that require the owning host. |

## What the clickable prototype demonstrates

- Chat, Work, blocked-task recovery, result review, new task, project access, browser handoff, settings, and private memory.
- One task detail destination and back navigation based on the entry point.
- Revising the blocked task without adding a second task or sidebar chat; no automatic downgrade from editing to inspection.
- Result summary, file changes, and checks separated, with limitations made explicit.
- A separate editable-result scenario requires opening Changes and Checks, then confirming acceptance of revision 7. Its diff and checks are labeled illustrative, not actual implementation evidence.
- An ordinary question such as "What does Full access mean?" gets a simulated reply in Chat rather than a task form. The prototype's small keyword router demonstrates this distinction; it is not a proposed production intent classifier.
- Counts update together when the sample result is marked reviewed.
- Worker conversation hidden by default, with an explicit sidebar opt-in.
- Folder permission confirmation names the exact folder; Full access is explicit.
- The browser preview shows profile selection and take-over/return-control. It does not connect a real browser or share cookies.
- Warm dark and light themes and a layout that adapts to a narrow panel.

Every interaction is simulated with in-memory sample state. Reload resets it. Sage is an illustrative compatible worker, not a discovered or verified configured worker. No real approval, grant, task dispatch, note save, or removal occurs.

## Prototype checks

Verified by interacting with the rendered prototype: Chat → blocked task → changed plan → explicit approval → one queued task; source-specific back navigation; ordinary question stays in Chat; new task → plan review; read-only Changes/Checks limitations and Mark reviewed; opt-in worker conversation appearing in the sidebar; browser Take over and Return control; browser profile switch; exact-folder confirmation; editable acceptance disabled until Changes and Checks are opened, then a revision-specific confirmation. The script also passed `node --check`.

A fresh builder review found no important unanswered questions for presenting this mockup. It requested ordinary-chat and editable-result coverage; both were added. This review does not constitute production app testing or approval to ship.

## Implementation boundaries

- Keep current Chat/Work information architecture and the user's existing visual language. This is a refinement, not another unrelated redesign.
- Preserve original task records, immutable owner/assistant/project identity, approvals, exact revisions, receipts, and history. Treat historical messages as history rather than silently rewriting their provenance.
- Consolidate the presentation without merging the security/authority of different operations.
- A plan revision for a blocked task needs verified host support. If no safe compatible worker exists, show that plainly; do not invent a supported option or change standing access.
- Hide task-owned execution/routing chats by durable lineage, not title matching. Existing user chats stay visible; manually kept task chats stay visible across restart.
- Additional browser profiles remain isolated. Share infrastructure without automatically sharing every tab, account, or profile across assistants. Preserve sign-ins during migration or explain necessary reauthentication.
- Reversible removal is a proposal requiring persistent lifecycle support, active-task handling, and a restore path. No local-only disappearance.
- Do not ship until new-task creation, proposal approval, running state, blocked recovery, both review types, pause/resume, offline, restart, and deep links are verified in the actual app. Package checks are separate from native workflow checks.

## Source anchors inspected

- `src/AssistantWorkspace.tsx`: Chat/Work shell, menu, status, nested back navigation.
- `src/AssistantWork.tsx`: attention rows, inert running/finished rows, project/detail nesting.
- `src/AssistantProjects.tsx`: task detail, delegation form, compatibility error display, result and review duplication.
- `src/PersonalWorkspaceTaskDetail.tsx` and `src/ApexAgentAll.tsx`: separate command-task presentation and result links.
- `src/assistantStatus.ts`: status aggregation and internal worker ID display.
- `src/App.tsx`: coordinator/worker thread creation, task routing, and project navigation.
- `crates/apex-host/src/assistant_delegation.rs`: raw delegated result messages.
- `desktop/browser.mjs` and `crates/apex-host/src/personal_worker/browser.rs`: existing separate browser implementations.

The existing `docs/superpowers/plans/2026-10-23-assistant-team-simplify.md` describes the already-started Chat/Work refinement. This review builds on that work and identifies remaining workflow failures; it does not claim that changing the tab names solved them.


## v5 refinement: Deleted tasks, Agents navigation, runtime chip

- Deleted tasks has Empty deleted tasks with an exact count, explicit irreversible confirmation and disabled empty state. Purged tasks do not reappear in Chat or Work. Project files and saved notes remain. Production implementation must retain minimum authority tombstones/receipts needed to prevent replay, without presenting deleted task history as still visible.
- Agents exclusively opens reusable worker profile management. It has no named-assistant links or assistant attention list. Opening an assistant through the left sidebar clears the global section selection. Audit App.tsx, SectionNavigation.tsx, attention menus and keyboard shortcuts as well as the tab button itself.
- The assistant identity is a single dropdown chip: provider, model, reasoning, speed, access, resets, usage, context. Full settings shares the same runtime values. Changes apply to future replies; pending and running task approvals keep their original scope. Full access requests explicit confirmation and grants no additional folders.
- Reuse existing BotSettings, ChatPane usageCard/resetsFor and speed.ts capabilities. Quota is host/provider/account/model specific; context belongs to this assistant conversation. Unsupported speed/reset actions are disabled; unknown reports stay unknown. No invented usage zeros or live balances.
- Rendered checks: provider/reasoning/Fast selection synchronized to Settings; Full access confirmation and cancellation; Usage and Context disclosures; chip expanded accessibility state; Agents selected while assistant header hidden; sidebar returns to Chat; finished sample task deleted, folder emptied, purged task absent in Work and active sample retained.

## v6 refinement: reuse the Threads composer

User requirement: the assistant uses the same composer as Threads, without multiple bot chips underneath, because it has exactly one provider/model at a time.

- Production should extract/reuse the existing Threads composer and its controllers rather than maintain a visually similar assistant-specific fork. Keep the single runtime selector in the assistant header; omit the participant bot row and add-bot/multi-recipient controls.
- Retain the plus menu, attachments, file/folder handling, configured tools and commands, supported single-assistant mentions, Plan, TL;DR, keyboard shortcuts, send/queue/steer behavior, per-reply Stop and Escape behavior. Keep project and access selection available through the plus menu. Existing grant boundaries still apply.
- Reuse VoiceCallBar and VoiceCallControls, the same default voice model/settings and chat-only override. Empty input shows the mic; a draft or attachments show Send. Textarea grows without moving the composer offscreen. Browser opens as the mini popup above it and expands the same tab into the main pane.
- Prototype matches the basic Threads composer layout (+, textarea, TL;DR, mic/Send) and provides Plan, sample attachments, stop, Enter/Shift+Enter and browser access. The only runtime chip is in the header. Tools/commands are clearly marked placeholders; no file upload or microphone access occurs. Concurrent reply queues/steering are specified for implementation but not simulated: the preview asks to stop the sample reply first.
- Source references: src/ChatPane.tsx composer around lines 3762–3880; src/ComposerTools.tsx plus menu; src/composerMenu.ts; src/styles.css composer-field, composer-box, round-send and tldr-pill rules. Preserve existing Themes rather than duplicating colors.
- Rendered checks: sample attachment, multiline Shift+Enter, Enter send, voice-to-Send switching, Stop/Escape preserving a draft, stopped reply retaining the sent message, and mini browser bottom above composer top. Standalone script passed node --check. All of these are prototype checks; no installed-app implementation or DMG release is claimed.


## v7 correction: source-faithful composer and full call controls

The v6 composer was too loosely approximated. Its single row, 22px radius, 9px padding and 180px textarea cap did not match current Threads. This correction supersedes those visual details.

- Source of truth: src/styles.css:4164–4213, not only the earlier base composer rules. Threads always places the textarea on its own row; the controls are below. Textarea minimum is 44px and maximum 200px. Box padding is 6px 8px 6px 10px with 4px gaps; + is 28px; voice mic and Send are 30px. Clay radius derives from --deck-radius times 1.6, with its default 10px token. The reading column is 44rem with a 24px minimum side gutter. The composer spans the pane and the inner box spans this same reading column. No independent assistant width or hardcoded pill size should be introduced in implementation.
- Voice source of truth: src/voice/VoiceCallControls.tsx, src/voice/voice.css, src/voice/callView.ts, src/voice/settings.ts. The preview now embeds the existing voice stylesheet and adapts the source call layouts. Default is Pill, with Bar and Top bar alternatives; changing the layout keeps the simulated call, chosen voice, aliases, pause, mute state and unsent draft.
- The call settings popover includes the chat-specific voice picker and preview button, pause-before-reply slider (100–2000ms, step50), nicknames, and the three Call controls modes. Pause applies next call; Smart Turn status is an illustrative sample state. Default voice follows the assistant override then app Settings. The sample default is Michael; the source English Kokoro voice list is available in this mockup, deduplicated. Production must use the actual helper's offered voices and allow unsupported previews to stay disabled.
- Pill remains visible next to Send when a draft exists. Bar can tuck without ending the call. Top bar shows a header capsule with status, timer, mute and End. The timer updates without replacing editable controls. Only one assistant is present, so no multi-agent Talking to selector is needed.
- Voice preview here is deliberately silent and shows a sample-only notice. It does not request microphone access, play audio, change app defaults, download speech engines, or alter the live assistant. Local Whisper/Kokoro and the assistant's existing text provider remain the implementation path already used by Threads; these controls do not invent another voice engine.
- Rendered checks at 724px and 1280px viewport widths: narrow pane has 24px gutters; wide inner box is 704px (44rem); empty box is 92px tall with a 44px textarea and two control rows. Twenty lines cap the textarea at 200px while the composer stays at the bottom. Pill stays beside Send with text. All three layouts render; voice, pause2000ms and aliases survive layout changes. Mute, call settings bounds including the Preview button, and End controls are exercised with sample state. These are source and rendered prototype checks, not installed-app audio tests.


## v8 approved: organized Work

The user requested this hierarchy in the existing clickable mockup first. The user approved implementation with “lets build it” after reviewing this preview. Native implementation and release verification remain separate gates.

- Needs you contains approvals, questions, blocked startup and results needing review. In progress contains queued/running work; empty groups are omitted.
- Each task appears once, with its title, concise status/project/worker line, one next action and an overflow menu for lifecycle actions. No card left borders.
- History holds completed/cancelled tasks in a collapsed drawer. Projects is a separate collapsed management drawer, with connected folder/access information and a link to project access; it does not repeat tasks.
- Deleted tasks stays reachable as a quiet footer link. New task remains the page's only prominent creation action.
- Verified clickable sample: review release-notes plan → approve sample → same task moves from Needs you into In progress; History expands completed/cancelled tasks; Projects opens management and returns to Work.

Preview: http://localhost:56324/ (Work v8). Canonical local preview: `/Users/tylercaldwell/.codex/visualizations/2026/10/23/01a168a3-ca13-7a10-afae-0d8dca07a81a/assistant-flow.html`.
