# Assistant & Team Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the named-assistant (Team) surface simple and theme-correct: Chat + Work instead of Conversation/Projects/Activity, one status everywhere, a single-column Settings page, a short Add a teammate dialog, and the LandingTexture rain on a new teammate's empty chat.

**Architecture:** A new pure module `src/assistantStatus.ts` becomes the only place that turns personal + delegated tasks into a status and work lists; the rail, header, Work tab and project cards all read it. `AssistantSection` shrinks to `chat | work | memory | settings` (with migration of persisted views). The embedded `ApexAgentAll` is pinned to its chat view; a new `AssistantWork.tsx` hosts the merged work list plus the existing `AssistantProjects` in a compact mode. All assistant CSS stops overriding theme tokens.

**Tech Stack:** React 19 + TypeScript (Vite/Electron), plain CSS with theme custom properties (`src/glass-theme.css`, `src/clay-theme.css`), tests with `node --test` + sucrase JSX harness (`tests/*.test.mjs`).

**Spec:** Design canvas "Apex Deck — Assistant & Team Redesign" — https://claude.ai/artifact/R5FNrC5dQkhzPHD5QFe58i (boards 01 Chat, 02 Work, 03 Settings, 04 New teammate, 05 Add a teammate; Theme tweak on every board). Earlier design: `docs/superpowers/specs/2026-10-22-assistant-workspace-design.md` (its safety, lineage and revision rules still hold).

### Audit findings this plan fixes (verified in the running app and source)

1. Conversation shows no composer: embedded `ApexAgentAll` hides its own Chat/Tasks tabs but keeps the per-assistant draft `view`; once a task link sets `view='tasks'` the form is `hidden={view !== 'chat'}` with no way back except Escape (`src/ApexAgentAll.tsx:138,226,608`). Empty state names "ApexAgent" (`:445`).
2. Three status calculations disagree: roster summary counts personal tasks only (`src/usePersonalAssistants.ts:86`), header counts personal + delegated (`src/AssistantWorkspace.tsx:26-28`), Projects counts delegated only (`src/AssistantProjects.tsx:167`).
3. `.app.assistant-active` replaces every theme token with a fixed warm palette (`src/assistant-workspace.css:3`), and `src/assistant-tasks.css` hard-codes Classic hexes (≈70) — the Team surface ignores Settings › Appearance.
4. Header/menu noise: "· Assistant · Ongoing conversation", glyph-only pause, ⋯ mixes Workspaces / Memory / Settings / Add a team member; Projects cards print the raw host id hash.
5. Review needs a checkbox *and* a button; results render as raw text (`**Short answer:**`), `src/ApexAgentTasks.tsx:462,514`.
6. Settings is one long scroll with a separate "Allow this folder…" button per project; creation dialog leads with Machine and repeats the long form.

## Global Constraints

- Work on a new branch: `git status` first (the checkout has others' untracked files — leave them), then `git switch -c feat/assistant-team-simplify`.
- `npx tsc --noEmit` and `npm test` must pass at the end of every task.
- Never hard-code a color in assistant CSS; use theme tokens only: `--bg --panel --panel-2 --line --text --muted --accent --accent-ink --warn --danger` (set per theme by `glass-theme.css` / `clay-theme.css`; Classic uses `styles.css`). Tints via `color-mix(in srgb, var(--token) N%, transparent|var(--token))`.
- Copy rules (design system): sentence case, verbs first, middle dot `·` joins facts, no emoji, "Needs you" / "Failed" / "Ready" in that order of urgency, attention colors always paired with words or a count.
- Status labels, exact: `Offline`, `Paused`, `Needs you · N`, `Failed · N`, `Working · N`, `Ready`. A Ready assistant shows **no** subtitle in the rail.
- Access labels, exact (match `ChatPane.tsx`): `ask`→`Asks first`, `full`→`Full access`, `read`→`Read only`, `edits`→`Can edit files`.
- Keep every existing safety rule: expected-revision saves, owner verification, folder grants saving immediately with confirmation, explicit review before accept, no auto-send.
- Do not touch the Agents section, worker profiles, or backend RPC shapes.

## Review Focus

1. **A persisted main view from an older build** (`section: 'conversation' | 'projects' | 'activity'`) must reopen the same assistant on Chat or Work, not fall back to the workspace — Task 4 test `legacy sections migrate`.
2. **A draft `view: 'tasks'` saved by an older build** must not hide the composer — Task 6 test `embedded chat ignores stored tasks view`.
3. **Offline assistant with open tasks** shows `Offline` (not a count) in rail and header while Work still lists the tasks — Task 2 test `offline wins but lists keep items`.
4. **Delegated task with `desiredState: 'paused'` still `running`** is not counted as working — Task 2 test `paused delegated task is not working`.
5. **Turning on a project whose folder is not granted, then the grant fails** leaves the switch off and the draft unchanged — Task 9 test `failed folder grant leaves switch off`.

---

### Task 1: Assistant surfaces follow the Appearance theme

**Files:**
- Modify: `src/assistant-workspace.css:3` (and every `var(--x,#hex)` fallback in the file, e.g. `:42`)
- Modify: `src/assistant-tasks.css`, `src/assistant-projects.css`, `src/assistant-editor.css`, `src/personal-panels.css`
- Modify: `src/glass-theme.css` (surface selector lists), `src/clay-theme.css` (surface selector list)
- Test: `tests/assistant-theme-tokens.test.mjs` (create)

**Interfaces:**
- Produces: alias tokens on `.app.assistant-active` that later CSS may use: `--shell --raised --border --dim --mint --amber --hover`, each defined only in terms of theme tokens.

- [ ] **Step 1: Write the failing test**

```js
// tests/assistant-theme-tokens.test.mjs
const FILES=['assistant-workspace.css','assistant-tasks.css','assistant-projects.css','assistant-editor.css','personal-panels.css'];
const COLOR=/#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/gi;
test('assistant CSS uses theme tokens only',()=>{
  for(const f of FILES){const css=read(f).replace(/\/\*[\s\S]*?\*\//g,'');assert.deepEqual(css.match(COLOR)??[],[],f);}
});
test('assistant-active defines aliases from theme tokens, never a palette',()=>{
  const block=read('assistant-workspace.css').match(/\.app\.assistant-active\{([^}]*)\}/)[1];
  for(const name of ['--bg','--panel','--panel-2','--line','--text','--muted','--accent']) assert.doesNotMatch(block,new RegExp(`(^|;)${name}:`),name);
  assert.match(block,/--mint:var\(--accent\)/); assert.match(block,/--amber:var\(--warn\)/); assert.match(block,/--shell:var\(--bg\)/);
});
test('glass and clay treat the assistant workspace as a surface',()=>{
  assert.match(read('glass-theme.css'),/\.assistant-workspace/); assert.match(read('clay-theme.css'),/\.assistant-workspace/);
});
```

- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/assistant-theme-tokens.test.mjs` — Expected: FAIL listing hexes per file.

- [ ] **Step 3: Replace the palette.** `.app.assistant-active` keeps only `font-size:13px;color:var(--text);background:var(--shell)` plus aliases `--shell:var(--bg);--raised:var(--panel-2);--border:var(--line);--dim:var(--muted);--mint:var(--accent);--amber:var(--warn);--hover:color-mix(in srgb,var(--text) 7%,transparent)`. Drop every hex fallback (`var(--line,#3b3732)` → `var(--line)`). In the other files map Classic literals: `#71e6b5`→`var(--accent)`, `#91a0af`/`#b3c0cc`→`var(--muted)`, `#e4eaf0`→`var(--text)`, `#0e141b`→`var(--panel)`, `#151e28`→`var(--panel-2)`, `#fbbf24`→`var(--warn)`, `#ff8585`→`var(--danger)`; `rgba(...)` tints → `color-mix(...)` of the matching token. Add `.assistant-workspace` to the glass surface list (`:root[data-deck-theme="glass"] :is(.pane, .rail, …)` blocks at the top of `glass-theme.css`) and to Clay's `:is(.pane, .rail, …)` list.

- [ ] **Step 4: Run** the test again — Expected: PASS. Run `npm test` — Expected: all pass (update any snapshot-style CSS assertion that pinned an old hex).

- [ ] **Step 5: Commit** `git commit -am "fix(assistant): follow Appearance theme tokens on Team surfaces"` (add the new test file first).

---

### Task 2: One shared assistant status model

**Files:**
- Create: `src/assistantStatus.ts`
- Modify: `src/App.tsx:1932` (move the delegated-task filter into the new module and call it)
- Test: `tests/assistant-status.test.mjs` (create)

**Interfaces:**
- Consumes: `PersonalTask` (`src/personalAssistant.ts:22`), `AssistantTask`, `AssistantTaskStatus` (`src/assistantTaskModel.ts`), `taskBelongsToAssistant`, `AssistantProjectBinding`, `AssistantRef`.
- Produces:
  - `type AssistantStatusState = 'offline'|'paused'|'needs_you'|'failed'|'working'|'ready'`
  - `type AssistantStatus = { state: AssistantStatusState; needsYou: number; failed: number; working: number; label: string }`
  - `assistantStatus(input: { offline: boolean; paused: boolean; personalTasks: readonly PersonalTask[]; delegatedTasks: readonly AssistantTask[] }): AssistantStatus`
  - `type WorkItem = { key: string; source: 'personal'|'delegated'; taskId: string; title: string; project?: ProjectRef; projectName?: string; worker?: string; status: string; atMs: number }`
  - `assistantWorkItems(personalTasks, delegatedTasks, projectName: (p: ProjectRef) => string): { needsYou: WorkItem[]; working: WorkItem[]; finished: WorkItem[]; cancelled: WorkItem[] }` — each list newest first.
  - `delegatedTasksForAssistant(owners: Record<string,{snapshot?:{tasks:AssistantTask[]}}>, ref: AssistantRef, projects: readonly AssistantProjectBinding[]): AssistantTask[]` — exactly the predicate now inline at `App.tsx:1932`.

Classification (the single source of truth):
- needs you — personal `needsYou`, `blocked`; delegated `needs_you`, `needs_clarification`, `ready_for_review`, `proposed`.
- failed — personal `failed`; delegated `failed`, `interrupted`.
- working — personal `running`, `queued`, `waiting`; delegated `running`, `applying`, `queued` **unless** `desiredState === 'paused'`.
- finished — personal `done`; delegated `done`. cancelled — `cancelled` from either.
- state precedence: `offline` > `paused` > `needs_you` > `failed` > `working` > `ready`. Label per Global Constraints.

- [ ] **Step 1: Write the failing tests** — `status counts personal and delegated together` (1 personal `needsYou` + 1 delegated `ready_for_review` → `{state:'needs_you',needsYou:2,label:'Needs you · 2'}`); `failed outranks working`; `offline wins but lists keep items` (offline:true → `label:'Offline'`, `assistantWorkItems(...).needsYou.length===1`); `paused delegated task is not working` (`status:'running',desiredState:'paused'` → `working:0`, `state:'ready'`); `ready has label Ready`; `delegatedTasksForAssistant keeps only assigned projects` (task on unassigned cwd excluded).
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/assistant-status.test.mjs` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `src/assistantStatus.ts`; replace the inline expression at `App.tsx:1932` with `delegatedTasksForAssistant(currentAssistantRegistry.owners, selectedAssistant.ref, assignedProjects)`.
- [ ] **Step 4: Run** the test, then `npx tsc --noEmit && npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): shared status model`.

---

### Task 3: Rail rows use the shared status

**Files:**
- Modify: `src/usePersonalAssistants.ts:18-21,86` (summary shape)
- Modify: `src/Sidebar.tsx:25,322-324` (row rendering), `src/App.tsx:2473` (wiring)
- Modify: `src/assistant-workspace.css` (`.assistant-team-row` subtitle colors)
- Test: `tests/sidebar-team-status.test.mjs` (create; sucrase harness as in `tests/assistant-workspace-component.test.mjs`)

**Interfaces:**
- Consumes: `assistantStatus`, `delegatedTasksForAssistant` (Task 2).
- Produces: `PersonalAssistantSummary` gains `paused: boolean; personalTasks: PersonalTask[]; projects: AssistantProjectBinding[]` and **loses** `status`. Sidebar prop `assistantStatusFor?: (ref: AssistantRef) => AssistantStatus`.

- [ ] **Step 1: Write the failing tests** — `ready row has no subtitle` (status `ready` → row text is exactly the name); `needs-you row shows words and count` (subtitle text `Needs you · 1`, element has `data-state="needs_you"`); `offline row says Offline`; row no longer contains `Assistant ·`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Summary copies `paused`, `tasks`, `projects` from the record. Sidebar row: avatar, name, and only when `state !== 'ready'` a subtitle `<span className="assistant-team-subtitle" data-state={state}>` with a 7px dot and `label`. App passes `assistantStatusFor={ref => assistantStatus({offline:s.offline, paused:s.paused, personalTasks:s.personalTasks, delegatedTasks: delegatedTasksForAssistant(currentAssistantRegistry.owners, ref, s.projects)})}` where `s` is the summary for `ref`. CSS: `[data-state=needs_you]` uses `var(--warn)`, `[data-state=failed]` `var(--danger)`, others `var(--muted)`; selected row = `var(--panel-2)` fill + `1px solid var(--line)` (no accent text color).
- [ ] **Step 4: Run** test, `npx tsc --noEmit && npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): rail rows show one shared status`.

---

### Task 4: Sections become Chat and Work

**Files:**
- Modify: `src/assistantWorkspaceModel.ts:4-45` (type, parse, navigation)
- Modify: `src/App.tsx:1906,1952,1980` and any other `'conversation'|'projects'|'activity'` section literal (grep `section:'` in `App.tsx`)
- Test: `tests/assistant-workspace-model.test.mjs` (extend)

**Interfaces:**
- Produces: `type AssistantSection = 'chat'|'work'|'memory'|'settings'`; `parseMainView` maps legacy `conversation`→`chat`, `projects`/`activity`→`work`; `assistantNavigation({kind:'open'})` opens `chat`; `back` defaults to `chat`.

- [ ] **Step 1: Write the failing tests** — `legacy sections migrate` (`parseMainView('{"kind":"assistant","assistant":{"hostId":"h","assistantId":"a"},"section":"activity"}')` → section `work`; `"conversation"` → `chat`); `open lands on chat`; `memory then back returns to work` (open → section work → section memory → back → `work`).
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/assistant-workspace-model.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** with a `LEGACY_SECTIONS: Record<string, AssistantSection>` lookup inside `parseMainView`; update App literals (`discoverAssignmentProjects` becomes `section==='work'||section==='settings'`).
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit` flags any missed literal — fix until clean; `npm test` PASS.
- [ ] **Step 5: Commit** `refactor(assistant): Chat and Work sections with view migration`.

---

### Task 5: Assistant header, tabs and menu

**Files:**
- Modify: `src/AssistantWorkspace.tsx` (whole header/tab block, `:20-50`)
- Modify: `src/assistant-workspace.css` (header, segmented tabs)
- Test: `tests/assistant-workspace-component.test.mjs` (update the Memory/Settings test, add new ones)

**Interfaces:**
- Consumes: `assistantStatus` (Task 2), `AssistantSection` (Task 4).
- Produces: `AssistantWorkspace` props replace `conversation/projects/projectView` with `chat: ReactNode; work: ReactNode`; removes `onAddAssistant` and `onBack` from the menu (the rail owns both). New exported helper `accessLabel(access: ParticipantConfig['access']): string` in `src/assistantStatus.ts`.

- [ ] **Step 1: Write the failing tests** — `header shows model, access and project count` (record profile model `deepseek-v4.1-flash`, access `ask`, 1 project → meta text `deepseek-v4.1-flash · Asks first · 1 project`; `2 projects` plural); `tabs are Chat and Work with attention count` (Work tab text `Work1` when status needsYou+failed = 1; no `Activity`/`Projects`/`Conversation` text); `menu holds only Memory and Settings`; `pause is a labelled button` (button text `Pause`, `Resume` when paused); `subview back says Chat or Work` (`previousSection:'work'`, section memory → button text `‹ Work`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Header: avatar · `<h1>{name}</h1>` · `<p>` meta (model id, `accessLabel`, `N project(s)`), status shown only when not `ready` as a flag beside the name (same `data-state` styling as Task 3). Segmented `role="tablist"` Chat/Work (Work count = `needsYou + failed`, warn pill). Actions: `<button className="…">Pause|Resume</button>` and ⋯ `details` menu with exactly Memory, Settings. Remove `· Assistant · Ongoing conversation`. Keep `hidden` (not unmount) for the Chat panel so the composer draft survives tab switches.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit` (App call site updated: pass `chat={…ApexAgentAll…}` and `work={<AssistantWork …/>}` — Work is a placeholder `null` until Task 7); `npm test` PASS.
- [ ] **Step 5: Commit** `feat(assistant): compact header with Chat/Work tabs`.

---

### Task 6: Chat always has a composer; review is one step

**Files:**
- Modify: `src/ApexAgentAll.tsx:51-56,138,226,445,608`
- Modify: `src/ApexAgentTasks.tsx:460-462,514`
- Test: `tests/apex-agent-all-component.test.mjs`, `tests/assistant-tasks-component.test.mjs` (extend)

**Interfaces:**
- Produces: `ApexAgentAll` prop `onOpenTask?: (key: string) => void` (embedded only); App wires it to `navigate work` + open that task (Task 7's `openTask`).

- [ ] **Step 1: Write the failing tests** — `embedded chat ignores stored tasks view` (seed the draft state `view:'tasks'` for the draftKey, render `embedded` → composer form `hidden` is false and transcript, not task list, renders); `embedded task link calls onOpenTask` (click `.assistant-task-link` → `onOpenTask` called with its key, view unchanged); `empty state uses the assistant name` (no tasks, `personal.name='Fidelity QA'` → text contains `Ask Fidelity QA`, not `ApexAgent`); `review is one button` (ready_for_review task, review material visible → no checkbox `.assistant-review-ack`; button `Mark reviewed` enabled only when `currentReviewVisible` and all review criteria checked); `result renders markdown` (result `**Fix first:** x` renders a `Markdown` element with that text).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `const shownView = embedded ? 'chat' : view` used for rendering and the form's `hidden`; in `openTask`, when `embedded && onOpenTask`, call it and return. Empty copy: `No tasks yet. Ask ${conversationName} to do something and it will show up here.` In `ApexAgentTasks`, drop the ack label and the `reviewed(task)` condition; the button's `disabled` becomes `busy || !currentReviewVisible || criteriaIncomplete` (the existing visibility signal is the proof the current revision was opened); delete the now-unused `reviewedRevision` state. In App, resolve the `onOpenTask` key by matching `projectTaskKey(task.lineage.project.hostId, task.lineage.project.workspaceId, task.id)` (`src/apexAgentTaskView.ts:32`) over `selectedDelegatedTasks`, then call the same handler Work uses (Task 7); an unmatched key stays in Chat. Render `task.result` with `<Markdown text={task.result} />`.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit && npm test` PASS.
- [ ] **Step 5: Commit** `fix(assistant): chat keeps its composer; single-step review`.

---

### Task 7: Work view merges Activity and Projects

**Files:**
- Create: `src/AssistantWork.tsx`
- Modify: `src/AssistantProjects.tsx:12-20,165-170` (props `compact`, `openTask`; card path)
- Modify: `src/App.tsx` (render `work={<AssistantWork …/>}`), `src/assistant-workspace.css` (work list styles)
- Test: `tests/assistant-work-component.test.mjs` (create), `tests/assistant-projects-component.test.mjs` (extend)

**Interfaces:**
- Consumes: `assistantWorkItems`, `WorkItem` (Task 2).
- Produces: `AssistantWork({ items, projects, onOpenTask, onNewTask, onAssignProject }: { items: ReturnType<typeof assistantWorkItems>; projects: ReactNode; onOpenTask: (item: WorkItem) => void; onNewTask?: () => void; onAssignProject?: () => void })`. `AssistantProjectsProps` gains `compact?: boolean; openTask?: { project: ProjectRef; taskId: string }`.

- [ ] **Step 1: Write the failing tests** — `sections in urgency order` (headings text order `Needs you`, `Working`, `Projects`, `Finished`); `empty working shows hint` (text `Nothing running. New tasks you start in Chat show up here.`); `finished is collapsed and groups cancelled` (`details` without `open`; 3 cancelled → one row `3 cancelled tasks`); `review button opens the task` (`Review` click → `onOpenTask(item)`); projects: `compact hides intro and stats` (no `assistant-project-intro` / `assistant-project-overview`); `card shows path not host id` (text contains cwd, not `hostId`); `openTask selects that task on mount`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Row = title, `projectName · worker · time` meta, warn border for Needs you, action button `Review` (needs you) or none. Toolbar: `+ New task` (primary, opens the existing delegate dialog through `onNewTask`) and `Assign a project`. App `onOpenTask`: delegated → `setMainView` section `work` + pass `openTask` to `AssistantProjects`; personal → section `chat`. `AssistantProjects`: when `compact`, skip intro/overview/filter select; seed `selected` from `openTask` in a `useEffect` keyed by `openTask?.taskId`; card subtitle `{item.project.cwd}`.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit && npm test` PASS.
- [ ] **Step 5: Commit** `feat(assistant): Work view with needs-you, working, projects, finished`.

---

### Task 8: New teammate empty chat with LandingTexture

**Files:**
- Modify: `src/ApexAgentAll.tsx` (embedded empty state), `src/landing/LandingTexture.tsx:36` (host selector)
- Modify: `src/App.tsx` (pass `landingTexture`), `src/assistant-workspace.css` (`.assistant-first-run`)
- Test: `tests/apex-agent-all-component.test.mjs` (extend), `tests/landing-texture*.test.mjs` if a selector test exists (else add one assertion to the new test)

**Interfaces:**
- Produces: `ApexAgentAll` prop `landingTexture?: LandingTextureSettings` (value from `effectiveLandingTexture(settings.landingTexture ?? DEFAULT_LANDING_TEXTURE, appearance)` exactly as `ChatPane` receives it at `App.tsx:2625`).

Copy (exact): eyebrow `New teammate`; heading `{name} is ready.`; body `Tell it what to own. It plans the work, runs your agents in its projects, and brings results back here.`; suggestion buttons `Review this project and tell me what to fix first.` · `Run the tests every morning and tell me what broke.` · `Check each new branch before I merge it.`; composer placeholder `Give {name} its first brief`.

- [ ] **Step 1: Write the failing tests** — `first run shows rain and copy` (embedded, zero entries and zero tasks → a `LandingTexture` element with the passed settings inside `.assistant-first-run`, heading `Fidelity QA is ready.`); `suggestion fills the composer, never sends` (click → composer value equals suggestion text, `onReply` not called); `first message replaces the empty state` (one personal message → no `.assistant-first-run`); `LandingTexture host includes assistant-first-run` (source of `LandingTexture.tsx` matches `.assistant-first-run`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Selector becomes `".chat-body, .agents-empty, .assistant-first-run"`. Empty state markup mirrors ChatPane's (`LandingTexture` then `.empty-copy` with the assistant avatar in `.empty-emblem`). CSS: `.assistant-first-run{position:relative}` children `z-index:1`; the soft calm behind the copy copies the `.transcript .landing-texture-wrap + .empty-copy::before` rule from `landing-texture.css` scoped to `.assistant-first-run`; texture extends under the composer like `.thread-landing`. Clay's serif heading comes from Clay's existing `.empty h3` rule — give the heading class `empty-title` and add `.assistant-first-run .empty-title` to that Clay selector.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit && npm test` PASS.
- [ ] **Step 5: Commit** `feat(assistant): rain empty state for a new teammate`.

---

### Task 9: Single-column Settings with one save bar

**Files:**
- Modify: `src/AssistantEditor.tsx:268-286` (settings layout), `src/assistantWorkspaceModel.ts` (add `dirtyFields`)
- Modify: `src/assistant-editor.css`
- Test: `tests/assistant-workspace-component.test.mjs`, `tests/assistant-workspace-model.test.mjs`

**Interfaces:**
- Produces: `dirtyFields(saved: {name:string;model:string;effort:string|null;access:string;projects:string[];look:{seed:string;color:string;kind?:string}}, draft: same): ('Name'|'Avatar'|'Model'|'Reasoning'|'Project tools'|'Projects')[]`. `AssistantEditor` prop `onOpenMemory?: () => void`.

Order (settings mode, top to bottom): General (avatar + Name + `Change avatar` toggling the existing `AssistantAvatarEditor` in a disclosure) → Model (Provider select **only when more than one compatible provider**; Model; Reasoning) → Projects & access (Project tools radiogroup `Ask first | Full access | Read only`; one `role="switch"` per project, `aria-label="Use {name}"`, path under the name; Browser row) → Memory row (button → `onOpenMemory`) → Tools & rules row (existing connections/rules `details`). Sticky footer: `{n} unsaved change(s) · {fields joined by ', '}` + `Discard` + `Save changes`; hidden when `n === 0`.

- [ ] **Step 1: Write the failing tests** — model: `dirtyFields lists changed fields in order` (model+effort changed → `['Model','Reasoning']`). component: `settings order` (text index General < Model < Projects & access < Memory < Tools & rules); `provider hidden with one provider`; `project tools is a radiogroup` (clicking `Full access` radio sets access `full`; replaces the old select-based assertion in the first existing test); `switch on granted project adds binding`; `switch on ungranted project asks first` (shows the existing confirm text `Allow {name} to access this folder and its subfolders?`, binding added only after the grant resolves); `failed folder grant leaves switch off` (grant rejects → switch unchecked, bindings unchanged, error shown); `save bar counts changes` (`1 unsaved change · Name`), `Discard restores saved values`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** using the existing state; the switch handler calls the existing `allowProjectFolder` path when `!granted && canGrantFolder`, and on success appends the binding. Remove the `Settings / Make X yours.` heading (the workspace subview header shows `‹ Chat` / `‹ Work` + `{name} settings`). Discard resets draft state to `savedBase`.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit && npm test` PASS.
- [ ] **Step 5: Commit** `feat(assistant): single-column settings with one save bar`.

---

### Task 10: Short Add a teammate dialog

**Files:**
- Modify: `src/AssistantCreationDialog.tsx`, `src/AssistantEditor.tsx` (create mode), `src/App.tsx:2703`
- Modify: `src/assistant-workspace.css` (`.assistant-creation`)
- Test: `tests/assistant-workspace-component.test.mjs`

**Interfaces:**
- Consumes: `assistantComposerDraftFor(key)` (`src/assistantComposerDrafts.ts:8`) to prefill the new assistant's composer.
- Produces: `AssistantCreation` gains `firstBrief?: string`; App, after `onSaved(ref)`, opens the assistant and writes `firstBrief` into that assistant's composer draft (`text` field) — **never sends it**.

Layout (exact copy): title `Add a teammate`; row: pixel avatar with `↻ Shuffle` (aria-label `New avatar pattern`) + Name; Model (+ Reasoning beside it); `In those projects it may` radiogroup `Ask first | Full access | Read only`; `First brief · optional` textarea, placeholder `e.g. Run the test suite every morning and tell me what broke.`, hint `Added to its chat, ready to send.`; `More options` disclosure holding Machine select, Allowed project folder, Browser note; footer `Cancel` + primary `Add teammate`. AI avatar generation stays in Settings only. Project assignment stays in Work/Settings (it needs folder grants this dialog cannot make safely).

- [ ] **Step 1: Write the failing tests** — `create dialog order and copy` (text order Name < Model < In those projects it may < First brief < More options; title `Add a teammate`; no `AI generate`, no `Connected context`); `machine lives under More options`; `first brief is prefilled not sent` (create with brief → `created[0].firstBrief` equals text; reply spy not called); update the existing creation test's `Avatar` ordering assertion to the new order.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the create-mode branch in `AssistantEditor`; move the Machine `<select>` from `App.tsx:2703` into the `More options` disclosure via a `machinePicker?: ReactNode` prop; submit label `Add teammate`.
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit && npm test` PASS.
- [ ] **Step 5: Commit** `feat(assistant): short Add a teammate dialog`.

---

### Task 11: Verify across every Appearance theme

**Files:** none (verification only).

- [ ] **Step 1:** `npx tsc --noEmit && npm test` — Expected: zero errors, all tests pass.
- [ ] **Step 2:** Start the dev build per `AGENTS.md`: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- [ ] **Step 3:** For each built-in skin — Classic, Smoked, Tide, Dusk, Rose, Frost, Liquid, Clay (dark) and Clay with Light on — open Settings › Appearance, apply it, then screenshot: an assistant's Chat with a Needs you card, Work, Settings, a brand-new teammate's empty chat, and the Add a teammate dialog. Expected: no warm fixed palette outside Clay, readable text on Frost and Clay light, glass blur on assistant surfaces for glass skins, rain visible behind the new-teammate copy and calm behind the text.
- [ ] **Step 4:** With macOS Reduce motion on, the rain renders one still frame; with Increase contrast on, it is absent (LandingTexture kill switches).
- [ ] **Step 5:** Record the 45 screenshots' pass/fail in the PR description; fix regressions in the owning task's files and re-run Step 1.
