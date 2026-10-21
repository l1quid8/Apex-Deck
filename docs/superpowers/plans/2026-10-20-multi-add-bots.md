# Multi-select Add Bot Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One trip through the "+ Add bot" menu can add several bots: tick any saved agents, set up one or more new bots with their full settings, and press one "Add N bots" button.

**Architecture:** The menu keeps its single live editor (the existing `draft`, with its model lists, API model loading and key handling). Finished new bots are frozen as `Draft` copies in a `queued` list and shown as one-line rows; clicking a row swaps it back into the editor. Checking the batch for name clashes and adding it one bot at a time live in a new pure module, `src/batchAdd.ts`, so the risky logic is unit-tested without rendering React. The daemon is unchanged: a batch is N ordinary `roomAddParticipant` calls in order.

**Tech Stack:** React + TypeScript (`src/ChatPane.tsx`), plain CSS (`src/styles.css`), `node --experimental-strip-types --test`.

**Spec:** the v2 mockup card `multi-agent-add-menu-mockup` from the 2026-10-20 group chat (the "v2 · full config per row" frame), plus the Human's notes in that chat: saved agents as checkable chips, new bots as rows with full config, one submit.

```
 + Add bot menu
 ┌───────────────────────────────────────────┐
 │ Saved agents  [x] Null  [x] Gwen  [ ] Muse│  picked: Set<id>
 │ New bots                                  │
 │  Claude · Opus · High · Can edit files  × │  queued[0] (frozen Draft)
 │  ▾ editor (tool, model, effort, access,   │  draft (live, today's state)
 │     name, persona, base URL/key for API) ×│
 │  + Another bot                            │  freeze draft → queued, new draft
 │                     More options  [Add 4] │  checkBatch → addInOrder
 └───────────────────────────────────────────┘
```

## Global Constraints

- Mention-handle rules stay in `src/slug.ts` (`botIdentity`, `mentionClash`, `clashMessage`); the batch must use them, not a copy.
- Never keep a typed API key in `queued`. Keys are saved to the machine by `withKey` when a row is frozen; a queued `Draft` always has `apiKey` empty.
- At most `MAX_NEW_BOTS = 4` new-bot rows per batch (queued + the open editor). Saved-agent picks are not capped.
- Opening the menu, picking one tool and pressing the button must still add exactly one bot ("Add 1 bot"). Today's single-bot flow is the zero-queued case, not a separate path.
- Only the chat quick-add menu changes. The full "More options" form, the Agents tab (`profileMode`), and the iPhone app stay single-bot.
- Copy: button reads `Add 1 bot` / `Add N bots`, or `Pick a bot` (disabled) when nothing is chosen; the row button reads `+ Another bot`.
- Run `npx tsc --noEmit` and `npm test` before calling any task done (AGENTS.md).

## Review Focus

1. **A clash inside the batch.** Two new rows both named "Opus", or a new row whose @handle matches a ticked saved agent. Expect: nothing is added and the second row shows "already answers to @opus". Pinned in Task 1 (`checkBatch` tests).
2. **A failure halfway through.** The daemon refuses bot 3 of 4 (another bot joined with that name meanwhile, or the room closed). Expect: bots 1–2 stay in the chat, the menu stays open with bots 3–4 still listed and the error on bot 3. Pinned in Task 1 (`addInOrder` test) and Task 3 (submit wiring).
3. **Auto-naming ignores queued rows.** The name-follows-model effect only looks at `participants`, so a second Claude row would also be called "Opus". Expect "Opus 2". Pinned in Task 2.
4. **An API bot with a typed key.** Freezing the row must save the key and keep only its name. Expect the queued row has `keyEnv` set and `apiKey` empty. Pinned in Task 3.
5. **A tall menu in a short window.** Four open-ish rows plus saved chips is taller than the old menu. Expect the menu scrolls inside itself and the Add button stays reachable. Pinned in Task 3 (CSS + offscreen render check).

---

### Task 1: Batch check and ordered add (pure module)

**Files:**
- Create: `src/batchAdd.ts`
- Test: `tests/batch-add.test.mjs`

**Interfaces:**
- Consumes: `botIdentity`, `Mentionable` from `src/slug.ts`; `ParticipantConfig` type from `src/backend.ts` (type-only import).
- Produces:
  - `export const MAX_NEW_BOTS = 4;`
  - `export function checkBatch(items: ParticipantConfig[], options: { others: readonly Mentionable[]; agents: readonly Mentionable[] }): { ok: ParticipantConfig[] } | { index: number; error: string }`. Walks `items` in order; each item is checked with `botIdentity(item, { editing: null, others: [...options.others, ...acceptedSoFar], agents: options.agents, place: "chat" })` and gets the returned `id`. First error wins and reports its index into `items`.
  - `export async function addInOrder(items: ParticipantConfig[], add: (config: ParticipantConfig) => Promise<void>): Promise<{ added: ParticipantConfig[]; failed: { index: number; error: string } | null }>`. Awaits each `add` in turn; stops at the first throw (no rollback of bots already added); `error` is `String(thrown)`.

- [ ] **Step 1: Write the failing tests** in `tests/batch-add.test.mjs` (import from `"../src/batchAdd.ts"`, same style as `tests/new-pane.test.mjs`):
  - `checkBatch accepts distinct names and gives each its id` — items `Opus`, `Forge` with `others: []` → `ok` ids `["opus", "forge"]`.
  - `checkBatch refuses two new bots with the same handle` — items `Opus`, `Opus` → `{ index: 1 }` and `error` matches `/already answers to @opus/`.
  - `checkBatch refuses a bot that clashes with someone already in the chat` — `others: [{ id: "gwen", display_name: "Gwen" }]`, items `[Opus, Gwen]` → `{ index: 1 }`.
  - `checkBatch refuses @all` — item named `All` → `{ index: 0 }`, error matches `/means everyone/`.
  - `addInOrder adds in order and stops at the first failure` — fake `add` records ids and throws on the third → `added` ids `["a", "b"]`, `failed.index === 2`, `failed.error` contains the thrown message, and the fourth was never called.
  - `addInOrder with no failure returns failed null`.
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/batch-add.test.mjs` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `src/batchAdd.ts` with the three exports above. No React, no backend import except the type.
- [ ] **Step 4: Run** the same command — expect all 6 PASS. Then `npx tsc --noEmit` — clean.
- [ ] **Step 5: Commit** `git add src/batchAdd.ts tests/batch-add.test.mjs && git commit -m "feat: check and add a batch of bots in order"`

### Task 2: Full settings in the quick-add editor

The v2 rows carry the same settings as the single-bot form. Today the quick-add editor has only tool, Model, Access and Name.

**Files:**
- Modify: `src/ChatPane.tsx` — `quickAddMenu` (around 2843–2902) and the name-follows-model effect (around 2499–2504)
- Modify: `src/styles.css` — `.quick-add-*` block (around 2433–2470)
- Test: `tests/chat-quick-add.test.mjs`

**Interfaces:**
- Consumes: render-scope `efforts`, `chosenApiModel`, `preset`, `set`, `effortLabel` already used by the full form (Reasoning effort field around 2742–2763).
- Produces: `queued: Draft[]` state declared here (empty until Task 3) so the naming effect can read it: `const [queued, setQueued] = useState<Draft[]>([]);` next to `quickAdd` (around line 632).

- [ ] **Step 1: Write the failing test** `quick add names a second bot after the queued ones` in `tests/chat-quick-add.test.mjs`: extract the `uniqueName(...)` call's taken-list expression from the effect source and assert it includes `queued` (regex on the effect body is acceptable here because the behavior itself is `uniqueName`, already unit-tested in `tests/new-pane.test.mjs`).
- [ ] **Step 2: Run** `npm test` — expect that test FAIL.
- [ ] **Step 3: Implement.**
  - Name effect: taken handles become `[...participants.map(mentionFor), ...queued.map((d) => slug(d.name))]`; add `queued` to its deps.
  - Editor adds, under the Model/Access grid: an **Effort** `<select name="quick-effort">` shown when `preset.efforts.length > 0`, options `Default` plus `efforts` via `effortLabel`; when `efforts` is empty show the hint "This model has no effort setting." A **Persona** `<input name="quick-persona">` (placeholder "Optional role or tone"). For `preset.api` presets only: **Base URL** (`draft.baseUrl`) and **Key name** (`draft.keyEnv`) plus a password **API key** input bound to `draft.apiKey`, reusing `keyNote(keyState, keyNameOf(draft))` as its hint.
  - Leave out Speed, Auto effort and Command; they stay behind "More options".
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` — all pass. Render the open menu offscreen with the app CSS and look at the PNG (one Claude editor, one API editor) before committing.
- [ ] **Step 5: Commit** `git commit -m "feat: effort, persona and API fields in the quick add menu"` (stage only `src/ChatPane.tsx`, `src/styles.css`, `tests/chat-quick-add.test.mjs`).

### Task 3: Ticked saved agents, queued rows, one submit

**Files:**
- Modify: `src/ChatPane.tsx` — state near line 632, `openQuickAdd` (2829), `addSaved` (2820, replaced), `quickAddMenu` (2843)
- Modify: `src/styles.css` — `.quick-add` (2434) and new `.quick-add-row*` rules
- Test: `tests/chat-quick-add.test.mjs`

**Interfaces:**
- Consumes: `checkBatch`, `addInOrder`, `MAX_NEW_BOTS` (Task 1); `queued`/`setQueued` (Task 2); existing `withKey`, `draftToConfig`, `createAppearance`, `rememberModel`, `notify`.
- Produces (component-local):
  - `const [picked, setPicked] = useState<Set<string>>(new Set());` — ids of ticked saved agents.
  - `const [editorOpen, setEditorOpen] = useState(true);` — whether the live editor counts as a row.
  - `freezeDraft(): Promise<boolean>` — runs `withKey(draft)`, then `draftToConfig`; on a string error calls `setFormError` and returns false; otherwise pushes the keyed draft (with `apiKey: ""` and an `appearance` from `createAppearance`) to `queued`.
  - `submitBatch(): Promise<boolean>` — see Step 3.

- [ ] **Step 1: Write the failing tests** in `tests/chat-quick-add.test.mjs`:
  - `saved agents in the quick add menu are toggles, not instant adds` — the saved chip render has `role="checkbox"` and `aria-checked`, and the source no longer contains `addSaved(`.
  - `the quick add submit counts the batch` — extract the label expression and evaluate it: `(0 picked, 0 queued, editor open)` → `Add 1 bot`; `(2, 1, true)` → `Add 4 bots`; `(0, 0, false)` → `Pick a bot`.
  - `a queued row never keeps a typed key` — extract the object pushed to `setQueued` in `freezeDraft` and assert it sets `apiKey: ""`.
- [ ] **Step 2: Run** `npm test` — expect the three FAIL.
- [ ] **Step 3: Implement.**
  - **Open/close:** `openQuickAdd` also resets `picked` to empty, `queued` to `[]`, `editorOpen` to true. Closing the menu (outside click, Escape, success) drops the batch; nothing is half-saved.
  - **Saved chips:** same chip look, now `role="checkbox" aria-checked={picked.has(p.id)}`, click toggles the id, `.on` style when ticked. Delete `addSaved`.
  - **Rows:** each `queued[i]` renders as a `.quick-add-row` button reading `{tool label} · {name} · {effort label or "Default"} · {access label}` with a `×` (aria-label `Remove {name}`). Clicking a row: if the editor is open and valid, freeze it first (if invalid, show its error and stop); then move `queued[i]` into `draft`, set `nameTouched.current = true`, remove it from `queued`. The editor's own `×` sets `editorOpen` false and clears `formError`.
  - **+ Another bot:** disabled when `queued.length + (editorOpen ? 1 : 0) >= MAX_NEW_BOTS` (title "Up to 4 new bots at a time"). If the editor is open, `freezeDraft()` first and stop on false; then reset `draft` with `emptyDraft(current preset, draft.access)`, `nameTouched.current = false`, `setEditorOpen(true)`.
  - **submitBatch:** build `items` = ticked saved agents (in the order shown) + `queued.map(draftToConfig)` + the editor's keyed config if `editorOpen`. Any string from `draftToConfig` → `setFormError`, stop. `checkBatch(items, { others: participants, agents: profiles })`; on error show it on the failing row (saved chip → `notify(error, "error")`; editor/queued row → `setFormError` and open that row in the editor). Then `addInOrder(ok, (c) => backend.roomAddParticipant(pane.id, c))`; append each `added` config to `participants` (same `list.some` guard as today) and call `rememberModel` for agent bots. On `failed`: keep the menu open, drop the added bots from `picked`/`queued`, and show `Added {n}. Could not add {name}: {error}` via `setFormError`. On success: `closeForm(draft.preset)`, return true.
  - **Form submit:** `onSubmit` calls `submitBatch()` and closes the menu when it returns true. Enter inside the editor therefore submits the whole batch, same as the button.
  - **Height:** `.quick-add` gets `max-height: var(--room, min(70vh, 640px)); overflow-y: auto;` and `.quick-add-foot` becomes `position: sticky; bottom: 0; background: var(--panel-2);` so the button stays visible.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` — all pass. Offscreen render with app CSS at a 700 px tall window: 2 ticked chips, 2 queued rows, open editor. Look at the PNG: the footer is visible, the rows fit 330 px without wrapping into a column.
- [ ] **Step 5: Commit** `git commit -m "feat: add several bots from one quick add menu"` (stage only this task's three files).

### Task 4: Check it in the running app, then hand off for review

**Files:** none changed unless a check fails.

- [ ] **Step 1:** Start the dev build from `~/Downloads/apex-deck` with `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- [ ] **Step 2:** In a new thread: tick two saved agents, queue one Claude and one API bot, press "Add 4 bots". Expect four chips in the composer and four join notices, in that order.
- [ ] **Step 3:** Queue two bots named "Opus" by hand. Expect nothing added and the clash message on the second row.
- [ ] **Step 4:** Old flow: open the menu, press "Add 1 bot" with defaults. Expect one bot, same as before this branch.
- [ ] **Step 5:** Kick every bot, then open the add menu from the small composer seat (from `f318a17`). Expect the same batch menu.
- [ ] **Step 6:** Hand the branch to Null for review (memory: "Null reviews finished work"). Don't merge or push until the Human says so.

## Out of scope

- Batch adding on the iPhone app and in the Agents tab.
- Removing the big empty-thread "+ Add bot" button. That's a separate decision, now that `8b6cd08` stops it stretching.
- A daemon-side "add many" call. N calls in order are enough at 4–10 bots, and one call per bot keeps the daemon's clash check working per bot.

## Task 5 (added 2026-10-20): the message box grows into the menu

From mockup `mockups/add-bot-menu-theme-v2.html`, picked by the Human.

- The welcome button and the composer seat both open one place, `quickAdd === "dock"`: the menu is the first child of `.composer-box.adding`, which hides its own controls. The floating hero menu and the roster portal are removed (clean cut-over). The sidebar's "details" menu is unchanged.
- The welcome block gets `.away` (fades and stops taking clicks) while the menu is open; × or Esc brings it back.
- Menu layout: header with ×, a scrolling middle (saved agents as avatar tiles, new-bot rows, the editor, "+ Another bot"), and a lineup strip outside the scroll (faces, `lineupText`, More options, Add N bots).
- On Glass and Clay the docked menu drops its own popup surface so the message box is the only material; Glass lifts the box's fill to at least .62 while it is the menu.
