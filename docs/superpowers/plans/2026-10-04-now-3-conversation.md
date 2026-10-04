# Now tier, Stage 3: conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You can read a thread while bots stream without losing your place, always see who gets your next message, recover from a failed or cut-off reply with one click, and hand a quoted reply to another bot.

**Architecture:** Each idea's rules live in a small pure TypeScript module with `node:test` coverage: `src/transcriptPlace.ts` (3.1), `src/recipients.ts` (3.2), `src/noticeActions.ts` (3.3), plus additions to `src/composerStatus.ts`, `src/reply.ts` and `src/turnQueue.ts`. `src/ChatPane.tsx` only measures the DOM, keeps state and renders. The one wire change is in `apex-core`: `RoomEvent::HopLimitReached` gains `next`, and `ConcurrentRoom::begin_turn` and the `room_turn` command take the participants to run plus an optional hop budget. The browser preview backend in `src/backend.ts` follows bot-to-bot rounds the way the native room does and gains two preview-only trigger words ("relay", "fail") so every new state can be walked through without the desktop app.

**Tech Stack:** React 19 + TypeScript (Vite), `node:test` with `--experimental-strip-types`, Rust (`apex-core`, Tauri 2 shell in `src-tauri`). No new dependencies.

**Spec:** docs/superpowers/specs/2026-10-04-now-tier.md (section "Stage 3: conversation"; "Shared interfaces" and "Global constraints" bind this plan).

## Global Constraints

- Preserve everything in "Must keep working" of `2026-10-03-ui-review-fixes.md`: approval cards, the turn queue and steering, `/compact` `/clear` `/pin` `/diff` `/fork` `/export`, attention counts, dragging panes without remounting terminals, and the browser preview behaving like the native app.
- The browser preview backend (`src/backend.ts`, preview half) gets every new command and event the native backend gets.
- Restoring or applying anything never silently raises access or starts an agent. Keys stay out of saved state.
- Standing decisions (`2026-10-03-open-work.md`): slash commands only create something or take text you'd type; no coloured left bars on strips or rows; pins stay a collapsible row above the chat; agent colours are chosen once and saved.
- Copy: second person, plain, sentence case, verb-first buttons, "e.g." placeholders, " · " joins facts, no emoji. Attention colours always come with words. Red (`--danger`) means Failed and destructive actions only.
- No new dependencies.
- New files differ from every existing file name by more than case.
- Commit on the stage's feature branch. Don't push and don't merge to `main` unless Tyler asks.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` (the suite only passes serially).
- Shared interfaces used exactly as the spec names them: `HopLimitReached.next` and a hop budget on `room_turn`, each with a `crates/apex-core/tests/wire_format.rs` update; `ThreadStatus` (stage 1) keeps its shape; `src/approvals.ts` (stage 2) is read only through its exported functions (this plan does not need to read it at all; see Task 3).
- New fields on saved structs use `#[serde(default)]`; `Pane.lastSeenSeq` is optional so older session files load without it.
- Pure modules (`src/*.ts` with tests) use type-only imports for types, import values from other pure modules with the `.ts` extension (as `src/composerMenu.ts` does), and use no enums, no parameter properties and no React, so they load under `--experimental-strip-types`.
- Tyler's own uncommitted work is never stashed, reset, checked out or discarded.

## Review Focus

1. Email addresses and `@` inside words (`me@opus.dev`, `x@all`, `@param`) are not mentions: the recipient line keeps the policy's reason and a quote still leads with the quoted bot. Test: Task 6, `an @ inside a word is not a mention`.
2. A quoted reply whose own text @mentions other bots does not count as your mention: quoting Jigga's "Ask @null about it" still goes to Jigga, and Null is not summoned. Test: Task 14, `a mention inside the quoted text is not yours`.
3. A thread you `/clear`ed restarts its messages at seq 0, so the mark saved before the clear must not hide the new replies. Test: Task 5, `a mark from before /clear does not hide new replies` (and ChatPane saves -1 on clear).
4. A thread that loads or grows while its pane is hidden (another workspace or section, `display: none`, which measures all zeros) opens at its latest message, or at its divider, when shown, never at the top. Test: Task 1, `a transcript that is not laid out counts as at the bottom`; Task 2's resize observer applies it when the pane is shown.
5. A bot removed after it failed, or named in a cut-off `next` list: no button for it, and "Let them answer" runs only bots still in the room. Test: Task 12, `a button only runs bots that are still here`.

---

## Before you start

- **Where to run things:** every command runs from the root of the checkout you work in: the main checkout `/Users/tylercaldwell/Downloads/apex-deck`, or the git worktree you were given. Paths in this plan are relative to that root.
- **Line numbers** are from `main@95d753d` plus Tyler's uncommitted composer auto-grow edits in the main checkout, before stage 1. Those edits add 7 lines after line 424 of `src/ChatPane.tsx`; in a tree without them, ChatPane lines after 424 are 7 lower. Stage 1 also changes `src/ChatPane.tsx` (how it reports `ThreadStatus`), `src/App.tsx`, `src/closing.ts` and `src-tauri/src/lib.rs`, so some numbers will have moved. Every step quotes the code it changes; find it by that.
- **Order:** the spec says stage 3 depends only on stage 1 being merged. Task 0 checks this.
- **Preview setup** (used by every preview check below):
  1. Run `npm run dev` (Vite on `http://localhost:1420/`; the title bar shows "Preview mode").
  2. Open it at the size the step names (1440x900 unless it says otherwise) and click once inside the page so the window has focus.
  3. If there is no workspace yet, click **Add a workspace** (the preview names it workspace-1), then **Start a group chat** (or **+ New thread**, Group chat).
  4. In the empty thread, use **+ Add model** twice: **Null** = Claude Code with Access **Ask first** (the preview has an Ask-first bot propose an edit, a command and a permission, one card at a time), and **Jigga** = Codex, **Read only**. A preview reply streams for 3 to 5 seconds.
  5. To start clean, run `localStorage.clear()` in the devtools console and reload.
  6. Preview-only trigger words this plan adds: a message containing `relay` makes each bot end its reply by @mentioning the next bot in the room (`relay all`: @all); a message containing `fail` makes each addressed bot fail once (Task 13).

## File map

| File | Change |
|---|---|
| `src/transcriptPlace.ts` (new) | At-bottom rule, new-replies pill, out-of-view cards, the "New since you looked" mark. |
| `src/recipients.ts` (new) | Mentions by the room's rules, the recipient line, empty-room examples, the 260px rule. |
| `src/noticeActions.ts` (new) | Try again and Let them answer: who gets a button, the cut-off notice copy, when buttons go. |
| `src/composerStatus.ts` | `waitingVerb`, `statusParts`, `stopLabel`, `stopTargets`; `composerCopy` gains first-message and quoting copy. |
| `src/reply.ts` | Quote lead rules, hand-off menu, quoting your own messages, the 360px rule. |
| `src/turnQueue.ts` | A one-off `turn` item that runs bots on the transcript as it is. |
| `src/ChatPane.tsx` | Scroll handling, pills, divider, split status, recipient line, examples, notice buttons, quote hand-off, message actions. |
| `src/Approvals.tsx` | Data attributes so a card can be found and its Allow once focused. |
| `src/App.tsx` | Saves `lastSeenSeq` on chat panes. |
| `src/types.ts` | `Pane.lastSeenSeq`; `hop_limit_reached.next`. |
| `src/backend.ts` | `roomTurn(id, participants, hops)` on both halves; preview follows rounds, emits `hop_limit_reached` with `next`, and fails on purpose for `fail`. |
| `src/DeckIcon.tsx` | A copy icon. |
| `src/styles.css` | Pills, divider, recipient line, examples, notice buttons, hand-off menu, message actions. |
| `crates/apex-core/src/room.rs`, `concurrent.rs` | `HopLimitReached.next`; `begin_turn(ids, hops)`. |
| `src-tauri/src/lib.rs` | `room_turn(id, participants, hops)`. |
| `crates/apex-core/tests/{wire_format,room,concurrent}.rs`, `tests/*.test.mjs` | Tests below. |
| `README.md`, `SPEC.md` | Describe the new behaviour (Task 17). |

---

### Task 0: Preflight

**Files:** none changed.

**Interfaces:**
- Consumes: nothing.
- Produces: the branch `feat/now-3-conversation`, and baseline results the final report compares against.

- [ ] **Step 1: Check the working tree**

Run: `git status --short`
Expected in the main checkout if nothing has happened since the review: ` M src/ChatPane.tsx`, ` M src/styles.css`, and untracked `docs/superpowers/` files.

If `src/ChatPane.tsx` or `src/styles.css` show as modified, those are Tyler's own composer auto-grow edits and not part of this plan. Stop and ask Tyler:

> src/ChatPane.tsx and src/styles.css have your uncommitted composer auto-grow change. Every task in this plan edits both files, and I can't commit around your hunks (interactive `git add -p` isn't available here). Shall I commit them first as their own commit, or would you like to handle them?

Never stash, reset, check out or discard them. If Tyler says not to commit them, stop here and wait for his direction. If he says to commit them, run:

```bash
git add src/ChatPane.tsx src/styles.css
git commit -m "feat: composer grows with its text"
```

- [ ] **Step 2: Find stage 1**

Run: `git grep -n "export interface ThreadStatus" main -- src/types.ts`
- One line printed: stage 1 is merged. The base is `main`.
- Nothing printed: run `git branch --list "*now-1*"`. If a stage-1 branch exists (for example `feat/now-1-safety`), it is the base; tell Tyler "Stage 1 isn't merged yet, so I'm building stage 3 on `<that branch>`." If no stage-1 branch exists, stop and tell Tyler stage 1 has to land first (the spec makes stage 3 depend on it).

- [ ] **Step 3: Note whether stage 2 is in the base**

Run: `git ls-tree --name-only <base> src/approvals.ts`
- Prints `src/approvals.ts`: stage 2 is in the base. Tasks 3 and 4 read the cards ChatPane renders and its own `asks`; check that ChatPane still keeps an `asks` state for its cards (`grep -n "const \[asks, setAsks\]" src/ChatPane.tsx`). If stage 2 replaced it with a read from `src/approvals.ts`, use that store's exported per-room reader wherever these tasks say `asks`, keeping the shape `Record<string, { request: string; action: ProposedAction }[]>` by mapping its cards to it.
- Prints nothing: stage 2 is not in the base. That is fine: these tasks use ChatPane's own open asks (the fallback the spec allows). If a stage-2 branch exists unmerged, ask Tyler whether to stack stage 3 on it; by default don't.

- [ ] **Step 4: Create the stage branch**

Run: `git switch -c feat/now-3-conversation <base>`, where `<base>` is what Step 2 found (`main`, or the stage-1 branch)
Expected: `Switched to a new branch 'feat/now-3-conversation'`

- [ ] **Step 5: Record baselines**

Run each and write the results down for the final report:

- `npm test` — Expected: `ℹ fail 0`. Note the pass count (113 on `main@95d753d` before stage 1).
- `npm run build` — Expected: `tsc --noEmit` prints nothing, then Vite prints `✓ built in`.
- `cargo test --workspace -- --test-threads=1` — Expected: every `test result: ok.` Note each line. On `main@95d753d`, `apex-core` reports 18 (unit), 12 (`concurrent`), 35 (`room`), 3 (`server_request`) and 9 (`wire_format`).

If any baseline fails, stop and report it to Tyler before changing anything.

- [ ] **Step 6: Commit**

Nothing to commit in this task. Run `git status --short` and confirm only untracked `docs/superpowers/` files are listed.

---

### Task 1: Rules for keeping your place

**Files:**
- Create: `src/transcriptPlace.ts`, `tests/transcript-place.test.mjs`
- Modify: `src/composerStatus.ts:7-10` (add `waitingVerb` after `replyingVerb`), `tests/composer-status.test.mjs:3` and end of file

**Interfaces:**
- Consumes: `joinNames(names: string[]): string` from `src/composerStatus.ts`.
- Produces:
  - `AT_BOTTOM_PX = 80`
  - `isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean`
  - `newPill(count: number): string`
  - `interface CardBox { by: string; request: string; top: number; bottom: number }`
  - `cardsOutOfView(cards: CardBox[], viewTop: number, viewBottom: number): CardBox[]`
  - `owners(cards: CardBox[]): string[]`
  - `waitingLine(names: string[]): string`
  - in `src/composerStatus.ts`: `waitingVerb(count: number): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/transcript-place.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { AT_BOTTOM_PX, cardsOutOfView, isAtBottom, newPill, owners, waitingLine } from "../src/transcriptPlace.ts";

test("within 80px of the bottom counts as at the bottom", () => {
  assert.equal(AT_BOTTOM_PX, 80);
  assert.equal(isAtBottom(1000, 1500, 500), true);
  assert.equal(isAtBottom(920, 1500, 500), true);
  assert.equal(isAtBottom(919, 1500, 500), false);
  assert.equal(isAtBottom(0, 1500, 500), false);
});

test("a transcript that is not laid out counts as at the bottom", () => {
  // A hidden pane (display: none) measures all zeros. It must stay "at the
  // bottom" so it opens at the latest message when it is shown.
  assert.equal(isAtBottom(0, 0, 0), true);
});

test("the new-replies pill counts what arrived", () => {
  assert.equal(newPill(1), "1 new · Jump to latest");
  assert.equal(newPill(3), "3 new · Jump to latest");
});

test("only cards wholly outside the view count, oldest first", () => {
  const cards = [
    { by: "null", request: "ask-1", top: -300, bottom: -100 },
    { by: "jigga", request: "ask-2", top: 50, bottom: 250 },
    { by: "null", request: "ask-3", top: 380, bottom: 600 },
    { by: "ada", request: "ask-4", top: 400, bottom: 640 },
    { by: "null", request: "ask-5", top: 700, bottom: 900 },
  ];
  const away = cardsOutOfView(cards, 0, 400);
  assert.deepEqual(away.map((c) => c.request), ["ask-1", "ask-4", "ask-5"]);
  assert.deepEqual(owners(away), ["null", "ada"]);
});

test("the waiting pill names who is waiting", () => {
  assert.equal(waitingLine(["Null"]), "Null is waiting for you");
  assert.equal(waitingLine(["Null", "Jigga"]), "Null and Jigga are waiting for you");
});
```

In `tests/composer-status.test.mjs`, change line 3 to:

```js
import { joinNames, replyingVerb, composerCopy, waitingVerb } from "../src/composerStatus.ts";
```

and add at the end:

```js
test("the waiting verb agrees with the count", () => {
  assert.equal(waitingVerb(1), "is waiting for you");
  assert.equal(waitingVerb(2), "are waiting for you");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/transcript-place.test.mjs tests/composer-status.test.mjs`
Expected: FAIL. `transcript-place` reports `ERR_MODULE_NOT_FOUND` for `src/transcriptPlace.ts`; `composer-status` reports `The requested module '../src/composerStatus.ts' does not provide an export named 'waitingVerb'`.

- [ ] **Step 3: Implement**

In `src/composerStatus.ts`, after `replyingVerb` (line 10), add:

```ts
/** The verb after the names of bots stopped on an approval card. */
export function waitingVerb(count: number): string {
  return count === 1 ? "is waiting for you" : "are waiting for you";
}
```

Create `src/transcriptPlace.ts`:

```ts
// Keeping your place in a thread's transcript.
//
// The transcript follows new content only while you are at its bottom.
// Scrolled up, it stays where you are and offers pills instead: one to
// jump to the latest reply, one to bring an approval card back into view.
// These rules are plain functions so they can be tested without a browser.

import { joinNames, waitingVerb } from "./composerStatus.ts";

/** How close to the bottom still counts as at the bottom, in pixels. */
export const AT_BOTTOM_PX = 80;

/**
 * Whether a scroller sits at its bottom, or within AT_BOTTOM_PX of it. A
 * transcript that is not laid out (a hidden pane measures all zeros) counts
 * as at the bottom, so it opens at the latest message when it is shown.
 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_PX;
}

/** The pill that jumps down: "3 new · Jump to latest". */
export function newPill(count: number): string {
  return `${count} new · Jump to latest`;
}

/** An open approval card's place on screen, in the same coordinates as the view. */
export interface CardBox {
  /** The bot that asked. */
  by: string;
  /** The request id from its `approval_requested` event. */
  request: string;
  top: number;
  bottom: number;
}

/** Cards wholly above or below the visible part of the transcript, oldest first. A card you can see part of is in view. */
export function cardsOutOfView(cards: CardBox[], viewTop: number, viewBottom: number): CardBox[] {
  return cards.filter((card) => card.bottom <= viewTop || card.top >= viewBottom);
}

/** The bots that own `cards`, each once, in order. */
export function owners(cards: CardBox[]): string[] {
  return [...new Set(cards.map((card) => card.by))];
}

/** "Null is waiting for you", "Null and Jigga are waiting for you". */
export function waitingLine(names: string[]): string {
  return `${joinNames(names)} ${waitingVerb(names.length)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/transcript-place.test.mjs tests/composer-status.test.mjs`
Expected: `ℹ fail 0`; the 5 `transcript-place` tests and the new waiting-verb test pass (9 tests in all if stage 2 has not added `composer-status` tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `ℹ fail 0`, pass count = baseline + 6.

- [ ] **Step 6: Commit**

```bash
git add src/transcriptPlace.ts src/composerStatus.ts tests/transcript-place.test.mjs tests/composer-status.test.mjs
git commit -m "feat: rules for keeping your place in a thread"
```

---

### Task 2: Hold your place while bots stream

**Files:**
- Modify: `src/ChatPane.tsx:6` (React import), `:31` (import), after `:424`/`:431` (new state), `:482-483` (bot branch of `message_added`), `:650-653` (scroll effect), `:885` (`send`), `:1426` (transcript), after `:1534` (pills)
- Modify: `src/styles.css:1410-1414` (`.chat-body`), end of file

**Interfaces:**
- Consumes: `isAtBottom`, `newPill` (Task 1).
- Produces, inside `ChatPane` for Tasks 3 and 5: `stuck: MutableRefObject<boolean>`, `unread` / `setUnread`, `settle: MutableRefObject<() => void>`, `onTranscriptScroll(): void`, `jumpToLatest(): void`, and the `.transcript-pills` container inside `.chat-body`.

- [ ] **Step 1: Import the rules**

In `src/ChatPane.tsx`, make sure line 6 imports `useLayoutEffect` (Tyler's composer change adds it; if it is missing, make the line `import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";`). After line 31 (`import { attachmentName, withAttachments, type Attachment } from "./attachments";`) add:

```ts
import { isAtBottom, newPill } from "./transcriptPlace";
```

- [ ] **Step 2: Add the state**

After `const composer = useRef<HTMLDivElement>(null);` (line 424), and after the composer auto-grow effect that follows it when Tyler's change is present (lines 425-431, ending `}, [text]);`), add:

```ts
  /** Whether the transcript sat at its bottom when it was last scrolled. New
   *  content follows only then; scrolled up, the transcript keeps your place. */
  const stuck = useRef(true);
  /** Bot replies that arrived while you were scrolled up. */
  const [unread, setUnread] = useState(0);
```

- [ ] **Step 3: Count replies that land while you are scrolled up**

In the `message_added` case, replace:

```ts
          if (event.message.speaker.kind === "bot") {
            const id = event.message.speaker.id;
```

with:

```ts
          if (event.message.speaker.kind === "bot") {
            const id = event.message.speaker.id;
            if (!stuck.current) setUnread((n) => n + 1);
```

- [ ] **Step 4: Follow the bottom only from the bottom**

Replace the effect at lines 650-653:

```ts
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, drafts, asks]);
```

with:

```ts
  /** Bring the transcript to where it should be after anything changed in it. */
  const settle = useRef(() => {});
  settle.current = () => {
    const el = scroller.current;
    // A hidden pane cannot scroll; the resize when it is shown settles it.
    if (!el || el.clientHeight === 0) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
  };
  // Before paint, so following the bottom never flickers.
  useLayoutEffect(() => settle.current(), [entries, drafts, asks]);
  // Showing the pane, or a composer that grows, changes the transcript's
  // height without any scrolling: stay at the bottom if you were there.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => settle.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, [profileMode]);
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stuck.current) setUnread(0);
  };
  const jumpToLatest = () => {
    stuck.current = true;
    setUnread(0);
    settle.current();
  };
```

- [ ] **Step 5: Sending takes you to the bottom**

In `send`, after `if (participants.length === 0) return;` (line 885) add:

```ts
    // Sending takes you to the bottom, where your message and the replies land.
    stuck.current = true;
    setUnread(0);
```

- [ ] **Step 6: Listen to scrolling**

Replace line 1426:

```tsx
      {!profileMode && <div className="transcript" ref={scroller}>
```

with:

```tsx
      {!profileMode && <div className="transcript" ref={scroller} onScroll={onTranscriptScroll}>
```

- [ ] **Step 7: Show the pill**

Between the transcript's closing `</div>}` (line 1534) and the `.chat-body` closing `</div>` (line 1535) add:

```tsx
      {!profileMode && unread > 0 && <div className="transcript-pills">
        <button type="button" className="transcript-pill" onClick={jumpToLatest}>{newPill(unread)}</button>
      </div>}
```

- [ ] **Step 8: Style it**

In `src/styles.css`, replace lines 1410-1414:

```css
.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
```

with:

```css
.chat-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
```

and add at the end of the file:

```css
/* Now 3.1: pills that keep your place while bots stream. */
.transcript-pills { position: absolute; left: 0; right: 0; bottom: 12px; z-index: 5; display: flex; justify-content: center; gap: 8px; padding: 0 12px; pointer-events: none; }
.transcript-pill { pointer-events: auto; display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 5px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
.transcript-pill:hover:not(:disabled) { background: var(--panel-2); }
```

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: no TypeScript errors; Vite prints `✓ built in`.

- [ ] **Step 10: Preview check (1440x900)**

Preview setup; only Jigga (Read only) is needed. Look for:
- Send `@jigga hello` three times (the extra ones queue). While a reply streams, scroll up a screen: the transcript stays where you put it. When the reply lands, a pill "1 new · Jump to latest" sits centred above the composer; the count goes up with each reply.
- Click the pill: the view jumps to the bottom and the pill goes.
- At the bottom, a streaming reply keeps the view at the bottom. Scrolling up less than 80px still follows.
- With the view at the bottom, type four lines with Shift+Enter so the composer grows: the last message stays in view.
- Add a second workspace (**+** in the rail), send `@jigga hello` in workspace-1, switch to workspace-2 straight away, wait 6 seconds, switch back: workspace-1's thread shows the latest reply, not the top.
- Send while scrolled up: the view goes to the bottom.

- [ ] **Step 11: Commit**

```bash
git add src/ChatPane.tsx src/styles.css
git commit -m "feat: threads keep your place while bots stream"
```

---

### Task 3: "Null is waiting for you · Show"

**Files:**
- Modify: `src/Approvals.tsx:27-31` (props), `:37` (signature), `:46` (card root), `:54` (buttons)
- Modify: `src/ChatPane.tsx` (the `transcriptPlace` import from Task 2; new state after Task 2's `unread`; `settle` and `onTranscriptScroll` from Task 2; `ApprovalCard` at `:1513-1519`; the pills from Task 2)
- Modify: `src/styles.css` (end of file)

**Interfaces:**
- Consumes: `cardsOutOfView`, `owners`, `waitingLine`, `type CardBox` (Task 1); `stuck`, `settle`, `onTranscriptScroll`, `.transcript-pills` (Task 2).
- Produces: `ApprovalCard` props `request?: string; by?: string`; card root attributes `data-request`, `data-by`, `data-answered`; button attribute `data-answer` (`"once" | "always" | "deny"`); in `ChatPane`: `measureCards(): void`, `showCard(request: string): void`, `cardsAway: CardBox[]`.

This task reads the cards the transcript renders. They come from ChatPane's own open asks, the fallback the spec allows when stage 2 isn't merged, and the same cards stage 2's store holds when it is. Nothing here imports `src/approvals.ts`.

- [ ] **Step 1: Let a card be found on screen**

In `src/Approvals.tsx`, replace lines 27-31:

```tsx
interface CardProps {
  action: ProposedAction;
  /** Called once with the person's answer. `always` stops the same thing being asked again. */
  onDecide: (approve: boolean, always: boolean) => void;
}
```

with:

```tsx
interface CardProps {
  action: ProposedAction;
  /** Called once with the person's answer. `always` stops the same thing being asked again. */
  onDecide: (approve: boolean, always: boolean) => void;
  /** The request id and the bot that asked, put on the card so the thread can find it on screen. */
  request?: string;
  by?: string;
}
```

Replace line 37 `export function ApprovalCard({ action, onDecide }: CardProps) {` with:

```tsx
export function ApprovalCard({ action, onDecide, request, by }: CardProps) {
```

Replace line 46:

```tsx
    <div className="approval" role="group" aria-label={`Allow or deny: ${action.title}`}>
```

with:

```tsx
    <div className="approval" role="group" aria-label={`Allow or deny: ${action.title}`} data-request={request} data-by={by} data-answered={answered !== null ? "" : undefined}>
```

Replace line 54:

```tsx
          <button key={answer} className={answer === "once" ? "primary" : answer === "deny" ? "danger" : "ghost"} onClick={() => decide(answer)} disabled={answered !== null}>
```

with:

```tsx
          <button key={answer} data-answer={answer} className={answer === "once" ? "primary" : answer === "deny" ? "danger" : "ghost"} onClick={() => decide(answer)} disabled={answered !== null}>
```

- [ ] **Step 2: Import the card rules**

In `src/ChatPane.tsx`, replace the line added in Task 2:

```ts
import { isAtBottom, newPill } from "./transcriptPlace";
```

with:

```ts
import { cardsOutOfView, isAtBottom, newPill, owners, waitingLine, type CardBox } from "./transcriptPlace";
```

- [ ] **Step 3: Measure the cards**

After Task 2's `const [unread, setUnread] = useState(0);` add:

```ts
  /** Open approval cards wholly out of view, oldest first. */
  const [cardsAway, setCardsAway] = useState<CardBox[]>([]);
  /** Find the open cards on screen and note which are out of view. */
  const measureCards = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    const view = el.getBoundingClientRect();
    const boxes = [...el.querySelectorAll<HTMLElement>(".approval[data-request]:not([data-answered])")].map((card) => {
      const box = card.getBoundingClientRect();
      return { by: card.dataset.by ?? "", request: card.dataset.request ?? "", top: box.top, bottom: box.bottom };
    });
    const away = cardsOutOfView(boxes, view.top, view.bottom);
    setCardsAway((old) => (old.map((c) => c.request).join("\n") === away.map((c) => c.request).join("\n") ? old : away));
  };
  /** Bring a card to the middle of the view and put focus on its Allow once. */
  const showCard = (request: string) => {
    const el = scroller.current;
    const card = el?.querySelector<HTMLElement>(`.approval[data-request="${CSS.escape(request)}"]`);
    if (!el || !card) return;
    const box = card.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    el.scrollTop += box.top - view.top - Math.max(12, (el.clientHeight - box.height) / 2);
    card.querySelector<HTMLButtonElement>('button[data-answer="once"]')?.focus({ preventScroll: true });
  };
```

- [ ] **Step 4: Measure after every change and every scroll**

Replace Task 2's `settle.current = …` assignment:

```ts
  settle.current = () => {
    const el = scroller.current;
    // A hidden pane cannot scroll; the resize when it is shown settles it.
    if (!el || el.clientHeight === 0) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
  };
```

with:

```ts
  settle.current = () => {
    const el = scroller.current;
    // A hidden pane cannot scroll; the resize when it is shown settles it.
    if (!el || el.clientHeight === 0) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    measureCards();
  };
```

and replace Task 2's `onTranscriptScroll`:

```ts
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stuck.current) setUnread(0);
  };
```

with:

```ts
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stuck.current) setUnread(0);
    measureCards();
  };
```

- [ ] **Step 5: Mark each card with its request and bot**

Replace in lines 1513-1519:

```tsx
                  <ApprovalCard
                    key={ask.request}
                    action={ask.action}
```

with:

```tsx
                  <ApprovalCard
                    key={ask.request}
                    request={ask.request}
                    by={id}
                    action={ask.action}
```

- [ ] **Step 6: Show the pill**

Replace Task 2's pills block:

```tsx
      {!profileMode && unread > 0 && <div className="transcript-pills">
        <button type="button" className="transcript-pill" onClick={jumpToLatest}>{newPill(unread)}</button>
      </div>}
```

with:

```tsx
      {!profileMode && (unread > 0 || cardsAway.length > 0) && <div className="transcript-pills">
        {cardsAway.length > 0 && <button type="button" className="transcript-pill" onClick={() => showCard(cardsAway[0].request)}>
          <span className="pill-dot" aria-hidden="true" />
          {waitingLine(owners(cardsAway).map((id) => names.get(id) ?? id))} · Show
        </button>}
        {unread > 0 && <button type="button" className="transcript-pill" onClick={jumpToLatest}>{newPill(unread)}</button>}
      </div>}
```

- [ ] **Step 7: Style the dot**

Add at the end of `src/styles.css`:

```css
.pill-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: no TypeScript errors; `✓ built in`.

- [ ] **Step 9: Preview check (1440x900)**

Preview setup with Null (Ask first) and Jigga (Read only). Look for:
- Send `@null fix the readme`. When Null's first card appears, scroll up until the card is out of view: a pill with an amber dot reads "Null is waiting for you · Show".
- Click Show: the card is centred and **Allow once** has the focus ring. Press Enter: the card answers and the pill goes; the next card appears.
- Scroll so half a card is visible: no pill.
- Send `@all go` and stay at the bottom: Jigga's long reply streams below Null's card and pushes it out of view; the pill appears while you are still at the bottom.
- Scroll up while Jigga streams and a reply lands: both pills show side by side, waiting first.

- [ ] **Step 10: Commit**

```bash
git add src/Approvals.tsx src/ChatPane.tsx src/styles.css
git commit -m "feat: a pill brings an approval card back into view"
```

---

### Task 4: Composer status says who is replying and who is waiting

**Files:**
- Modify: `src/composerStatus.ts` (end of file), `tests/composer-status.test.mjs`
- Modify: `src/ChatPane.tsx:3` (import), `:459-461` (who is working), after `:770` (`stopReplying`), `:1543-1553` (status line), `:1627` (turn controls)

**Interfaces:**
- Consumes: `joinNames`, `replyingVerb`, `waitingVerb` (Task 1).
- Produces:
  - `statusParts<T>(replying: T[], waiting: T[]): { who: T[]; verb: string }[]`
  - `stopLabel(names: string[]): string`
  - `stopTargets(replying: string[], waiting: string[]): string[] | "all"`
  - in `ChatPane`: `active`, `replyingNow`, `waitingNow` (arrays of `ParticipantConfig`), `stopReplying(): void`

Stage 1 makes ChatPane report `ThreadStatus.replying` and `.waiting` (display names of bots producing a reply, and of bots stopped on an open card). If you find that stage 1 already builds those two participant lists in ChatPane, reuse them for `replyingNow` and `waitingNow` instead of adding a second copy in Step 5; the definitions are the same.

- [ ] **Step 1: Write the failing tests**

In `tests/composer-status.test.mjs`, change line 3 to:

```js
import { joinNames, replyingVerb, composerCopy, waitingVerb, statusParts, stopLabel, stopTargets } from "../src/composerStatus.ts";
```

and add at the end:

```js
test("the status line splits who is replying from who is waiting", () => {
  assert.deepEqual(statusParts(["Jigga"], ["Null"]), [{ who: ["Jigga"], verb: "is replying" }, { who: ["Null"], verb: "is waiting for you" }]);
  assert.deepEqual(statusParts([], ["Null", "Ada"]), [{ who: ["Null", "Ada"], verb: "are waiting for you" }]);
  assert.deepEqual(statusParts(["Jigga", "Ada"], []), [{ who: ["Jigga", "Ada"], verb: "are replying" }]);
  assert.deepEqual(statusParts([], []), []);
});

test("Stop names only the bots that are replying", () => {
  assert.equal(stopLabel(["Jigga"]), "Stop Jigga");
  assert.equal(stopLabel(["Jigga", "Ada"]), "Stop Jigga and Ada");
  assert.equal(stopLabel(["Jigga", "Ada", "Null"]), "Stop 3 bots");
});

test("Stop leaves a waiting card up, and stops everything when nobody waits", () => {
  assert.deepEqual(stopTargets(["jigga"], ["null"]), ["jigga"]);
  assert.equal(stopTargets(["jigga", "ada"], []), "all");
  assert.deepEqual(stopTargets([], ["null"]), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: FAIL with `does not provide an export named 'statusParts'`.

- [ ] **Step 3: Implement**

Add at the end of `src/composerStatus.ts`:

```ts
/** The status line in parts: who is replying, then who is waiting for you. Empty groups are left out. */
export function statusParts<T>(replying: T[], waiting: T[]): { who: T[]; verb: string }[] {
  const parts: { who: T[]; verb: string }[] = [];
  if (replying.length > 0) parts.push({ who: replying, verb: replyingVerb(replying.length) });
  if (waiting.length > 0) parts.push({ who: waiting, verb: waitingVerb(waiting.length) });
  return parts;
}

/** The Stop button's words. It names only bots that are replying: "Stop Jigga". */
export function stopLabel(names: string[]): string {
  if (names.length === 0) return "Stop";
  return names.length <= 2 ? `Stop ${joinNames(names)}` : `Stop ${names.length} bots`;
}

/**
 * Who Stop stops. With nobody waiting on a card it stops everything, as it
 * always has (that also stops /compact). Otherwise it stops only the bots
 * that are replying, so a card you have not answered stays up.
 */
export function stopTargets(replying: string[], waiting: string[]): string[] | "all" {
  return waiting.length === 0 ? "all" : replying;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: `ℹ fail 0`; the three new tests pass.

- [ ] **Step 5: Split who is working in ChatPane**

Replace line 3:

```ts
import { composerCopy, joinNames, replyingVerb } from "./composerStatus";
```

with:

```ts
import { composerCopy, joinNames, statusParts, stopLabel, stopTargets } from "./composerStatus";
```

Replace lines 459-461:

```ts
  // Who is replying right now, for the line above the composer.
  const replying = participants.filter(p => working[p.id]);
  const replyingSince = replying.length ? Math.min(...replying.map(p => working[p.id].startedAt)) : 0;
```

with:

```ts
  // Who is at work right now, for the line above the composer: bots still
  // replying, and bots stopped on an approval card waiting for you.
  const active = participants.filter((p) => working[p.id] || asks[p.id]?.length);
  const waitingNow = active.filter((p) => asks[p.id]?.length);
  const replyingNow = active.filter((p) => !asks[p.id]?.length);
  const activeSince = active.length ? Math.min(...active.map((p) => working[p.id]?.startedAt ?? now)) : 0;
```

- [ ] **Step 6: Stop only the replying bots while a card waits**

After `forkAt` (it ends at line 770 with `};`) add:

```ts
  /** Stop: only the bots that are replying, unless nobody is waiting on a card. */
  const stopReplying = () => {
    const targets = stopTargets(replyingNow.map((p) => p.id), waitingNow.map((p) => p.id));
    if (targets === "all") void turnQueue.halt();
    else targets.forEach((id) => void turnQueue.halt(id));
  };
```

- [ ] **Step 7: Render the split status line**

Replace lines 1543-1553:

```tsx
        {busy && replying.length > 0 && <div className="composer-status" role="status">
          <span className="composer-status-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="composer-status-who">
            {replying.map((p, index) => <span key={p.id}>
              {index > 0 && (index === replying.length - 1 ? " and " : ", ")}
              <strong style={{ color: color(p.id) }}>{p.display_name}</strong>
            </span>)} {replyingVerb(replying.length)}
          </span>
          <span className="composer-status-time" aria-label={`for ${elapsed(now - replyingSince)}`}>{elapsed(now - replyingSince)}</span>
          <button className="danger small" aria-label={`Stop ${joinNames(replying.map(p => p.display_name))}`} onClick={() => void turnQueue.halt()}>Stop</button>
        </div>}
```

with:

```tsx
        {busy && active.length > 0 && <div className="composer-status" role="status">
          <span className="composer-status-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="composer-status-who">
            {statusParts(replyingNow, waitingNow).map((part, partIndex) => <span key={part.verb}>
              {partIndex > 0 && " · "}
              {part.who.map((p, index) => <span key={p.id}>
                {index > 0 && (index === part.who.length - 1 ? " and " : ", ")}
                <strong style={{ color: color(p.id) }}>{p.display_name}</strong>
              </span>)} {part.verb}
            </span>)}
          </span>
          <span className="composer-status-time" aria-label={`for ${elapsed(now - activeSince)}`}>{elapsed(now - activeSince)}</span>
          {replyingNow.length > 0 && <button className="danger small" aria-label={`Stop ${joinNames(replyingNow.map((p) => p.display_name))}`} onClick={stopReplying}>{stopLabel(replyingNow.map((p) => p.display_name))}</button>}
        </div>}
```

- [ ] **Step 8: Keep per-bot controls reachable while a card waits**

Replace on line 1627:

```tsx
          {busy && replying.length > 1 && <details className="turn-controls"><summary aria-label="Turn controls">⋯</summary><div className="turn-controls-menu">
```

with:

```tsx
          {busy && (active.length > 1 || waitingNow.length > 0) && <details className="turn-controls"><summary aria-label="Turn controls">⋯</summary><div className="turn-controls-menu">
```

The menu lists Steer and Stop for every working bot (waiting ones included) and Stop all, so a bot waiting on a card can still be stopped.

- [ ] **Step 9: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`.

- [ ] **Step 10: Preview check (1440x900)**

Preview setup with Null (Ask first) and Jigga (Read only). Look for:
- Send `@all go`. While Null waits on its card and Jigga writes, the composer status reads "**Jigga** is replying · **Null** is waiting for you", names in their colours, and the button reads "Stop Jigga".
- Click Stop Jigga: Jigga's reply ends with "[Interrupted]"; Null's card stays up and the line reads "Null is waiting for you" with no Stop button.
- The ⋯ next to Queue lists "Steer Null" and "Stop Null" plus "Stop all"; Stop Null rejects the card.
- Send `@jigga hello` alone: the line reads "Jigga is replying" and "Stop Jigga" stops it.

- [ ] **Step 11: Commit**

```bash
git add src/composerStatus.ts tests/composer-status.test.mjs src/ChatPane.tsx
git commit -m "feat: composer status splits replying from waiting, and Stop names who it stops"
```

---

### Task 5: "New since you looked"

**Files:**
- Modify: `src/types.ts:183-194` (`Pane`)
- Modify: `src/transcriptPlace.ts` (end of file), `tests/transcript-place.test.mjs`, `tests/closing.test.mjs`
- Modify: `src/App.tsx` after `:80` (`onThreadSeen`), `:714` (ChatPane props)
- Modify: `src/ChatPane.tsx` (Props before `:61`; signature `:322`; after `:325`; after `:419`; the `transcriptPlace` import; after Task 3's `showCard`; `roomCreate` at `:621-625`; Tasks 2–3's scroll block; `clearChat` at `:727`; `send`; the transcript entries at `:1440-1483`)
- Modify: `src/styles.css` (end of file)

**Interfaces:**
- Consumes: Tasks 1–3 (`isAtBottom`, `stuck`, `setUnread`, `measureCards`, `settle`, `onTranscriptScroll`, `jumpToLatest`).
- Produces:
  - `Pane.lastSeenSeq?: number`
  - `interface SeenMessage { seq: number; bot: boolean }`
  - `seenList(messages: { seq: number; speaker: { kind: string } }[]): SeenMessage[]`
  - `firstUnseen(messages: SeenMessage[], lastSeen: unknown): number | null`
  - `unseenCount(messages: SeenMessage[], from: number | null): number`
  - `seenMark(messages: SeenMessage[], saved: number | undefined): number | null`
  - ChatPane prop `onSeen?: (paneId: string, seq: number) => void`; in ChatPane `entriesRef`, `dividerAt` / `setDividerAt`, `watching: boolean`; the transcript entries rendered with `entries.flatMap` and a `const item = …` per entry (Tasks 13 and 16 edit its branches)

- [ ] **Step 1: Write the failing tests**

In `tests/transcript-place.test.mjs`, change the import line to:

```js
import { AT_BOTTOM_PX, cardsOutOfView, firstUnseen, isAtBottom, newPill, owners, seenList, seenMark, unseenCount, waitingLine } from "../src/transcriptPlace.ts";
```

and add at the end:

```js
const msgs = [{ seq: 0, bot: false }, { seq: 1, bot: true }, { seq: 2, bot: false }, { seq: 3, bot: true }, { seq: 4, bot: true }];

test("the divider goes above the first reply after the last one you saw", () => {
  assert.equal(firstUnseen(msgs, 1), 3);
  assert.equal(firstUnseen(msgs, 2), 3);
  assert.equal(firstUnseen(msgs, 4), null);
  assert.equal(unseenCount(msgs, 3), 2);
  assert.equal(unseenCount(msgs, null), 0);
});

test("threads saved before marks existed show no divider", () => {
  assert.equal(firstUnseen(msgs, undefined), null);
  assert.equal(firstUnseen(msgs, "3"), null);
});

test("a mark from before /clear does not hide new replies", () => {
  // Messages count from 0 again after /clear; an old mark of 40 is past them all.
  assert.equal(firstUnseen([{ seq: 0, bot: false }, { seq: 1, bot: true }], 40), 1);
  assert.equal(firstUnseen([{ seq: 0, bot: false }, { seq: 1, bot: true }], -1), 1);
});

test("the saved mark moves to the newest message only when it changes", () => {
  assert.equal(seenMark(msgs, 2), 4);
  assert.equal(seenMark(msgs, 4), null);
  assert.equal(seenMark(msgs, undefined), 4);
  assert.equal(seenMark([], -1), null);
});

test("transcript messages are read as bot or not", () => {
  assert.deepEqual(
    seenList([{ seq: 0, speaker: { kind: "human" }, text: "hi" }, { seq: 1, speaker: { kind: "bot", id: "null" }, text: "hello" }]),
    [{ seq: 0, bot: false }, { seq: 1, bot: true }],
  );
});
```

In `tests/closing.test.mjs`, add at the end:

```js
test("a thread keeps where you stopped reading; older files load without it", () => {
  assert.equal(savedThreads([chat("a", { lastSeenSeq: 7 })])[0].lastSeenSeq, 7);
  assert.equal(loadedThreads([chat("a", { lastSeenSeq: 7 })], ["w"])[0].lastSeenSeq, 7);
  assert.equal(loadedThreads([chat("a")], ["w"])[0].lastSeenSeq, undefined);
});
```

The closing test passes at once: it pins behaviour the feature relies on (saving and loading keep the field) so that stage 4's rewrite of `savedThreads` / `loadedThreads` can't drop it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/transcript-place.test.mjs tests/closing.test.mjs`
Expected: `transcript-place` FAILS with `does not provide an export named 'firstUnseen'`; `closing` passes.

- [ ] **Step 3: Implement the rules**

Add at the end of `src/transcriptPlace.ts`:

```ts
/** A message as the "New since you looked" divider sees it. */
export interface SeenMessage {
  seq: number;
  /** Your own messages never count as new. */
  bot: boolean;
}

/** Read transcript messages for the divider. */
export function seenList(messages: { seq: number; speaker: { kind: string } }[]): SeenMessage[] {
  return messages.map((m) => ({ seq: m.seq, bot: m.speaker.kind === "bot" }));
}

/**
 * Where "New since you looked" goes: the seq of the first bot message after
 * `lastSeen`, the newest message you saw at the bottom of the thread. Null
 * when nothing is new, and when there is no mark (threads saved before marks
 * existed, or a mark that is not a number). A mark past the newest message
 * means the thread was cleared since (messages count from 0 again), so all
 * of it is new.
 */
export function firstUnseen(messages: SeenMessage[], lastSeen: unknown): number | null {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return null;
  const newest = messages.length > 0 ? messages[messages.length - 1].seq : -1;
  const mark = lastSeen > newest ? -1 : lastSeen;
  return messages.find((m) => m.bot && m.seq > mark)?.seq ?? null;
}

/** How many bot messages are at or after `from`, for the pill when a thread opens at its divider. */
export function unseenCount(messages: SeenMessage[], from: number | null): number {
  return from === null ? 0 : messages.filter((m) => m.bot && m.seq >= from).length;
}

/** The mark to save while you watch the bottom of a thread: the newest message's seq, or null when the saved mark already says so. */
export function seenMark(messages: SeenMessage[], saved: number | undefined): number | null {
  if (messages.length === 0) return null;
  const newest = messages[messages.length - 1].seq;
  return newest === saved ? null : newest;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/transcript-place.test.mjs tests/closing.test.mjs`
Expected: `ℹ fail 0`; all 10 `transcript-place` tests and the new closing test pass.

- [ ] **Step 5: Save the mark on chat panes**

In `src/types.ts`, in `interface Pane`, after `sample?: boolean;` add:

```ts
  /** The seq of the newest message you saw at the bottom of this thread, or
   *  -1 after /clear. Missing in sessions saved before it existed: no divider. */
  lastSeenSeq?: number;
```

In `src/App.tsx`, after line 80 (`const [panes, setPanes] = useState<Pane[]>([]);`) add:

```ts
  /** Where you stopped reading each thread, saved with it for "New since you looked". */
  const onThreadSeen = useCallback((paneId: string, seq: number) => setPanes((list) => (
    list.some((p) => p.id === paneId && p.lastSeenSeq !== seq) ? list.map((p) => (p.id === paneId ? { ...p, lastSeenSeq: seq } : p)) : list
  )), []);
```

and on line 714, in the `<ChatPane …>` element, change `onStatus={onThreadStatus}` to `onStatus={onThreadStatus} onSeen={onThreadSeen}`.

- [ ] **Step 6: ChatPane props and refs**

In `src/ChatPane.tsx` `interface Props`, before `/** Agents only: bumped to open the new agent form. */` add:

```ts
  /** Save where you stopped reading: the seq of the newest message you saw at the bottom, or -1 after /clear. */
  onSeen?: (paneId: string, seq: number) => void;
```

In the component signature (line 322) add `onSeen` right after `onStatus` in the destructuring: `({ pane, cwd, workspaceName = "", onStatus, onSeen, addRequest, …`.

After line 325 (`const [entries, setEntries] = useState<Entry[]>([]);`) add:

```ts
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
```

After line 419 (`useEffect(() => { if (profileMode) setParticipants(profiles); }, [profiles, profileMode]);`) add:

```ts
  /** The window has focus; a thread counts as watched only then. */
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, []);
  const watching = focused && windowFocused && ready && !profileMode;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
```

Replace the `transcriptPlace` import with:

```ts
import { cardsOutOfView, firstUnseen, isAtBottom, newPill, owners, seenList, seenMark, unseenCount, waitingLine, type CardBox } from "./transcriptPlace";
```

After Task 3's `showCard` function add:

```ts
  /** "New since you looked" sits above the message with this seq. */
  const [dividerAt, setDividerAt] = useState<number | null>(null);
  /** Set when the thread opens with replies you missed, until the view has moved to the divider. */
  const opening = useRef(false);
  /** The newest message seen at the bottom, as last saved. */
  const lastSeenRef = useRef(pane.lastSeenSeq);
```

- [ ] **Step 7: Open at the divider**

In the `roomCreate` `.then`, replace:

```ts
        setEntries(restored);
        setReady(true);
```

with:

```ts
        setEntries(restored);
        // Open at "New since you looked" when replies came in after you last looked.
        const seen = seenList(saved.transcript);
        const from = firstUnseen(seen, lastSeenRef.current);
        setDividerAt(from);
        if (from !== null) {
          opening.current = true;
          setUnread(unseenCount(seen, from));
        }
        setReady(true);
```

- [ ] **Step 8: Settle at the divider, mark what you watched, notice coming back**

Replace the whole scroll block from Tasks 2 and 3 (from `/** Bring the transcript to where it should be after anything changed in it. */` through the end of `jumpToLatest`) with:

```ts
  /** Bring the transcript to where it should be after anything changed in it. */
  const settle = useRef(() => {});
  settle.current = () => {
    const el = scroller.current;
    // A hidden pane cannot scroll; the resize when it is shown settles it.
    if (!el || el.clientHeight === 0) return;
    const mark = opening.current ? el.querySelector<HTMLElement>(".unseen-divider") : null;
    if (mark) {
      // A thread with replies you missed opens at its divider, just below the top.
      opening.current = false;
      el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
      if (stuck.current) setUnread(0);
    } else if (stuck.current) el.scrollTop = el.scrollHeight;
    measureCards();
  };
  // Before paint, so following the bottom never flickers.
  useLayoutEffect(() => settle.current(), [entries, drafts, asks, dividerAt]);
  // Showing the pane, or a composer that grows, changes the transcript's
  // height without any scrolling: stay at the bottom if you were there.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => settle.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, [profileMode]);
  /** While you watch the bottom of the thread, everything in it counts as seen. */
  const markSeen = useRef(() => {});
  markSeen.current = () => {
    if (!watchingRef.current || !stuck.current) return;
    const next = seenMark(seenList(messagesOf(entriesRef.current)), lastSeenRef.current);
    if (next === null) return;
    lastSeenRef.current = next;
    onSeen?.(pane.id, next);
  };
  // Coming back to the thread marks where the replies you missed begin.
  const wasWatching = useRef(false);
  useEffect(() => {
    if (watching && !wasWatching.current) {
      const from = firstUnseen(seenList(messagesOf(entriesRef.current)), lastSeenRef.current);
      if (from !== null) setDividerAt(from);
    }
    wasWatching.current = watching;
  }, [watching]);
  useEffect(() => markSeen.current(), [entries, watching]);
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el || el.clientHeight === 0) return;
    stuck.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stuck.current) { setUnread(0); markSeen.current(); }
    measureCards();
  };
  const jumpToLatest = () => {
    stuck.current = true;
    setUnread(0);
    settle.current();
  };
```

The "coming back" effect is declared before the marking effect on purpose: when you return, the divider is placed from the old mark before the mark moves.

- [ ] **Step 9: Clearing resets the mark; sending removes the divider**

In `clearChat`, replace:

```ts
      .then(() => {
        setEntries([]);
```

with:

```ts
      .then(() => {
        setEntries([]);
        setDividerAt(null);
        // Messages count from 0 again; nothing in the cleared thread is new.
        lastSeenRef.current = -1;
        onSeen?.(pane.id, -1);
```

In `send`, replace the lines added in Task 2:

```ts
    // Sending takes you to the bottom, where your message and the replies land.
    stuck.current = true;
    setUnread(0);
```

with:

```ts
    // Sending takes you to the bottom, where your message and the replies land,
    // and clears "New since you looked".
    stuck.current = true;
    setUnread(0);
    setDividerAt(null);
```

- [ ] **Step 10: Draw the divider**

Replace the transcript entries (lines 1440-1483, from `{entries.map((entry) =>` through its closing `)}`) with:

```tsx
        {entries.flatMap((entry) => {
          const item = entry.kind === "notice" ? (
            <p key={`n${entry.notice.key}`} className={`notice ${entry.notice.tone}`}>
              {entry.notice.text}
            </p>
          ) : entry.kind === "low" ? (
            <p key={`l${entry.low.key}`} className="notice low-context">
              <span>{names.get(entry.low.id) ?? entry.low.id} is down to {entry.low.left}% context. Compacting summarizes earlier turns and refills it.</span>
              <button className="ghost" onClick={compactChat} disabled={!canCompact}>Compact</button>
            </p>
          ) : entry.kind === "summary" ? (
            <details key={`s${entry.summary.upto}`} className="compacted">
              <summary>
                {entry.summary.by ? `Summarized by ${names.get(entry.summary.by) ?? entry.summary.by}` : "Summarized"} · the models see this instead of the messages above
              </summary>
              <Markdown text={entry.summary.summary} onOpen={openTarget} />
            </details>
          ) : entry.message.speaker.kind === "human" ? (
            <div key={`m${entry.message.seq}`} className="bubble human">
              <RichText text={entry.message.text} onOpen={openTarget} />
              {forkButton(entry.message.seq)}
            </div>
          ) : (
            <div key={`m${entry.message.seq}`} className="bot-row">
              <Avatar
                seed={appearance(entry.message.speaker.id).seed}
                color={color(entry.message.speaker.id)}
                {...(newestReply.get(entry.message.speaker.id) === entry.message.seq ? { levels: levelsFor(entry.message.speaker.id), refills: refillsFor(entry.message.speaker.id) } : {})}
              />
              <div className="bubble bot completed">
                <span className="speaker" style={{ color: color(entry.message.speaker.id) }}>
                  {names.get(entry.message.speaker.id) ?? entry.message.speaker.id}
                </span>
                <Markdown text={entry.message.text} onOpen={openTarget} />
                <button className="quote-reply-icon" aria-label={`Quote response from ${names.get(entry.message.speaker.id) ?? entry.message.speaker.id}`} onClick={() => {
                  if (entry.message.speaker.kind !== "bot") return;
                  setReply({ id: entry.message.speaker.id, name: names.get(entry.message.speaker.id) ?? entry.message.speaker.id, text: entry.message.text });
                  input.current?.focus();
                }}><DeckIcon name="reply" size={18} /></button>
                {forkButton(entry.message.seq)}
              </div>
            </div>
          );
          // "New since you looked" goes above the first reply you have not seen.
          return entry.kind === "message" && entry.message.seq === dividerAt
            ? [<div key={`u${entry.message.seq}`} className="unseen-divider" role="separator" aria-label="New since you looked"><span>New since you looked</span></div>, item]
            : [item];
        })}
```

Add at the end of `src/styles.css`:

```css
/* Now 3.1: "New since you looked", a hairline with no colour. */
.unseen-divider { display: flex; align-items: center; gap: 10px; align-self: stretch; color: var(--muted); font-size: 11px; }
.unseen-divider::before, .unseen-divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
```

- [ ] **Step 11: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`, pass count = baseline + 15.

- [ ] **Step 12: Preview check (1440x900)**

Preview setup, then **+ New thread** for a second thread so two threads sit side by side, each with Jigga (Read only). Click inside the page first. Look for:
- In thread A send `@jigga hello`, then at once click into thread B's message box. When A's reply lands, A follows it (it was at the bottom) and shows no divider.
- Click into thread A: a hairline "New since you looked" divider sits above Jigga's new reply.
- Send a message in A: the divider goes.
- In A send `@jigga hello` and click into B again; after the reply lands, reload the page without touching A: A opens with the divider near the top of its view, and a "1 new · Jump to latest" pill if the reply runs past the bottom.
- Send `/clear` in A, then `@jigga hello`, click into B, wait, click back into A: the divider sits above the first new reply.
- In devtools, `JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")).panes` shows `lastSeenSeq` on the threads.

- [ ] **Step 13: Commit**

```bash
git add src/types.ts src/transcriptPlace.ts tests/transcript-place.test.mjs tests/closing.test.mjs src/App.tsx src/ChatPane.tsx src/styles.css
git commit -m "feat: New since you looked divider, saved per thread"
```

---

### Task 6: Rules for the recipient line

**Files:**
- Create: `src/recipients.ts`, `tests/recipients.test.mjs`

**Interfaces:**
- Consumes: `joinNames` from `src/composerStatus.ts`; `type TurnPolicy` from `src/types.ts`.
- Produces:
  - `handleFor(id: string): string`
  - `mentionTarget(text: string, ids: string[]): "everyone" | string[]`
  - `hasMention(text: string, ids: string[]): boolean`
  - `interface RecipientInput { targets: string[]; roster: { id: string; name: string }[]; policy: TurnPolicy; mentioned: boolean; addressedBefore: boolean; busy: string[] }`
  - `interface RecipientLine { to: string; reason: string; queued: boolean }`
  - `recipientLine(input: RecipientInput): RecipientLine | null`
  - `exampleRows(ids: string[]): { label: string; text: string }[]`
  - `MIN_LINE_HEIGHT = 260`, `showsRecipientLine(paneHeight: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/recipients.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { exampleRows, handleFor, hasMention, mentionTarget, recipientLine, showsRecipientLine } from "../src/recipients.ts";

test("mentions follow the room's rules", () => {
  const ids = ["null", "jigga", "sol-6.1"];
  assert.equal(handleFor("Sol 6.1!"), "sol6.1");
  assert.deepEqual(mentionTarget("@jigga then @NULL, and @jigga again", ids), ["jigga", "null"]);
  assert.deepEqual(mentionTarget("what do you think, @sol-6.1.", ids), ["sol-6.1"]);
  assert.equal(mentionTarget("@all thoughts?", ids), "everyone");
  assert.equal(mentionTarget("hey @Everyone", ids), "everyone");
  assert.deepEqual(mentionTarget("@nobody here", ids), []);
});

test("an @ inside a word is not a mention", () => {
  const ids = ["null", "opus"];
  assert.equal(hasMention("mail me at me@opus.dev", ids), false);
  assert.equal(hasMention("see x@all and a@null", ids), false);
  assert.equal(hasMention("@param is a JSDoc tag", ids), false);
  assert.equal(hasMention("thanks @null", ids), true);
  assert.equal(hasMention("@all of you", []), true);
});

const roster = [{ id: "jigga", name: "Jigga" }, { id: "null", name: "Null" }];
const line = (extra) => recipientLine({ targets: ["null"], roster, policy: "mention", mentioned: false, addressedBefore: true, busy: [], ...extra });

test("the recipient line says who gets the message and why", () => {
  assert.deepEqual(line({ mentioned: true }), { to: "Null", reason: "you mentioned", queued: false });
  assert.deepEqual(line({}), { to: "Null", reason: "last addressed", queued: false });
  assert.deepEqual(line({ targets: ["jigga"], addressedBefore: false }), { to: "Jigga", reason: "first in the room", queued: false });
  assert.deepEqual(line({ targets: ["jigga", "null"], policy: "everyone" }), { to: "everyone", reason: "everyone at once", queued: false });
  assert.deepEqual(line({ targets: ["jigga", "null"], policy: "round_robin" }), { to: "Jigga, then Null", reason: "everyone in turn", queued: false });
});

test("a busy recipient means the message waits", () => {
  assert.equal(line({ busy: ["null"] }).queued, true);
  assert.equal(line({ busy: ["jigga"] }).queued, false);
});

test("no line without bots or a target", () => {
  assert.equal(line({ roster: [], targets: [] }), null);
  assert.equal(line({ targets: [] }), null);
});

test("bots mentioned together are joined like a sentence", () => {
  const three = [...roster, { id: "ada", name: "Ada" }];
  assert.equal(line({ roster: three, targets: ["null", "ada"], mentioned: true }).to, "Null and Ada");
});

test("examples use a real handle", () => {
  assert.deepEqual(exampleRows(["Null", "jigga"]), [
    { label: "e.g. @all what would you change first?", text: "@all what would you change first?" },
    { label: "e.g. @null review the last commit", text: "@null review the last commit" },
    { label: "e.g. /pin Use pnpm, not npm", text: "/pin Use pnpm, not npm" },
  ]);
  assert.deepEqual(exampleRows([]), []);
});

test("the line hides in a pane under 260px tall", () => {
  assert.equal(showsRecipientLine(259), false);
  assert.equal(showsRecipientLine(260), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test tests/recipients.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/recipients.ts`.

- [ ] **Step 3: Implement**

Create `src/recipients.ts`:

```ts
// Who gets the message in the composer, and why, for the line above the
// message box. The room decides (roomTargets); this explains its answer in
// the room's own terms. Mentions follow crates/apex-core/src/mention.rs.

import type { TurnPolicy } from "./types";
import { joinNames } from "./composerStatus.ts";

const HANDLE_CHAR = /[\p{L}\p{N}_.-]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The @handle the room matches for a participant id: its letters, digits, dashes, underscores and dots, lower-cased. */
export function handleFor(id: string): string {
  return [...id].filter((c) => HANDLE_CHAR.test(c)).join("").toLowerCase();
}

/**
 * Who `text` @mentions, by the room's rules: "everyone" for @all or
 * @everyone, otherwise the ids mentioned, first mention first. An @ right
 * after a letter or digit (an email address) is not a mention, and trailing
 * dots are sentence punctuation.
 */
export function mentionTarget(text: string, ids: string[]): "everyone" | string[] {
  const found: string[] = [];
  let everyone = false;
  for (const match of text.matchAll(/@([\p{L}\p{N}_.-]*)/gu)) {
    const at = match.index ?? 0;
    if (at > 0 && LETTER_OR_DIGIT.test(text[at - 1])) continue;
    const word = match[1].toLowerCase().replace(/\.+$/, "");
    if (word === "all" || word === "everyone") everyone = true;
    else {
      const id = ids.find((candidate) => handleFor(candidate) === word);
      if (id && !found.includes(id)) found.push(id);
    }
  }
  return everyone ? "everyone" : found;
}

/** Whether `text` @mentions anyone in the room, or everyone. */
export function hasMention(text: string, ids: string[]): boolean {
  const target = mentionTarget(text, ids);
  return target === "everyone" || target.length > 0;
}

export interface RecipientInput {
  /** Who roomTargets said gets the message, in the order they answer. */
  targets: string[];
  /** Everyone in the room, in roster order. */
  roster: { id: string; name: string }[];
  policy: TurnPolicy;
  /** The message @mentions someone, or everyone. */
  mentioned: boolean;
  /** You have written in this thread before, so the room may have someone you addressed last. */
  addressedBefore: boolean;
  /** Bots at work now. A message to one of them waits in the queue. */
  busy: string[];
}

/** The line above the message box: "To Null · last addressed", plus " · queued (busy)" when a recipient is at work. */
export interface RecipientLine {
  /** "Null", "Null and Ada", "everyone", "Jigga, then Null". */
  to: string;
  /** you mentioned, last addressed, first in the room, everyone at once, or everyone in turn. */
  reason: string;
  queued: boolean;
}

export function recipientLine(input: RecipientInput): RecipientLine | null {
  const { targets, roster, policy, mentioned, addressedBefore, busy } = input;
  if (roster.length === 0 || targets.length === 0) return null;
  const name = (id: string) => roster.find((p) => p.id === id)?.name ?? id;
  const everyone = roster.length > 1 && roster.every((p) => targets.includes(p.id));
  // Everyone in turn answers one at a time, each seeing the reply before it.
  const to = policy === "round_robin" && targets.length > 1
    ? targets.map(name).join(", then ")
    : everyone ? "everyone" : joinNames(targets.map(name));
  const reason = mentioned ? "you mentioned"
    : policy === "everyone" ? "everyone at once"
    : policy === "round_robin" ? "everyone in turn"
    : addressedBefore ? "last addressed" : "first in the room";
  return { to, reason, queued: targets.some((id) => busy.includes(id)) };
}

/** Starter rows for an empty room, built from a real handle. Clicking one puts `text` in the composer; it is never sent for you. */
export function exampleRows(ids: string[]): { label: string; text: string }[] {
  if (ids.length === 0) return [];
  return ["@all what would you change first?", `@${handleFor(ids[0])} review the last commit`, "/pin Use pnpm, not npm"]
    .map((text) => ({ label: `e.g. ${text}`, text }));
}

/** Below this pane height the recipient line is hidden, to leave room for the conversation. */
export const MIN_LINE_HEIGHT = 260;

export function showsRecipientLine(paneHeight: number): boolean {
  return paneHeight >= MIN_LINE_HEIGHT;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/recipients.test.mjs`
Expected: `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/recipients.ts tests/recipients.test.mjs
git commit -m "feat: rules for who gets your message and why"
```

---

### Task 7: The recipient line

**Files:**
- Modify: `src/ChatPane.tsx` (import after the `transcriptPlace` import; `:380` recipients state; `:462` before `copy`; after Task 2's `unread`; `:758-764` recipients effect; `:853-861` targets effect; `:1280` policy option; `:1353` root; `:1569` old hint and the composer field)
- Modify: `src/styles.css:1675` (`.recipient-hint`), end of file

**Interfaces:**
- Consumes: `hasMention`, `recipientLine`, `showsRecipientLine` (Task 6); `replyText(text, quote)` from `src/reply.ts`; `details.show("room")` from `DetailsHost`.
- Produces, in ChatPane: `addressedBefore: boolean` (used by Task 8), `targetsText: string`, `recipient: RecipientLine | null`, `root: RefObject<HTMLDivElement>`, `lineFits: boolean`, and the pane-size observer that Task 16 extends.

The pane height is measured in script rather than with a CSS container query on `.pane`, because a size container on the pane risks becoming the containing block for the fixed-position link menu (`.link-menu`) inside the transcript.

- [ ] **Step 1: Import the rules**

After the `transcriptPlace` import add:

```ts
import { hasMention, recipientLine, showsRecipientLine } from "./recipients";
```

- [ ] **Step 2: Drop the busy-only recipients call**

Delete line 380 `const [recipients, setRecipients] = useState<string[]>([]);` and the effect at lines 758-764:

```ts
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (ready && busy) void backend.roomTargets(pane.id, text).then(ids => { if (alive) setRecipients(ids); }).catch(() => {});
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, ready, busy, pane.id]);
```

The recipient line uses the existing `roomTargets` call that feeds the server menu instead (Step 4).

- [ ] **Step 3: Know whether you've written in this thread**

Before line 462 (`const copy = composerCopy(busy, participants.length === 0);`) add:

```ts
  /** You have written in this thread, so the room may have someone you addressed last. */
  const addressedBefore = messagesOf(entries).some((m) => m.speaker.kind === "human");
```

- [ ] **Step 4: Ask the room about the message as it will be sent, and keep the answer with its text**

Replace lines 855-861:

```ts
  const [serverTargets, setServerTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!ready || !participants.length) return;
    let live = true;
    backend.roomTargets(pane.id, text).then(ids => { if (live) setServerTargets(ids); }).catch(() => {});
    return () => { live = false; };
  }, [backend, pane.id, text, ready, participants]);
```

with:

```ts
  const [serverTargets, setServerTargets] = useState<string[]>([]);
  /** The text `serverTargets` was worked out for, so the recipient line never mixes a new draft with an old answer. */
  const [targetsText, setTargetsText] = useState("");
  useEffect(() => {
    if (!ready || !participants.length) return;
    let live = true;
    // Ask about the message as it will be sent, with a quote's leading handle.
    const outgoing = reply ? replyText(text, reply) : text;
    // A slower answer for older text is ignored once the text has changed.
    backend.roomTargets(pane.id, outgoing).then(ids => { if (live) { setServerTargets(ids); setTargetsText(outgoing); } }).catch(() => {});
    return () => { live = false; };
  }, [backend, pane.id, text, reply, ready, participants]);
  const recipient = recipientLine({
    targets: serverTargets,
    roster: participants.map((p) => ({ id: p.id, name: p.display_name })),
    policy: options.policy,
    mentioned: hasMention(targetsText, participants.map((p) => p.id)),
    addressedBefore,
    busy: participants.filter((p) => working[p.id]).map((p) => p.id),
  });
```

- [ ] **Step 5: Measure the pane**

After Task 2's `const [unread, setUnread] = useState(0);` add:

```ts
  /** The chat's root element; its pane's size decides what fits. */
  const root = useRef<HTMLDivElement>(null);
  /** False in a pane under 260px tall, where the recipient line is hidden. */
  const [lineFits, setLineFits] = useState(true);
  useEffect(() => {
    const paneBox = root.current?.closest<HTMLElement>(".pane");
    if (!paneBox) return;
    const observer = new ResizeObserver(() => {
      // A hidden pane measures nothing; keep what it had.
      if (paneBox.offsetWidth === 0 && paneBox.offsetHeight === 0) return;
      setLineFits(showsRecipientLine(paneBox.offsetHeight));
    });
    observer.observe(paneBox);
    return () => observer.disconnect();
  }, []);
```

and give the root element the ref: replace line 1353

```tsx
    <div className={`chat ${profileMode ? "" : "thread-chat"}`}>
```

with:

```tsx
    <div ref={root} className={`chat ${profileMode ? "" : "thread-chat"}`}>
```

- [ ] **Step 6: Render the line above the message box**

Delete line 1569:

```tsx
        {busy && recipients.length > 0 && <div className="recipient-hint">To {recipients.map(id => names.get(id) ?? id).join(", ")} · {recipients.some(id => turnQueue.state[id] === "working") ? "queued (busy)" : "starts now"}</div>}
```

and immediately before `<div className="composer-field">` add:

```tsx
        {recipient && lineFits && <div className="recipient-line">
          To {recipient.to} · <button type="button" className="link-button" title="Change who answers by default" onClick={() => details?.show("room")}>{recipient.reason}</button>{recipient.queued && " · queued (busy)"}
        </div>}
```

- [ ] **Step 7: Rename the policy option**

Replace line 1280:

```tsx
              <option value="mention">Only who I @mention</option>
```

with:

```tsx
              <option value="mention">Whoever I addressed last</option>
```

- [ ] **Step 8: Style it**

In `src/styles.css` delete line 1675 (`.recipient-hint { font-size: 11px; color: var(--muted); margin-bottom: 4px; }`) and add at the end:

```css
/* Now 3.2: who gets your message, and why. */
.recipient-line { margin: 0 0 4px 2px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.link-button { padding: 0; border: 0; border-radius: 0; background: none; color: inherit; font: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 2px; cursor: pointer; }
.link-button:hover:not(:disabled) { background: none; color: var(--text); text-decoration-color: currentColor; }
```

- [ ] **Step 9: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors (in particular no leftover `recipients` / `setRecipients`); `✓ built in`; `ℹ fail 0`.

- [ ] **Step 10: Preview check (1440x900)**

Preview setup with Null added first, then Jigga, both Read only. Look for, in 11px muted text above the message box:
- New thread, empty composer: "To Null · first in the room".
- Send `hello`; the line then reads "To Null · last addressed".
- Type `@jigga`: "To Jigga · you mentioned". Type `mail me@jigga.dev` instead: back to "To Null · last addressed".
- Click the reason: thread details opens at Room. The first Who answers option reads "Whoever I addressed last".
- Choose Everyone at once: "To everyone · everyone at once". Choose Everyone in turn: "To Null, then Jigga · everyone in turn". Set it back.
- While Null replies, type `@null more`: "To Null · you mentioned · queued (busy)".
- Drag the horizontal divider between two stacked threads until one pane is shorter than 260px: that pane's line disappears; drag back and it returns.

- [ ] **Step 11: Commit**

```bash
git add src/ChatPane.tsx src/styles.css
git commit -m "feat: the composer always says who gets your message"
```

---

### Task 8: Examples in an empty room, and a first-message hint

**Files:**
- Modify: `src/composerStatus.ts:12-17` (`composerCopy`), `tests/composer-status.test.mjs`
- Modify: `src/ChatPane.tsx` (the `recipients` import; `:462` `copy`; after `:902` `mention`; the empty transcript at `:1437`; `:1622` hint)
- Modify: `src/styles.css` (end of file)

**Interfaces:**
- Consumes: `exampleRows` (Task 6); `addressedBefore` (Task 7).
- Produces: `composerCopy(busy: boolean, empty: boolean, extra?: { firstMessage?: boolean }): { placeholder: string; hint: string }` whose `hint` is now the whole line; ChatPane `insertExample(example: string): void`.

- [ ] **Step 1: Write the failing test**

Add at the end of `tests/composer-status.test.mjs`:

```js
test("before the first message in a room of two or more bots, the hint teaches @all", () => {
  assert.equal(composerCopy(false, false, { firstMessage: true }).hint, "@all asks everyone · / for commands · ↵ send");
  assert.equal(composerCopy(false, false).hint, "@ who answers · ! which tools · ↵ send · ⇧↵ new line");
  assert.match(composerCopy(true, false, { firstMessage: true }).hint, /↵ queue/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: FAIL: the first assertion gets `"↵ send · ⇧↵ new line"`.

- [ ] **Step 3: Implement**

Replace `composerCopy` (lines 12-17 of `src/composerStatus.ts`):

```ts
/** What the composer says Enter will do, so the placeholder and hint never disagree. */
export function composerCopy(busy: boolean, empty: boolean): { placeholder: string; hint: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "↵ send · ⇧↵ new line" };
  if (busy) return { placeholder: "Add to the next turn, or ⌘↵ to steer now…", hint: "↵ queue · ⌘↵ steer now · ⇧↵ new line" };
  return { placeholder: "Message the room. @name picks who answers.", hint: "↵ send · ⇧↵ new line" };
}
```

with:

```ts
/**
 * What the composer says Enter will do, so the placeholder and hint never
 * disagree. `hint` is the whole line under the message box. Before the first
 * message in a room of two or more bots it teaches @all and / instead.
 */
export function composerCopy(busy: boolean, empty: boolean, extra: { firstMessage?: boolean } = {}): { placeholder: string; hint: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "@ who answers · ! which tools · ↵ send · ⇧↵ new line" };
  if (busy) return { placeholder: "Add to the next turn, or ⌘↵ to steer now…", hint: "@ who answers · ! which tools · ↵ queue · ⌘↵ steer now · ⇧↵ new line" };
  if (extra.firstMessage) return { placeholder: "Message the room. @name picks who answers.", hint: "@all asks everyone · / for commands · ↵ send" };
  return { placeholder: "Message the room. @name picks who answers.", hint: "@ who answers · ! which tools · ↵ send · ⇧↵ new line" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: `ℹ fail 0`; the new test passes.

- [ ] **Step 5: Use the whole hint line**

In `src/ChatPane.tsx`, replace line 462:

```ts
  const copy = composerCopy(busy, participants.length === 0);
```

with:

```ts
  const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore });
```

and replace line 1622:

```tsx
        <div className="composer-hint"><span>@ who answers · ! which tools · {copy.hint}</span></div>
```

with:

```tsx
        <div className="composer-hint"><span>{copy.hint}</span></div>
```

- [ ] **Step 6: Offer examples in an empty room**

Change the `recipients` import to:

```ts
import { exampleRows, hasMention, recipientLine, showsRecipientLine } from "./recipients";
```

After `mention` (the function at lines 899-902) add:

```ts
  /** Put an example in the composer without sending it. */
  const insertExample = (example: string) => {
    const next = text.trim() ? `${text.trimEnd()} ${example}` : example;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length); });
  };
```

In the empty transcript, replace line 1437:

```tsx
            {participants.length === 0 && quickAddButton("empty", true)}
```

with:

```tsx
            {participants.length === 0 && quickAddButton("empty", true)}
            {participants.length > 0 && <div className="example-rows" aria-label="Examples">
              {exampleRows(participants.map((p) => p.id)).map((row) => (
                <button key={row.text} type="button" className="example-row" onClick={() => insertExample(row.text)}>{row.label}</button>
              ))}
            </div>}
```

- [ ] **Step 7: Style it**

Add at the end of `src/styles.css`:

```css
.example-rows { display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-top: 16px; }
.example-row { padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--muted); font-size: 12px; text-align: left; }
.example-row:hover:not(:disabled) { color: var(--text); }
```

- [ ] **Step 8: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`.

- [ ] **Step 9: Preview check (1440x900)**

Preview setup with Null and Jigga (Read only). Look for:
- New thread with both bots and no messages: three rows under "The room is yours.": "e.g. @all what would you change first?", "e.g. @null review the last commit" (the first bot's real handle), "e.g. /pin Use pnpm, not npm".
- Click the second row: the composer holds `@null review the last commit` with the cursor at the end; nothing is sent.
- Focus the composer: the hint reads "@all asks everyone · / for commands · ↵ send". Send the message: the rows go and the hint reads "@ who answers · ! which tools · ↵ send · ⇧↵ new line".
- A thread with one bot shows the rows but the ordinary hint.

- [ ] **Step 10: Commit**

```bash
git add src/composerStatus.ts tests/composer-status.test.mjs src/ChatPane.tsx src/styles.css
git commit -m "feat: example messages in an empty room and a first-message hint"
```

---

### Task 9: The cut-off notice says who was asked next

**Files:**
- Modify: `crates/apex-core/src/room.rs:84-85`, `:722-725`
- Modify: `crates/apex-core/src/concurrent.rs:250-253`
- Modify: `crates/apex-core/tests/wire_format.rs:145`, `crates/apex-core/tests/room.rs:162`, `:175`, `crates/apex-core/tests/concurrent.rs:275-279`
- Modify: `src/types.ts:157`
- Modify: `src/backend.ts:217-219`, `:230`, `:240`, `:289-295`, `:311-317`, `:319-326`, `:392`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Rust: `RoomEvent::HopLimitReached { limit: usize, next: Vec<ParticipantId> }` (wire: `{ "type": "hop_limit_reached", "limit": 3, "next": ["null"] }`)
  - TS: `{ type: "hop_limit_reached"; limit: number; next: string[] }`
  - preview: `runPreview(id, participant): Promise<string[]>` and `runChain(id: string, first: string[], sequential: boolean, limit: number): Promise<void>`, which Tasks 10 and 13 use; `lastHuman` inside `runPreview`'s per-target block (Task 13 uses it).

- [ ] **Step 1: Write the failing wire test**

In `crates/apex-core/tests/wire_format.rs`, replace line 145:

```rust
    assert_eq!(to_value(RoomEvent::HopLimitReached { limit: 3 }).unwrap(), json!({ "type": "hop_limit_reached", "limit": 3 }));
```

with:

```rust
    assert_eq!(
        to_value(RoomEvent::HopLimitReached { limit: 3, next: vec![ParticipantId::new("null")] }).unwrap(),
        json!({ "type": "hop_limit_reached", "limit": 3, "next": ["null"] })
    );
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: compile error `error[E0559]: variant `RoomEvent::HopLimitReached` has no field named `next``.

- [ ] **Step 3: Add `next` and fill it**

In `crates/apex-core/src/room.rs`, replace lines 84-85:

```rust
    /// Bots kept addressing each other and the room cut them off.
    HopLimitReached { limit: usize },
```

with:

```rust
    /// Bots kept addressing each other and the room cut them off. `next`
    /// lists who the last replies addressed, so the person can let them answer.
    HopLimitReached {
        limit: usize,
        #[serde(default)]
        next: Vec<ParticipantId>,
    },
```

Replace lines 722-725:

```rust
            if hops >= self.options.max_bot_hops {
                on_event(RoomEvent::HopLimitReached { limit: self.options.max_bot_hops });
                break;
            }
```

with:

```rust
            if hops >= self.options.max_bot_hops {
                on_event(RoomEvent::HopLimitReached { limit: self.options.max_bot_hops, next: targets.clone() });
                break;
            }
```

In `crates/apex-core/src/concurrent.rs`, replace lines 250-253:

```rust
            if hops >= batch.limit {
                sink(RoomEvent::HopLimitReached { limit: batch.limit });
                break;
            }
```

with:

```rust
            if hops >= batch.limit {
                sink(RoomEvent::HopLimitReached { limit: batch.limit, next: unique });
                break;
            }
```

(`unique` moves into the event only on the branch that breaks, so the loop's later use of it still compiles.)

- [ ] **Step 4: Run the core tests to see the old tests break**

Run: `cargo test -p apex-core -- --test-threads=1`
Expected: compile errors in `tests/room.rs` (`error[E0063]: missing field `next` in initializer of `RoomEvent``, twice) and `tests/concurrent.rs` (`error[E0027]: pattern does not mention field `next``).

- [ ] **Step 5: Update them to say who is next**

In `crates/apex-core/tests/room.rs`, replace line 162:

```rust
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 2 }));
```

with:

```rust
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 2, next: vec![ParticipantId::new("grok")] }));
```

and line 175:

```rust
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 0 }));
```

with:

```rust
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 0, next: vec![ParticipantId::new("grok")] }));
```

In `crates/apex-core/tests/concurrent.rs`, replace lines 275-279:

```rust
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, RoomEvent::HopLimitReached { limit: 1 })));
```

with:

```rust
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, RoomEvent::HopLimitReached { limit: 1, next } if next == &vec![ParticipantId::new("null"), ParticipantId::new("jigga")])));
```

(In that round-robin test the second round's replies are Jigga's "@null again", then Null's "@jigga again", so the cut-off list is Null, then Jigga.)

- [ ] **Step 6: Run the core tests to verify they pass**

Run: `cargo test -p apex-core -- --test-threads=1`
Expected: every `test result: ok.`; counts unchanged from the baseline (18, 12, 35, 3, 9 on `main@95d753d`).

- [ ] **Step 7: Mirror the shape in TypeScript**

In `src/types.ts`, replace line 157:

```ts
  | { type: "hop_limit_reached"; limit: number }
```

with:

```ts
  /** The room cut off bots answering each other; `next` is who the last replies asked. */
  | { type: "hop_limit_reached"; limit: number; next: string[] }
```

- [ ] **Step 8: Make the preview follow rounds like the native room**

In `src/backend.ts`:

1. Replace line 217:

```ts
  const runPreview = async (id: string, participant: string) => {
```

with:

```ts
  /** One participant's turn. Resolves with the bots its reply addressed, so
   *  runChain can follow them the way the native room does. */
  const runPreview = async (id: string, participant: string): Promise<string[]> => {
```

2. After line 219 (`let active = true;`) add:

```ts
      let stopped = false;
      let addressed: string[] = [];
```

3. On line 230 replace `active = false; resolve();` with `stopped = true; active = false; resolve();`.

4. After line 240 (`const p = {...configured, access: ownsEditor ? configured.access : "read" as const};`) add:

```ts
        const lastHuman = [...room.transcript].reverse().find((m) => m.speaker.kind === "human");
```

5. On line 289 change `const reply = [` to `let reply = [`, and after line 295 (`].join("\n\n");`) add:

```ts
        // Preview only: "relay" in your message makes each bot hand over to the
        // next one in the room ("relay all": to everyone else), so the round
        // limit and Let them answer can be seen.
        if (lastHuman && /\brelay\b/i.test(lastHuman.text) && room.participants.length > 1) {
          const others = room.participants.filter((x) => x.id !== p.id);
          const next = room.participants[(room.participants.findIndex((x) => x.id === p.id) + 1) % room.participants.length];
          const everyone = /\brelay all\b/i.test(lastHuman.text);
          reply += everyone ? "\n\n@all your turn." : `\n\n@${next.id} your turn.`;
          addressed = everyone ? others.map((x) => x.id) : [next.id];
        }
```

6. Replace lines 311-317:

```ts
      finally {
        active = false; cancellations.delete(key);
        if (editors.get(id) === participant) { editors.delete(id); emitRoom(id, {type: "editor_changed", id: null}); }
        emitRoom(id, {type: "participant_idle", id: participant});
        if (![...cancellations.keys()].some(key => key.startsWith(`${id}:`))) emitRoom(id, {type: "idle"});
      }
    };
```

with:

```ts
      finally {
        active = false; cancellations.delete(key);
        if (editors.get(id) === participant) { editors.delete(id); emitRoom(id, {type: "editor_changed", id: null}); }
        emitRoom(id, {type: "participant_idle", id: participant});
      }
      return stopped ? [] : addressed;
    };

  /** Rooms with chains of turns running; a room is idle when its last chain ends. */
  const chains = new Map<string, number>();
  /** Run `first`, then whoever the replies address, up to `limit` rounds of
   *  bots answering bots, like ConcurrentRoom::run. */
  const runChain = async (id: string, first: string[], sequential: boolean, limit: number) => {
    chains.set(id, (chains.get(id) ?? 0) + 1);
    try {
      let wave = first;
      let inTurn = sequential;
      for (let hops = 0; wave.length > 0; hops++) {
        const replies: string[][] = [];
        if (inTurn) for (const target of wave) replies.push(await runPreview(id, target));
        else replies.push(...await Promise.all(wave.map((target) => runPreview(id, target))));
        const next = [...new Set(replies.flat())].filter((target) => rooms.get(id)?.participants.some((p) => p.id === target));
        if (next.length === 0) break;
        if (hops >= limit) { emitRoom(id, { type: "hop_limit_reached", limit, next }); break; }
        wave = next;
        inTurn = true;
      }
    } finally {
      const left = (chains.get(id) ?? 1) - 1;
      if (left > 0) chains.set(id, left);
      else { chains.delete(id); emitRoom(id, { type: "idle" }); }
    }
  };
```

7. In `postPreview` (lines 319-326), replace:

```ts
    await Promise.all(targets.map(target => runPreview(id, target)));
```

with:

```ts
    await runChain(id, targets, room.options.policy === "round_robin", room.options.max_bot_hops);
```

8. Replace line 392:

```ts
    roomTurn: async (id, participant) => { void runPreview(id, participant); },
```

with:

```ts
    roomTurn: async (id, participant) => { void runChain(id, [participant], true, rooms.get(id)?.options.max_bot_hops ?? 3); },
```

- [ ] **Step 9: Run every check**

Run: `cargo test --workspace -- --test-threads=1 && npm test && npm run build`
Expected: every `test result: ok.`; `ℹ fail 0`; no TypeScript errors; `✓ built in`.

- [ ] **Step 10: Preview check (1440x900)**

Preview setup with Null and Jigga (Read only); Model-to-model rounds stays 3. Look for:
- Send `@null relay`: Null's reply ends "@jigga your turn.", then Jigga, Null and Jigga answer in turn (4 replies), then the notice "Stopped after 3 rounds of models answering each other." (its new wording comes in Task 13). The composer status and Stop behave as before, and the room goes idle after the notice.
- With Who answers set to Everyone in turn, send `hello`: Null answers, then Jigga, one at a time.

- [ ] **Step 11: Commit**

```bash
git add crates/apex-core/src/room.rs crates/apex-core/src/concurrent.rs crates/apex-core/tests/wire_format.rs crates/apex-core/tests/room.rs crates/apex-core/tests/concurrent.rs src/types.ts src/backend.ts
git commit -m "feat: hop limit says who was asked next"
```

---

### Task 10: `room_turn` takes who to run and a hop budget

**Files:**
- Modify: `crates/apex-core/src/concurrent.rs:150-162` (`begin_turn`)
- Modify: `crates/apex-core/tests/concurrent.rs:204-207`, `:338`, end of file
- Modify: `src-tauri/src/lib.rs:379-382` (`room_turn`)
- Modify: `src/backend.ts:42` (interface), `:119` (desktop), the preview `roomTurn` from Task 9

**Interfaces:**
- Consumes: `runChain` (Task 9, preview); `HopLimitReached.next` (Task 9).
- Produces:
  - Rust: `ConcurrentRoom::begin_turn(&self, ids: Vec<ParticipantId>, hops: Option<usize>) -> Result<TurnBatch, String>`
  - Tauri command: `room_turn(id: String, participants: Vec<ParticipantId>, hops: Option<usize>)`
  - TS: `Backend.roomTurn(id: string, participants: string[], hops: number | null): Promise<void>` (both halves). `null` keeps the room's round limit; `0` buys exactly one reply each.

`room_turn` takes a list so "Let them answer" can run several bots in one batch, one after another, each seeing the reply before it, the way the room's own follow-up rounds run. The budget is the shared interface the spec names.

- [ ] **Step 1: Write the failing tests**

In `crates/apex-core/tests/concurrent.rs`, add at the end:

```rust
#[test]
fn a_turn_with_a_zero_budget_buys_exactly_one_reply() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["@jigga over to you"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["never said"]));
        let runtime = ConcurrentRoom::new(Room::new(vec![null.clone(), jigga.clone()], RoomOptions::default()));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_turn(vec![ParticipantId::new("null")], Some(0)).await.unwrap();
        runtime.run(batch, &sink).await;
        assert_eq!(null.requests().len(), 1);
        assert!(jigga.requests().is_empty(), "a budget of 0 buys one reply, even though the room allows 3 rounds");
        let events = events.lock().unwrap();
        assert!(events.contains(&RoomEvent::HopLimitReached { limit: 0, next: vec![ParticipantId::new("jigga")] }));
        assert!(!events.iter().any(|e| matches!(e, RoomEvent::MessageAdded { message } if message.speaker == Speaker::Human)), "nothing is posted");
    });
}

#[test]
fn bots_let_answer_together_go_one_after_another() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["first"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["second"]));
        let runtime = ConcurrentRoom::new(Room::new(vec![null.clone(), jigga.clone()], RoomOptions::default()));
        let batch = runtime.begin_turn(vec![ParticipantId::new("null"), ParticipantId::new("jigga")], Some(0)).await.unwrap();
        runtime.run(batch, &|_| {}).await;
        assert!(jigga.requests()[0].turns.iter().any(|t| t.content.contains("first")), "Jigga saw Null's reply");
    });
}

#[test]
fn a_turn_for_someone_who_left_is_refused() {
    block_on(async {
        let (runtime, _) = setup();
        let refused = runtime.begin_turn(vec![ParticipantId::new("ghost")], None).await;
        assert_eq!(refused.err(), Some("that participant is no longer in this room".to_string()));
    });
}

#[test]
fn without_a_budget_a_turn_keeps_the_rooms_round_limit() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["@jigga one"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["@null two"]));
        let runtime = ConcurrentRoom::new(Room::new(
            vec![null.clone(), jigga.clone()],
            RoomOptions { policy: apex_core::TurnPolicy::Mention, max_bot_hops: 1 },
        ));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_turn(vec![ParticipantId::new("null")], None).await.unwrap();
        runtime.run(batch, &sink).await;
        assert_eq!(jigga.requests().len(), 1);
        assert!(events.lock().unwrap().contains(&RoomEvent::HopLimitReached { limit: 1, next: vec![ParticipantId::new("null")] }));
    });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p apex-core --test concurrent -- --test-threads=1`
Expected: compile error `error[E0061]: this method takes 1 argument but 2 arguments were supplied` for `begin_turn`.

- [ ] **Step 3: Implement the budget in the core**

In `crates/apex-core/src/concurrent.rs`, replace lines 150-162:

```rust
    /// A queued turn reads the existing transcript; it never reposts human text.
    pub async fn begin_turn(&self, id: ParticipantId) -> Result<TurnBatch, String> {
        let room = self.room.lock().await;
        if !room.has(&id) {
            return Err("that participant is no longer in this room".into());
        }
        Ok(self.batch(
            vec![id],
            true,
            room.options().max_bot_hops,
            room.configs().into_iter().map(|c| c.id).collect(),
        ))
    }
```

with:

```rust
    /// Turns on the transcript as it is; nothing is posted. Several
    /// participants answer one after another, each seeing the replies before
    /// it. `hops` caps the rounds of bots answering bots that may follow:
    /// `None` keeps the room's limit, `Some(0)` buys exactly one reply each.
    pub async fn begin_turn(&self, ids: Vec<ParticipantId>, hops: Option<usize>) -> Result<TurnBatch, String> {
        let room = self.room.lock().await;
        if ids.is_empty() {
            return Err("no one was named to answer".into());
        }
        if ids.iter().any(|id| !room.has(id)) {
            return Err("that participant is no longer in this room".into());
        }
        let mut unique = Vec::new();
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        Ok(self.batch(
            unique,
            true,
            hops.unwrap_or(room.options().max_bot_hops),
            room.configs().into_iter().map(|c| c.id).collect(),
        ))
    }
```

- [ ] **Step 4: Update the two existing callers**

In `crates/apex-core/tests/concurrent.rs`, replace lines 204-207:

```rust
        let next = runtime
            .begin_turn(ParticipantId::new("jigga"))
            .await
            .unwrap();
```

with:

```rust
        let next = runtime
            .begin_turn(vec![ParticipantId::new("jigga")], None)
            .await
            .unwrap();
```

and line 338:

```rust
        let next = runtime.begin_turn(ParticipantId::new("jigga")).await.unwrap();
```

with:

```rust
        let next = runtime.begin_turn(vec![ParticipantId::new("jigga")], None).await.unwrap();
```

- [ ] **Step 5: Run the core tests to verify they pass**

Run: `cargo test -p apex-core --test concurrent -- --test-threads=1`
Expected: `test result: ok.` with 4 more tests than the Task 0 baseline (16 on `main@95d753d`).

- [ ] **Step 6: Pass it through the desktop command**

In `src-tauri/src/lib.rs`, replace lines 379-382:

```rust
#[tauri::command]
async fn room_turn(app: AppHandle, state: State<'_, AppState>, id: String, participant: ParticipantId) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = handle.runtime.begin_turn(participant).await?;
```

with:

```rust
/// Run participants on the transcript as it is, one after another, without
/// posting anything (Try again, Let them answer). `hops` caps the bot-to-bot
/// rounds that may follow: `None` keeps the room's limit, `Some(0)` buys
/// exactly one reply each.
#[tauri::command]
async fn room_turn(app: AppHandle, state: State<'_, AppState>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>) -> Result<(), String> {
    let handle = state.handle(&id)?;
    let batch = handle.runtime.begin_turn(participants, hops).await?;
```

(The rest of the function, which spawns `run_batch` and reports a storage failure, stays as it is.)

- [ ] **Step 7: Both backend halves**

In `src/backend.ts`, replace line 42:

```ts
  roomTurn(id: string, participant: string): Promise<void>;
```

with:

```ts
  /** Run participants on the transcript as it is, one after another, without
   *  posting anything. `hops` caps the rounds of bots answering bots that may
   *  follow: null keeps the room's limit, 0 buys exactly one reply each. */
  roomTurn(id: string, participants: string[], hops: number | null): Promise<void>;
```

Replace line 119:

```ts
    roomTurn: (id, participant) => invoke("room_turn", { id, participant }),
```

with:

```ts
    roomTurn: (id, participants, hops) => invoke("room_turn", { id, participants, hops }),
```

Replace the preview `roomTurn` from Task 9:

```ts
    roomTurn: async (id, participant) => { void runChain(id, [participant], true, rooms.get(id)?.options.max_bot_hops ?? 3); },
```

with:

```ts
    roomTurn: async (id, participants, hops) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      if (participants.some((target) => !room.participants.some((p) => p.id === target))) throw new Error("that participant is no longer in this room");
      void runChain(id, [...new Set(participants)], true, hops ?? room.options.max_bot_hops);
    },
```

- [ ] **Step 8: Run every check**

Run: `cargo test --workspace -- --test-threads=1 && npm test && npm run build`
Expected: every `test result: ok.` (`concurrent` now baseline + 4); `ℹ fail 0`; no TypeScript errors; `✓ built in`. Nothing in the UI calls `roomTurn` yet; Task 13 does, and its preview check covers it.

- [ ] **Step 9: Commit**

```bash
git add crates/apex-core/src/concurrent.rs crates/apex-core/tests/concurrent.rs src-tauri/src/lib.rs src/backend.ts
git commit -m "feat: room_turn takes who to run and a hop budget"
```

---

### Task 11: The queue can run a one-off turn

**Files:**
- Modify: `src/turnQueue.ts:1-3` (types), `:58` and `:62` (post type), after `:91` (`turn`), `:111` (drain)
- Modify: `tests/turn-queue.test.mjs` (end of file)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type TurnKind = "message" | "compact" | "turn"`
  - `QueuedMessage.hops?: number | null`
  - `ParticipantQueues` post callback `(text: string, to: string[], kind: TurnKind, hops?: number | null) => Promise<void>`
  - `ParticipantQueues.turn(to: string[], hops: number | null): void` — runs `to` ahead of anything queued for them, posting no text, and resumes their paused queues.

Going through the queue keeps a retried bot's order right: the retry runs before messages queued for that bot, and those messages (paused by the failure) follow it.

- [ ] **Step 1: Write the failing tests**

Add at the end of `tests/turn-queue.test.mjs`:

```js
test('trying again runs the failed bot first, then what was queued for it', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async (text, _to, kind, hops) => { sent.push({ text, kind, hops }); }, async () => {}, () => {});
  await q.send('@null first');
  q.error('null'); q.idle('null');
  await q.send('@null later');
  assert.deepEqual(sent.map(s => s.text), ['@null first'], 'the failure paused Null');
  q.turn(['null'], null); await tick();
  assert.deepEqual(sent.slice(1), [{ text: '', kind: 'turn', hops: null }]);
  q.idle('null'); await tick();
  assert.deepEqual(sent.map(s => s.text), ['@null first', '', '@null later']);
});

test('a turn for several bots waits until every one is free, then posts once', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (_text, to, kind, hops) => { sent.push({ to, kind, hops }); }, async () => {}, () => {});
  await q.send('@jigga plan');
  q.turn(['null', 'jigga'], 0); await tick();
  assert.deepEqual(sent.map(s => s.kind), ['message']);
  q.idle('jigga'); await tick();
  assert.deepEqual(sent.at(-1), { to: ['null', 'jigga'], kind: 'turn', hops: 0 });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/turn-queue.test.mjs`
Expected: FAIL with `TypeError: q.turn is not a function`.

- [ ] **Step 3: Implement**

In `src/turnQueue.ts`, replace lines 1-3:

```ts
/** Serializes a room's turns; queued context never overlaps an active turn. */
export type TurnKind = "message" | "compact";
export interface QueuedMessage { id: number; text: string; kind: TurnKind }
```

with:

```ts
/** Serializes a room's turns; queued context never overlaps an active turn. */
/** "turn" runs bots on the transcript as it is and posts no text (see ParticipantQueues.turn). */
export type TurnKind = "message" | "compact" | "turn";
/** `hops` is set on "turn" items only: the cap on bot-to-bot rounds, null for the room's own. */
export interface QueuedMessage { id: number; text: string; kind: TurnKind; hops?: number | null }
```

In `ParticipantQueues`, replace line 58:

```ts
  private post: (text: string, to: string[], kind: TurnKind) => Promise<void>;
```

with:

```ts
  private post: (text: string, to: string[], kind: TurnKind, hops?: number | null) => Promise<void>;
```

and line 62:

```ts
  constructor(targets: (text: string) => Promise<string[]>, post: (text: string, to: string[], kind: TurnKind) => Promise<void>, stop: (id?: string) => Promise<void>, changed: (items: ParticipantMessage[]) => void, failed: (error: unknown) => void = () => {}) {
```

with:

```ts
  constructor(targets: (text: string) => Promise<string[]>, post: (text: string, to: string[], kind: TurnKind, hops?: number | null) => Promise<void>, stop: (id?: string) => Promise<void>, changed: (items: ParticipantMessage[]) => void, failed: (error: unknown) => void = () => {}) {
```

After `steer` (it ends at line 91) add:

```ts
  /** Run `to` once more on the transcript as it is, ahead of anything queued
   *  for them, posting no text. Their paused queues resume after it, since
   *  you chose to go on with them. `hops` caps the bot-to-bot rounds that
   *  may follow; null keeps the room's limit. */
  turn(to: string[], hops: number | null) {
    for (const id of to) this.paused.delete(id);
    this.items.unshift({ id: ++this.serial, text: "", kind: "turn", to, hops });
    this.publish(); void this.drain();
  }
```

In `drain`, replace line 111:

```ts
          await this.post(item.text, item.to, item.kind);
```

with:

```ts
          await this.post(item.text, item.to, item.kind, item.hops);
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --experimental-strip-types --test tests/turn-queue.test.mjs`
Expected: `ℹ fail 0`; the two new tests pass (11 in the file).

- [ ] **Step 5: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: `ℹ fail 0`; no TypeScript errors (ChatPane's three-argument post callback still fits); `✓ built in`.

- [ ] **Step 6: Commit**

```bash
git add src/turnQueue.ts tests/turn-queue.test.mjs
git commit -m "feat: queue can run bots once on the transcript as it is"
```

---

### Task 12: Rules for Try again and Let them answer

**Files:**
- Create: `src/noticeActions.ts`, `tests/notice-actions.test.mjs`

**Interfaces:**
- Consumes: `joinNames` (`src/composerStatus.ts`), `mentionTarget` (Task 6), `type Message` (`src/types.ts`).
- Produces:
  - `type NoticeAction = { kind: "retry"; id: string } | { kind: "let"; ids: string[] }`
  - `retryFor(failedId: string, roster: string[]): NoticeAction | null`
  - `stillHere(action: NoticeAction, roster: string[]): string[]`
  - `hopNotice(limit: number, asker: string | null, next: string[]): string` (names, not ids)
  - `letLabel(names: string[]): string`
  - `askerOf(messages: Message[], next: string[], roster: string[]): string | null`
  - `liveActions(entries: { key: number | null; human: boolean }[], used: ReadonlySet<number>): Set<number>`

The spec gives the notice copy for one or more rounds. With a budget of 0 (Let them answer, or a room set to 0 rounds) "Stopped after 0 rounds" would be wrong, so that case reads "Stopped so you can choose." `HopLimitReached` carries only `next`, so the asker is worked out from the transcript.

- [ ] **Step 1: Write the failing tests**

Create `tests/notice-actions.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { askerOf, hopNotice, letLabel, liveActions, retryFor, stillHere } from "../src/noticeActions.ts";

test("Try again is offered for a bot still in the room, never for storage", () => {
  assert.deepEqual(retryFor("null", ["null", "jigga"]), { kind: "retry", id: "null" });
  assert.equal(retryFor("storage", ["null"]), null);
  assert.equal(retryFor("ghost", ["null"]), null);
});

test("a button only runs bots that are still here", () => {
  assert.deepEqual(stillHere({ kind: "retry", id: "null" }, ["jigga"]), []);
  assert.deepEqual(stillHere({ kind: "let", ids: ["null", "ada"] }, ["null", "jigga"]), ["null"]);
  assert.deepEqual(stillHere({ kind: "let", ids: ["null", "jigga"] }, ["null", "jigga"]), ["null", "jigga"]);
});

test("the cut-off notice says who asked whom", () => {
  assert.equal(hopNotice(3, "Jigga", ["Null"]), "Stopped after 3 rounds of models answering each other. Jigga asked Null next.");
  assert.equal(hopNotice(1, "Jigga", ["Null", "Ada"]), "Stopped after 1 round of models answering each other. Jigga asked Null and Ada next.");
  assert.equal(hopNotice(0, "Null", ["Jigga"]), "Stopped so you can choose. Null asked Jigga next.");
  assert.equal(hopNotice(2, null, ["Null"]), "Stopped after 2 rounds of models answering each other. Null is next.");
});

test("the button names one bot, or says them", () => {
  assert.equal(letLabel(["Null"]), "Let Null answer");
  assert.equal(letLabel(["Null", "Ada"]), "Let them answer");
});

test("the asker is the latest reply since your message that mentions who is next", () => {
  const m = (seq, who, text) => ({ seq, speaker: who === "you" ? { kind: "human" } : { kind: "bot", id: who }, text });
  const ids = ["null", "jigga", "ada"];
  assert.equal(askerOf([m(0, "you", "@jigga go"), m(1, "jigga", "@null your turn"), m(2, "ada", "agreed")], ["null"], ids), "jigga");
  assert.equal(askerOf([m(0, "jigga", "@null earlier"), m(1, "you", "go"), m(2, "ada", "no mention")], ["null"], ids), null);
  assert.equal(askerOf([m(0, "you", "go"), m(1, "ada", "@all thoughts?")], ["null", "jigga"], ids), "ada");
});

test("buttons go once used or once you send", () => {
  const entries = [{ key: 1, human: false }, { key: null, human: true }, { key: 2, human: false }, { key: 3, human: false }, { key: null, human: false }];
  assert.deepEqual([...liveActions(entries, new Set([3]))], [2]);
  assert.deepEqual([...liveActions(entries, new Set())].sort(), [2, 3]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/notice-actions.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/noticeActions.ts`.

- [ ] **Step 3: Implement**

Create `src/noticeActions.ts`:

```ts
// Buttons on chat notices: Try again after a bot fails, and Let them answer
// after the room cuts off bots answering each other. Both run bots once on
// the transcript as it is (roomTurn) and post nothing. Plain functions so
// the rules can be tested without the interface.

import type { Message } from "./types";
import { joinNames } from "./composerStatus.ts";
import { mentionTarget } from "./recipients.ts";

/** What a notice's button does. */
export type NoticeAction = { kind: "retry"; id: string } | { kind: "let"; ids: string[] };

/** `failed` events from the app's own storage use this id; there is no bot to try again. */
const STORAGE = "storage";

/** Try again for a bot's failure, while that bot is in the room. Never for a storage error. */
export function retryFor(failedId: string, roster: string[]): NoticeAction | null {
  return failedId !== STORAGE && roster.includes(failedId) ? { kind: "retry", id: failedId } : null;
}

/** The bots an action would run that are still in the room. With none left, no button shows. */
export function stillHere(action: NoticeAction, roster: string[]): string[] {
  return (action.kind === "retry" ? [action.id] : action.ids).filter((id) => roster.includes(id));
}

/** The notice when the room cut off bots answering each other. `asker` and `next` are display names. */
export function hopNotice(limit: number, asker: string | null, next: string[]): string {
  const stopped = limit === 0
    ? "Stopped so you can choose."
    : `Stopped after ${limit} ${limit === 1 ? "round" : "rounds"} of models answering each other.`;
  if (next.length === 0) return stopped;
  const who = asker ? `${asker} asked ${joinNames(next)} next.` : `${joinNames(next)} ${next.length === 1 ? "is" : "are"} next.`;
  return `${stopped} ${who}`;
}

/** "Let Null answer", or "Let them answer" for several. */
export function letLabel(names: string[]): string {
  return names.length === 1 ? `Let ${names[0]} answer` : "Let them answer";
}

/** Who asked the cut-off bots: the latest bot reply since your last message that @mentions one of them, or everyone. */
export function askerOf(messages: Message[], next: string[], roster: string[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const speaker = messages[i].speaker;
    if (speaker.kind === "human") return null;
    const target = mentionTarget(messages[i].text, roster);
    if (target === "everyone" || target.some((id) => next.includes(id))) return speaker.id;
  }
  return null;
}

/** Notices whose button still shows: those after your latest message, not used yet. */
export function liveActions(entries: { key: number | null; human: boolean }[], used: ReadonlySet<number>): Set<number> {
  const live = new Set<number>();
  for (let i = entries.length - 1; i >= 0 && !entries[i].human; i--) {
    const key = entries[i].key;
    if (key !== null && !used.has(key)) live.add(key);
  }
  return live;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --experimental-strip-types --test tests/notice-actions.test.mjs`
Expected: `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/noticeActions.ts tests/notice-actions.test.mjs
git commit -m "feat: rules for Try again and Let them answer"
```

---

### Task 13: Try again and Let them answer

**Files:**
- Modify: `src/ChatPane.tsx` (import; `:74` `Notice`; `:470-471` `notify`; `:577` `failed`; `:579-581` `hop_limit_reached`; `:744-757` dispatch and queue; after Task 4's `stopReplying`; the notice branch from Task 5)
- Modify: `src/backend.ts:209`, after the `turn_started` emit at `:241`
- Modify: `src/styles.css` (end of file)

**Interfaces:**
- Consumes: `NoticeAction`, `retryFor`, `stillHere`, `hopNotice`, `letLabel`, `askerOf`, `liveActions` (Task 12); `ParticipantQueues.turn` (Task 11); `Backend.roomTurn(id, participants, hops)` (Task 10); `hop_limit_reached.next` and the preview's `lastHuman` (Task 9).
- Produces: `Notice.action?: NoticeAction`; `notify(message, tone?, action?)`; `noticeButton(key: number, action: NoticeAction): JSX.Element | null`; the preview's `fail` trigger.

- [ ] **Step 1: Import the rules and widen notices**

After the `recipients` import add:

```ts
import { askerOf, hopNotice, letLabel, liveActions, retryFor, stillHere, type NoticeAction } from "./noticeActions";
```

Replace line 74:

```ts
type Notice = { key: number; text: string; tone: "info" | "error" };
```

with:

```ts
/** A line in the transcript from the app. `action` adds Try again or Let them answer. */
type Notice = { key: number; text: string; tone: "info" | "error"; action?: NoticeAction };
```

Replace lines 470-471:

```ts
  const notify = (message: string, tone: Notice["tone"] = "info") =>
    setEntries((list) => [...list, { kind: "notice", notice: { key: noticeKey.current++, text: message, tone } }]);
```

with:

```ts
  const notify = (message: string, tone: Notice["tone"] = "info", action?: NoticeAction) =>
    setEntries((list) => [...list, { kind: "notice", notice: { key: noticeKey.current++, text: message, tone, ...(action ? { action } : {}) } }]);
```

- [ ] **Step 2: Offer Try again on a bot's failure**

Replace line 577:

```ts
          notify(`${nameOf(event.id)} could not reply: ${event.error}`, "error");
```

with:

```ts
          notify(`${nameOf(event.id)} could not reply: ${event.error}`, "error", retryFor(event.id, [...namesRef.current.keys()]) ?? undefined);
```

- [ ] **Step 3: Say who was asked next, and offer to let them answer**

Replace lines 579-581:

```ts
        case "hop_limit_reached":
          notify(`Stopped after ${event.limit} rounds of models answering each other.`);
          break;
```

with:

```ts
        case "hop_limit_reached": {
          const roster = [...namesRef.current.keys()];
          const action: NoticeAction | undefined = event.next.length > 0 ? { kind: "let", ids: event.next } : undefined;
          // Read the asker from the newest list: its reply may have landed in this same tick.
          setEntries((list) => {
            const asker = askerOf(messagesOf(list), event.next, roster);
            const text = hopNotice(event.limit, asker && nameOf(asker), event.next.map(nameOf));
            return [...list, { kind: "notice", notice: { key: noticeKey.current++, text, tone: "info", ...(action ? { action } : {}) } }];
          });
          break;
        }
```

- [ ] **Step 4: Dispatch one-off turns**

Replace lines 744-757:

```ts
  const dispatch = useRef<(message: string, to: string[], kind: TurnKind) => Promise<void>>(async () => {});
  dispatch.current = async (message, to, kind) => {
    if (kind === "compact") {
      try { await backend.roomCompact(pane.id); }
      finally { to.forEach(id => turnQueue.idle(id)); }
    } else await backend.roomPostTo(pane.id, message, to);
  };
  const [turnQueue] = useState(() => new ParticipantQueues(
    message => backend.roomTargets(pane.id, message),
    (message, to, kind) => dispatch.current(message, to, kind),
    id => backend.roomStop(pane.id, id),
    items => { setQueued(items); setBusy(turnQueue.active); setQueuePaused(turnQueue.paused.size > 0); },
    error => { notify(`Could not send: ${String(error)}. Affected queues are paused.`, "error"); },
  ));
```

with:

```ts
  const dispatch = useRef<(message: string, to: string[], kind: TurnKind, hops?: number | null) => Promise<void>>(async () => {});
  dispatch.current = async (message, to, kind, hops) => {
    if (kind === "compact") {
      try { await backend.roomCompact(pane.id); }
      finally { to.forEach(id => turnQueue.idle(id)); }
    } else if (kind === "turn") await backend.roomTurn(pane.id, to, hops ?? null);
    else await backend.roomPostTo(pane.id, message, to);
  };
  const [turnQueue] = useState(() => new ParticipantQueues(
    message => backend.roomTargets(pane.id, message),
    (message, to, kind, hops) => dispatch.current(message, to, kind, hops),
    id => backend.roomStop(pane.id, id),
    // A one-off turn has no text to show or edit, so the queue line leaves it out.
    items => { setQueued(items.filter(item => item.kind !== "turn")); setBusy(turnQueue.active); setQueuePaused(turnQueue.paused.size > 0); },
    error => { notify(`Could not send: ${String(error)}. Affected queues are paused.`, "error"); },
  ));
```

- [ ] **Step 5: The buttons**

After Task 4's `stopReplying` add:

```ts
  /** Notices whose button you pressed; each works once. */
  const usedActions = useRef(new Set<number>());
  const [usedKeys, setUsedKeys] = useState<ReadonlySet<number>>(() => new Set());
  const liveKeys = liveActions(entries.map((entry) => ({
    key: entry.kind === "notice" && entry.notice.action ? entry.notice.key : null,
    human: entry.kind === "message" && entry.message.speaker.kind === "human",
  })), usedKeys);
  /** Try again or Let them answer: run those bots once on the transcript as it is. */
  const noticeButton = (key: number, action: NoticeAction) => {
    const ids = stillHere(action, participants.map((p) => p.id));
    if (ids.length === 0 || !liveKeys.has(key)) return null;
    const label = action.kind === "retry" ? "Try again" : letLabel(ids.map((id) => names.get(id) ?? id));
    return <button type="button" className="ghost small" disabled={ids.some((id) => working[id])} onClick={() => {
      if (usedActions.current.has(key)) return;
      usedActions.current.add(key);
      setUsedKeys(new Set(usedActions.current));
      // Let them answer buys exactly one reply each; Try again keeps the room's round limit.
      turnQueue.turn(ids, action.kind === "let" ? 0 : null);
    }}>{label}</button>;
  };
```

- [ ] **Step 6: Render the button on its notice**

In the transcript entries (Task 5's `flatMap`), replace:

```tsx
          const item = entry.kind === "notice" ? (
            <p key={`n${entry.notice.key}`} className={`notice ${entry.notice.tone}`}>
              {entry.notice.text}
            </p>
```

with:

```tsx
          const item = entry.kind === "notice" ? (
            <p key={`n${entry.notice.key}`} className={`notice ${entry.notice.tone}${entry.notice.action ? " with-action" : ""}`}>
              <span>{entry.notice.text}</span>
              {entry.notice.action && noticeButton(entry.notice.key, entry.notice.action)}
            </p>
```

- [ ] **Step 7: Style it**

Add at the end of `src/styles.css`:

```css
/* Now 3.3: Try again and Let them answer on notices. */
.notice.with-action { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 10px; text-align: center; }
.notice.with-action button { padding: 2px 10px; font-size: 12px; color: var(--text); }
```

- [ ] **Step 8: Let the preview fail on purpose**

In `src/backend.ts`, after line 209 (`const askOwners = new Map<string, string>();`) add:

```ts
  /** Preview only: bots that already failed on purpose for a message, so Try again succeeds. */
  const failedOnce = new Set<string>();
```

and right after `emit( { type: "turn_started", id: p.id });` (line 241) add:

```ts
        // Preview only: "fail" in your message makes each addressed bot fail
        // once, so Try again can be seen.
        const failKey = `${id}:${p.id}:${lastHuman?.seq}`;
        if (lastHuman && /\bfail\b/i.test(lastHuman.text) && !failedOnce.has(failKey)) {
          failedOnce.add(failKey);
          await sleep(400); if (!active) return;
          emit({ type: "failed", id: p.id, error: "Preview: this bot failed on purpose. Try again runs it once more." });
          continue;
        }
```

- [ ] **Step 9: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`.

- [ ] **Step 10: Preview check (1440x900)**

Preview setup with Null and Jigga (Read only). Look for:
- Send `@null fail`: the red notice "Null could not reply: Preview: this bot failed on purpose. Try again runs it once more." with a ghost **Try again** in neutral text. Click it: the button disappears, Null replies, and no new message of yours appears.
- Send `@null relay` (rounds 3): after four replies the notice reads "Stopped after 3 rounds of models answering each other. Jigga asked Null next." with **Let Null answer**. Click it: Null replies once ("@jigga your turn."), then a new notice "Stopped so you can choose. Null asked Jigga next." with **Let Jigga answer**; the first button is gone.
- Add a third bot (Ada, Read only) and send `@null relay all`: the cut-off notice names two bots ("… asked Jigga and Ada next.") with **Let them answer**; clicking runs them one after another.
- With a live button showing, send any message: the button disappears.
- Remove Jigga in thread details while "Let Jigga answer" shows: the button disappears.
- A storage failure has no Try again (not reachable in the preview; covered by the `retryFor` test).

- [ ] **Step 11: Commit**

```bash
git add src/ChatPane.tsx src/backend.ts src/styles.css
git commit -m "feat: Try again after a failure and Let them answer after the round limit"
```

---

### Task 14: Quotes follow your own @mention

**Files:**
- Modify: `src/reply.ts` (whole file), `tests/reply.test.mjs`
- Modify: `src/ChatPane.tsx:886` (`send`), Task 7's targets effect

**Interfaces:**
- Consumes: `hasMention` (Task 6); `type Message`.
- Produces:
  - `interface ReplyQuote { id: string; name: string; text: string; to?: string }` (`id` is `""` for your own message; `to` is a bot id or `"all"`, set from Send to ▾)
  - `quoteLead(body: string, quote: ReplyQuote, ids: string[]): string | null`
  - `replyText(text: string, quote: ReplyQuote | null, ids?: string[]): string`
  - `quoteFor(message: Message, nameOf: (id: string) => string): ReplyQuote`
  - `handOffChoices(lead: string | null, bots: { id: string; name: string }[]): { to: string; label: string }[]`
  - `handOffLabel(lead: string | null, nameOf: (id: string) => string): string`
  - `MIN_ACTIONS_WIDTH = 360`, `foldsMessageActions(paneWidth: number): boolean`

- [ ] **Step 1: Write the failing tests**

In `tests/reply.test.mjs`, replace line 3 with:

```js
import { foldsMessageActions, handOffChoices, handOffLabel, quoteFor, quoteLead, replyText } from '../src/reply.ts';
```

and add at the end:

```js
test('your own @mention means the quote adds no handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.' };
  assert.equal(replyText('@null check this', quote, ['jigga', 'null']), '@null check this\n\n> Jigga wrote:\n> Use a cache.');
  assert.ok(replyText('@all thoughts?', quote, ['jigga', 'null']).startsWith('@all thoughts?'));
});

test('a mention inside the quoted text is not yours', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Ask @null about it' };
  assert.ok(replyText('Agreed?', quote, ['jigga', 'null']).startsWith('@jigga Agreed?'));
});

test('Send to sets the leading handle', () => {
  const quote = { id: 'jigga', name: 'Jigga', text: 'Use a cache.', to: 'null' };
  assert.ok(replyText('Check this', quote, ['jigga', 'null']).startsWith('@null Check this'));
  assert.ok(replyText('Check this', { ...quote, to: 'all' }, ['jigga', 'null']).startsWith('@all Check this'));
  assert.equal(quoteLead('Check this', quote, ['jigga', 'null']), 'null');
});

test('your own messages can be quoted and lead with nobody by default', () => {
  const quote = quoteFor({ seq: 4, speaker: { kind: 'human' }, text: 'Ship it' }, (id) => id);
  assert.deepEqual(quote, { id: '', name: 'I', text: 'Ship it' });
  assert.equal(replyText('Still true?', quote, ['null']), 'Still true?\n\n> I wrote:\n> Ship it');
  assert.deepEqual(quoteFor({ seq: 5, speaker: { kind: 'bot', id: 'null' }, text: 'Done' }, () => 'Null'), { id: 'null', name: 'Null', text: 'Done' });
});

test('the hand-off menu lists the other bots and Everyone', () => {
  const bots = [{ id: 'jigga', name: 'Jigga' }, { id: 'null', name: 'Null' }];
  assert.deepEqual(handOffChoices('jigga', bots), [{ to: 'null', label: 'Null' }, { to: 'all', label: 'Everyone' }]);
  assert.deepEqual(handOffChoices('all', bots), [{ to: 'jigga', label: 'Jigga' }, { to: 'null', label: 'Null' }]);
  assert.equal(handOffLabel('null', (id) => (id === 'null' ? 'Null' : id)), 'Send to Null');
  assert.equal(handOffLabel('all', (id) => id), 'Send to everyone');
  assert.equal(handOffLabel(null, (id) => id), 'Send to…');
});

test('message actions fold into one menu in a pane under 360px wide', () => {
  assert.equal(foldsMessageActions(359), true);
  assert.equal(foldsMessageActions(360), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test tests/reply.test.mjs`
Expected: FAIL with `does not provide an export named 'foldsMessageActions'`.

- [ ] **Step 3: Implement**

Replace the whole of `src/reply.ts` with:

```ts
// Quoting a message in the composer, and handing the quote to a bot.

import type { Message } from "./types";
import { hasMention } from "./recipients.ts";

export interface ReplyQuote {
  /** The quoted bot's id, or "" for one of your own messages. */
  id: string;
  name: string;
  text: string;
  /** Who the quote is handed to, chosen in Send to ▾: a bot id or "all". Unset follows the quoted bot. */
  to?: string;
}

/**
 * The handle a quoted reply leads with: your choice in Send to ▾; else the
 * quoted bot, unless your own text already @mentions someone or the quote
 * is one of your messages. Null leads with nobody, and the room's policy or
 * your mention decides.
 */
export function quoteLead(body: string, quote: ReplyQuote, ids: string[]): string | null {
  if (quote.to) return quote.to;
  if (!quote.id || hasMention(body, ids)) return null;
  return quote.id;
}

/** Quote mentions are context, not instructions to summon another participant. */
export function replyText(text: string, quote: ReplyQuote | null, ids: string[] = []): string {
  const body = text.trim();
  if (!quote) return body;
  const context = `${quote.name} wrote:\n${quote.text}`.replaceAll('@', '＠');
  const lead = quoteLead(body, quote, ids);
  return `${lead ? `@${lead} ` : ""}${body}\n\n${context.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

/** The quote for a message: a bot's reply under its name, or one of yours ("I wrote:" to the models). */
export function quoteFor(message: Message, nameOf: (id: string) => string): ReplyQuote {
  return message.speaker.kind === "bot"
    ? { id: message.speaker.id, name: nameOf(message.speaker.id), text: message.text }
    : { id: "", name: "I", text: message.text };
}

/** The choices in Send to ▾: every bot but the current lead, then Everyone. */
export function handOffChoices(lead: string | null, bots: { id: string; name: string }[]): { to: string; label: string }[] {
  return [
    ...bots.filter((bot) => bot.id !== lead).map((bot) => ({ to: bot.id, label: bot.name })),
    ...(lead === "all" ? [] : [{ to: "all", label: "Everyone" }]),
  ];
}

/** "Send to Null", "Send to everyone", or "Send to…" when the room's policy or your mention decides. */
export function handOffLabel(lead: string | null, nameOf: (id: string) => string): string {
  return lead === "all" ? "Send to everyone" : lead ? `Send to ${nameOf(lead)}` : "Send to…";
}

/** Below this pane width, Quote, Copy and Fork fold into one ⋯ menu. */
export const MIN_ACTIONS_WIDTH = 360;

export function foldsMessageActions(paneWidth: number): boolean {
  return paneWidth < MIN_ACTIONS_WIDTH;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --experimental-strip-types --test tests/reply.test.mjs tests/commands.test.mjs`
Expected: `reply` `ℹ pass 9`; `commands` still passes (its `@bot /compact` case has no mention in the body); `ℹ fail 0`.

- [ ] **Step 5: Pass the room's handles where quotes are built**

In `src/ChatPane.tsx` `send`, replace on line 886:

```ts
    const message = withAttachments(parsed.text && replyText(postable(parsed.text), reply), sendable.map((a) => a.path!));
```

with:

```ts
    const message = withAttachments(parsed.text && replyText(postable(parsed.text), reply, participants.map((p) => p.id)), sendable.map((a) => a.path!));
```

In Task 7's targets effect, replace:

```ts
    const outgoing = reply ? replyText(text, reply) : text;
```

with:

```ts
    const outgoing = reply ? replyText(text, reply, participants.map((p) => p.id)) : text;
```

- [ ] **Step 6: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`.

- [ ] **Step 7: Preview check (1440x900)**

Preview setup with Null and Jigga (Read only), and one reply from Jigga in the thread. Look for:
- Quote Jigga's reply (the reply icon), type `@null check this`: the recipient line reads "To Null · you mentioned". Send: your message starts `@null check this` (no `@jigga`), followed by the quoted lines.
- Quote Jigga's reply and type `Agreed?`: the line reads "To Jigga · you mentioned" and the sent message starts `@jigga Agreed?`.

- [ ] **Step 8: Commit**

```bash
git add src/reply.ts tests/reply.test.mjs src/ChatPane.tsx
git commit -m "feat: quotes follow your own @mention"
```

---

### Task 15: "Quoting Jigga" and Send to ▾

**Files:**
- Modify: `src/composerStatus.ts` (`composerCopy` from Task 8), `tests/composer-status.test.mjs`
- Modify: `src/ChatPane.tsx` (reply import `:30`; state after `:381`; `copy` from Task 8; the quote preview at `:1570-1573`)
- Modify: `src/styles.css` (end of file)

**Interfaces:**
- Consumes: `quoteLead`, `handOffChoices`, `handOffLabel` (Task 14).
- Produces: `composerCopy(busy, empty, extra?: { firstMessage?: boolean; quoting?: boolean })`; ChatPane `handOffOpen`, `handOffButton`, `quoteTo: string | null`.

- [ ] **Step 1: Write the failing test**

Add at the end of `tests/composer-status.test.mjs`:

```js
test("while quoting, the placeholder suggests what to ask", () => {
  assert.equal(composerCopy(false, false, { quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.equal(composerCopy(true, false, { quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.match(composerCopy(true, false, { quoting: true }).hint, /↵ queue/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: FAIL: the placeholder is `"Message the room. @name picks who answers."`.

- [ ] **Step 3: Implement**

Replace `composerCopy` in `src/composerStatus.ts` (Task 8's version) with:

```ts
/**
 * What the composer says Enter will do, so the placeholder and hint never
 * disagree. `hint` is the whole line under the message box. Before the first
 * message in a room of two or more bots it teaches @all and / instead.
 * While quoting, the placeholder suggests what to ask about the quote.
 */
export function composerCopy(busy: boolean, empty: boolean, extra: { firstMessage?: boolean; quoting?: boolean } = {}): { placeholder: string; hint: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "@ who answers · ! which tools · ↵ send · ⇧↵ new line" };
  const placeholder = extra.quoting
    ? "e.g. Check this against the tests and say what breaks"
    : busy ? "Add to the next turn, or ⌘↵ to steer now…" : "Message the room. @name picks who answers.";
  if (busy) return { placeholder, hint: "@ who answers · ! which tools · ↵ queue · ⌘↵ steer now · ⇧↵ new line" };
  if (extra.firstMessage) return { placeholder, hint: "@all asks everyone · / for commands · ↵ send" };
  return { placeholder, hint: "@ who answers · ! which tools · ↵ send · ⇧↵ new line" };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: `ℹ fail 0`; the new test passes.

- [ ] **Step 5: ChatPane state for the menu**

Replace line 30:

```ts
import { replyText, type ReplyQuote } from "./reply";
```

with:

```ts
import { handOffChoices, handOffLabel, quoteLead, replyText, type ReplyQuote } from "./reply";
```

After line 381 (`const [reply, setReply] = useState<ReplyQuote | null>(null);`) add:

```ts
  /** Whether the quote's Send to ▾ menu is open. */
  const [handOffOpen, setHandOffOpen] = useState(false);
  const handOffButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!reply) setHandOffOpen(false); }, [reply]);
  useEffect(() => {
    if (!handOffOpen) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".hand-off")) setHandOffOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHandOffOpen(false);
      handOffButton.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [handOffOpen]);
```

Replace Task 8's `copy` line:

```ts
  const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore });
```

with:

```ts
  const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore, quoting: Boolean(reply) });
  /** Who a quote will lead with right now, for its Send to ▾ button. */
  const quoteTo = reply ? quoteLead(text.trim(), reply, participants.map((p) => p.id)) : null;
```

- [ ] **Step 6: Render "Quoting Jigga" and Send to ▾**

Replace lines 1570-1573:

```tsx
        {reply && <div className="quote-preview">
          <div className="quote-preview-copy"><span className="speaker">{reply.name}</span><blockquote>{reply.text}</blockquote></div>
          <button className="quote-cancel" aria-label="Cancel quote" onClick={() => { setReply(null); input.current?.focus(); }}>×</button>
        </div>}
```

with:

```tsx
        {reply && <div className="quote-preview">
          <div className="quote-preview-copy"><span className="speaker">{reply.id ? `Quoting ${reply.name}` : "Quoting your message"}</span><blockquote>{reply.text}</blockquote></div>
          <span className="pane-menu-wrap hand-off">
            <button ref={handOffButton} type="button" className="ghost small" aria-haspopup="menu" aria-expanded={handOffOpen} onClick={() => setHandOffOpen((open) => !open)}>
              {handOffLabel(quoteTo, (id) => names.get(id) ?? id)} ▾
            </button>
            {handOffOpen && <span className="pane-menu hand-off-menu" role="menu">
              {handOffChoices(quoteTo, participants.map((p) => ({ id: p.id, name: p.display_name }))).map((choice) => (
                <button role="menuitem" key={choice.to} onClick={() => { setReply((quote) => (quote ? { ...quote, to: choice.to } : quote)); setHandOffOpen(false); input.current?.focus(); }}>{choice.label}</button>
              ))}
            </span>}
          </span>
          <button className="quote-cancel" aria-label="Cancel quote" onClick={() => { setReply(null); input.current?.focus(); }}>×</button>
        </div>}
```

- [ ] **Step 7: Style it**

Add at the end of `src/styles.css`:

```css
/* Now 3.4: hand a quote to another bot. The menu opens upward from the composer. */
.hand-off { flex: none; }
.hand-off > button { padding: 3px 8px; font-size: 12px; white-space: nowrap; }
.hand-off-menu { top: auto; bottom: calc(100% + 6px); }
```

- [ ] **Step 8: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors; `✓ built in`; `ℹ fail 0`.

- [ ] **Step 9: Preview check (1440x900)**

Preview setup with Null and Jigga (Read only), and one reply from Jigga. Look for:
- Quote Jigga's reply: the preview reads "Quoting Jigga", with a button "Send to Jigga ▾"; the composer placeholder reads "e.g. Check this against the tests and say what breaks".
- Open Send to ▾: it opens upward and lists Null and Everyone. Choose Null: the button reads "Send to Null ▾", focus returns to the message box, and the recipient line reads "To Null · you mentioned". Send `Check this`: the message starts `@null Check this`.
- Open the menu and press Escape: it closes and focus returns to the Send to button. Click elsewhere: it closes.
- Choose Everyone: "Send to everyone ▾" and the recipient line "To everyone · you mentioned".
- Type `@null ` while quoting with nothing chosen: the button reads "Send to… ▾".

- [ ] **Step 10: Commit**

```bash
git add src/composerStatus.ts tests/composer-status.test.mjs src/ChatPane.tsx src/styles.css
git commit -m "feat: hand a quoted reply to another bot"
```

---

### Task 16: Copy, quoting your own messages, and one ⋯ in narrow panes

**Files:**
- Modify: `src/DeckIcon.tsx:3`, after `:13`
- Modify: `src/ChatPane.tsx` (reply import; after `:259` constants; Task 7's pane-size block; `:771-773` `forkButton`; the human and bot branches in Task 5's transcript entries)
- Modify: `src/styles.css:1401-1402`, `:1617-1619`, end of file

**Interfaces:**
- Consumes: `quoteFor`, `foldsMessageActions` (Task 14); `root` and the pane-size observer (Task 7); `forkAt` (existing).
- Produces: DeckIcon name `"copy"`; ChatPane `messageActions(message: Message): JSX.Element`, `copyMessage(message: Message): void`, `copied: number | null`, `messageMenu: number | null`, `foldActions: boolean`.

- [ ] **Step 1: A copy icon**

In `src/DeckIcon.tsx`, replace line 3:

```tsx
type IconName = "folder" | "sidebar" | "arrow" | "spark" | "send" | "chat" | "reply";
```

with:

```tsx
type IconName = "folder" | "sidebar" | "arrow" | "spark" | "send" | "chat" | "reply" | "copy";
```

and after line 13 (the `chat` icon) add:

```tsx
    {name === "copy" && <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>}
```

- [ ] **Step 2: Copy state and the narrow-pane rule**

In `src/ChatPane.tsx`, change the reply import to:

```ts
import { foldsMessageActions, handOffChoices, handOffLabel, quoteFor, quoteLead, replyText, type ReplyQuote } from "./reply";
```

After line 259 (`const MAX_STEPS_SHOWN = 4;`) add:

```ts
/** How long Copy reads "Copied". */
const COPIED_MS = 1500;
```

Replace Task 7's pane-size block (from `/** False in a pane under 260px tall, where the recipient line is hidden. */` through that effect's `}, []);`) with:

```ts
  /** False in a pane under 260px tall, where the recipient line is hidden. */
  const [lineFits, setLineFits] = useState(true);
  /** True in a pane under 360px wide, where message actions fold into one ⋯. */
  const [foldActions, setFoldActions] = useState(false);
  useEffect(() => {
    const paneBox = root.current?.closest<HTMLElement>(".pane");
    if (!paneBox) return;
    const observer = new ResizeObserver(() => {
      // A hidden pane measures nothing; keep what it had.
      if (paneBox.offsetWidth === 0 && paneBox.offsetHeight === 0) return;
      setLineFits(showsRecipientLine(paneBox.offsetHeight));
      setFoldActions(foldsMessageActions(paneBox.offsetWidth));
    });
    observer.observe(paneBox);
    return () => observer.disconnect();
  }, []);
```

- [ ] **Step 3: Quote, Copy and Fork on every message**

Replace `forkButton` (lines 771-773):

```tsx
  const forkButton = (seq: number) => onFork && <button className="quote-reply-icon fork-message-icon" aria-label="Fork from here" title="Fork from here" onClick={() => forkAt(`${pane.title} (fork)`, seq + 1)}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3 3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/></svg>
  </button>;
```

with:

```tsx
  const forkIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3 3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/></svg>;
  /** The message whose Copy reads "Copied" for a moment, by seq. */
  const [copied, setCopied] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  /** Put a message's markdown on the clipboard. */
  const copyMessage = (message: Message) => {
    if (!navigator.clipboard) return notify("Could not copy: the clipboard isn't available here.", "error");
    navigator.clipboard.writeText(message.text)
      .then(() => {
        setCopied(message.seq);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
      })
      .catch((error) => notify(`Could not copy: ${String(error)}`, "error"));
  };
  /** The message whose ⋯ menu is open, by seq. */
  const [messageMenu, setMessageMenu] = useState<number | null>(null);
  useEffect(() => {
    if (messageMenu === null) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".message-more")) setMessageMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      scroller.current?.querySelector<HTMLButtonElement>(`[data-message-more="${messageMenu}"]`)?.focus();
      setMessageMenu(null);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [messageMenu]);
  /** Quote, Copy and Fork on a message; one ⋯ menu instead in a pane under 360px wide. */
  const messageActions = (message: Message) => {
    const quote = () => { setReply(quoteFor(message, (id) => names.get(id) ?? id)); input.current?.focus(); };
    const copy = () => copyMessage(message);
    const fork = () => forkAt(`${pane.title} (fork)`, message.seq + 1);
    const copiedHere = copied === message.seq;
    if (foldActions) return <span className="message-actions">
      <span className="pane-menu-wrap message-more">
        <button type="button" className="msg-more" data-message-more={message.seq} aria-label="Message actions" aria-haspopup="menu" aria-expanded={messageMenu === message.seq} onClick={() => setMessageMenu((open) => (open === message.seq ? null : message.seq))}>
          {copiedHere ? <span className="copied">Copied</span> : "⋯"}
        </button>
        {messageMenu === message.seq && <span className="pane-menu" role="menu">
          <button role="menuitem" onClick={() => { setMessageMenu(null); quote(); }}>Quote</button>
          <button role="menuitem" onClick={() => { setMessageMenu(null); copy(); }}>Copy</button>
          {onFork && <button role="menuitem" onClick={() => { setMessageMenu(null); fork(); }}>Fork from here</button>}
        </span>}
      </span>
    </span>;
    return <span className="message-actions">
      <button type="button" className="msg-action quote" title="Quote" onClick={quote}
        aria-label={message.speaker.kind === "bot" ? `Quote response from ${names.get(message.speaker.id) ?? message.speaker.id}` : "Quote your message"}>
        <DeckIcon name="reply" size={18} />
      </button>
      <button type="button" className="msg-action copy" title="Copy" aria-label={copiedHere ? "Copied" : "Copy message"} onClick={copy}>
        {copiedHere ? <span className="copied">Copied</span> : <DeckIcon name="copy" size={16} />}
      </button>
      {onFork && <button type="button" className="msg-action fork" aria-label="Fork from here" title="Fork from here" onClick={fork}>{forkIcon}</button>}
    </span>;
  };
```

- [ ] **Step 4: Use them on your messages and on replies**

In the transcript entries (Task 5's `flatMap`), replace the human branch:

```tsx
            <div key={`m${entry.message.seq}`} className="bubble human">
              <RichText text={entry.message.text} onOpen={openTarget} />
              {forkButton(entry.message.seq)}
            </div>
```

with:

```tsx
            <div key={`m${entry.message.seq}`} className="bubble human">
              <RichText text={entry.message.text} onOpen={openTarget} />
              {messageActions(entry.message)}
            </div>
```

and in the bot branch replace:

```tsx
                <Markdown text={entry.message.text} onOpen={openTarget} />
                <button className="quote-reply-icon" aria-label={`Quote response from ${names.get(entry.message.speaker.id) ?? entry.message.speaker.id}`} onClick={() => {
                  if (entry.message.speaker.kind !== "bot") return;
                  setReply({ id: entry.message.speaker.id, name: names.get(entry.message.speaker.id) ?? entry.message.speaker.id, text: entry.message.text });
                  input.current?.focus();
                }}><DeckIcon name="reply" size={18} /></button>
                {forkButton(entry.message.seq)}
```

with:

```tsx
                <Markdown text={entry.message.text} onOpen={openTarget} />
                {messageActions(entry.message)}
```

- [ ] **Step 5: Style it**

In `src/styles.css`, delete lines 1401-1402:

```css
.quote-reply-icon { position: absolute; right: 10px; top: 10px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; background: transparent; color: var(--muted); }
.quote-reply-icon:hover, .quote-reply-icon:focus-visible { color: var(--text); background: var(--panel); }
```

and lines 1617-1619:

```css
.fork-message-icon { opacity: 0; }
.bubble.bot .fork-message-icon { right: 44px; }
.bubble:hover .fork-message-icon, .bubble:focus-within .fork-message-icon { opacity: 1; }
```

(keep `.bubble.bot.completed { position: relative; padding-right: 54px; }` on line 1400 and `.bubble.human { position: relative; }` on line 1616), then add at the end:

```css
/* Now 3.4: Quote, Copy and Fork on every message; one ⋯ in a narrow pane. */
.message-actions { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: row-reverse; align-items: center; gap: 2px; }
.msg-action, .msg-more { display: grid; place-items: center; min-width: 32px; height: 32px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); }
.msg-action:hover:not(:disabled), .msg-action:focus-visible, .msg-more:hover:not(:disabled), .msg-more:focus-visible { color: var(--text); background: var(--panel); }
.bubble .msg-action { opacity: 0; }
.bubble.bot .msg-action.quote, .bubble:hover .msg-action, .bubble:focus-within .msg-action { opacity: 1; }
.bubble.human:has(.msg-more) { padding-right: 44px; }
.copied { font-size: 11px; color: var(--text); }
```

- [ ] **Step 6: Build and run the suite**

Run: `npm run build && npm test`
Expected: no TypeScript errors (no leftover `forkButton`); `✓ built in`; `ℹ fail 0`.

- [ ] **Step 7: Preview check (1440x900)**

Preview setup with Jigga (Read only) and one exchange. Look for:
- A reply shows its Quote icon at the top right; hovering the reply shows Copy and Fork beside Quote.
- Click Copy: the button reads "Copied" for about 1.5 seconds. Paste into the composer: the reply's markdown (`##` headings, the table, the code fence) arrives as text.
- Hover your own message: Quote, Copy and Fork. Quote it: the preview reads "Quoting your message" with "Send to… ▾"; the sent message's quoted lines start "> I wrote:".
- Drag the divider between two side-by-side threads until one is narrower than 360px: each message in it shows one ⋯; it opens Quote, Copy and Fork from here, each works, Escape closes it and returns focus to the ⋯; after Copy the ⋯ reads "Copied" briefly. Widen the pane again and the three icons return.

- [ ] **Step 8: Commit**

```bash
git add src/DeckIcon.tsx src/ChatPane.tsx src/styles.css
git commit -m "feat: copy any message, quote your own, and fold actions in narrow panes"
```

---

### Task 17: Docs, all checks, and the walkthrough

**Files:**
- Modify: `README.md:57-60`, `:66`, after `:80`, `:93-94`
- Modify: `SPEC.md:43-44`, after `:60`, `:122`

**Interfaces:**
- Consumes: every task above.
- Produces: up-to-date docs and the verification report.

- [ ] **Step 1: README**

Replace lines 57-60:

```markdown
- **Turn taking.** `@name` picks who answers, `@all` asks everyone. Without a
  mention the room follows its policy: whoever you addressed last, everyone
  at once, or everyone in turn. Models can @mention each other, up to a
  limit you set, and there is a stop button.
```

with:

```markdown
- **Turn taking.** `@name` picks who answers, `@all` asks everyone. Without a
  mention the room follows its policy: whoever you addressed last, everyone
  at once, or everyone in turn. A line above the message box says who gets
  your message and why, such as "To Null · last addressed"; click the reason
  to change the policy. An empty room offers example messages built from
  your bots' handles. Models can @mention each other, up to a limit you set,
  and there is a stop button. When the limit cuts them off, the notice says
  who was asked next and **Let Null answer** buys exactly one more reply. A
  reply that fails offers **Try again**, which runs that bot once on the
  conversation as it is.
```

In the Approvals bullet, replace its last line (line 66):

```markdown
  the reply's time limit. Stop rejects whatever is waiting.
```

with:

```markdown
  the reply's time limit. If the card scrolls out of view, a pill such as
  "Null is waiting for you · Show" brings it back and puts focus on Allow
  once. While another bot is still replying, the composer's Stop names and
  stops only the bots that are replying, so the card stays up; **Stop all**
  in its ⋯ menu rejects whatever is waiting.
- **Reading while bots reply.** The conversation follows new replies only
  while you are at the bottom. Scroll up and it keeps your place; a pill
  such as "3 new · Jump to latest" takes you down. Come back to a thread and
  a divider marks "New since you looked", and the thread opens there.
  Sending a message clears it.
```

After the Composer tools bullet (it ends on line 80 with `cursor. Commands without arguments run while preserving your draft.`) add:

```markdown
- **Quote, hand off and copy.** Quote any message, yours or a bot's. The
  quote goes to the bot you quoted unless you @mention someone yourself or
  pick another bot or Everyone in **Send to ▾**. **Copy** puts a message's
  markdown on the clipboard. In a narrow pane these actions fold into one ⋯.
```

In the Queue and steer bullet, replace lines 93-94:

```markdown
- **Queue and steer.** While models reply, Enter queues your message for
  the next turn. You can edit or remove queued messages. Steer (or
```

with:

```markdown
- **Queue and steer.** While models reply, a status line above the message
  box says who is replying and who is waiting for you, such as "Jigga is
  replying · Null is waiting for you", and Enter queues your message for
  the next turn. You can edit or remove queued messages. Steer (or
```

- [ ] **Step 2: SPEC**

In `SPEC.md`, replace lines 43-44:

```markdown
| Models can @mention each other, with a round limit | done |
| Pass (a model declines to reply), failure reporting, stop | done |
```

with:

```markdown
| Models can @mention each other, with a round limit; the cut-off notice names who was asked next and Let them answer buys one more reply | done |
| Pass (a model declines to reply), failure reporting with Try again, stop that names the bots it stops | done |
```

After line 60 (`| Queue added context or steer to another model | … |`) add:

```markdown
| The transcript keeps your place while bots reply, with pills for new replies and for an approval card out of view | done |
| "New since you looked" divider, saved per thread (`lastSeenSeq`) | done |
| Recipient line above the composer: who gets the message and why | done |
| Quote any message, hand a quote to another bot, copy a message's markdown | done |
```

Replace line 122:

```markdown
Thread controls live in one right sidebar following the focused thread; narrow layouts overlay it. The header keeps a single row of chips. Pins remain above the conversation in an expandable, wrapping strip. The composer + menu offers mentions and commands, with `/` and `@` keyboard filtering.
```

with:

```markdown
Thread controls live in one right sidebar following the focused thread; narrow layouts overlay it. The header keeps a single row of chips. Pins remain above the conversation in an expandable, wrapping strip. The composer + menu offers mentions and commands, with `/` and `@` keyboard filtering. A recipient line above the message box says who gets the next message and why; its reason opens Room in the sidebar.
```

- [ ] **Step 3: Run every check**

Run: `npm test && npm run build && cargo test --workspace -- --test-threads=1 && git diff --check <base>...HEAD` (`<base>` is the branch Task 0 started from)
Expected: `ℹ fail 0` with pass count = baseline + 39; no TypeScript errors and `✓ built in`; every `test result: ok.` (`apex-core` `concurrent` = baseline + 4); `git diff --check` prints nothing.

- [ ] **Step 4: Walkthrough at 1440x900**

Preview setup (start clean) with Null (Claude Code, Ask first) and Jigga (Codex, Read only), then check each, in order:
1. Hold your place: scroll up while a reply streams; it stays put; "1 new · Jump to latest" appears and works; at the bottom it follows; a growing composer keeps you at the bottom; a thread left in another workspace shows its latest message when you come back.
2. `@null fix the readme`, scroll the card out of view: "Null is waiting for you · Show" with an amber dot; Show centres it and focuses Allow once.
3. `@all go`: "Jigga is replying · Null is waiting for you"; "Stop Jigga" stops only Jigga; the ⋯ still offers Stop Null and Stop all.
4. Two threads: a reply arrives in A while B is focused; back in A, "New since you looked" sits above it; sending clears it; reloading with an unseen reply opens A at the divider; after `/clear` the divider still marks new replies.
5. Recipient line: first in the room, last addressed, you mentioned, everyone at once, everyone in turn, queued (busy); the reason opens Room; "Whoever I addressed last"; hidden in a pane under 260px tall.
6. Empty room with both bots: three example rows; clicking one fills the composer without sending; the first-message hint.
7. `@null fail`: Try again runs Null once and disappears.
8. `@null relay`: the cut-off notice with "Jigga asked Null next." and Let Null answer; then "Stopped so you can choose." with Let Jigga answer; with a third bot, `@null relay all` gives Let them answer; sending hides live buttons.
9. Quote Jigga with `@null check this`: no `@jigga`; "Quoting Jigga", Send to ▾ (Null, Everyone), the quoting placeholder; Escape returns focus.
10. Copy reads "Copied"; your own messages have Quote and Copy; under 360px wide one ⋯ with Quote, Copy, Fork from here.

Then the must-keep-working list: answer each approval card (Allow once, Always allow, Deny); queue a message and steer with ⌘↵; run `/compact`, `/clear`, `/pin Use pnpm`, `/diff`, `/fork`, `/export`; in an unwatched thread a failure and a question still flag it (title bar count and rail flag); drag a pane by its head onto another and resize with a divider; open a terminal in Code, type `work`, and check it keeps printing while you drag.

- [ ] **Step 5: Walkthrough at about 820x1400**

Resize to 820x1400 and repeat items 1, 2, 4, 5, 7, 9 and 10 in one or two panes. Look for: pills centred and never wider than the pane; the recipient line ellipsised rather than wrapping; the quote preview's Send to button on one line beside the quote; the hand-off menu fully inside the pane; thread details overlaying when opened from the recipient line.

- [ ] **Step 6: Report**

Report real numbers and plainly say what was not checked: frontend and Rust test counts against the Task 0 baselines; the build; which walkthrough items passed at each size. The desktop app was not run (only the browser preview); the native `room_turn` path is covered by the Rust tests in Task 10 but not exercised by hand. List any item that did not behave as written.

- [ ] **Step 7: Commit**

```bash
git add README.md SPEC.md
git commit -m "docs: describe holding your place, the recipient line, Try again and quote hand-off"
```

Do not push and do not merge.
