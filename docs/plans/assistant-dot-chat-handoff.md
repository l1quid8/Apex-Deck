# Hand-off: ApexAgent as one Dot-style chat

**For:** deepgeek · **From:** Claude (Code tab), with the Human · **Date:** 2026-10-23
**Status:** design approved by the Human through three click-through mockups (v3 is the target). Nothing has been built. Base: `main` at `e4a7b5f`.

## 1. What the Human wants, in one paragraph

ApexAgent should feel like OpenAI's Dot (the Human's Dot is named "Null" in the ChatGPT app): **one chat** with the assistant. Clicking its avatar opens the assistant's info in the app's **existing right sidebar, on the Details tab**. The **Work tab and the New task form go away.** Jobs start by asking in the chat, show up as plain chat messages, and ask their questions in the chat. The Human **likes ApexAgent's granular settings and wants every one kept.** The Work tab, its noisy task list and the New task form were the problem ("clunky, unorganized and noisy"). The settings were never the problem.

## 2. The approved mockups (open these first)

Both are self-contained HTML files in this checkout. **They are untracked, so do not delete them.**

| File | What it is |
|---|---|
| `mockups/assistant-dot-v3.html` | **The approved target.** One chat, the session-strip header and voice controls, and the assistant's info in the right sidebar's **Details** tab, with fold-open sections, inline Model & access and a Browser sidebar tab. |
| `mockups/assistant-dot-v2.html` | Same chat and header, with the panel as a separate overlay. **Superseded by v3;** use it for comparison only. |
| `mockups/assistant-dot-v1.html` | Earlier centered header. **Use it for comparison only.** |

To view them, run `preview_start` with the `mockups` entry in `.claude/launch.json` (a Python static server on port 8743), then open `http://localhost:8743/assistant-dot-v3.html`. Or open the file directly in a browser. The top bar has demo buttons: **Avatar panel**, **Question in chat**, **Start a task**, **Finish task**, **Browser**, **Project access** and **Settings**. To see the session-strip call controls, open call settings and pick **Top bar**, or run `state.voiceLook='capsule'` in the console and click the phone button. The sidebar's fold state is saved in `localStorage` under `apex-dot-v3-folds`; clear it to see the defaults.

Both mockups grew out of Codex's v8 prototype. Its notes list **every setting that must survive**:
`~/.codex/visualizations/2026/10/23/01a168a3-ca13-7a10-afae-0d8dca07a81a/assistant-ux-review.md` (the "Settings feature parity: prototype v4" and "Add teammate feature parity: prototype v3" sections). Section 7 below repeats the list so you don't depend on that path.

Reference products the Human studied: Dot (`https://learn.chatgpt.com/docs/dots`), Meta Muse (`muse.ai`, where the Human's assistant is named "Jigguh") and Grok Bot (`https://docs.x.ai/grok-bot/overview`).

## 3. Where the current UI lives (read before changing anything)

| Area | File(s) | Notes |
|---|---|---|
| Assistant screen shell: header, Chat/Work tabs, ⋯ menu | `src/AssistantWorkspace.tsx` (69 lines), `src/assistant-workspace.css` | The header holds the identity chip (it opens `AssistantRuntimeSettings`), the tabs, the `callControls` slot and the ⋯ menu (Projects, Browser, Memory, Settings, Pause). |
| Section model and saved view | `src/assistantWorkspaceModel.ts` | `AssistantSection = 'chat' \| 'work' \| 'memory' \| 'settings'`, the `LEGACY_SECTIONS` migration, `assistantNavigation`. |
| Work tab | `src/AssistantWork.tsx`, `src/assistant-work.css`, `assistantWorkItems` in `src/assistantStatus.ts` | Needs you / In progress / History / Projects drawer / Deleted drawer, plus **+ New task**. |
| Wiring | `src/App.tsx` around line 2657 | Renders `<AssistantWorkspace …>` with `chat={<ApexAgentAll …/>}`, `work={<AssistantWork …/>}` (which wraps `<AssistantProjects …/>`) and `editor={<AssistantEditor …/>}`. New task works through `workNewTaskRequest` (line 1913) and `AssistantProjects newTaskRequest`. |
| The chat itself | `src/ApexAgentAll.tsx` (705 lines) | Personal task cards (`taskCard`, about line 393), decision buttons (`personal.decide`: approve / handOff / spend / uncertain), schedule proposals with Confirm/Decline (about line 535), and task lines folded into "Task · … ›" links (`collapsesToLink`). It sends to the project coordinator with `assistant_message`. |
| Project (delegated) tasks | `src/AssistantProjects.tsx`, `src/ApexAgentTasks.tsx`, `src/WorkspaceTaskDetails.tsx`, `src/PersonalWorkspaceTaskDetail.tsx` | Plan review and result review, using `assistant_task_action` (`revise_startup`, accept, etc.). |
| Settings | `src/AssistantEditor.tsx`, `src/AssistantAvatarEditor.tsx`, `src/AssistantRuntimeSettings.tsx`, `src/PersonalPanels.tsx` | `PanelName = 'activity' \| 'scheduled' \| 'memory' \| 'rules' \| 'settings' \| 'costs' \| 'notices' \| 'connections'`. |
| Browser | `src/AssistantBrowser.tsx`, `src/PersonalBrowser.tsx` | Popup in chat, expand into the main pane, Take over. |
| Right sidebar | `src/RightPanel.tsx`, `src/rightPanelModel.ts`, `src/ThreadDetails.tsx`, `src/detailsLayout.ts`, `src/App.tsx` around lines 405–470 and 742 | `TabKind = dashboard \| tasks \| details \| artifacts \| browser \| files \| worktrees \| phone`. Dashboard, Tasks and Details are the fixed tabs. Details content is portaled into `detailsSlot` through a `DetailsHost` (`open`, `overlay`, `collapsed`, `toggle`, `show`, `close`, `target`). **Today `detailsHostBase.open` is true only when `section === "threads"`**, and `DetailsSection = "bots" \| "form" \| "room" \| "allowed" \| "changes"`. `overlayDetails` already uses a 400 px minimum when `mainView.kind === "assistant"`. The existing `browser` tab is a URL browser (its label comes from `tab.url`), **not** the assistant's remote headless browser. |
| Voice | `src/voice/VoiceCallControls.tsx` (`VoiceCallBar`, `VoiceCallCapsule`, `VoiceCallControls`, `CallSettings`), `src/voice/useAssistantVoice.ts`, `src/voice/personalBridge.ts` | `ApexAgentAll` portals `VoiceCallCapsule` into `voiceHeader` (App.tsx's `assistantVoiceHost`, line 1910). **`VoiceCallCapsule` is shared with regular threads** (`ChatPane.tsx` line 3488). |
| Assistant record | `src/personalAssistant.ts` | `messages, tasks, rules, facts, schedules, notices, costs, machines, projects`. **There is no outputs or files field.** |

## 4. Scope

**In (Mac desktop app):**
1. Remove the Work tab and the New task form, and drop the `'work'` section.
2. Show tasks in the chat as plain messages: questions and approvals become messages with at most two buttons plus a Details disclosure.
3. Replace the header with the session strip (section 6).
4. Put the assistant's info in the right sidebar's Details tab, and add the assistant browser as a sidebar tab (section 5.3).
5. Move project management (assign or unassign folders, access) to a **Projects & access** subview reached from ⋯ and from the Details footer.
6. Keep every setting (section 7).

**Out (for now):**
- The iPhone app (`src/phone/PhoneApp.tsx`). It needs the same treatment later; do not change it in this branch.
- Regular threads' voice UI (`ChatPane.tsx`). The exception is the one shared fix in 6.4, and only if the Human says yes.
- Rust host changes. Everything in the mockups maps onto commands that already exist. If you find a real gap, stop and ask; don't add a host command quietly.
- Outputs data (see the open questions).

## 5. The new assistant screen

### 5.1 Layout
- `AssistantWorkspace` renders **the chat only**. Delete the `role="tablist"` nav. `section` becomes `'chat' | 'projects' | 'memory' | 'settings'`. `projects`, `memory` and `settings` are subviews with "‹ Back to Chat", exactly how memory and settings already work.
- In `assistantWorkspaceModel.ts`, saved views with `section: 'work'` must open as `'chat'`. Add `work:'chat'` to `LEGACY_SECTIONS`, and remove `'work'` from `ASSISTANT_SECTIONS`. Old names must not linger as fallbacks; see the "renames are clean cut-overs" rule.
- Remove `AssistantWork.tsx`, `assistant-work.css`, the `workNewTaskRequest` state and the `onNewTask` wiring. Also remove the Deleted-tasks drawer UI. Its restore and empty actions can move into a Recent activity row menu in Details later. **Ask the Human before deleting the Deleted-tasks feature entirely.**
- `AssistantProjects` loses its create-task entry point (`newTaskRequest`). It keeps assign, unassign, folder grants and the detail views.

### 5.2 Chat behaviour (Dot's pattern, verified hands-on with the Human's Null)
- **Starting work:** you ask in the chat. The assistant answers in plain words ("On it. I'll … and keep you posted. We can keep chatting while it runs."). There is no form. Routing to a project still goes through the existing `assistant_message` path.
- **Progress:** post only updates that matter, and blockers. Don't post a line for every step.
- **Finished:** a normal assistant message with the result, sources as links, and an explicit "No files were changed" when that's true, plus a small **Open details ›** link that opens that task's activity detail in Details.
- **Questions and approvals:** a plain assistant message that says what it needs, followed by **at most two buttons**. Map the existing `decision.kind`s onto them:
  - approve → **Approve / Decline**
  - handOff → **I did it / Skip**
  - spend → **Go ahead / Not now**
  - uncertain → **Run again / Decline**
  - Delegation questions use plain wording, for example **Hand it to Sage / Written plan only**.

  Put the exact action (command, folder, machine, worker, write scope, access) behind a **Details** disclosure, collapsed by default. This replaces the boxed `apex-agent-task-card` with its badges, chips and meta lines.
- **Once you answer,** the buttons disappear and your answer shows as your own chat bubble ("Hand it to Sage"). The assistant's follow-up then appears **below it, in time order.**
- **Ready to review:** "Ready to look at: … nothing is in your project yet." with **Review changes / Not now**. Review changes opens the review in Details (5.4). Not now posts "It's waiting under Needs you in my panel."
- **Draft schedules:** the assistant shows a draft card (name, when + time zone, where, what, scope "read and summarize only") with **Schedule it / Not now**. This maps to the existing schedule proposal and `personal.decide`.
- **Typing indicator:** three dots while a reply is pending.
- **Scrolling (this was the first bug the Human hit):**
  - The chat opens at the latest message.
  - New messages keep it pinned to the bottom.
  - If you scrolled up to read, a re-render must not move you.
  - Never rebuild the transcript in a way that resets `scrollTop`.
  - Jumping to a message from Details scrolls it into the center and briefly highlights it.
- **Folded task lines:** keep the existing grouping (approval, result and system lines of one task collapse to one place), but render that place as the plain message described above, not as a card or a "Task · … ›" pill.

### 5.3 The assistant in the right sidebar's Details tab (approved in v3)
**There is one sidebar, not two.** Clicking the avatar in the header opens the app's existing right sidebar (`RightPanel`) on its **Details** tab, alongside Dashboard and Tasks, and shows the assistant's content there. Clicking the avatar while Details is showing closes the sidebar. Clicking it from another tab switches to Details. The Human's complaint with v2 was that the cards "open their own sidebar and close the original so it looks weird." **Nothing in Details may close the sidebar or pop up somewhere else.**

**Wiring (the builder decides the details):**
- Let `DetailsHost` serve an assistant as well as a thread. `detailsHostBase.open` becomes true when the Details tab is active and **either** `section === "threads"` **or** `mainView.kind === "assistant"`. Set `target` to the assistant's identity key (`assistantIdentityKey`).
- The assistant screen portals its content into `detailsSlot`, the way `ThreadDetails` does for threads.
- Add the assistant's fold keys to the collapsed state, either by widening `DetailsSection` or with a separate map, so each section **remembers being open or folded**. That means across re-renders, and across reloads if `detailsCollapsed` is already saved (check it; the mockup uses `localStorage`).
- **Redraws must not reset the sidebar's scroll position.** Changing a setting in place has to leave you where you were.

**Contents, from top to bottom:**
1. **Avatar (64 px) with a pencil,** which opens the existing avatar editor. Next to it, the name and the status ("Active now", "Working", "Needs you" or "Paused"). Long names are cut off with "…".
2. **Call** button, which starts the existing voice call.
3. **Browser card**, with the title "Browser" and a line such as "Ready", "In use · Take over anytime" or "You have control". It opens the assistant's browser **as a tab in the same sidebar** (see below). It does not close Details or pop up in the chat.
4. **Model & access card that folds open in place,** like an accordion, collapsed by default. Folded, it shows the runtime summary (`model · access · N projects`) on one line, cut off with "…". Opened, it shows the existing `AssistantRuntimeSettings` controls **inline**: provider, model, reasoning, speed, access, the notes, Resets, Usage, Context and "All settings ›". Changes apply in place through the same code paths as today's popover, including the Full access confirm. **This replaces the runtime-chip popover.**
5. **Needs you** *(folds, with a count)*: one row per open question or ready review. A question row jumps to its message in the chat; a review row opens the review in Details (5.4). Hide the section when it's empty.
6. **Schedules** *(folds)*: active schedules with **Cancel** (the lane's `cancelSchedule`, which is `personal_schedule_cancel` in `usePersonalAssistants.ts`), or "No schedules. Ask in chat to set one up." / "One draft is waiting for you in chat."
7. **Recent activity** *(folds, with a count)*: one line per task, personal or delegated, with an icon (✓ done, ! waiting on you, ○ working) and a short line ("Waiting on you", "Working", "Today 2:14 PM"). Clicking a row opens the **activity detail inside Details**: "‹ Name", the title, a "You asked · time" box, "Worked for …", the result, **Review changes** when one is ready, and **Go to chat**.
8. **Outputs** *(folds, with a count)*: see the open questions. Leave the section out until there's a data source.
9. **Footer links:** Memory · Projects & access · Settings. These open the main-pane subviews.

**Fold behaviour:** each section header is one button with an arrow (rotated when open) and `aria-expanded`/`aria-controls`. It works from the keyboard and shows a visible focus ring. The default is that Model & access is folded and the rest are open.

**Browser as a sidebar tab:**
- The Browser card adds a **Browser** tab next to Dashboard · Tasks · Details, with its own × that closes only that tab and returns to Details. The tab shows the assistant's own remote browser (the current `AssistantBrowser`/`PersonalBrowser` content: page, profile, **Take over / Return control**), with the same profile, cookies and control owner as today.
- The existing `browser` TabKind is a URL browser, so use a distinct tab kind or mode for the assistant browser. The name is the builder's call. Do not reuse the URL browser.
- Closing the tab must not silently hand control back to the assistant.
- Keep the existing popup-in-chat and expand-to-main-pane routes working for the message box's + → Browser and ⋯ → Browser.

**Tabs:** the strip must fit at the sidebar's width with no overflow or sideways scrolling, including when the Browser tab and its × are present. Dashboard and Tasks keep their current content.

**Narrow windows:** when `overlayDetails` is true, the sidebar covers the chat as it does today, and the × closes it.

### 5.4 Review in Details
Delegated results are reviewed **inside the Details tab**, not on a full page:
- "‹ Name", the title, and "Sage · revision 7 · separate copy · nothing in your project yet"
- a plain summary
- **Files changed** (name + `+38 −2`, with long names cut off)
- **Checks** (✓ Type check passed …)
- an optional **Anything to change?** note
- **Accept revision N** (primary) and **Ask for changes**

Use the existing `assistant_task_action` calls and keep the **revision/hash check** they already do. Accepting posts "Accept revision N" as your bubble plus the assistant's "Done …" message, and **returns Details to its overview. It does not close the sidebar.** If the full existing detail (diff viewer, checks) is too rich for the sidebar's width, add "Open full review", which opens the existing detail view in the main pane; Back returns to Chat.

## 6. Header: the session strip (Human's exact spec)

### 6.1 Shape and position
- The header is **exactly 60 px** in every state, including padding, and it **floats over the chat with no background and no bottom border.** Messages scroll up behind it. Give the chat and subviews enough top padding (about 76–78 px) that nothing starts hidden underneath. Make the strip itself `pointer-events:none` and its children `auto`, so clicks in the empty parts reach the chat.
- **Session capsule:** one compact object, **centered on the same line as the conversation and the message box** (not the window), and vertically centered in the 60 px. Center the visible capsule, not an oversized invisible wrapper. When the right sidebar opens, the center follows the narrower chat; the mockup measured capsule, chat and composer centers equal in every state.
- **Inside the capsule:** a **36 px avatar** (click opens the right sidebar on Details), then the name with the status line under it, then the call controls.
- The capsule has one subtle shared surface: a thin border, a 14 px radius, and a light frosted fill (about 82% background plus a 10 px backdrop blur) so it stays readable when text scrolls behind it.
- **Far right, separate from the capsule:** the **phone** button (only when no call is running) and the **⋯** menu. Both are **36 px circles** with a 1 px border, transparent at rest, with a soft fill on hover and while the menu is open.

### 6.2 Status line
- No call: the status word ("Needs you" in accent color, "Thinking", "Paused", or "Active now").
- In a call: *Listening* · 5:04. **Only "Listening" is italic.** The separator and timer are regular, and the timer uses tabular numerals (`font-variant-numeric: tabular-nums`) so it doesn't jiggle. When muted it reads *Muted* in red. Keep a screen-reader live region with the full line ("Muted · Name can still talk") outside the visible text.

### 6.3 Call controls in the capsule (the assistant's "Top bar" look, `look === 'capsule'`)
- **Mic/mute, call settings and end**, about 36 px targets with 15 px icons, **transparent at rest.** A soft background shows only on the hovered or focused button. **End is a restrained red handset** that gets a light red tint on hover, never a solid red block. (The shared `.voice-end:hover` rule paints solid red; the mockup needed `!important` to beat it.)
- **Hidden by default.** They reveal when you hover the capsule (not the whole header) or tab into it with the keyboard, with a 150–200 ms fade.
- **The capsule grows evenly around its middle** to show them, so the avatar and name shift left by half the growth. The Human chose this over reserving the space.
- **They stay visible** while the pointer or focus is inside the capsule, and while call settings are open. They hide about **200 ms** after the pointer leaves.
- **Clicking a control does only that control's job and never opens the sidebar** (stop propagation). Muting with the keyboard keeps focus on the mute button after re-render; the mockup had to restore focus explicitly.
- While a call is running, hide the right-side phone button and the call button in the message box, so there's one set of call controls.
- Call settings opens anchored under the capsule (`Popover`), with the existing `CallSettings` content.
- **Build this as an assistant-only component** (for example `VoiceSessionStrip` in `src/voice/VoiceCallControls.tsx`, using `useCall`, `Mute`, `End`, `Clock`, `Wave` and `CallSettings`). **Do not restyle `VoiceCallCapsule`**: regular threads use it in `ChatPane.tsx`. The **Bar** and **Pill** looks stay exactly as they are.

### 6.4 Call settings behaviour
- Picking a new call look (Bar / Pill / Top bar) **closes the call settings popup.** It should not pop up again in the controls' new spot. `CallSettings` is shared with regular threads, so **ask the Human whether regular threads get this too** before changing the shared code. If they say no, close it only in the assistant's strip.

## 7. Settings that must survive (nothing here may disappear)

From Codex's parity notes (prototype v4/v3) and `PersonalPanels.tsx`:
- **General:** name, and the full avatar editor (pixel color, new pattern, AI image with provider choice, prompt, preview, use, discard; ChatGPT Images stays an option).
- **Model:** configured provider, the model it offers, and supported reasoning. Changing the provider reconciles the model and reasoning (`reconcileEffort`). Speed stays too.
- **Projects & access:** default project tools, per-project grants, an explicit Full access, and Browser access.
- **Preferences:** reply style, time zone, quiet hours, daily spend limit, the unknown-cost preference, local-only privacy, allowed endpoints, and the context budget.
- **Voice:** the shared regular-chat voice settings (voice picker, pause before reply, nicknames, call look). Do not create a second assistant-only voice setup.
- **Memory:** private notes and project notebooks.
- **Connections, rules and spending:**
  - machine and service connections
  - the Read/Write/Send/Spend action modes
  - standing rules, which can only tighten (Ask / HandOff)
  - cost history, with reported, estimated and unknown kept apart
  - schedules and notices
- **Saving:** one Save/Discard bar for the main form, and keep the existing expected-revision, owner and host checks.
- **Add teammate:** Provider, Model, Reasoning, Project tools, an optional first brief that becomes a draft and is **not auto-sent**, machine and folder, and the avatar editor. Codex found a regression here: creation lost the full avatar editor in `b68aab6`. Fix it if you touch that form.

## 8. Rules for this repo (from AGENTS.md and the Human's standing preferences)
- Run `git status` first; other bots edit this folder at the same time. Create a branch with `git switch -c feat/assistant-one-chat`. Stage only your own hunks, and never `git add -A`.
- Dev build: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`, started from `/Users/tylercaldwell/Downloads/apex-deck`. Never touch the installed Deck's data. The production `.dmg` build happens only in `…/release`.
- `npx tsc --noEmit` must pass before you report anything as done or merged. Run `npm test` (Node's test runner over `tests/*.test.mjs`). The tests most affected:
  - `tests/assistant-workspace-model.test.mjs`
  - `tests/assistant-workspace-component.test.mjs`
  - `tests/assistant-work-component.test.mjs` and `tests/assistant-work-creation-entry.test.mjs` (these assert the Work tab and New task; retire or rewrite them)
  - `tests/assistant-status.test.mjs`
  - `tests/assistant-projects*.test.mjs`
  - `tests/apex-agent-all*.test.mjs`
  - `tests/apex-agent-voice-and-actions.test.mjs`
  - `tests/voice-call-view.test.mjs`
  - `tests/workspace-task-detail.test.mjs`
  - `tests/assistant-runtime-component.test.mjs`
- **Look before you install:** render the new header, chat and Details sidebar offscreen or in the dev build and look at screenshots at the Human's real window size (the pane was 1024×768). Click through it with the mouse and the keyboard before saying it works. The Human called the first mockup "buggy" because it was only checked by code. Section 9 is the checklist.
- Never touch the real clipboard in checks. Never write a bot @handle in replies.
- Talk to the Human in plain, everyday language.
- Don't merge to `main`, push or install without the Human's explicit OK. Null usually reviews before merge.

## 9. Acceptance checklist (each item was verified in the mockup; verify again in the app)
1. Opening an assistant shows only the chat, with no Work tab. A saved `section:'work'` view opens Chat.
2. The chat opens at the latest message. Sending, answering and replies keep it at the bottom. Scrolling up and then re-rendering keeps your place.
3. Messages stay in time order after you answer an old question; the answer and follow-up appear at the bottom.
4. Answer buttons disappear once answered, and your choice shows as your own bubble.
5. Details opens the exact action. Approve, Decline, I did it, Go ahead and Schedule it call the existing decide paths.
6. Avatar click opens the right sidebar on Details, and clicking it again closes the sidebar. From Dashboard or Tasks, it switches to Details. Nothing inside Details closes the sidebar or pops up elsewhere. The capsule stays centered on the chat with the sidebar open.
7. Needs you rows jump to the right message, which is centered and highlighted. Recent activity rows open the detail inside Details. Go to chat scrolls to the message; it closes the sidebar only when the sidebar is covering the chat. (The mockup always closes it; this is a deliberate small change, since a docked sidebar doesn't need to close.)
7a. Model & access folds open inside Details. Changing a setting there applies in place, and the sidebar keeps its scroll position. Each section's fold state is remembered.
7b. The Browser card opens a Browser tab in the same sidebar. Take over works there, and the tab's × closes only that tab and returns to Details. The tab strip never overflows.
8. The review in Details: Accept and Ask for changes post into the chat in order, the revision hash is still checked, and Details returns to its overview without closing the sidebar.
9. The header is 60 px in every state, with no background and no border, and messages scroll behind it.
10. Call (Top bar look): the controls are hidden at rest, appear on capsule hover or keyboard Tab, and hide about 200 ms after leaving. They stay visible while call settings are open. Clicking a control never opens the sidebar. Keyboard mute keeps focus. End is a soft red with no solid fill. The timer doesn't jiggle.
11. Picking Bar, Pill or Top bar closes call settings. Bar and Pill look unchanged in the assistant chat and in regular threads.
12. Every setting in section 7 is reachable from ⋯ → Settings, Memory, Projects & access, or the Model & access card in Details.
13. Light and dark themes both work. In narrow windows the sidebar covers the chat, as Details does today.
14. Pop-up notices don't cover the header or the composer; the mockup moved them to the bottom-left.

## 10. Open questions for the Human (ask; don't guess)
1. **Outputs** in Details: the assistant record has no files field. Should the list come from task results or the Library, or should it wait?
2. **Deleted tasks:** should restore and permanently empty live in Details (a Recent activity row menu), or is it fine to drop that UI?
3. **Call settings closing after a look change:** regular threads too, or only the assistant?
4. **Phone app:** same redesign next, in its own branch?

## 11. Suggested order
1. Section model and navigation: drop Work, add the `projects` subview and the saved-view migration, plus tests.
2. Header session strip without voice: centered capsule, round buttons, floating transparent header, then the avatar → Details toggle.
3. `DetailsHost` for assistants, plus Details content with real data: identity, Call, Browser card, inline Model & access, and the Needs you, Schedules and Recent activity sections with remembered folds and activity detail. Then the assistant Browser sidebar tab.
4. Chat rewrite of task cards into plain messages with at most two buttons and Details, the scroll pinning, and in-order answers.
5. Review in Details.
6. `VoiceSessionStrip` (the assistant's Top bar look) and the call-settings close, after checking question 3 with the Human.
7. Screenshot and click-through pass against section 9, `npx tsc --noEmit`, then hand to Null for review.
