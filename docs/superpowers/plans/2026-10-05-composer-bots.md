# Bots in the Message Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a thread's bot badges into the bottom row of the message box, move Artifacts and Changes up to the pane's top line, and replace the "To Jigga · last addressed" line with a placeholder that names who gets the message.

**Architecture:** All of it is renderer work in `src/`: no daemon, Rust or protocol change. `ChatPane.tsx` keeps owning the bot badges and counts; the counts reach the pane head (which `App.tsx` renders) through a React portal into an empty slot, the same way Thread details already portals into its sidebar slot. Two small pure modules carry the logic that can be unit tested: `src/fit.ts` (rows that give up detail step by step until they fit) and `src/floating.ts` (where a popover goes so it stays on screen now that the badges sit at the bottom of the pane).

**Tech Stack:** React 19, TypeScript 7 (`tsc --noEmit`), plain CSS in `src/styles.css`, Node's built-in test runner (`node --experimental-strip-types --test`), Electron smoke checks in `desktop/smoke.mjs`.

**Spec:** There is no separate spec document. The design was agreed in the group chat on 2026-10-05 and is drawn in the mockup at `~/Downloads/apex-deck/.superpowers/mockups/composer-bots-jigga.html` (open it in a browser and switch the top strip to **Proposed**). Where the mockup and this plan disagree, this plan wins. The decisions:

1. The bot badges move from the row under the pane head into the bottom row of the message box: **+** (attach, commands), the bots, **Add bot**, a flexible gap, **TL;DR**, **Send/Stop**. The text gets the box's full width above that row.
2. Badges keep their live status: the avatar's battery ring and working shimmer, the status dot, queued counts, the "editing" badge, pending-settings dot, and the low warnings. Clicking a badge still opens the Model and Reasoning popover; hovering still shows the usage card.
3. The badges the message will go to are lit (their bot's colour, filled). This shows the recipient, not necessarily who replies: **Who answers** can still pick someone else.
4. The "To Jigga · last addressed ▾" line is removed. **Who answers** stays in Thread details.
5. The empty box names the recipient: `Message Jigga…`, `Message everyone…`, `Queue for Jigga… (⌘↵ steers)`, `TL;DR to Jigga: short answers`.
6. **+** stays for attachments and commands. Adding a bot gets a person-plus icon and the words **Add bot**, with a dashed outline so it can never be mistaken for **+**.
7. **Artifacts · 7** and **Changes · 34** move to the pane's top line, before the maximize button. On a crowded top line they shrink to an icon and a number first.
8. A narrow pane shrinks the badges in steps: model details go first, then percentages, then names. The avatars always stay.

**Not in this plan:** the **This Mac / Apex-Terminal** label on the top line. It only means something once one window can hold threads on two machines, so it ships with that feature. Task 2 leaves room for it: the top line already gives up its words in a set order, and that feature adds the host label as the last thing to shrink.

## Global Constraints

- Work in `~/Downloads/apex-deck-composer` on branch `feat/composer-bots`. Never commit to `main`; never push.
- No change to anything outside `src/`, `tests/` and `desktop/smoke.mjs`.
- The textarea's accessible name stays `Message the room` (`aria-label`), whatever the placeholder says.
- The Agents section (`profileMode`) looks and behaves exactly as today.
- Copy is exact: `Message ${to}…`, `Message the room…`, `Queue for ${to}… (⌘↵ steers)`, `Queue a message… (⌘↵ steers)`, `TL;DR to ${to}: short answers`, `TL;DR mode: short answers`, `Add bot`. The ellipsis is the single character `…`.
- Match the file's style: double quotes in `ChatPane.tsx`/`App.tsx`, single quotes in `BotSettings.tsx` and `desktop/smoke.mjs`, small inline SVG icon components at the bottom of `ChatPane.tsx`, a one-line comment above each non-obvious block.
- Every task ends with `npm test` and `npx tsc --noEmit` both clean.

## Review Focus

1. **Two threads side by side in the narrowest window (900px) with three bots with long names:** every avatar and **Add bot** stays in view, nothing scrolls sideways. Pinned by the smoke check in Task 4.
2. **Popovers near the bottom and right edges:** Model and Reasoning for the rightmost bot in the right-hand pane, the usage card for the last bot, and the Add bot form in a short window all open fully on screen. Pinned by the `floating.ts` tests in Task 3, then checked by eye in Task 5.
3. **The placeholder in every state:** no message yet ("first in the room"), Everyone at once, Everyone in turn, a bot working, TL;DR on, quoting, no bots, and right after you delete an @mention. Pinned by the `recipientName` and `composerCopy` tests in Task 1.
4. **The top line still drags:** clicking Artifacts or Changes opens its panel and never starts a pane drag; dragging the head by its empty space still moves the pane; the "new" dot on Artifacts still shows. Checked by hand in Task 2, step 7.
5. **Everything the old composer did still works:** the **+** menu, `/` commands, `@` mentions and `!` servers open above the box with arrow-key selection; ⌘⇧T toggles TL;DR and the whole box wiggles on a TL;DR send; Esc stops the bots; pasting or dropping an image attaches it. Checked by hand in Task 3, step 9.

---

### Task 1: The placeholder names who gets the message, and the "To … · last addressed" line goes

**Files:**
- Modify: `src/recipients.ts` (replace `recipientLine` with `recipientName`; delete `RecipientLine`, `MIN_LINE_HEIGHT`, `showsRecipientLine`)
- Modify: `src/composerStatus.ts` (`composerCopy` gains `to` and `tldr`)
- Modify: `src/ChatPane.tsx` (imports at lines 3 and 51; delete the `lineFits` block at ~524-536; move `const copy` from ~607 to after the recipient; delete the recipient line at ~2417-2419; textarea placeholder at ~2460)
- Modify: `src/ReplyPolicyPicker.tsx` (delete the `ReplyPolicyPicker` component, keep `REPLY_POLICIES`)
- Modify: `src/styles.css` (delete `.recipient-line` and the `.reply-policy-*` rules at ~2069-2077)
- Test: `tests/recipients.test.mjs`, `tests/composer-status.test.mjs`

**Interfaces:**
- Produces: `recipientName(input: { targets: string[]; roster: { id: string; name: string }[]; policy: TurnPolicy }): string | null` in `src/recipients.ts`.
- Produces: `composerCopy(busy: boolean, empty: boolean, extra?: { firstMessage?: boolean; quoting?: boolean; to?: string | null; tldr?: boolean }): { placeholder: string; hint: string; keys: string }`.
- Produces (in `ChatPane`): `const recipient: string | null` (who gets the message, by name).

- [ ] **Step 0: Install dependencies in the new folder**

```bash
cd ~/Downloads/apex-deck-composer && npm ci
```
Expected: installs without errors. Then `npm test` passes and `npx tsc --noEmit` prints nothing.

- [ ] **Step 1: Write the failing tests**

In `tests/recipients.test.mjs`, change the import line to:

```js
import { exampleRows, handleFor, hasMention, mentionTarget, recipientName } from "../src/recipients.ts";
```

Replace everything from `const roster = ...` down to (and including) the test `"bots mentioned together are joined like a sentence"` with:

```js
const roster = [{ id: "jigga", name: "Jigga" }, { id: "null", name: "Null" }];
const to = (extra) => recipientName({ targets: ["null"], roster, policy: "mention", ...extra });

test("the composer names who gets the message", () => {
  assert.equal(to({}), "Null");
  assert.equal(to({ targets: ["jigga", "null"] }), "everyone");
  assert.equal(to({ targets: ["jigga", "null"], policy: "everyone" }), "everyone");
  assert.equal(to({ targets: ["jigga", "null"], policy: "round_robin" }), "Jigga, then Null");
  assert.equal(to({ targets: ["null"], policy: "round_robin" }), "Null");
});

test("a room of one is never everyone", () => {
  assert.equal(to({ roster: [{ id: "null", name: "Null" }] }), "Null");
});

test("no name without bots or a target", () => {
  assert.equal(to({ roster: [], targets: [] }), null);
  assert.equal(to({ targets: [] }), null);
});

test("bots mentioned together are joined like a sentence", () => {
  const three = [...roster, { id: "ada", name: "Ada" }];
  assert.equal(to({ roster: three, targets: ["null", "ada"] }), "Null and Ada");
});
```

Delete the test `"the line hides in a pane under 260px tall"` at the end of the file. Keep `"examples use a real handle"`.

In `tests/composer-status.test.mjs`, add after the test `"while quoting, the placeholder suggests what to ask"`:

```js
test("the placeholder names who gets the message", () => {
  assert.equal(composerCopy(false, false, { to: "Jigga" }).placeholder, "Message Jigga…");
  assert.equal(composerCopy(false, false, { to: "everyone" }).placeholder, "Message everyone…");
  assert.equal(composerCopy(true, false, { to: "Jigga" }).placeholder, "Queue for Jigga… (⌘↵ steers)");
  assert.equal(composerCopy(false, false, { to: "Jigga", tldr: true }).placeholder, "TL;DR to Jigga: short answers");
  // A queued TL;DR message still waits; the glowing box already says TL;DR.
  assert.equal(composerCopy(true, false, { to: "Jigga", tldr: true }).placeholder, "Queue for Jigga… (⌘↵ steers)");
});

test("before the room answers, the placeholder speaks to the room", () => {
  assert.equal(composerCopy(false, false).placeholder, "Message the room…");
  assert.equal(composerCopy(false, false, { to: null, tldr: true }).placeholder, "TL;DR mode: short answers");
  assert.equal(composerCopy(true, false, { to: null }).placeholder, "Queue a message… (⌘↵ steers)");
});

test("quoting and an empty room keep their own placeholders", () => {
  assert.equal(composerCopy(false, false, { to: "Jigga", quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.equal(composerCopy(false, false, { to: "Jigga", tldr: true, quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.equal(composerCopy(false, true, { to: "Jigga" }).placeholder, "Add a model to start");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --experimental-strip-types --test tests/recipients.test.mjs tests/composer-status.test.mjs`
Expected: FAIL. `recipientName` is not exported, and `"Message the room. @name picks who answers."` is not equal to `"Message Jigga…"`.

- [ ] **Step 3: Write `recipientName`**

In `src/recipients.ts`, change the header comment's first two lines to:

```ts
// Who gets the message in the composer, for its placeholder and its lit bot
// badges. The room decides (roomTargets); this names its answer.
```

Replace `RecipientInput`, `RecipientLine` and `recipientLine` (from `export interface RecipientInput` down to the closing brace of `recipientLine`) with:

```ts
export interface RecipientInput {
  /** Who roomTargets said gets the message, in the order they answer. */
  targets: string[];
  /** Everyone in the room, in roster order. */
  roster: { id: string; name: string }[];
  policy: TurnPolicy;
}

/** Who gets the message: "Null", "Null and Ada", "everyone", "Jigga, then Null". Null without bots or a target. */
export function recipientName({ targets, roster, policy }: RecipientInput): string | null {
  if (roster.length === 0 || targets.length === 0) return null;
  const name = (id: string) => roster.find((p) => p.id === id)?.name ?? id;
  // Everyone in turn answers one at a time, each seeing the reply before it.
  if (policy === "round_robin" && targets.length > 1) return targets.map(name).join(", then ");
  const everyone = roster.length > 1 && roster.every((p) => targets.includes(p.id));
  return everyone ? "everyone" : joinNames(targets.map(name));
}
```

Delete `MIN_LINE_HEIGHT` and `showsRecipientLine` (with their comments) at the end of the file.

- [ ] **Step 4: Teach `composerCopy` the recipient**

In `src/composerStatus.ts`, replace `composerCopy` (its doc comment through its closing brace) with:

```ts
/**
 * What the composer says Enter will do, so the placeholder and hint never
 * disagree. `to` names who gets the message (recipientName). The placeholder
 * only shows in an empty box, so it names whoever gets a message with no @.
 */
export function composerCopy(busy: boolean, empty: boolean, extra: { firstMessage?: boolean; quoting?: boolean; to?: string | null; tldr?: boolean } = {}): { placeholder: string; hint: string; keys: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "@ who answers · ! which tools", keys: "⇧↵ new line" };
  const { to } = extra;
  // While quoting, the placeholder suggests what to ask about the quote.
  const placeholder = extra.quoting ? "e.g. Check this against the tests and say what breaks"
    : busy ? (to ? `Queue for ${to}… (⌘↵ steers)` : "Queue a message… (⌘↵ steers)")
    : extra.tldr ? (to ? `TL;DR to ${to}: short answers` : "TL;DR mode: short answers")
    : to ? `Message ${to}…` : "Message the room…";
  if (busy) return { placeholder, hint: "@ who answers · ! which tools", keys: "↵ queue · ⌘↵ steer" };
  if (extra.firstMessage) return { placeholder, hint: "@all asks everyone · / for commands", keys: "↵ send · ⇧↵ new line" };
  return { placeholder, hint: "@ who answers · ! which tools", keys: "↵ send · ⇧↵ new line" };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/recipients.test.mjs tests/composer-status.test.mjs`
Expected: PASS, every test.

- [ ] **Step 6: Wire it into `ChatPane` and remove the line**

In `src/ChatPane.tsx`:

1. Line 3 becomes `import { REPLY_POLICIES } from "./ReplyPolicyPicker";`
2. Line 51 becomes `import { exampleRows, recipientName } from "./recipients";` (`hasMention` was only used for the old line's "you mentioned").
3. Delete the whole `lineFits` block (~524-536): the doc comment `/** False in a pane under 260px tall, ... */`, `const [lineFits, setLineFits] = useState(true);` and the `useEffect` that observes `.pane` and calls `setLineFits`. Keep `const root = useRef<HTMLDivElement>(null);` and its comment above it; later code uses `root`.
4. Cut the line `const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore, quoting: Boolean(reply) });` (~607). Keep `addressedBefore` where it is.
5. Replace the `const recipient = recipientLine({ ... });` statement (~1570-1577) with:

```tsx
  /** Who gets the message as it stands, for the placeholder. */
  const recipient = recipientName({
    targets: serverTargets,
    roster: participants.map((p) => ({ id: p.id, name: p.display_name })),
    policy: options.policy,
  });
  const copy = composerCopy(busy, participants.length === 0, { firstMessage: participants.length >= 2 && !addressedBefore, quoting: Boolean(reply), to: recipient, tldr });
```

6. Nothing reads `targetsText` any more, and `tsconfig.json` has `noUnusedLocals`, so delete it: its doc comment and `useState` line (~1559-1560), and in the `roomTargets` effect change `.then(ids => { if (live) { setServerTargets(ids); setTargetsText(outgoing); } })` to `.then(ids => { if (live) setServerTargets(ids); })`.
7. Delete the recipient line (~2417-2419):

```tsx
        {recipient && lineFits && <div className="recipient-line">
          To {recipient.to} · <ReplyPolicyPicker value={options.policy} label={recipient.reason} disabled={!ready || busy} onChange={policy => changeOptions({ ...options, policy })} />
        </div>}
```

8. On the textarea, change `placeholder={tldr ? "TL;DR mode: short answers" : copy.placeholder}` to `placeholder={copy.placeholder}`. Leave `aria-label="Message the room"` alone.

In `src/ReplyPolicyPicker.tsx`, delete the `ReplyPolicyPicker` function and any imports only it used; keep `REPLY_POLICIES` and its comment (Thread details' **Who answers** select still uses it). In `src/styles.css`, delete the `.recipient-line` rule and the `.reply-policy-trigger`, `.reply-policy-chevron` and `.reply-policy-menu` rules (~2069-2077).

- [ ] **Step 7: Run everything**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; the type check prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/recipients.ts src/composerStatus.ts src/ChatPane.tsx src/ReplyPolicyPicker.tsx src/styles.css tests/recipients.test.mjs tests/composer-status.test.mjs
git commit -m "feat: the message box says who gets the message, in place of the To line"
```

---

### Task 2: Artifacts and Changes move to the pane's top line

**Files:**
- Create: `src/fit.ts`
- Test: `tests/fit.test.mjs`
- Modify: `src/App.tsx` (~1081: a slot in the pane head of chat panes)
- Modify: `src/ChatPane.tsx` (`fitChips` ~348; the counts at ~2170; a head-fitting effect; two icons at the bottom of the file)
- Modify: `src/styles.css` (top-line rules; delete `.thread-chat .thread-counts` rules ~1761-1762)

**Interfaces:**
- Produces: `fitSteps<T extends string>(steps: readonly T[], apply: (step: T) => void, fits: () => boolean): T` in `src/fit.ts`.
- Produces (in `ChatPane.tsx`): `const CHIP_STEPS = ["full", "levels", "names"] as const;` used by `fitChips`. Task 4 adds `"faces"`.
- Produces (DOM): App renders `<span className="pane-counts" />` in every chat pane's `.pane-head`. ChatPane portals `.thread-counts` into it and sets `data-fit` on `.pane-head` to `full | compact | tight | min`.

- [ ] **Step 1: Write the failing test**

Create `tests/fit.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fitSteps } from "../src/fit.ts";

/** A row whose width depends on the step applied to it, in `room` pixels of space. */
const fitRow = (room, widths) => {
  const row = { step: null };
  const kept = fitSteps(Object.keys(widths), (step) => { row.step = step; }, () => widths[row.step] <= room);
  return { kept, applied: row.step };
};

test("a row keeps the most detail that fits", () => {
  const widths = { full: 600, levels: 450, names: 300, faces: 120 };
  assert.deepEqual(fitRow(700, widths), { kept: "full", applied: "full" });
  assert.deepEqual(fitRow(460, widths), { kept: "levels", applied: "levels" });
  assert.deepEqual(fitRow(200, widths), { kept: "faces", applied: "faces" });
});

test("when nothing fits, the last step stays applied", () => {
  assert.deepEqual(fitRow(50, { full: 600, faces: 120 }), { kept: "faces", applied: "faces" });
});

test("steps are tried in order and stop at the first that fits", () => {
  const tried = [];
  fitSteps(["full", "levels", "names"], (step) => tried.push(step), () => tried.at(-1) === "levels");
  assert.deepEqual(tried, ["full", "levels"]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/fit.test.mjs`
Expected: FAIL with a module-not-found error for `../src/fit.ts`.

- [ ] **Step 3: Write `src/fit.ts`**

```ts
// Rows that give up detail step by step until they fit their space: the bot
// badges in the message box, and the pane's top line.

/** Apply each step in order and keep the first that fits. When none fits, the last step stays applied. */
export function fitSteps<T extends string>(steps: readonly T[], apply: (step: T) => void, fits: () => boolean): T {
  for (const step of steps) {
    apply(step);
    if (fits()) return step;
  }
  return steps[steps.length - 1];
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --experimental-strip-types --test tests/fit.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Give the pane head a slot, and move the counts into it**

In `src/App.tsx`, after the line `{pane.kind === "chat" && <ModStatuses paneId={pane.id} />}` (~1081), add:

```tsx
                    {/* ChatPane puts Artifacts and Changes here. */}
                    {pane.kind === "chat" && <span className="pane-counts" />}
```

In `src/ChatPane.tsx`:

1. Add `import { fitSteps } from "./fit";` with the other local imports, and add `createPortal` to the existing `react-dom` import if it is not already there (it is used for Thread details, so it should be).
2. Replace `fitChips` (~347-353) with:

```ts
/** How much of each bot chip shows, most first. */
const CHIP_STEPS = ["full", "levels", "names"] as const;
/** How much of the pane's top line shows: then the count labels go, then the status words, then the server chip. */
const HEAD_STEPS = ["full", "compact", "tight", "min"] as const;
/** A thread title cut shorter than this makes the top line give up something else. */
const TITLE_ROOM = 150;

/** Show the most of each bot chip that lets the whole row fit: details, then usage levels, go first. Names alone may still scroll. */
function fitChips(row: HTMLElement) {
  fitSteps(CHIP_STEPS, (step) => { row.dataset.fit = step; }, () => row.scrollWidth <= row.clientWidth);
}

/** Give up words on the pane's top line until it fits and the title keeps its room. */
function fitHead(head: HTMLElement) {
  const title = head.querySelector<HTMLElement>(".pane-title");
  fitSteps(HEAD_STEPS, (step) => { head.dataset.fit = step; }, () =>
    head.scrollWidth <= head.clientWidth && (!title || title.scrollWidth <= title.clientWidth || title.clientWidth >= TITLE_ROOM));
}
```

3. Right after the `chipRow` effects (~1466-1481), add:

```tsx
  // Artifacts and Changes sit on the pane's top line, in the slot App leaves for them.
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeadSlot(root.current?.closest(".pane")?.querySelector<HTMLElement>(".pane-head .pane-counts") ?? null);
  }, []);
  // The top line refits when the pane resizes or anything on it changes: counts, status words, the server chip.
  useEffect(() => {
    const head = headSlot?.closest<HTMLElement>(".pane-head");
    if (!head) return;
    fitHead(head);
    const resized = new ResizeObserver(() => fitHead(head));
    resized.observe(head);
    // Only text and children: fitting sets an attribute, which must not trigger another fit.
    const changed = new MutationObserver(() => fitHead(head));
    changed.observe(head, { childList: true, characterData: true, subtree: true });
    return () => { resized.disconnect(); changed.disconnect(); };
  }, [headSlot]);
```

4. Replace the `{!profileMode && <div className="thread-counts">...</div>}` line (~2170) with nothing, and add this just before the `return (` of the component (next to `allowedList`):

```tsx
  const changedFiles = new Set(changes.map((c) => c.change.path)).size;
  const newArtifacts = unseenArtifacts > 0 && !panel;
  // Labels hide on a crowded top line, so each button names itself for screen readers.
  const threadCounts = (
    <div className="thread-counts">
      {artifacts.artifacts.length > 0 && <button key={artifactGlow || undefined} className={`ghost small${panel ? " on" : ""}${artifactGlow ? " artifact-glow" : ""}`} aria-pressed={panel !== null} aria-label={`Artifacts · ${artifacts.artifacts.length}${newArtifacts ? `, ${unseenArtifacts} new` : ""}`} title="Artifacts" onClick={() => setPanel((view) => (view ? null : DEFAULT_VIEW))}>
        <ArtifactsIcon /><span className="count-label">Artifacts · </span>{artifacts.artifacts.length}{newArtifacts && <span className="new-dot" aria-hidden="true" />}
      </button>}
      {changes.length > 0 && <button className="ghost small" aria-label={`Changes · ${changedFiles}`} title="Changes" onClick={() => { details?.show("changes"); loadDiff(); }}>
        <ChangesIcon /><span className="count-label">Changes · </span>{changedFiles}
      </button>}
    </div>
  );
```

5. Inside the returned `<div ref={root} ...>`, next to the Thread details portal line (~2114), add:

```tsx
      {!profileMode && headSlot && createPortal(threadCounts, headSlot)}
```

6. At the bottom of the file, next to `TrashIcon`, add:

```tsx
function ArtifactsIcon() {
  return <svg className="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 14l-2 2 2 2m6-4 2 2-2 2" /></svg>;
}

function ChangesIcon() {
  return <svg className="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8" /></svg>;
}
```

In `src/styles.css`, delete `.thread-chat .thread-counts { ... }` and `.thread-chat .thread-counts button { ... }` (~1761-1762). Keep `.thread-counts .on` (~2324). Add, next to the `.pane-head .pane-title` rule (~2125):

```css
/* Artifacts and Changes, on the pane's top line before the window buttons (ChatPane portals them in). */
.pane-counts { display: contents; }
.pane-head .thread-counts { display: flex; flex: none; gap: 4px; }
.pane-head .thread-counts button { white-space: nowrap; font-size: 11px; line-height: 1.4; }
.count-icon { display: none; margin-right: 4px; vertical-align: -2px; }
/* ChatPane picks data-fit. A crowded top line gives up, in order: the count labels, the status words, then the server chip. */
.pane-head:is([data-fit="compact"], [data-fit="tight"], [data-fit="min"]) .count-label { display: none; }
.pane-head:is([data-fit="compact"], [data-fit="tight"], [data-fit="min"]) .count-icon { display: inline-block; }
.pane-head:is([data-fit="tight"], [data-fit="min"]) .pane-folder { display: none; }
.pane-head[data-fit="min"] .server-chip { display: none; }
```

- [ ] **Step 6: Run everything**

Run: `npm test && npx tsc --noEmit`
Expected: all pass; the type check prints nothing.

- [ ] **Step 7: Check it in the browser preview**

Run `npm run dev` in the background and open http://localhost:5173 (the browser uses the demo backend). Open a thread with artifacts and changes (or create some in the demo). Check:
- **Artifacts · N** and **Changes · N** sit on the top line just before □, and the old row under the head no longer has them.
- Clicking each opens its panel. Pressing on them does not pick the pane up. Dragging the head by its empty space still moves the pane.
- With two or three panes side by side, the labels become icon + number first, then the "3 bots" words go, and the title keeps its room.
- A new artifact still shows the dot.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add src/fit.ts tests/fit.test.mjs src/App.tsx src/ChatPane.tsx src/styles.css
git commit -m "feat: Artifacts and Changes move up to the pane's top line"
```

---

### Task 3: The bots move into the message box

**Files:**
- Create: `src/floating.ts`
- Test: `tests/floating.test.mjs`
- Modify: `src/ChatPane.tsx` (the chip row ~2115-2171 becomes `botChips`; the composer ~2391-2477; `rosterAnchor` ~457 and ~2108; `usageCard` ~1747; a hover helper)
- Modify: `src/BotSettings.tsx:32`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `CHIP_STEPS`, `fitChips`, `chipRow` from Task 2 (unchanged); `copy` from Task 1.
- Produces: `aboveAnchor(anchor: { left: number; top: number }, viewport: { width: number; height: number }, width: number, gap?: number): { left: number; bottom: number }` and `popoverTop(anchor: { top: number; bottom: number }, height: number, viewportHeight: number, gap?: number): number` in `src/floating.ts`.
- Produces (in `ChatPane.tsx`): `const botChips: JSX.Element`. Task 4 edits the chip markup inside it. DOM: `.composer-box > .composer-field + .composer-dock`, and `.composer-dock > .composer-tools, .chips, .dock-spacer, .tldr-pill, .round-send`.

- [ ] **Step 1: Write the failing test**

Create `tests/floating.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { aboveAnchor, popoverTop } from "../src/floating.ts";

const window = { width: 1200, height: 800 };

test("a card opens above its badge, in line with it", () => {
  assert.deepEqual(aboveAnchor({ left: 100, top: 700 }, window, 340), { left: 100, bottom: 106 });
  assert.deepEqual(aboveAnchor({ left: 100, top: 700 }, window, 330, 8), { left: 100, bottom: 108 });
});

test("a card by the right edge moves left to stay on screen", () => {
  assert.equal(aboveAnchor({ left: 1000, top: 700 }, window, 340).left, 852);
});

test("a card wider than the window keeps its left edge on screen", () => {
  assert.equal(aboveAnchor({ left: 50, top: 700 }, { width: 300, height: 800 }, 340).left, 8);
});

test("bot settings open below the badge when there is room", () => {
  assert.equal(popoverTop({ top: 100, bottom: 130 }, 300, 800), 136);
});

test("bot settings open above a badge at the bottom of the window", () => {
  assert.equal(popoverTop({ top: 700, bottom: 730 }, 300, 800), 394);
});

test("bot settings taller than the room on either side stay on screen", () => {
  assert.equal(popoverTop({ top: 200, bottom: 230 }, 700, 800), 8);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/floating.test.mjs`
Expected: FAIL with a module-not-found error for `../src/floating.ts`.

- [ ] **Step 3: Write `src/floating.ts`**

```ts
// Where a popover goes beside the element that opened it, kept on screen.
// The bot badges sit at the bottom of the pane, so their cards open upward.

/** Space kept between a popover and the window's edge. */
const MARGIN = 8;

/** Fixed-position offsets for a popover `width` wide that opens above `anchor`: its left edge in line with the anchor's, moved left to stay on screen. */
export function aboveAnchor(anchor: { left: number; top: number }, viewport: { width: number; height: number }, width: number, gap = 6): { left: number; bottom: number } {
  return {
    left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN)),
    bottom: viewport.height - anchor.top + gap,
  };
}

/** The top of a popover `height` tall: below `anchor` when it fits there, otherwise above it, and always on screen. */
export function popoverTop(anchor: { top: number; bottom: number }, height: number, viewportHeight: number, gap = 6): number {
  const below = anchor.bottom + gap;
  const top = below + height + MARGIN <= viewportHeight ? below : anchor.top - gap - height;
  return Math.max(MARGIN, Math.min(top, viewportHeight - height - MARGIN));
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --experimental-strip-types --test tests/floating.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Make the popovers open upward**

In `src/BotSettings.tsx`, add `import { popoverTop } from './floating';` and change line 32 to:

```ts
    setPosition({ top: popoverTop(rect, height, window.innerHeight), left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
```

In `src/ChatPane.tsx`:

1. Add `import { aboveAnchor } from "./floating";` with the local imports. Near `NARROW_PX` (~345), add:

```ts
/** The widest a bot's usage card gets (.usage-card max-width). */
const USAGE_CARD_WIDTH = 340;
/** The Add bot form's width (.quick-add). */
const QUICK_ADD_WIDTH = 330;
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
```

2. Change `rosterAnchor` (~457) to `useState<{ left: number; bottom: number } | null>(null)`, and its render (~2108) to `style={{ left: rosterAnchor.left, bottom: rosterAnchor.bottom }}`.
3. Under `const [card, setCard] = useState<string | null>(null);` (~397), add:

```tsx
  /** Where the hovered bot's usage card sits: above its badge, at the bottom of the pane. */
  const [cardAt, setCardAt] = useState<{ left: number; bottom: number } | null>(null);
  const hoverCard = (id: string, badge: HTMLElement) => { setCard(id); setCardAt(aboveAnchor(badge.getBoundingClientRect(), viewport(), USAGE_CARD_WIDTH)); };
```

4. Change `usageCard` (~1747) to take where it floats. The signature becomes `const usageCard = (p: ParticipantConfig, at?: { left: number; bottom: number } | null) => {` and its root element becomes:

```tsx
      <div className={at ? "usage-card above" : "usage-card"} style={at ? { left: at.left, bottom: at.bottom } : undefined} role="group" aria-label={`Usage for ${p.display_name}`}>
```

Thread details' call `usageCard(p)` (~2084) stays as it is.

- [ ] **Step 6: Build the bot row as `botChips` and drop the old row**

Cut the whole `<div className="chat-bar">...</div>` block (~2115-2171) out of the returned markup. Put this back in its place, so the Agents section keeps its row exactly as before:

```tsx
      {profileMode && <div className="chat-bar"><div className="chips">{(participants.length > 0 || adding) && addButton}</div></div>}
```

Above `return (` (next to `threadCounts`), define `botChips` from the chips you cut. Keep each chip's inner markup exactly as it was (the `<span className="chip" ...>` and its button are unchanged in this task). Only the wrapper handlers, the usage card call and the Add bot click change:

```tsx
  // The bots ride in the message box's bottom row, between + and TL;DR.
  const botChips = (
    <div ref={chipRow} className="chips">
      {participants.map((p) => {
        const levels = levelsFor(p.id);
        return (
        <span
          className="chip-wrap"
          key={p.id}
          onMouseEnter={(e) => hoverCard(p.id, e.currentTarget)}
          onMouseLeave={() => setCard((open) => (open === p.id ? null : open))}
          onFocus={(e) => hoverCard(p.id, e.currentTarget)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCard((open) => (open === p.id ? null : open)); }}
          onKeyDown={(e) => { if (e.key === "Escape") setCard(null); }}
        >
        {/* <span className="chip" ...> ... </span> exactly as cut, including the chip-name button and everything inside it */}
        {card === p.id && !quickSettings && usageCard(p, cardAt)}
        </span>
        );
      })}
      {participants.length > 0 && (
        <span className="quick-add-wrap roster">
          <button className="chip-add" disabled={!ready} aria-label="Add a bot" title="Add a bot" aria-haspopup="dialog" aria-expanded={quickAdd === "roster"} onClick={(e) => { if (availablePresets.length === 0 && availableProfiles.length === 0) { details?.show("form"); setAdding(true); } else { setRosterAnchor(aboveAnchor(e.currentTarget.getBoundingClientRect(), viewport(), QUICK_ADD_WIDTH, 8)); openQuickAdd("roster"); } }}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </span>
      )}
    </div>
  );
```

(The JSX comment line above is an instruction, not code: paste the cut `<span className="chip" style={{ borderColor: color(p.id) }}>...</span>` there.)

- [ ] **Step 7: Rebuild the composer around one box**

Replace the composer's inside, from `<div className="composer-input">` to the closing `</div>` of `composer-actions`, so it reads:

```tsx
        <div className="composer-input">
        {/* quote preview: unchanged */}
        {/* attachments: unchanged */}
        <div className="composer-box" ref={field}>
          <div className="composer-field">
            {/* <textarea ... /> unchanged from Task 1 */}
          </div>
          <div className="composer-dock">
            {/* <ComposerMenu ref={composerMenu} ... /> unchanged, moved here from composer-field */}
            {botChips}
            <span className="dock-spacer" />
            {/* <button type="button" className="tldr-pill" ...>...</button> unchanged, moved here */}
            {/* the busy ? Stop : Send buttons, unchanged, moved here from composer-actions */}
          </div>
        </div>
        {/* unknownServers line: unchanged */}
        <div className="composer-hint">{!busy && <span className="hint-text">{copy.hint}</span>}<span className="send-key" aria-hidden="true">{copy.keys}</span></div>
        </div>
```

(The JSX comments mark elements to move unchanged; do not leave the comments in the code.) `.composer-actions` is gone. `field` now points at `.composer-box`, so a TL;DR send wiggles the whole box.

- [ ] **Step 8: Restyle**

In `src/styles.css`:

1. Delete `.thread-chat .chat-bar { ... }` and `.thread-chat .chips { ... }` (~1757-1758). Keep `.thread-chat .chip-wrap`, `.thread-chat .chip-name` and the two `.thread-chat .chips[data-fit=...]` rules.
2. Delete every `.composer-actions` rule (~1717, ~1789, ~1980, ~1996, and `.composer-actions { position: relative; }` ~2370). In ~1997 delete only the `.composer-actions > button, ` selector. If nothing is left, delete the rule.
3. Change ~1992 to `.composer-field { align-items: flex-end; }` and delete ~1993 (`.composer-field:focus-within`).
4. Rename the TL;DR selectors (~2420-2440): `.composer.tldr .composer-field` → `.composer.tldr .composer-box` (both selectors in that rule), `.composer.tldr .composer-field > textarea::placeholder` → `.composer.tldr .composer-box textarea::placeholder`, and every `.composer-field > .tldr-pill` → `.composer-dock > .tldr-pill`.
5. Rename `.composer-actions > button.round-send` (~2362-2366) to `.composer-dock > button.round-send`, and make it 30px: `width: 30px; height: 30px; min-width: 30px; min-height: 30px; max-height: 30px;`.
6. Replace the send-key rules (~2371-2372) with:

```css
.send-key { display: none; margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
.composer:focus-within .send-key { display: inline; }
```

7. In the narrow-window media query (~1046), change `.composer-hint > span:last-child { display: none; }` to `.composer-hint .hint-text { display: none; }`. It still hides the hint and keeps the keys, as before.
8. Add after the `/* Composer: one rounded box ... */` block (~2002):

```css
/* The message box: the text on top, then one row of +, the bots, TL;DR and Send. */
.composer-box { display: flex; flex-direction: column; gap: 2px; padding: 2px 6px 5px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); }
.composer-box:focus-within { border-color: var(--accent); }
.composer-dock { display: flex; align-items: center; gap: 4px; min-width: 0; }
.composer-dock .composer-plus { width: 28px; height: 28px; font-size: 21px; }
.composer-dock .chips { flex: 0 1 auto; min-width: 0; flex-wrap: nowrap; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.composer-dock .chip-name { padding: 2px 8px 2px 3px; font-size: 12px; }
.composer-dock .chip-meta { font-size: 11px; }
.composer-dock .dock-spacer { flex: 1; min-width: 4px; }
/* A badge's usage card floats above it, so the row's overflow never clips it. */
.usage-card.above { position: fixed; top: auto; }
.usage-card.above::before { inset: auto 0 -7px; }
.quick-add-wrap.roster-pop .quick-add { top: auto; bottom: 0; }
```

and change the existing `.quick-add-wrap.roster-pop .quick-add { top: 0; left: 0; }` (~1947) to `.quick-add-wrap.roster-pop .quick-add { left: 0; }` so the new rule sets the vertical position.

- [ ] **Step 9: Run everything, then check it in the browser**

Run: `npm test && npx tsc --noEmit`
Expected: all pass; the type check prints nothing.

Then run `npm run dev` in the background, open http://localhost:5173, and open a thread with three bots. Check:
- The row under the pane head is gone. The box holds the text on top, and **+**, the three badges, the **+** add button, TL;DR and Send underneath.
- Hovering a badge shows its usage card **above** it, fully on screen, including the rightmost badge of the right-hand pane.
- Clicking a badge opens Model and Reasoning above it, fully on screen.
- The add button opens the Add bot form above it, fully on screen, also in a short window.
- **+** opens its menu above the box. Typing `/`, `@` and `!` opens their menus. Arrow keys and Enter pick from them.
- ⌘⇧T toggles TL;DR and the glowing border goes around the whole box. Sending in TL;DR wiggles the whole box.
- With a bot working, the Stop button replaces Send and Esc stops it. Pasting an image attaches it.
- The Agents section looks the same as on `main`.

Stop the dev server when done.

- [ ] **Step 10: Commit**

```bash
git add src/floating.ts tests/floating.test.mjs src/BotSettings.tsx src/ChatPane.tsx src/styles.css
git commit -m "feat: a thread's bots sit in the message box, under the text"
```

---

### Task 4: Lit badges, Add bot, and avatars-only on narrow panes

**Files:**
- Modify: `src/ChatPane.tsx` (`CHIP_STEPS`; the chip markup inside `botChips`; the add button; a `PersonPlus` icon; the `react` import at line 19)
- Modify: `src/styles.css`
- Modify: `desktop/smoke.mjs` (a new step before `'quitting while an agent replies asks first'`)

**Interfaces:**
- Consumes: `botChips`, `chipRow`, `CHIP_STEPS` (Tasks 2-3); `serverTargets` (existing state in `ChatPane`).
- Produces (DOM): `.chip.to` on badges that get the message; `--who` custom property on each `.chip`; `.chip-label` around each bot's name; `.chip-add-label` inside the add button; `.chips[data-fit="faces"]`.

- [ ] **Step 1: Write the failing smoke check**

In `desktop/smoke.mjs`, add this step just before `await step('quitting while an agent replies asks first', ...)`:

```js
  await step('two threads side by side keep every bot and Add bot in view', async () => {
    const bots = ['reviewer-with-a-long-name', 'planner-with-a-long-name', 'implementer-long-name'].map((id) => shell(id, 'true'));
    await page(`
      await __deck.backend.roomCreate('smoke-bots-a', ${JSON.stringify(bots)}, ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.roomCreate('smoke-bots-b', ${JSON.stringify(bots)}, ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.sessionSave({
        version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: '/tmp' }],
        panes: [
          { id: 'smoke-bots-a', workspaceId: 'ws-smoke', kind: 'chat', title: 'Bots A' },
          { id: 'smoke-bots-b', workspaceId: 'ws-smoke', kind: 'chat', title: 'Bots B' },
        ],
        profiles: [], activeWorkspace: 'ws-smoke', focusedPane: 'smoke-bots-a', section: 'threads', layout: 'top',
      });
      return true;`);
    contents.reload();
    await sleep(200);
    await ready();
    // What is wrong with the message boxes right now, or '' when nothing is.
    const problems = () => page(`
      const panes = [...document.querySelectorAll('.pane')].filter((p) => p.offsetWidth > 0 && p.querySelector('.composer'));
      if (panes.length !== 2) return panes.length + ' thread pane(s) showing, not 2';
      const found = [];
      for (const pane of panes) {
        const name = pane.querySelector('.pane-title')?.textContent;
        if (pane.querySelector('.thread-chat > .chat-bar')) found.push(name + ': the old bot row is still there');
        const placeholder = pane.querySelector('.composer textarea').placeholder;
        if (!placeholder.startsWith('Message ')) found.push(name + ': the placeholder says ' + JSON.stringify(placeholder));
        const row = pane.querySelector('.composer-dock .chips');
        const seats = [...pane.querySelectorAll('.composer-dock .chip'), pane.querySelector('.composer-dock .chip-add')];
        if (!row || seats.length !== 4 || seats.includes(null)) { found.push(name + ': ' + seats.filter(Boolean).length + ' of 3 bots and Add bot in the message box'); continue; }
        const box = row.getBoundingClientRect();
        const cut = seats.filter((seat) => { const r = seat.getBoundingClientRect(); return r.width === 0 || r.left < box.left - 1 || r.right > box.right + 1; });
        if (cut.length) found.push(name + ': ' + cut.length + ' badge(s) cut off');
      }
      return found.join('; ');`);
    const [width, height] = win.getContentSize();
    try {
      // 900 is the window's minimum width (desktop/main.mjs).
      for (const w of [1600, 1200, 900]) {
        win.setContentSize(w, height);
        let problem = '';
        await until(`the message boxes at ${w}px`, async () => (problem = await problems()) === '', 5_000)
          .catch(() => { throw new Error(`at ${w}px: ${problem}`); });
      }
    } finally {
      win.setContentSize(width, height);
    }
  });
```

- [ ] **Step 2: Run the smoke checks to see this one fail**

Run: `npm run desktop:smoke`
Expected: the earlier steps print `smoke: ok`, then this step fails with `at 900px: Bots A: 1 badge(s) cut off` (or more), because names cannot shrink away yet. The first run compiles `apex-daemon` in this folder, which takes several minutes. If it instead fails with `1 thread pane(s) showing, not 2`, the layout put the panes on top of each other: open `src/layout.ts` (`sync`), see how two panes of one workspace are placed, and save a matching `layout` in the session above. The smoke window is hidden; the Preview smoke step shows `ResizeObserver` still runs there. If, after Task 4, this step still times out at every width with the badges unfitted, wrap the loop in `win.showInactive()` … `win.hide()` so the window lays itself out, and say so in the hand-over.

- [ ] **Step 3: Light the badges that get the message, and add the faces step**

In `src/ChatPane.tsx`:

1. Line 19: add `type CSSProperties, ` at the start of the `react` import's braces.
2. `CHIP_STEPS` becomes `["full", "levels", "names", "faces"] as const`, and `fitChips`'s doc comment becomes `/** Show the most of each bot chip that lets the whole row fit: details go first, then usage levels, then names. The avatars always stay. */`.
3. On the line just above `const botChips = (`, add `/** The bots the message goes to, as the room last answered. */` and `const lit = new Set(serverTargets);`. Then change the chip's opening tag from `<span className="chip" style={{ borderColor: color(p.id) }}>` to:

```tsx
            <span className={lit.has(p.id) ? "chip to" : "chip"} style={{ "--who": color(p.id) } as CSSProperties}>
```

4. On the chip-name button, change `title={`Model and reasoning for ${p.display_name}`}` to:

```tsx
title={lit.has(p.id) ? `${p.display_name} gets your message · model and reasoning` : `Model and reasoning for ${p.display_name}`}
```

5. Wrap the bare `{p.display_name}` inside the chip-name button as `<span className="chip-label">{p.display_name}</span>`.

- [ ] **Step 4: Make Add bot a person-plus**

In `botChips`, change the add button's `aria-label="Add a bot" title="Add a bot"` to `aria-label="Add bot" title="Add bot"`, and replace its plus `<svg>` with:

```tsx
            <PersonPlus /><span className="chip-add-label">Add bot</span>
```

At the bottom of the file, next to `TrashIcon`, add:

```tsx
function PersonPlus() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M19 8v6M16 11h6" /></svg>;
}
```

- [ ] **Step 5: Style them**

In `src/styles.css`, after the `.composer-dock` rules from Task 3, add:

```css
/* Each badge is outlined in its bot's colour; the bots your message goes to are lit. */
.composer-dock .chip { border-color: color-mix(in srgb, var(--who) 30%, var(--line)); transition: background-color .15s, border-color .15s; }
.composer-dock .chip.to { border-color: var(--who); background: color-mix(in srgb, var(--who) 13%, transparent); }
/* Adding a bot is an empty seat with a person-plus, so it never reads as the attach button's +. */
.composer-dock .quick-add-wrap.roster { flex: none; display: inline-flex; }
.composer-dock .chip-add { width: auto; height: 23px; gap: 4px; margin-left: 2px; padding: 0 8px 0 6px; display: inline-flex; align-items: center; border: 1px dashed color-mix(in srgb, var(--muted) 55%, transparent); border-radius: 999px; font-size: 12px; }
.composer-dock .chip-add:hover:not(:disabled), .composer-dock .chip-add[aria-expanded="true"] { border-style: solid; }
.chips:not([data-fit="full"]) .chip-add-label { display: none; }
.chips:not([data-fit="full"]) .chip-add { padding: 0 5px; }
/* The narrowest step: the avatar and its status dot, with the name in the tooltip. */
.thread-chat .chips[data-fit="faces"] .chip-meta, .thread-chat .chips[data-fit="faces"] .chip-label { display: none; }
.thread-chat .chips[data-fit="faces"] .chip-name { gap: 3px; padding: 2px 5px 2px 2px; }
```

- [ ] **Step 6: Run everything, including the smoke checks**

Run: `npm test && npx tsc --noEmit && npm run desktop:smoke`
Expected: all unit tests pass, the type check prints nothing, and every smoke step prints `smoke: ok`, including `two threads side by side keep every bot and Add bot in view`.

- [ ] **Step 7: Check the lighting in the browser**

Run `npm run dev` in the background and open http://localhost:5173 with a three-bot thread. Check:
- With the box empty, the badge named in the placeholder is lit.
- Typing `@null` lights Null only. Typing `@all` lights all three. Deleting the mention goes back to the default.
- In Thread details, setting **Who answers** to *Everyone at once* lights all three with the box empty, and the placeholder says `Message everyone…`.
- In a wide pane the add button reads **Add bot** with the person icon. In narrow panes it shows the icon only, and the badges drop to avatars. Hovering an avatar still names the bot.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add src/ChatPane.tsx src/styles.css desktop/smoke.mjs
git commit -m "feat: badges light up for whoever gets your message, and Add bot gets its own icon"
```

---

### Task 5: Check the whole branch and show the result

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run every check from a clean state**

```bash
cd ~/Downloads/apex-deck-composer && git status --short && npm test && npx tsc --noEmit && npm run desktop:smoke
```
Expected: `git status --short` prints nothing, every unit test passes, the type check prints nothing, and every smoke step prints `smoke: ok`. Note the unit test count in the hand-over (`main` had 461).

- [ ] **Step 2: Walk the Review Focus list in the browser preview**

Run `npm run dev` in the background, open http://localhost:5173, and go through all five Review Focus items above at 1, 2 and 3 panes. Take a screenshot of each pane count with the **Proposed** layout. Stop the dev server when done.

- [ ] **Step 3: Compare against the mockup**

Open `~/Downloads/apex-deck/.superpowers/mockups/composer-bots-jigga.html`, switch to **Proposed**, and put it next to the screenshots. The intended differences are: the simpler placeholder (`Message Jigga…`), the person-plus **Add bot**, and no This Mac / Apex-Terminal label. Anything else that differs is a bug to fix before handing over.

- [ ] **Step 4: Hand over**

Report to the group with the screenshots, the test counts and the smoke output. Clean up anything temporary the checks created (dev servers, browser profiles in `/tmp`). Do not merge or push. The human decides that.
