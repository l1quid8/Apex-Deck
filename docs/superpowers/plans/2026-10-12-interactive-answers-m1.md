# Interactive Answers, Milestone 1: the Comparison Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot can end a reply with a comparison card the person can adjust. The card's settings survive a restart and follow forks and moves, and the person can share them back to the room as a visible message.

**Architecture:** A card is a fenced `apex-ui` JSON block at the end of an ordinary reply. The frontend checks it against a strict schema (`schema.ts`), works out results with two app-owned rule types (`comparison.ts`), and draws it natively (`AnswerCard.tsx`) through a new `fence` prop on `Markdown.tsx`. Settings a person changes are saved per card by the host in `rooms/<hex id>.answers.json`, with revision checks (`answers_load`, `answer_save`), behind a debounced client store (`answerStore.ts`). "Discuss these settings" puts a plain-text snapshot in the message box; sending it goes through the thread's normal routing. An app-wide setting, "Interactive answers" (off by default), adds the card format to every bot's instructions.

**Tech Stack:** React 19 + TypeScript 7 (`tsc --noEmit`), `node --test --experimental-strip-types`, sucrase-compiled component tests, Rust (apex-core, apex-host, apex-daemon), serde_json.

**Spec:** The design agreed in the thread on 2026-10-12 (Null's plan, Luna's review, and the human's go), condensed under "Decisions" below. Visual reference: `mockups/intelligent-ui/threads-comparison.html`. Names shared by both tracks: `src/interactiveAnswers/contract.ts`, committed with this plan. Read it before your first task.

**Checked before handoff:** Jigga applied every code block below to a throwaway copy of `cba01a8`. `tsc --noEmit` passed; `npm test` ran 1282 tests and failed only the 11 already failing on `main`; `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon` passed in full. If a step doesn't behave as written, say so in the chat rather than working around it quietly.

## Global Constraints

- Branch `feat/intelligent_ui`, in its own worktree folder (`apex-deck-worktrees/feat-intelligent_ui`). Build and edit only there. Don't push, merge, install the app, restart the Mac service, or touch the VPS.
- Two bots work in this folder at once. Stage files by path only. Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout -- <path>`, `git restore`, or `git reset --hard`. Run `git status` before every commit. If a file you own has changes you didn't make, stop and ask in the chat.
- Edit only the files your track owns (see "Ownership and order"). If you need a change in the other track's file, ask for it in the chat.
- Every commit leaves `npm run build` passing and adds no `npm test` failures. Commit one task at a time. If git says the index is locked, wait a few seconds and try again.
- Run Rust tests as `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon`. A Deck pane's long TMPDIR breaks the Unix-socket tests.
- Fence language `apex-ui`, `schemaVersion` 1, and the only `kind` is `comparison`.
- Card limits: source ≤ 16,000 characters; ids match `^[a-z0-9][a-z0-9_-]{0,39}$`; title ≤ 80; summary ≤ 280; labels ≤ 40; option note ≤ 120; text values ≤ 80; units ≤ 8; 0–4 inputs; 2–6 choice options; 1–12 rows; 2–6 options; 0–6 rules, at most one `rankBy`; 0–6 assumptions, each ≤ 200; 0–6 sources with http(s) URLs ≤ 300. A range needs min < max, step > 0, at most 1,000 stops, and a default between min and max.
- A card is data only. No HTML, scripts, formulas, commands, or network requests. All card text renders as plain text. Source links open through the chat's existing `onOpen`.
- Saved-settings file `rooms/<hex id>.answers.json`. Commands `answers_load { room }` (read tier, thread) and `answer_save { room, key, fingerprint, inputs, revision }` (chat tier, thread).
- Settings key `interactiveAnswers`, default off. It only controls what bots are told. Cards in replies always render.
- Exact words: "Discuss these settings", "Reset", "Preparing interactive answer…", "Best fit", the setting label "Interactive answers".
- `ChatPane.tsx` and `PhoneApp.tsx` get wiring only. Logic lives in `src/interactiveAnswers/`.
- Never put absolute home-folder paths in committed files. The repo is public.

## Decisions (the spec, condensed)

1. A card goes after the written answer. The written answer must make sense without it.
2. Checking is strict about known fields and ignores unknown ones. A newer `schemaVersion` or `kind` shows "needs a newer Apex Deck" instead of a card.
3. Results come from two app-owned rule types. Limits (`atMost`/`atLeast` against a range input) put options out. Ranking (`rankBy` on a choice input) orders the options that are left. Best fit is the top-ranked option that fits; ties keep the card's order. Models never write formulas.
4. The author and message come from the transcript, never from the JSON.
5. Version: a card is vN when N − 1 bot cards with the same `cardId` came before it in the thread. Revising means a later reply reuses the `cardId`. Older versions stay where they are.
6. While a reply is still streaming, an `apex-ui` block shows "Preparing interactive answer…" and no controls.
7. Changing a setting never calls a model. The setting is saved in the thread (it survives restart, fork, and move), but bots see it only when the person discusses it.
8. "Discuss these settings" puts a snapshot in the message box, under anything already typed: the card's title, version, and author, each setting, and the result. Nothing is sent until the person presses Send, and the thread's usual reply rules decide who answers.
9. Two windows changing one card: the host refuses a save made from an older revision. That window then shows the newer settings with "Another window changed this card, so your last change wasn't saved." Nothing is ever overwritten silently.
10. Markdown and PDF exports print each card as a short summary plus a table, at its saved settings. The JSON export keeps the reply exactly as written.
11. Phone, this milestone: the card shows read-only at its defaults, with no Discuss button. The phone needs a rebuild to show it at all.
12. Bots learn the format only while Settings → Interactive answers is on.

Deliberate differences from the mockup: the shared snapshot shows as ordinary message text (no special box), and there are no "Preview streaming" or sample-reply buttons.

**Not in this milestone:** chart and calculator cards; an expanded full-pane view; a New version button; live sync of settings between open windows; Discuss and saved settings on the phone; styled snapshot boxes; any action outside the card.

## Review Focus

1. **A half-written card while a reply streams.** Expected: the placeholder, never raw JSON, an error, or live controls. Pinned by A3 (`PreparingCard` has no controls) and A5 (the drafts' `fence` draws `PreparingCard`; wiring test).
2. **A broken, oversized, unsupported, or crashing card in a finished reply.** Expected: a readable fallback with the data tucked away, while the rest of the reply and the chat keep working. Pinned by A1 (every reason), A3 (fallback and the error boundary).
3. **Saved settings that no longer fit their card.** A rewind or fork reused the message number, the card changed, a value is out of range, or an option is unknown. Expected: ignored, clamped, or set back to the default; never a crash. Pinned by the contract fingerprint test, A2 `resolveInputs`, A3 (fingerprint check in `ThreadCard`), and B1 (`values()`).
4. **Two windows editing one card.** Expected: nothing is overwritten silently, including a change made while the refused save was on its way. Pinned by B1 (two clash tests) and B2 (revision refusal in Rust).
5. **A slider dragged fast, then the thread closed.** Expected: one save after the drag, with the last value, and anything still waiting saved on close. Pinned by B1 (debounce and flush tests) and A5 (`store.flush()` on unmount).

## Baseline (clean `cba01a8`, before any change)

- `npm run build`: passes.
- `npm test`: 1234 tests, 11 fail. All are already on `main`: ten in `tests/monitor-attention-integration.test.mjs` plus "a rendered sidebar chat drag carries its owning folder and machine". They aren't ours; leave them alone.
- `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon --no-fail-fast`: everything passes except `apex-host command::tests::names_lists_every_command`. It expects 133 commands, but `main` has 134 (`persona_draft` was added without updating it). Task B2 sets the count to 136 and fixes it.

## Ownership and order

| Track | Owner | Tasks | Files |
|---|---|---|---|
| A: the card | **Muck** | A1 → A2 → A3 → A4 → A5 | `src/interactiveAnswers/{schema,comparison,share}.ts`, `src/interactiveAnswers/{AnswerCard,ThreadCard}.tsx`, `src/interactiveAnswers/answer-card.css`, `src/markdownText.ts`, `src/Markdown.tsx`, `src/exportThread.ts`, `src/ChatPane.tsx`, `src/phone/PhoneApp.tsx`, `tests/interactive-answers-*.mjs`, `tests/markdown.test.mjs`, `tests/markdown-fence.test.mjs`, `tests/export-cards.test.mjs` |
| B: saved settings and bot instructions | **Null** | B1 → B2 → B3 → B4 | `src/interactiveAnswers/answerStore.ts`, `src/backend.ts`, `src/commandBackend.ts`, `src/hostBackends.ts`, `src/threadMove.ts`, `src/settings.ts`, `src/SettingsPage.tsx`, `crates/apex-core/src/{view,room}.rs`, `crates/apex-host/src/{storage,command,host,documents}.rs`, `crates/apex-host/tests/host.rs`, `crates/apex-daemon/src/authority.rs`, `tests/answer-store.test.mjs`, `tests/answer-guidance.test.mjs`, `tests/command-backend.test.mjs`, `tests/thread-move.test.mjs`, `tests/settings.test.mjs` |
| Shared | Jigga | — | `src/interactiveAnswers/contract.ts` (change only by agreement in the chat) |

Waiting points: **A5 needs B1 committed** (it imports `createAnswerStore`). **B4's guidance test needs A1 committed** (it imports `schema.ts` and the test fixture). Nothing else waits.

After each commit, post in the chat: `@jigga <task> done: <sha> <one line>`. Jigga reviews each task (spec first, then code quality) and posts findings. Fix must-fix items before your next task. When you need something from the other track, @ them directly.

---

## Track A: the card (Muck)

### Task A1: Card format and checking

**Files:**
- Create: `src/interactiveAnswers/schema.ts`
- Create: `tests/interactive-answers-fixture.mjs` (shared test data, not a test itself)
- Test: `tests/interactive-answers-schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_VERSION = 1`, `MAX_CARD_CHARS = 16_000`; types `RangeInput`, `ChoiceInput`, `CardInput`, `CardRow`, `CardOption`, `CardRule`, `RankRule`, `CardSource`, `ComparisonCard`, `CardRead`; `readCard(source: string): CardRead`. The fixture exports `EXAMPLE` (the card object), `source` (its JSON text), and `variant(change)` (an edited copy, as text). `EXAMPLE` must stay identical to the card in the bots' instructions (B4 checks this).

- [ ] **Step 1: Write the fixture and the failing test**

`tests/interactive-answers-fixture.mjs`:

````js
// The example card from the bots' instructions (ANSWERS_SYSTEM in
// crates/apex-core/src/view.rs), for the interactive answers tests. This file
// is not a test itself: its name doesn't end in .test.mjs.

export const EXAMPLE = {
  schemaVersion: 1,
  kind: "comparison",
  cardId: "hosting",
  title: "Where should this run?",
  summary: "Managed hosting fits most budgets with the least upkeep.",
  inputs: [
    { id: "budget", type: "range", label: "Monthly budget", min: 50, max: 500, step: 25, default: 250, unit: "$" },
    { id: "priority", type: "choice", label: "Priority", options: [{ id: "cost", label: "Cost" }, { id: "ease", label: "Simplicity" }], default: "ease" },
  ],
  rows: [
    { id: "price", label: "Monthly cost", unit: "$", better: "lower" },
    { id: "ease", label: "Ease, 1 to 5", better: "higher" },
    { id: "work", label: "Upkeep" },
  ],
  options: [
    { id: "vps", label: "VPS", values: { price: 60, ease: 2, work: "High" }, note: "You own updates and backups." },
    { id: "managed", label: "Managed", values: { price: 180, ease: 5, work: "Low" } },
    { id: "serverless", label: "Serverless", values: { price: 90, ease: 4, work: "Medium" }, note: "Cost grows with traffic." },
  ],
  rules: [
    { type: "atMost", input: "budget", row: "price" },
    { type: "rankBy", input: "priority", rows: { cost: "price", ease: "ease" } },
  ],
  assumptions: ["Prices are estimates for one small web app."],
  sources: [{ label: "Provider pricing", url: "https://example.com/pricing" }],
};

/** The example as a fenced block's text. */
export const source = JSON.stringify(EXAMPLE);

/** The example's text after `change` edits a copy of it. */
export function variant(change) {
  const card = structuredClone(EXAMPLE);
  change(card);
  return JSON.stringify(card);
}
````

`tests/interactive-answers-schema.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CARD_CHARS, readCard } from "../src/interactiveAnswers/schema.ts";
import { EXAMPLE, source, variant } from "./interactive-answers-fixture.mjs";

const reason = (text) => {
  const read = readCard(text);
  assert.equal(read.ok, false, "expected the card to be refused");
  return read;
};

test("the example card in the bots' instructions reads exactly as written", () => {
  const read = readCard(source);
  assert.equal(read.ok, true);
  assert.deepEqual(read.card, EXAMPLE);
});

test("text that isn't a card object says why", () => {
  assert.deepEqual(reason("{"), { ok: false, reason: "The card isn't valid JSON.", unsupported: false });
  assert.deepEqual(reason("[]"), { ok: false, reason: "The card must be a JSON object.", unsupported: false });
  assert.match(reason(" ".repeat(MAX_CARD_CHARS + 1)).reason, /larger than 16,000 characters/);
  assert.deepEqual(reason(variant((c) => { delete c.schemaVersion; })), { ok: false, reason: "The card has no schemaVersion.", unsupported: false });
});

test("a newer version or kind asks for a newer Apex Deck", () => {
  assert.deepEqual(reason(variant((c) => { c.schemaVersion = 2; })), { ok: false, reason: "Card version 2 needs a newer Apex Deck.", unsupported: true });
  assert.deepEqual(reason(variant((c) => { c.kind = "chart"; })), { ok: false, reason: '"chart" cards need a newer Apex Deck.', unsupported: true });
});

test("every limit is checked, with the field that broke it", () => {
  const cases = [
    [(c) => { c.cardId = "Hosting!"; }, /^cardId must be a short id/],
    [(c) => { c.title = " "; }, /^title must be text\.$/],
    [(c) => { c.title = "x".repeat(81); }, /^title is longer than 80 characters\.$/],
    [(c) => { c.options = c.options.slice(0, 1); }, /^options must list 2 to 6 items\.$/],
    [(c) => { c.rows = []; }, /^rows must list 1 to 12 items\.$/],
    [(c) => { c.inputs[0].min = 600; }, /^inputs\[0\] needs min below max\.$/],
    [(c) => { c.inputs[0].step = 0.1; }, /at most 1000 stops/],
    [(c) => { c.inputs[0].default = 1000; }, /^inputs\[0\]\.default must be between min and max\.$/],
    [(c) => { c.inputs[1].default = "speed"; }, /^inputs\[1\]\.default must be one of its options\.$/],
    [(c) => { c.inputs[0].type = "slider"; }, /^inputs\[0\]\.type must be "range" or "choice"\.$/],
    [(c) => { c.options[1].id = "vps"; }, /^options uses the id "vps" twice\.$/],
    [(c) => { c.options[0].values.price = "cheap"; }, /^rules\[0\]\.row: every option needs a number for "Monthly cost"\.$/],
    [(c) => { c.options[0].values.work = { a: 1 }; }, /^options\[0\]\.values\.work must be a number or text\.$/],
    [(c) => { c.rules.push({ ...c.rules[1] }); }, /^Only one rankBy rule is allowed\.$/],
    [(c) => { c.rules[0].input = "priority"; }, /^rules\[0\]\.input must name a range input\.$/],
    [(c) => { c.rules[1].input = "budget"; }, /^rules\[1\]\.input must name a choice input\.$/],
    [(c) => { c.rows.push({ id: "score", label: "Score" }); c.options.forEach((o, i) => { o.values.score = i; }); c.rules[1].rows.ease = "score"; }, /row "score" needs "better"/],
    [(c) => { c.sources[0].url = "javascript:alert(1)"; }, /^sources\[0\]\.url must start with http:\/\/ or https:\/\/\.$/],
    [(c) => { c.sources[0].url = "file:///etc/hosts"; }, /must start with http/],
  ];
  for (const [change, expected] of cases) assert.match(reason(variant(change)).reason, expected);
});

test("extra fields are ignored and the optional parts may be left out", () => {
  const extra = readCard(variant((c) => { c.theme = "dark"; c.options[0].icon = "server"; }));
  assert.equal(extra.ok, true);
  assert.equal("theme" in extra.card, false);
  const bare = readCard(variant((c) => { delete c.summary; delete c.assumptions; delete c.sources; c.inputs = []; c.rules = []; }));
  assert.equal(bare.ok, true);
  assert.deepEqual([bare.card.summary, bare.card.inputs, bare.card.rules, bare.card.assumptions, bare.card.sources], ["", [], [], [], []]);
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `node --experimental-strip-types --test tests/interactive-answers-schema.test.mjs`
Expected: FAIL, `Cannot find module …/src/interactiveAnswers/schema.ts`.

- [ ] **Step 3: Write `src/interactiveAnswers/schema.ts`**

`fail()` must stay a function declaration. TypeScript only narrows after a `never`-returning call when the callee is declared that way.

````ts
// Interactive answers: the card format. A card is a fenced `apex-ui` block of
// JSON at the end of a bot's reply. Every value is checked here, so the card
// component only ever draws a card that makes sense; anything else gets a
// reason to show instead. Unknown fields are ignored, so a model that adds
// one still gets its card. Shared names are in contract.ts.

export const SCHEMA_VERSION = 1;
/** The longest card source read, in characters. */
export const MAX_CARD_CHARS = 16_000;

export interface RangeInput { id: string; type: "range"; label: string; min: number; max: number; step: number; default: number; unit?: string }
export interface ChoiceInput { id: string; type: "choice"; label: string; options: { id: string; label: string }[]; default: string }
export type CardInput = RangeInput | ChoiceInput;
/** A line of the comparison. `better` says which end ranks first. */
export interface CardRow { id: string; label: string; unit?: string; better?: "lower" | "higher" }
/** One of the things compared: a number or text per row id. A missing value shows as a dash. */
export interface CardOption { id: string; label: string; values: Record<string, number | string>; note?: string }
export type CardRule =
  | { type: "atMost"; input: string; row: string }
  | { type: "atLeast"; input: string; row: string }
  | { type: "rankBy"; input: string; rows: Record<string, string> };
export type RankRule = Extract<CardRule, { type: "rankBy" }>;
export interface CardSource { label: string; url: string }

export interface ComparisonCard {
  schemaVersion: 1;
  kind: "comparison";
  cardId: string;
  title: string;
  /** Empty when the card has none. */
  summary: string;
  inputs: CardInput[];
  rows: CardRow[];
  options: CardOption[];
  /** atMost and atLeast put an option out when its row is above or below a range input; rankBy picks, per choice, the row that ranks the rest. */
  rules: CardRule[];
  assumptions: string[];
  sources: CardSource[];
}

/** A block read as a card, or why it can't be one. `unsupported`: a newer app could draw it. */
export type CardRead = { ok: true; card: ComparisonCard } | { ok: false; reason: string; unsupported: boolean };

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

class BadCard extends Error {}

function fail(reason: string): never {
  throw new BadCard(reason);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim())) fail(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${field} is longer than ${max} characters.`);
  return trimmed;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(`${field} must be a short id of lowercase letters, digits, - or _.`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a number.`);
  return value;
}

/** A list of `min` to `max` items. An optional one (min 0) may be left out. */
function list(value: unknown, field: string, min: number, max: number): unknown[] {
  const items = value === undefined && min === 0 ? [] : value;
  if (!Array.isArray(items) || items.length < min || items.length > max) fail(`${field} must list ${min} to ${max} items.`);
  return items;
}

function unique(ids: string[], field: string) {
  const seen = new Set<string>();
  for (const one of ids) {
    if (seen.has(one)) fail(`${field} uses the id "${one}" twice.`);
    seen.add(one);
  }
}

const unit = (value: unknown, field: string): { unit?: string } => (value === undefined ? {} : { unit: text(value, field, 8) });

function input(value: unknown, field: string): CardInput {
  const x = object(value, field);
  const base = { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40) };
  if (x.type === "range") {
    const min = number(x.min, `${field}.min`);
    const max = number(x.max, `${field}.max`);
    const step = number(x.step, `${field}.step`);
    if (min >= max) fail(`${field} needs min below max.`);
    if (step <= 0 || (max - min) / step > 1000) fail(`${field}.step must be above 0 and give at most 1000 stops.`);
    const start = number(x.default, `${field}.default`);
    if (start < min || start > max) fail(`${field}.default must be between min and max.`);
    return { ...base, type: "range", min, max, step, default: start, ...unit(x.unit, `${field}.unit`) };
  }
  if (x.type === "choice") {
    const options = list(x.options, `${field}.options`, 2, 6).map((item, j) => {
      const o = object(item, `${field}.options[${j}]`);
      return { id: id(o.id, `${field}.options[${j}].id`), label: text(o.label, `${field}.options[${j}].label`, 40) };
    });
    unique(options.map((o) => o.id), `${field}.options`);
    const start = options.find((o) => o.id === x.default);
    if (!start) fail(`${field}.default must be one of its options.`);
    return { ...base, type: "choice", options, default: start.id };
  }
  return fail(`${field}.type must be "range" or "choice".`);
}

function row(value: unknown, field: string): CardRow {
  const x = object(value, field);
  if (x.better !== undefined && x.better !== "lower" && x.better !== "higher") fail(`${field}.better must be "lower" or "higher".`);
  const better = x.better === "lower" ? "lower" : x.better === "higher" ? "higher" : undefined;
  return { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40), ...unit(x.unit, `${field}.unit`), ...(better ? { better } : {}) };
}

function option(value: unknown, field: string, rows: CardRow[]): CardOption {
  const x = object(value, field);
  const given = x.values === undefined ? {} : object(x.values, `${field}.values`);
  const values: Record<string, number | string> = {};
  for (const r of rows) {
    const v = given[r.id];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") values[r.id] = number(v, `${field}.values.${r.id}`);
    else if (typeof v === "string") values[r.id] = text(v, `${field}.values.${r.id}`, 80, false);
    else fail(`${field}.values.${r.id} must be a number or text.`);
  }
  const note = text(x.note, `${field}.note`, 120, false);
  return { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40), values, ...(note ? { note } : {}) };
}

function rules(value: unknown, card: Pick<ComparisonCard, "inputs" | "rows" | "options">): CardRule[] {
  const numeric = (rowId: unknown, field: string): CardRow => {
    const r = card.rows.find((one) => one.id === rowId);
    if (!r) fail(`${field} must name one of the rows.`);
    for (const o of card.options) if (typeof o.values[r.id] !== "number") fail(`${field}: every option needs a number for "${r.label}".`);
    return r;
  };
  let ranks = 0;
  return list(value, "rules", 0, 6).map((item, i): CardRule => {
    const field = `rules[${i}]`;
    const x = object(item, field);
    const linked = card.inputs.find((one) => one.id === x.input);
    if (x.type === "atMost" || x.type === "atLeast") {
      if (!linked || linked.type !== "range") fail(`${field}.input must name a range input.`);
      return { type: x.type === "atMost" ? "atMost" : "atLeast", input: linked.id, row: numeric(x.row, `${field}.row`).id };
    }
    if (x.type === "rankBy") {
      if (++ranks > 1) fail("Only one rankBy rule is allowed.");
      if (!linked || linked.type !== "choice") fail(`${field}.input must name a choice input.`);
      const given = object(x.rows, `${field}.rows`);
      const rows: Record<string, string> = {};
      for (const choice of linked.options) {
        const r = numeric(given[choice.id], `${field}.rows.${choice.id}`);
        if (!r.better) fail(`${field}.rows.${choice.id}: row "${r.id}" needs "better": "lower" or "higher".`);
        rows[choice.id] = r.id;
      }
      return { type: "rankBy", input: linked.id, rows };
    }
    return fail(`${field}.type must be "atMost", "atLeast" or "rankBy".`);
  });
}

/** Read a fenced block's text as a card. */
export function readCard(source: string): CardRead {
  if (source.length > MAX_CARD_CHARS) return { ok: false, reason: `The card is larger than ${MAX_CARD_CHARS.toLocaleString("en-US")} characters.`, unsupported: false };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, reason: "The card isn't valid JSON.", unsupported: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "The card must be a JSON object.", unsupported: false };
  const top = raw as Record<string, unknown>;
  if (typeof top.schemaVersion !== "number") return { ok: false, reason: "The card has no schemaVersion.", unsupported: false };
  if (top.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: `Card version ${top.schemaVersion} needs a newer Apex Deck.`, unsupported: true };
  if (typeof top.kind !== "string") return { ok: false, reason: "The card has no kind.", unsupported: false };
  if (top.kind !== "comparison") return { ok: false, reason: `"${top.kind.slice(0, 40)}" cards need a newer Apex Deck.`, unsupported: true };
  try {
    const inputs = list(top.inputs, "inputs", 0, 4).map((item, i) => input(item, `inputs[${i}]`));
    unique(inputs.map((x) => x.id), "inputs");
    const rows = list(top.rows, "rows", 1, 12).map((item, i) => row(item, `rows[${i}]`));
    unique(rows.map((x) => x.id), "rows");
    const options = list(top.options, "options", 2, 6).map((item, i) => option(item, `options[${i}]`, rows));
    unique(options.map((x) => x.id), "options");
    const sources = list(top.sources, "sources", 0, 6).map((item, i) => {
      const x = object(item, `sources[${i}]`);
      const url = text(x.url, `sources[${i}].url`, 300);
      if (!/^https?:\/\/\S+$/i.test(url)) fail(`sources[${i}].url must start with http:// or https://.`);
      return { label: text(x.label, `sources[${i}].label`, 80), url };
    });
    const card: ComparisonCard = {
      schemaVersion: 1,
      kind: "comparison",
      cardId: id(top.cardId, "cardId"),
      title: text(top.title, "title", 80),
      summary: text(top.summary, "summary", 280, false),
      inputs,
      rows,
      options,
      rules: rules(top.rules, { inputs, rows, options }),
      assumptions: list(top.assumptions, "assumptions", 0, 6).map((item, i) => text(item, `assumptions[${i}]`, 200)),
      sources,
    };
    return { ok: true, card };
  } catch (error) {
    if (error instanceof BadCard) return { ok: false, reason: error.message, unsupported: false };
    throw error;
  }
}
````

- [ ] **Step 4: Run it and watch it pass**

Run: `node --experimental-strip-types --test tests/interactive-answers-schema.test.mjs && npm run build`
Expected: 5 tests pass; the build passes.

- [ ] **Step 5: Commit**

```bash
git add src/interactiveAnswers/schema.ts tests/interactive-answers-fixture.mjs tests/interactive-answers-schema.test.mjs
git commit -m "feat(answers): apex-ui comparison card format and checking"
```

### Task A2: Results, words, versions, and export summaries

**Files:**
- Create: `src/interactiveAnswers/comparison.ts`, `src/interactiveAnswers/share.ts`
- Modify: `src/markdownText.ts` (add `swapFences` at the end)
- Test: `tests/interactive-answers-comparison.test.mjs`; `tests/markdown.test.mjs` (one added test)

**Interfaces:**
- Consumes: A1 (`readCard`, card types); `contract.ts` (`CARD_LANGUAGE`, `cardKey`, `fingerprint`, `InputValues`, `AnswerEntry`).
- Produces:
  - `comparison.ts`: `snap(input, value): number`; `resolveInputs(card, saved): InputValues`; `OptionResult { id; label; out: string[]; rank: number | null }`; `Evaluation { inputs; options; best: string | null; rankedBy: CardRow | null; fitting: number }`; `evaluate(card, values): Evaluation`; `isRank(rule)`; `formatValue(value, unit?): string`; `inputText(input, value): string`; `resultLine(card, ev): string`.
  - `share.ts`: `cardVersions(messages: { seq; speaker: { kind }; text }[]): Map<string, number>`; `snapshotText(card, values, version, author): string`; `discussDraft(current, snapshot): string`; `cardMarkdown(card, values): string`; `withCardSummaries(text, seq, answers?): string`.
  - `markdownText.ts`: `swapFences(source, language, swap: (text) => string | null): string`.

- [ ] **Step 1: Write the failing tests**

`tests/interactive-answers-comparison.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { evaluate, formatValue, resolveInputs, resultLine, snap } from "../src/interactiveAnswers/comparison.ts";
import { cardMarkdown, cardVersions, discussDraft, snapshotText, withCardSummaries } from "../src/interactiveAnswers/share.ts";
import { source, variant } from "./interactive-answers-fixture.mjs";

const card = readCard(source).card;
const read = (text) => readCard(text).card;

test("saved settings that no longer fit are clamped, snapped or replaced by the default", () => {
  assert.deepEqual(resolveInputs(card, null), { budget: 250, priority: "ease" });
  assert.deepEqual(resolveInputs(card, { budget: 999, priority: "speed", stray: 1 }), { budget: 500, priority: "ease" });
  assert.deepEqual(resolveInputs(card, { budget: 112, priority: "cost" }), { budget: 100, priority: "cost" });
  assert.deepEqual(resolveInputs(card, { budget: "100" }), { budget: 250, priority: "ease" });
  assert.equal(snap({ min: 0, max: 1, step: 0.1 }, 0.30000000000000004), 0.3);
  assert.equal(snap({ min: 0, max: 10, step: 3 }, 10), 9);
});

test("limits put options out and the chosen priority ranks the rest", () => {
  const ease = evaluate(card, { budget: 250, priority: "ease" });
  assert.equal(ease.best, "managed");
  assert.deepEqual(ease.options.map((o) => [o.id, o.rank, o.out]), [["vps", 3, []], ["managed", 1, []], ["serverless", 2, []]]);
  assert.equal(resultLine(card, ease), "Best fit: Managed (priority: Simplicity).");

  const tight = evaluate(card, { budget: 100, priority: "ease" });
  assert.equal(tight.best, "serverless");
  assert.deepEqual(tight.options[1], { id: "managed", label: "Managed", out: ["Above monthly budget"], rank: null });

  assert.equal(evaluate(card, { budget: 250, priority: "cost" }).best, "vps");

  const none = evaluate(card, { budget: 50, priority: "cost" });
  assert.equal(none.best, null);
  assert.equal(resultLine(card, none), "No option fits these settings.");
});

test("ties keep the card's order; without a ranking the line counts what fits", () => {
  assert.equal(evaluate(read(variant((c) => { c.options[2].values.ease = 5; })), null).best, "managed");
  const unranked = read(variant((c) => { c.rules = [c.rules[0]]; }));
  const ev = evaluate(unranked, { budget: 100 });
  assert.equal(ev.best, null);
  assert.equal(resultLine(unranked, ev), "2 of 3 options fit these settings.");
});

test("values read the way people write them", () => {
  assert.equal(formatValue(1250, "$"), "$1,250");
  assert.equal(formatValue(-5, "$"), "-$5");
  assert.equal(formatValue(35, "%"), "35%");
  assert.equal(formatValue(12.5, "ms"), "12.5 ms");
  assert.equal(formatValue(3), "3");
  assert.equal(formatValue("High"), "High");
  assert.equal(formatValue(undefined), "—");
  assert.equal(formatValue(""), "—");
});

test("a card's version counts the bot cards with its id before it", () => {
  const bot = (seq, text) => ({ seq, speaker: { kind: "bot", id: "null" }, text });
  const fenced = (body) => `Here.\n\n\`\`\`apex-ui\n${body}\n\`\`\``;
  const versions = cardVersions([
    bot(1, fenced(source)),
    { seq: 2, speaker: { kind: "human" }, text: fenced(source) },
    bot(3, "No card here."),
    bot(4, fenced(variant((c) => { c.title = "Revised"; }))),
    bot(5, fenced("{broken")),
  ]);
  assert.deepEqual([...versions], [[cardKey(1, "hosting"), 1], [cardKey(4, "hosting"), 2]]);
});

test("the snapshot names the card, version and author, each setting, and the result", () => {
  assert.equal(snapshotText(card, { budget: 100, priority: "ease" }, 2, "Null"), [
    'Settings from Null\'s card "Where should this run?" (v2):',
    "- Monthly budget: $100",
    "- Priority: Simplicity",
    "Best fit: Serverless (priority: Simplicity). Out: Managed (above monthly budget).",
  ].join("\n"));
});

test("Discuss puts the snapshot under what's typed, with a line to write on", () => {
  assert.equal(discussDraft("", "S"), "S\n\n");
  assert.equal(discussDraft("  ", "S"), "S\n\n");
  assert.equal(discussDraft("@jigga thoughts?\n", "S"), "@jigga thoughts?\n\nS\n\n");
});

test("exports print a card as a summary and table at its saved settings", () => {
  const reply = `Pick one.\n\n\`\`\`apex-ui\n${source}\n\`\`\`\n\nAsk me anything.`;
  const saved = { [cardKey(7, "hosting")]: { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" }, revision: 1, at: 0 } };
  const out = withCardSummaries(reply, 7, saved);
  assert.ok(out.startsWith("Pick one.\n\n**Where should this run?**\n\nManaged hosting fits"));
  assert.match(out, /Monthly budget: \$100 · Priority: Simplicity/);
  assert.match(out, /\| {2}\| VPS \| Managed \| Serverless \|/);
  assert.match(out, /\| Monthly cost \| \$60 \| \$180 \| \$90 \|/);
  assert.match(out, /Best fit: Serverless \(priority: Simplicity\)\. Out: Managed \(above monthly budget\)\./);
  assert.match(out, /- \[Provider pricing\]\(https:\/\/example\.com\/pricing\)/);
  assert.ok(out.endsWith("Ask me anything."));
  // Settings saved on another card, or a block that isn't a card, change nothing.
  const other = { [cardKey(7, "hosting")]: { ...saved[cardKey(7, "hosting")], fingerprint: "00000000" } };
  assert.match(withCardSummaries(reply, 7, other), /Monthly budget: \$250/);
  const broken = "```apex-ui\n{oops\n```";
  assert.equal(withCardSummaries(broken, 7, {}), broken);
  assert.equal(cardMarkdown(card, null).split("\n\n")[0], "**Where should this run?**");
});
````

In `tests/markdown.test.mjs`, change the import to `import { parseBlocks, parseInline, swapFences } from "../src/markdownText.ts";` and add at the end:

````js
test("swapFences swaps only blocks in the language asked for, closed or not", () => {
  const text = "a\n```apex-ui\n{1}\n```\nb\n```js\nx\n```\n~~~apex-ui\n{2}";
  assert.equal(swapFences(text, "apex-ui", (body) => `<${body}>`), "a\n<{1}>\nb\n```js\nx\n```\n<{2}>");
  assert.equal(swapFences(text, "apex-ui", () => null), text);
});
````

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types --test tests/interactive-answers-comparison.test.mjs tests/markdown.test.mjs`
Expected: FAIL (`comparison.ts` missing; `swapFences` is not a function).

- [ ] **Step 3: Write the code**

Append to `src/markdownText.ts`. It reuses the file's own `FENCE`, so blocks are found exactly as `parseBlocks` finds them:

````ts
/**
 * `source` with each fenced block written in `language` swapped for what
 * `swap` returns for its text; null keeps the block as written. Blocks are
 * found the way parseBlocks finds them, including one a reply never closed.
 */
export function swapFences(source: string, language: string, swap: (text: string) => string | null): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    if (!fence) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const marker = fence[1];
    const closing = new RegExp(`^\\s{0,3}\\${marker[0]}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closing.test(lines[end])) end++;
    const swapped = fence[2] === language ? swap(lines.slice(i + 1, end).join("\n")) : null;
    if (swapped === null) out.push(...lines.slice(i, end + 1));
    else out.push(swapped);
    i = end + 1;
  }
  return out.join("\n");
}
````

`src/interactiveAnswers/comparison.ts`:

````ts
// Interactive answers: what a comparison card's settings give. Only the rule
// types in schema.ts decide anything, so a person can always check the
// result: limits put options out, then the chosen priority ranks the options
// that are left. Ties keep the card's order. Nothing here calls a model.

import type { InputValues } from "./contract.ts";
import type { CardInput, CardRow, ComparisonCard, RangeInput, RankRule } from "./schema.ts";

/** Decimal places a number is written with: 0.25 has 2, 1e-7 has 7. */
function places(n: number): number {
  const [digits, exponent] = String(n).split("e-");
  return (digits.split(".")[1]?.length ?? 0) + (exponent ? Number(exponent) : 0);
}

/** `value` moved inside the input's range and onto its nearest step. */
export function snap(input: Pick<RangeInput, "min" | "max" | "step">, value: number): number {
  const inside = Math.min(input.max, Math.max(input.min, value));
  const stepped = input.min + Math.round((inside - input.min) / input.step) * input.step;
  return Math.min(input.max, Number(stepped.toFixed(Math.min(20, Math.max(places(input.min), places(input.step))))));
}

/** The settings to use: saved ones that still fit the card, else each input's default. */
export function resolveInputs(card: Pick<ComparisonCard, "inputs">, saved: InputValues | null | undefined): InputValues {
  const out: InputValues = {};
  for (const input of card.inputs) {
    const value = saved?.[input.id];
    if (input.type === "range") out[input.id] = typeof value === "number" && Number.isFinite(value) ? snap(input, value) : input.default;
    else out[input.id] = typeof value === "string" && input.options.some((o) => o.id === value) ? value : input.default;
  }
  return out;
}

export interface OptionResult {
  id: string;
  label: string;
  /** Why it's out, one line per limit it breaks; empty when it fits. */
  out: string[];
  /** Its place among the options that fit, from 1, when the card ranks them; else null. */
  rank: number | null;
}

export interface Evaluation {
  /** The settings used. */
  inputs: InputValues;
  /** One per option, in the card's order. */
  options: OptionResult[];
  /** The top-ranked option that fits; null when the card doesn't rank or nothing fits. */
  best: string | null;
  /** The row that ranks the options for the chosen priority. */
  rankedBy: CardRow | null;
  /** How many options fit every limit. */
  fitting: number;
}

export const isRank = (rule: ComparisonCard["rules"][number]): rule is RankRule => rule.type === "rankBy";

export function evaluate(card: ComparisonCard, values: InputValues | null | undefined): Evaluation {
  const inputs = resolveInputs(card, values);
  const options: OptionResult[] = card.options.map((option) => ({
    id: option.id,
    label: option.label,
    out: card.rules.flatMap((rule) => {
      if (rule.type === "rankBy") return [];
      const limit = inputs[rule.input] as number;
      const value = option.values[rule.row] as number;
      const name = (card.inputs.find((input) => input.id === rule.input)?.label ?? rule.input).toLowerCase();
      if (rule.type === "atMost" && value > limit) return [`Above ${name}`];
      if (rule.type === "atLeast" && value < limit) return [`Below ${name}`];
      return [];
    }),
    rank: null,
  }));
  const ranking = card.rules.find(isRank);
  const rankedBy = ranking ? card.rows.find((row) => row.id === ranking.rows[inputs[ranking.input] as string]) ?? null : null;
  if (rankedBy) {
    const sign = rankedBy.better === "lower" ? 1 : -1;
    card.options
      .map((option, i) => ({ value: option.values[rankedBy.id] as number, result: options[i] }))
      .filter(({ result }) => result.out.length === 0)
      .sort((a, b) => sign * (a.value - b.value))
      .forEach(({ result }, place) => { result.rank = place + 1; });
  }
  return {
    inputs,
    options,
    best: options.find((o) => o.rank === 1)?.id ?? null,
    rankedBy,
    fitting: options.filter((o) => o.out.length === 0).length,
  };
}

const PREFIX = new Set(["$", "€", "£", "¥"]);

/** A value as the card shows it: "$1,250", "35%", "12.5 ms"; text as written; nothing as a dash. */
export function formatValue(value: number | string | undefined, unit?: string): string {
  if (value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  const digits = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const sign = value < 0 ? "-" : "";
  if (!unit) return `${sign}${digits}`;
  if (PREFIX.has(unit)) return `${sign}${unit}${digits}`;
  return unit === "%" ? `${sign}${digits}%` : `${sign}${digits} ${unit}`;
}

/** A setting in words: "$250" for a range, the option's label for a choice. */
export function inputText(input: CardInput, value: number | string | undefined): string {
  if (input.type === "range") return formatValue(typeof value === "number" ? value : input.default, input.unit);
  return input.options.find((o) => o.id === value)?.label ?? String(value ?? "");
}

/** One line saying what the settings give. */
export function resultLine(card: ComparisonCard, ev: Evaluation): string {
  if (ev.fitting === 0) return "No option fits these settings.";
  const ranking = card.rules.find(isRank);
  const best = card.options.find((o) => o.id === ev.best);
  const input = ranking && card.inputs.find((one) => one.id === ranking.input);
  if (best && input) return `Best fit: ${best.label} (${input.label.toLowerCase()}: ${inputText(input, ev.inputs[input.id])}).`;
  return `${ev.fitting} of ${card.options.length} options fit these settings.`;
}
````

`src/interactiveAnswers/share.ts`:

````ts
// Interactive answers: a card's place in its thread and its words outside
// the card: its version, the snapshot "Discuss these settings" writes, and
// the summary exports print instead of the JSON.

import { parseBlocks, swapFences } from "../markdownText.ts";
import { CARD_LANGUAGE, cardKey, fingerprint, type AnswerEntry, type InputValues } from "./contract.ts";
import { evaluate, formatValue, inputText, resultLine, type Evaluation } from "./comparison.ts";
import { readCard, type ComparisonCard } from "./schema.ts";

/**
 * Each bot card's version, by cardKey. A card is version n when n - 1 bot
 * cards with the same id came before it in the thread. A block that doesn't
 * read as a card has no version and doesn't count.
 */
export function cardVersions(messages: { seq: number; speaker: { kind: string }; text: string }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const versions = new Map<string, number>();
  for (const message of messages) {
    if (message.speaker.kind !== "bot" || !message.text.includes(CARD_LANGUAGE)) continue;
    for (const block of parseBlocks(message.text)) {
      if (block.kind !== "code" || block.language !== CARD_LANGUAGE) continue;
      const read = readCard(block.text);
      if (!read.ok) continue;
      const n = (seen.get(read.card.cardId) ?? 0) + 1;
      seen.set(read.card.cardId, n);
      versions.set(cardKey(message.seq, read.card.cardId), n);
    }
  }
  return versions;
}

/** The result line, then which options are out and why. */
function outcome(card: ComparisonCard, ev: Evaluation): string {
  const out = ev.options.filter((o) => o.out.length > 0).map((o) => `${o.label} (${o.out.join(", ").toLowerCase()})`);
  return out.length ? `${resultLine(card, ev)} Out: ${out.join("; ")}.` : resultLine(card, ev);
}

/** What "Discuss these settings" writes: whose card, which version, each setting, and what they give. */
export function snapshotText(card: ComparisonCard, values: InputValues | null, version: number, author: string): string {
  const ev = evaluate(card, values);
  return [
    `Settings from ${author}'s card "${card.title}" (v${version}):`,
    ...card.inputs.map((input) => `- ${input.label}: ${inputText(input, ev.inputs[input.id])}`),
    outcome(card, ev),
  ].join("\n");
}

/** The message box after Discuss: the snapshot under anything already typed, then an empty line to write on. */
export function discussDraft(current: string, snapshot: string): string {
  return current.trim() ? `${current.trimEnd()}\n\n${snapshot}\n\n` : `${snapshot}\n\n`;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The card in Markdown at `values` (its defaults when null): for exports, and anywhere it can't be drawn. */
export function cardMarkdown(card: ComparisonCard, values: InputValues | null): string {
  const ev = evaluate(card, values);
  const table = [
    ["", ...card.options.map((o) => o.label)],
    ["---", ...card.options.map(() => "---")],
    ...card.rows.map((row) => [row.label, ...card.options.map((o) => formatValue(o.values[row.id], row.unit))]),
  ].map((cells) => `| ${cells.map(cell).join(" | ")} |`).join("\n");
  const settings = card.inputs.map((input) => `${input.label}: ${inputText(input, ev.inputs[input.id])}`).join(" · ");
  const notes = [...card.assumptions.map((a) => `- ${a}`), ...card.sources.map((s) => `- [${s.label}](${s.url})`)].join("\n");
  return [`**${card.title}**`, card.summary, settings, table, outcome(card, ev), notes].filter(Boolean).join("\n\n");
}

/** A bot reply with each card that reads swapped for its summary, at its saved settings when they were set on that card. */
export function withCardSummaries(text: string, seq: number, answers: Record<string, AnswerEntry> = {}): string {
  return swapFences(text, CARD_LANGUAGE, (source) => {
    const read = readCard(source);
    if (!read.ok) return null;
    const saved = answers[cardKey(seq, read.card.cardId)];
    return cardMarkdown(read.card, saved && saved.fingerprint === fingerprint(source) ? saved.inputs : null);
  });
}
````

- [ ] **Step 4: Run them and watch them pass**

Run: `node --experimental-strip-types --test tests/interactive-answers-comparison.test.mjs tests/markdown.test.mjs && npm run build`
Expected: all pass (8 new tests plus the existing markdown ones); the build passes.

- [ ] **Step 5: Commit**

```bash
git add src/interactiveAnswers/comparison.ts src/interactiveAnswers/share.ts src/markdownText.ts tests/interactive-answers-comparison.test.mjs tests/markdown.test.mjs
git commit -m "feat(answers): card results, snapshot text, versions and export summaries"
```

### Task A3: The card, its placeholder and its fallback

**Files:**
- Create: `src/interactiveAnswers/AnswerCard.tsx` (`AnswerCard`, `PreparingCard`, `CardFallback`)
- Create: `src/interactiveAnswers/ThreadCard.tsx` (`ThreadCard`, `CardBoundary`)
- Create: `src/interactiveAnswers/answer-card.css`
- Test: `tests/interactive-answers-card.test.mjs`

**Interfaces:**
- Consumes: A1, A2; `contract.ts` (`AnswerStore`, `cardKey`, `fingerprint`, `InputValues`). It doesn't need B1: the test uses a stand-in store that implements the `AnswerStore` interface.
- Produces:
  - `AnswerCard(props: { card; version; author; values: InputValues | null; onChange?; onDiscuss?; onOpen; status? })`. Without `onChange` the card is read-only and has no buttons.
  - `PreparingCard({ author })` and `CardFallback({ reason, source })`.
  - `ThreadCard(props: { source; seq; author; versions: Map<string, number>; answers: AnswerStore | null; readOnly?; onDiscuss?; onOpen })`. This is what A5 puts in a reply.

- [ ] **Step 1: Write the failing test**

`tests/interactive-answers-card.test.mjs` (same stand-in-React approach as `tests/attached-media-component.test.mjs`):

````js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "sucrase";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { evaluate, formatValue, inputText, resolveInputs, resultLine } from "../src/interactiveAnswers/comparison.ts";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { snapshotText } from "../src/interactiveAnswers/share.ts";
import { source, variant } from "./interactive-answers-fixture.mjs";

// The components run with a stand-in React that returns plain objects, as in
// attached-media-component.test.mjs: imports are stripped and what they gave is passed in.
const React = { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
function load(file, names, deps) {
  const code = fs.readFileSync(new URL(`../src/interactiveAnswers/${file}`, import.meta.url), "utf8");
  const compiled = transform(code.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), { transforms: ["typescript", "jsx"], jsxRuntime: "classic" }).code;
  return new Function("React", ...Object.keys(deps), `${compiled}\nreturn { ${names.join(", ")} };`)(React, ...Object.values(deps));
}
const { AnswerCard, PreparingCard, CardFallback } = load("AnswerCard.tsx", ["AnswerCard", "PreparingCard", "CardFallback"], {
  Fragment: "Fragment", useId: () => "g1", evaluate, formatValue, inputText, resolveInputs, resultLine, snapshotText,
});
class Component { constructor(props) { this.props = props; } }
const { ThreadCard, CardBoundary } = load("ThreadCard.tsx", ["ThreadCard", "CardBoundary"], {
  Component, useEffect: () => {}, useMemo: (make) => make(), useState: (start) => [start, () => {}], AnswerCard, CardFallback, cardKey, fingerprint, readCard,
});

const find = (node, match) => findAll(node, match)[0] ?? null;
function findAll(node, match, found = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, found));
  else if (node && typeof node === "object") {
    if (match(node)) found.push(node);
    findAll(node.children, match, found);
  }
  return found;
}
const text = (node) => (node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node.children));
const card = readCard(source).card;
const range = (tree) => find(tree, (n) => n.type === "input" && n.props.type === "range");

test("the example card shows its settings, the options side by side, the best fit and the result", () => {
  const tree = AnswerCard({ card, version: 2, author: "Null", values: null, onChange() {}, onDiscuss() {}, onOpen() {} });
  const slider = range(tree).props;
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value, slider.disabled], [50, 500, 25, 250, false]);
  assert.equal(find(tree, (n) => n.type === "input" && n.props.type === "radio" && n.props.checked).props.value, "ease");
  assert.deepEqual(findAll(tree, (n) => n.type === "article").map((n) => n.props.className), ["answer-option", "answer-option best", "answer-option"]);
  assert.equal(text(find(tree, (n) => n.props.className === "answer-eyebrow")), "Interactive comparison · v2 · Null");
  assert.equal(text(find(tree, (n) => n.props.className === "answer-result")), "Best fit: Managed (priority: Simplicity).");
});

test("a lower budget puts an option out and moves the best fit", () => {
  const changes = [];
  range(AnswerCard({ card, version: 1, author: "Null", values: null, onChange: (v) => changes.push(v), onOpen() {} })).props.onChange({ target: { value: "100" } });
  assert.deepEqual(changes, [{ budget: 100, priority: "ease" }]);
  const [vps, managed, serverless] = findAll(AnswerCard({ card, version: 1, author: "Null", values: changes[0], onChange() {}, onOpen() {} }), (n) => n.type === "article");
  assert.equal(managed.props.className, "answer-option out");
  assert.match(text(managed), /Above monthly budget/);
  assert.equal(serverless.props.className, "answer-option best");
  assert.match(text(vps), /Ranked #2/);
});

test("Reset goes back to the defaults and Discuss hands over the snapshot", () => {
  const changes = [];
  const shared = [];
  const tree = AnswerCard({ card, version: 1, author: "Null", values: { budget: 100, priority: "cost" }, onChange: (v) => changes.push(v), onDiscuss: (s) => shared.push(s), onOpen() {} });
  const button = (label) => find(tree, (n) => n.type === "button" && text(n) === label);
  button("Reset").props.onClick();
  button("Discuss these settings").props.onClick();
  assert.deepEqual(changes, [{ budget: 250, priority: "ease" }]);
  assert.deepEqual(shared, [snapshotText(card, { budget: 100, priority: "cost" }, 1, "Null")]);
});

test("without onChange the card is read-only: controls off and no buttons", () => {
  const tree = AnswerCard({ card, version: 1, author: "Null", values: null, onOpen() {} });
  assert.equal(range(tree).props.disabled, true);
  assert.equal(find(tree, (n) => n.type === "fieldset").props.disabled, true);
  assert.equal(find(tree, (n) => n.type === "button"), null);
});

test("a source link opens through the chat's own link handler", () => {
  const opened = [];
  let prevented = false;
  const tree = AnswerCard({ card, version: 1, author: "Null", values: null, onOpen: (target) => opened.push(target) });
  find(tree, (n) => n.type === "a").props.onClick({ preventDefault: () => { prevented = true; } });
  assert.deepEqual([opened, prevented], [["https://example.com/pricing"], true]);
});

test("while a reply is being written the card is a placeholder with no controls", () => {
  const tree = PreparingCard({ author: "Null" });
  assert.match(text(tree), /Preparing interactive answer…/);
  assert.equal(find(tree, (n) => n.type === "input" || n.type === "button"), null);
});

test("a block that isn't a card shows the fallback with its reason", () => {
  const tree = ThreadCard({ source: "{oops", seq: 4, author: "Null", versions: new Map(), answers: null, onOpen() {} });
  assert.equal(tree.type, CardFallback);
  assert.equal(tree.props.reason, "The card isn't valid JSON.");
});

function fakeStore(saved) {
  const calls = [];
  return {
    calls,
    values: (key, print) => (saved[key]?.fingerprint === print ? saved[key].inputs : null),
    set: (...args) => calls.push(args),
    status: () => "Saved just now",
    subscribe: () => () => {},
  };
}

test("saved settings reach the card only when they were set on this exact card", () => {
  const answers = fakeStore({ "4:hosting": { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" } } });
  const drawn = (text) => ThreadCard({ source: text, seq: 4, author: "Null", versions: new Map([["4:hosting", 3]]), answers, onDiscuss() {}, onOpen() {} }).children[0];
  const shown = drawn(source);
  assert.equal(shown.type, AnswerCard);
  assert.deepEqual([shown.props.values, shown.props.version, shown.props.status], [{ budget: 100, priority: "ease" }, 3, "Saved just now"]);
  assert.equal(drawn(variant((c) => { c.title = "Changed"; })).props.values, null);
  shown.props.onChange({ budget: 150, priority: "ease" });
  assert.deepEqual(answers.calls, [["4:hosting", fingerprint(source), { budget: 150, priority: "ease" }]]);
});

test("read-only cards show saved settings but can't change them or be discussed", () => {
  const shown = ThreadCard({ source, seq: 4, author: "Null", versions: new Map(), answers: fakeStore({}), readOnly: true, onDiscuss() {}, onOpen() {} }).children[0];
  assert.deepEqual([shown.props.onChange, shown.props.onDiscuss, shown.props.status], [undefined, undefined, undefined]);
});

test("a card that throws while it is drawn falls back instead of breaking the chat", () => {
  const boundary = new CardBoundary({ source: "{}", children: "card" });
  assert.equal(boundary.render(), "card");
  boundary.state = CardBoundary.getDerivedStateFromError();
  const fallback = boundary.render();
  assert.equal(fallback.type, CardFallback);
  assert.match(fallback.props.reason, /couldn't be drawn/);
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `node --experimental-strip-types --test tests/interactive-answers-card.test.mjs`
Expected: FAIL, `ENOENT … AnswerCard.tsx`.

- [ ] **Step 3: Write the components and styles**

`src/interactiveAnswers/AnswerCard.tsx`:

````tsx
import { Fragment, useId } from "react";

import type { InputValues } from "./contract.ts";
import { evaluate, formatValue, inputText, resolveInputs, resultLine } from "./comparison.ts";
import type { ComparisonCard } from "./schema.ts";
import { snapshotText } from "./share.ts";
import "./answer-card.css";

export interface AnswerCardProps {
  card: ComparisonCard;
  /** Its version in the thread, from 1. */
  version: number;
  /** The bot whose reply it is, by display name. */
  author: string;
  /** The settings to show; anything missing or out of range shows its default. */
  values: InputValues | null;
  /** A setting changed. Without it the card is read-only. */
  onChange?: (values: InputValues) => void;
  /** Put a snapshot of these settings in the message box. Without it there's no Discuss button. */
  onDiscuss?: (snapshot: string) => void;
  /** Open a source link the way the chat opens links. */
  onOpen: (target: string) => void;
  /** Saving news for under the buttons. */
  status?: string;
}

/** A comparison card in a finished reply: its settings, the options side by side, the result, and where the numbers came from. */
export function AnswerCard({ card, version, author, values, onChange, onDiscuss, onOpen, status }: AnswerCardProps) {
  const group = useId();
  const ev = evaluate(card, values);
  const [headline, ...details] = card.rows;
  const set = (id: string, value: number | string) => onChange?.({ ...ev.inputs, [id]: value });
  return (
    <section className="answer-card" aria-label={card.title}>
      <header className="answer-card-head">
        <span className="answer-eyebrow">Interactive comparison · v{version} · {author}</span>
        <h3>{card.title}</h3>
        {card.summary && <p className="answer-summary">{card.summary}</p>}
      </header>
      {card.inputs.length > 0 && (
        <div className="answer-inputs">
          {card.inputs.map((input) =>
            input.type === "range" ? (
              <label key={input.id} className="answer-range">
                <span>
                  {input.label} <output>{inputText(input, ev.inputs[input.id])}</output>
                </span>
                <input type="range" min={input.min} max={input.max} step={input.step} value={ev.inputs[input.id]} disabled={!onChange} onChange={(e) => set(input.id, Number(e.target.value))} />
              </label>
            ) : (
              <fieldset key={input.id} className="answer-choice" disabled={!onChange}>
                <legend>{input.label}</legend>
                <div className="answer-segments">
                  {input.options.map((option) => (
                    <label key={option.id} className={ev.inputs[input.id] === option.id ? "on" : undefined}>
                      <input type="radio" name={`${group}-${input.id}`} value={option.id} checked={ev.inputs[input.id] === option.id} onChange={() => set(input.id, option.id)} />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ),
          )}
        </div>
      )}
      <div className="answer-options">
        {card.options.map((option, i) => {
          const result = ev.options[i];
          const best = ev.best === option.id;
          return (
            <article key={option.id} className={`answer-option${best ? " best" : ""}${result.out.length ? " out" : ""}`}>
              <div className="answer-option-top">
                <h4>{option.label}</h4>
                {best && <span className="answer-best">Best fit</span>}
              </div>
              <div className="answer-headline">
                <strong>{formatValue(option.values[headline.id], headline.unit)}</strong>
                <span>{headline.label}</span>
              </div>
              <p className="answer-fit">{result.out.length ? result.out.join(" · ") : result.rank ? `Ranked #${result.rank}` : "Fits these settings"}</p>
              {details.length > 0 && (
                <dl>
                  {details.map((row) => (
                    <Fragment key={row.id}>
                      <dt>{row.label}</dt>
                      <dd>{formatValue(option.values[row.id], row.unit)}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {option.note && <p className="answer-note">{option.note}</p>}
            </article>
          );
        })}
      </div>
      <p className="answer-result" aria-live="polite">{resultLine(card, ev)}</p>
      {(card.assumptions.length > 0 || card.sources.length > 0) && (
        <details className="answer-more">
          <summary>Assumptions and sources</summary>
          {card.assumptions.length > 0 && <ul>{card.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul>}
          {card.sources.length > 0 && (
            <ul className="answer-sources">
              {card.sources.map((source, i) => (
                <li key={i}>
                  <a href={source.url} onClick={(e) => { e.preventDefault(); onOpen(source.url); }}>{source.label}</a>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {onChange && (
        <footer className="answer-foot">
          <button type="button" className="ghost small" onClick={() => onChange(resolveInputs(card, null))}>Reset</button>
          <span className="answer-hint">{status ?? "Saved in this thread. Bots see these settings only when you discuss them."}</span>
          {onDiscuss && <button type="button" className="primary small" onClick={() => onDiscuss(snapshotText(card, ev.inputs, version, author))}>Discuss these settings</button>}
        </footer>
      )}
    </section>
  );
}

/** Where a card will be while its reply is still being written: no controls until the whole card is there. */
export function PreparingCard({ author }: { author: string }) {
  return (
    <section className="answer-card preparing" aria-busy="true">
      <span className="answer-eyebrow">{author} is writing</span>
      <p aria-live="polite">Preparing interactive answer…</p>
      <div className="answer-skeleton" />
      <div className="answer-skeleton short" />
      <p className="answer-hint">Controls appear when the complete card is ready.</p>
    </section>
  );
}

/** A block that can't be drawn as a card: why, with its data tucked away. */
export function CardFallback({ reason, source }: { reason: string; source: string }) {
  return (
    <section className="answer-card broken">
      <span className="answer-eyebrow">Interactive answer</span>
      <p>This interactive answer can't be shown. {reason}</p>
      <details className="answer-more">
        <summary>Show the card's data</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </section>
  );
}
````

`src/interactiveAnswers/ThreadCard.tsx`:

````tsx
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { AnswerCard, CardFallback } from "./AnswerCard.tsx";
import { cardKey, fingerprint, type AnswerStore } from "./contract.ts";
import { readCard } from "./schema.ts";

interface Props {
  /** The fenced block's text. */
  source: string;
  /** The reply's message number. */
  seq: number;
  /** The bot whose reply it is, by display name. */
  author: string;
  /** From cardVersions over the thread's messages. */
  versions: Map<string, number>;
  /** The thread's saved settings; null while they load, or where they aren't kept. */
  answers: AnswerStore | null;
  /** Show the card without letting it change: the phone, for now. */
  readOnly?: boolean;
  onDiscuss?: (snapshot: string) => void;
  onOpen: (target: string) => void;
}

/** A card in a finished reply, with the settings saved for it; the fallback when the block isn't one. */
export function ThreadCard({ source, seq, author, versions, answers, readOnly = false, onDiscuss, onOpen }: Props) {
  const read = useMemo(() => readCard(source), [source]);
  const print = useMemo(() => fingerprint(source), [source]);
  const key = read.ok ? cardKey(seq, read.card.cardId) : "";
  const [, redraw] = useState(0);
  useEffect(() => (answers && key ? answers.subscribe(key, () => redraw((n) => n + 1)) : undefined), [answers, key]);
  if (!read.ok) return <CardFallback reason={read.reason} source={source} />;
  const store = readOnly ? null : answers;
  return (
    <CardBoundary source={source}>
      <AnswerCard
        card={read.card}
        version={versions.get(key) ?? 1}
        author={author}
        values={answers?.values(key, print) ?? null}
        onChange={store ? (values) => store.set(key, print, values) : undefined}
        onDiscuss={store ? onDiscuss : undefined}
        onOpen={onOpen}
        status={store?.status(key)}
      />
    </CardBoundary>
  );
}

/** A card that throws while it is drawn shows the fallback instead of taking the chat down with it. */
export class CardBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <CardFallback reason="Something in it couldn't be drawn." source={this.props.source} /> : this.props.children;
  }
}
````

`src/interactiveAnswers/answer-card.css`:

````css
/* Interactive answers: a comparison card in a reply. Laid out like
   mockups/intelligent-ui/threads-comparison.html, in the app's own colours.
   The fallbacks are for the phone, whose sheet names some colours itself. */
.answer-card { container-type: inline-size; margin: 10px 0; border: 1px solid var(--line, #24303d); border-radius: var(--radius, 12px); background: var(--panel, #0e141b); overflow: hidden; }
.answer-card-head { padding: 14px 16px 10px; }
.answer-eyebrow { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted, #91a0af); }
.answer-card-head h3 { margin: 4px 0 0; font-size: 15px; font-weight: 600; }
.answer-summary { margin: 6px 0 0; color: var(--muted, #91a0af); }
.answer-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px 22px; padding: 4px 16px 14px; }
.answer-range { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted, #91a0af); }
.answer-range output { margin-left: 4px; color: var(--text, #e4eaf0); font-variant-numeric: tabular-nums; }
.answer-range input { width: 100%; accent-color: var(--accent, #71e6b5); }
.answer-choice { min-width: 0; margin: 0; padding: 0; border: 0; font-size: 12px; color: var(--muted, #91a0af); }
.answer-choice legend { margin-bottom: 6px; padding: 0; }
.answer-segments { display: flex; flex-wrap: wrap; gap: 4px; }
.answer-segments label { position: relative; flex: 1; padding: 6px 10px; border: 1px solid var(--line, #24303d); border-radius: 8px; text-align: center; color: var(--text, #e4eaf0); cursor: pointer; }
.answer-segments label.on { background: var(--accent, #71e6b5); border-color: var(--accent, #71e6b5); color: var(--accent-ink, #04211d); }
.answer-segments input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.answer-segments label:has(input:focus-visible) { outline: 2px solid var(--accent, #71e6b5); outline-offset: 2px; }
.answer-choice:disabled label, .answer-range input:disabled { cursor: default; opacity: 0.7; }
.answer-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1px solid var(--line, #24303d); border-bottom: 1px solid var(--line, #24303d); }
.answer-option { min-width: 0; padding: 14px 16px; background: var(--bg, #090d12); border-right: 1px solid var(--line, #24303d); }
.answer-option:last-child { border-right: 0; }
.answer-option.best { background: var(--panel-2, #151e28); box-shadow: inset 0 3px var(--accent, #71e6b5); }
.answer-option.out { opacity: 0.55; }
.answer-option-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; }
.answer-option h4 { margin: 0; font-size: 13px; font-weight: 600; }
.answer-best { font-size: 11px; color: var(--accent, #71e6b5); }
.answer-headline { display: flex; flex-direction: column; margin-top: 8px; }
.answer-headline strong { font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; }
.answer-headline span, .answer-fit, .answer-note, .answer-hint { font-size: 12px; color: var(--muted, #91a0af); }
.answer-fit { margin: 4px 0 10px; }
.answer-option dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 12px; }
.answer-option dt { color: var(--muted, #91a0af); }
.answer-option dd { margin: 0; }
.answer-note { margin: 10px 0 0; }
.answer-result { margin: 0; padding: 12px 16px 4px; }
.answer-more { padding: 4px 16px 12px; font-size: 12px; color: var(--muted, #91a0af); }
.answer-more summary { cursor: pointer; }
.answer-more ul { margin: 6px 0 0; padding-left: 18px; }
.answer-more pre { max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.answer-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--line, #24303d); }
.answer-foot .primary { margin-left: auto; }
.answer-card.preparing, .answer-card.broken { padding: 14px 16px; }
.answer-skeleton { height: 44px; margin: 10px 0; border-radius: 6px; background: var(--line, #24303d); animation: answer-pulse 1.4s ease-in-out infinite; }
.answer-skeleton.short { width: 60%; height: 14px; }
@keyframes answer-pulse { 50% { opacity: 0.5; } }
@media (prefers-reduced-motion: reduce) { .answer-skeleton { animation: none; } }
/* A narrow pane stacks the options. */
@container (max-width: 480px) {
  .answer-options { grid-template-columns: 1fr; }
  .answer-option { border-right: 0; border-bottom: 1px solid var(--line, #24303d); }
  .answer-option:last-child { border-bottom: 0; }
}
````

- [ ] **Step 4: Run it and watch it pass**

Run: `node --experimental-strip-types --test tests/interactive-answers-card.test.mjs && npm run build`
Expected: 10 tests pass; the build passes.

- [ ] **Step 5: Look at it before committing**

Following the house rule "look before installing UI": draw the example card offscreen at 720 px and at 360 px wide. A throwaway HTML page that loads the built CSS is enough. View the PNGs and compare them against `mockups/intelligent-ui/threads-comparison.html`: options side by side when wide and stacked when narrow, Best fit marked, the out option dimmed, and the segmented control readable. Don't commit the throwaway page.

- [ ] **Step 6: Commit**

```bash
git add src/interactiveAnswers/AnswerCard.tsx src/interactiveAnswers/ThreadCard.tsx src/interactiveAnswers/answer-card.css tests/interactive-answers-card.test.mjs
git commit -m "feat(answers): comparison card, streaming placeholder and safe fallback"
```

### Task A4: Markdown draws cards; exports print them as summaries

**Files:**
- Modify: `src/Markdown.tsx` (new optional `fence` prop)
- Modify: `src/exportThread.ts` (`ThreadExport.answers`; cards print as summaries)
- Test: `tests/markdown-fence.test.mjs`, `tests/export-cards.test.mjs`

**Interfaces:**
- Consumes: A2 (`withCardSummaries`); `contract.ts` (`AnswerEntry`).
- Produces: `Markdown` prop `fence?: (code: { language: string; text: string }) => ReactNode | undefined`; returning `undefined` keeps the usual code block. `ThreadExport.answers?: Record<string, AnswerEntry>`.

- [ ] **Step 1: Write the failing tests**

`tests/markdown-fence.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "sucrase";
import { parseBlocks, parseInline, pathLike } from "../src/markdownText.ts";

const React = { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const code = fs.readFileSync(new URL("../src/Markdown.tsx", import.meta.url), "utf8");
const compiled = transform(code.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), { transforms: ["typescript", "jsx"], jsxRuntime: "classic" }).code;
const { Markdown, BlockView, CodeBlock } = new Function("React", "useEffect", "useMemo", "useState", "parseBlocks", "parseInline", "pathLike", "RichText", `${compiled}\nreturn { Markdown, BlockView, CodeBlock };`)(
  React, () => {}, (make) => make(), (start) => [start, () => {}], parseBlocks, parseInline, pathLike, "RichText",
);
const inline = (source) => source;

test("a fence the caller draws replaces the code view; other code blocks stay code", () => {
  const fence = (block) => (block.language === "apex-ui" ? { type: "card", props: { text: block.text }, children: [] } : undefined);
  const card = BlockView({ block: { kind: "code", language: "apex-ui", text: "{}" }, inline, fence });
  assert.equal(card.type, "Fragment");
  assert.deepEqual(card.children, [{ type: "card", props: { text: "{}" }, children: [] }]);
  assert.equal(BlockView({ block: { kind: "code", language: "js", text: "x" }, inline, fence }).type, CodeBlock);
  assert.equal(BlockView({ block: { kind: "code", language: "apex-ui", text: "{}" }, inline }).type, CodeBlock);
});

test("Markdown hands its fence to every block", () => {
  const fence = () => undefined;
  const tree = Markdown({ text: "Hi\n\n```apex-ui\n{}\n```", onOpen() {}, fence });
  assert.deepEqual(tree.children.map((child) => child.props.fence), [fence, fence]);
});
````

`tests/export-cards.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import { exportHtml, exportJson, exportMarkdown } from "../src/exportThread.ts";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { source } from "./interactive-answers-fixture.mjs";

test("Markdown and PDF exports print cards as summaries at their saved settings; JSON keeps the reply as written", () => {
  const reply = `Pick one.\n\n\`\`\`apex-ui\n${source}\n\`\`\``;
  const thread = {
    title: "Hosting", participants: [{ id: "null", display_name: "Null" }], pins: [], compaction: null,
    transcript: [{ seq: 3, speaker: { kind: "bot", id: "null" }, text: reply }],
    answers: { [cardKey(3, "hosting")]: { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" }, revision: 1, at: 0 } },
  };
  const at = new Date("2026-10-12T12:00:00Z");
  const markdown = exportMarkdown(thread, at);
  assert.match(markdown, /Monthly budget: \$100 · Priority: Simplicity/);
  assert.doesNotMatch(markdown, /schemaVersion/);
  const html = exportHtml(thread, at);
  assert.match(html, /<table><thead><tr><th><\/th><th>VPS<\/th>/);
  assert.doesNotMatch(html, /schemaVersion/);
  assert.match(exportJson(thread, at), /schemaVersion/);
});
````

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types --test tests/markdown-fence.test.mjs tests/export-cards.test.mjs`
Expected: FAIL (the fence is ignored; the export still contains `schemaVersion`).

- [ ] **Step 3: Change `src/Markdown.tsx`**

In `interface Props`, after `pathExists`:

````tsx
  /** Draws a fenced block itself, as interactive answers do with apex-ui; undefined keeps the code view. */
  fence?: (code: { language: string; text: string }) => ReactNode | undefined;
````

Pass it through: `export function Markdown({ text, onOpen, codeAction, pathExists, fence }: Props)`, `<BlockView … codeAction={codeAction} fence={fence} />`, and give `BlockView` the prop: `function BlockView({ block, inline, codeAction, fence }: { block: Block; inline: (source: string) => ReactNode; codeAction?: Props["codeAction"]; fence?: Props["fence"] })`. Replace its `case "code":` with:

````tsx
    case "code": {
      const drawn = fence?.({ language: block.language, text: block.text });
      if (drawn !== undefined) return <>{drawn}</>;
      return <CodeBlock language={block.language} text={block.text} action={codeAction?.({ language: block.language, text: block.text })} />;
    }
````

- [ ] **Step 4: Change `src/exportThread.ts`**

Add the imports after the `markdownText.ts` import:

````ts
import type { AnswerEntry } from "./interactiveAnswers/contract.ts";
import { withCardSummaries } from "./interactiveAnswers/share.ts";
````

Add to `interface ThreadExport`, after `compaction`:

````ts
  /** Settings chosen on the thread's cards, by cardKey; cards print at these. */
  answers?: Record<string, AnswerEntry>;
````

Above `function speakerName`:

````ts
/** A message as the Markdown and PDF exports print it: a bot's cards become their summaries. */
function printed(message: Message, t: ThreadExport): string {
  return message.speaker.kind === "bot" ? withCardSummaries(message.text, message.seq, t.answers) : message.text;
}
````

Then use `printed(message, t)` instead of `message.text` in three places: the `exportMarkdown` loop, and both `bodyHtml(…)` calls in `exportHtml`. Leave `exportJson` alone.

- [ ] **Step 5: Run them and watch them pass**

Run: `node --experimental-strip-types --test tests/markdown-fence.test.mjs tests/export-cards.test.mjs tests/export.test.mjs tests/pdf-export.test.mjs && npm run build`
Expected: all pass; the build passes.

- [ ] **Step 6: Commit**

```bash
git add src/Markdown.tsx src/exportThread.ts tests/markdown-fence.test.mjs tests/export-cards.test.mjs
git commit -m "feat(answers): Markdown fence hook; exports print cards as summaries"
```

### Task A5: Wire cards into the chat and the phone (after B1 is committed)

**Files:**
- Modify: `src/ChatPane.tsx` (wiring only)
- Modify: `src/phone/PhoneApp.tsx` (read-only cards, placeholder)
- Test: `tests/interactive-answers-wiring.test.mjs`

**Interfaces:**
- Consumes: A2 (`cardVersions`, `discussDraft`), A3 (`ThreadCard`, `PreparingCard`), A4 (`fence`, `ThreadExport.answers`), B1 (`createAnswerStore`), `contract.ts` (`CARD_LANGUAGE`, `AnswerStore`).
- Produces: the feature, end to end.

- [ ] **Step 1: Write the failing test**

`tests/interactive-answers-wiring.test.mjs`. A merge once dropped wiring like this without anyone noticing (92c68c4), so this test checks the pieces are present:

````js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The chat and phone wiring is a few lines in very large files. A merge has
// dropped wiring like this before (92c68c4), so its pieces are checked here.
const read = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("finished replies draw cards, replies being written show the placeholder, and exports get the settings", () => {
  const chat = read("ChatPane.tsx");
  for (const piece of ["createAnswerStore(backend, pane.id)", "fence={cardIn(entry.message)}", "<PreparingCard author={names.get(id) ?? id} />", "answers: answers?.entries()", "discussDraft(text, snapshot)"]) {
    assert.ok(chat.includes(piece), piece);
  }
});

test("the phone draws cards read-only and shows the placeholder while a reply is written", () => {
  const phone = read("phone/PhoneApp.tsx");
  for (const piece of ["answers={null} readOnly", "<PreparingCard author={name} />", "cardVersions(props.messages)"]) assert.ok(phone.includes(piece), piece);
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `node --experimental-strip-types --test tests/interactive-answers-wiring.test.mjs`
Expected: FAIL on `createAnswerStore(backend, pane.id)`.

- [ ] **Step 3: Wire `src/ChatPane.tsx`**

After `import { Markdown } from "./Markdown";`:

````tsx
import { PreparingCard } from "./interactiveAnswers/AnswerCard.tsx";
import { createAnswerStore } from "./interactiveAnswers/answerStore.ts";
import { CARD_LANGUAGE, type AnswerStore } from "./interactiveAnswers/contract.ts";
import { cardVersions, discussDraft } from "./interactiveAnswers/share.ts";
import { ThreadCard } from "./interactiveAnswers/ThreadCard.tsx";
````

Directly above `const changeArtifacts = (next: ArtifactFile) => {`:

````tsx
  // Settings people chose on the cards in this thread's replies. See src/interactiveAnswers.
  const [answers, setAnswers] = useState<AnswerStore | null>(null);
  useEffect(() => {
    setAnswers(null);
    if (profileMode || (hostConnection.revision === 0 && backend.host)) return;
    let live = true;
    const store = createAnswerStore(backend, pane.id);
    void store.load().then(() => { if (live) setAnswers(store); });
    return () => { live = false; void store.flush(); };
  }, [backend, pane.id, profileMode, hostConnection.revision]);
  const versions = useMemo(() => cardVersions(messagesOf(entries)), [entries]);
  /** "Discuss these settings": the snapshot goes in the message box, never straight to the bots. */
  const discussCard = (snapshot: string) => {
    const next = discussDraft(text, snapshot);
    setText(next);
    setCaret(next.length);
    if (details?.overlay) details.close();
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length); });
  };
  const cardIn = (message: Message) => (code: { language: string; text: string }) =>
    code.language === CARD_LANGUAGE
      ? <ThreadCard source={code.text} seq={message.seq} author={message.speaker.kind === "bot" ? names.get(message.speaker.id) ?? message.speaker.id : "Human"} versions={versions} answers={answers} onDiscuss={discussCard} onOpen={openTarget} />
      : undefined;
````

In the finished bot reply, add the fence: `<Markdown text={entry.message.text} onOpen={openTarget} pathExists={pathExists} codeAction={(code) => artifactAction(entry.message, code)} fence={cardIn(entry.message)} />`

In the drafts area (`{partial && (`): `<Markdown text={partial} onOpen={openTarget} fence={(code) => (code.language === CARD_LANGUAGE ? <PreparingCard author={names.get(id) ?? id} /> : undefined)} />`

In `threadExport`, add `answers: answers?.entries()` after `compaction: compactionOf(entries)`.

- [ ] **Step 4: Wire `src/phone/PhoneApp.tsx` (read-only)**

After `import { Markdown } from "../Markdown";`:

````tsx
import { PreparingCard } from "../interactiveAnswers/AnswerCard.tsx";
import { CARD_LANGUAGE } from "../interactiveAnswers/contract.ts";
import { cardVersions } from "../interactiveAnswers/share.ts";
import { ThreadCard } from "../interactiveAnswers/ThreadCard.tsx";
````

In `ThreadView`, right after `const press = useLongPress();`:

````tsx
  // Cards show read-only on the phone for now, at their defaults.
  const versions = useMemo(() => cardVersions(props.messages), [props.messages]);
````

On the finished bot message's `<Markdown …>` (the one inside `<div className="ph-md">` whose `onOpen` checks `press.held`), add:

````tsx
fence={(code) => (code.language === CARD_LANGUAGE
  ? <ThreadCard source={code.text} seq={message.seq} author={message.speaker.kind === "bot" ? person(message.speaker.id).display_name : "Human"} versions={versions} answers={null} readOnly onOpen={(target) => { if (/^https?:/i.test(target)) window.open(target, "_blank", "noopener"); }} />
  : undefined)}
````

The `kind` check is needed: TypeScript drops the `speaker` narrowing inside the arrow. On the draft `<Markdown text={turn.text} …>` inside `ph-md ph-draft`, add `fence={(code) => (code.language === CARD_LANGUAGE ? <PreparingCard author={name} /> : undefined)}`.

- [ ] **Step 5: Run everything**

Run: `node --experimental-strip-types --test tests/interactive-answers-wiring.test.mjs && npm run build && npm test`
Expected: the wiring test passes; the build passes; `npm test` shows only the 11 baseline failures.

- [ ] **Step 6: See it work**

Close any other `desktop:dev`, then run `npm run desktop:dev` from the worktree. Turn on Settings → Interactive answers. In a new thread, ask one bot: "Compare three ways to host this project, and add a comparison card." Check each of these and post screenshots in the chat:
- The placeholder shows while the reply is written.
- The card draws, and the slider and choices change the result.
- Reset works.
- Discuss fills the message box without sending.
- Quitting and reopening keeps the settings.
- A fork keeps them.
- The Markdown export prints the summary table.
- A narrow pane stacks the options.
- Keyboard works: Tab reaches the slider and arrow keys move it; arrow keys move between the choices.

- [ ] **Step 7: Commit**

```bash
git add src/ChatPane.tsx src/phone/PhoneApp.tsx tests/interactive-answers-wiring.test.mjs
git commit -m "feat(answers): cards in thread replies with saved settings and Discuss; read-only on the phone"
```

---

## Track B: saved settings and bot instructions (Null)

### Task B1: Client side of saved settings

**Files:**
- Modify: `src/backend.ts` (interface methods; the browser stand-in, including fork and delete)
- Modify: `src/commandBackend.ts`, `src/hostBackends.ts`
- Create: `src/interactiveAnswers/answerStore.ts`
- Test: `tests/answer-store.test.mjs`; `tests/command-backend.test.mjs` (two rows)

**Interfaces:**
- Consumes: `contract.ts` (`AnswerEntry`, `AnswerSaveResult`, `AnswersFile`, `AnswerStore`, `InputValues`).
- Produces:
  - `Backend.answersLoad(room): Promise<unknown>` and `Backend.answerSave(room, key, fingerprint, inputs, revision): Promise<AnswerSaveResult>`, which send `answers_load { room }` and `answer_save { room, key, fingerprint, inputs, revision }`.
  - `answerStore.ts`: `SAVE_DELAY_MS = 300`, `AnswerBackend`, `readAnswers(raw): AnswersFile`, `createAnswerStore(backend: AnswerBackend, room: string, delay?): AnswerStore`. A5 calls `createAnswerStore(backend, pane.id)`; B3 calls `readAnswers`.

- [ ] **Step 1: Write the failing tests**

`tests/answer-store.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerStore, readAnswers } from "../src/interactiveAnswers/answerStore.ts";

const KEY = "4:hosting";
const PRINT = "0a1b2c3d";
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host that keeps one thread's settings the way answer_save does, and writes down every save. */
function host(cards = {}, { loadError, saveError } = {}) {
  const saves = [];
  const file = { version: 1, cards: structuredClone(cards) };
  return {
    saves,
    file,
    answersLoad: async () => { if (loadError) throw new Error(loadError); return Object.keys(file.cards).length ? structuredClone(file) : null; },
    answerSave: async (room, key, fingerprint, inputs, revision) => {
      saves.push({ room, key, fingerprint, inputs, revision });
      if (saveError) throw new Error(saveError);
      const current = file.cards[key];
      if (current && current.revision !== revision) return { conflict: structuredClone(current) };
      const saved = { fingerprint, inputs: structuredClone(inputs), revision: (current?.revision ?? 0) + 1, at: 1 };
      file.cards[key] = saved;
      return { saved: structuredClone(saved) };
    },
  };
}
const entry = (inputs, revision = 1, fingerprint = PRINT) => ({ fingerprint, inputs, revision, at: 0 });

test("loaded settings apply only to the card they were set on", async () => {
  const store = createAnswerStore(host({ [KEY]: entry({ budget: 100 }, 2) }), "t", 1);
  await store.load();
  assert.deepEqual(store.values(KEY, PRINT), { budget: 100 });
  assert.equal(store.values(KEY, "ffffffff"), null);
  assert.equal(store.values("5:hosting", PRINT), null);
  assert.equal(store.status(KEY), undefined);
});

test("a dragged slider saves once, with the last value and the revision it changed", async () => {
  const backend = host({ [KEY]: entry({ budget: 100, priority: "ease" }, 2) });
  const store = createAnswerStore(backend, "t", 5);
  await store.load();
  for (const budget of [110, 120, 130]) store.set(KEY, PRINT, { budget, priority: "ease" });
  assert.deepEqual(store.values(KEY, PRINT), { budget: 130, priority: "ease" }, "shows at once");
  await wait(); await store.flush();
  assert.deepEqual(backend.saves, [{ room: "t", key: KEY, fingerprint: PRINT, inputs: { budget: 130, priority: "ease" }, revision: 2 }]);
  store.set(KEY, PRINT, { budget: 140, priority: "ease" });
  await store.flush();
  assert.equal(backend.saves[1].revision, 3, "the next save names the revision the last one made");
});

test("closing a thread saves what's waiting at once", async () => {
  const backend = host();
  const store = createAnswerStore(backend, "t", 10_000);
  await store.load();
  store.set(KEY, PRINT, { budget: 300 });
  await store.flush();
  assert.deepEqual(backend.saves.map((s) => [s.inputs, s.revision]), [[{ budget: 300 }, 0]]);
});

test("another window saved first: its settings show and this change isn't saved over them", async () => {
  const backend = host({ [KEY]: entry({ budget: 100, priority: "ease" }, 2) });
  const store = createAnswerStore(backend, "t", 1);
  await store.load();
  backend.file.cards[KEY] = entry({ budget: 100, priority: "cost" }, 3); // the other window changed priority
  store.set(KEY, PRINT, { budget: 150, priority: "ease" }); // this one changed budget
  await wait(); await store.flush();
  assert.deepEqual(backend.saves.map((s) => [s.inputs, s.revision]), [[{ budget: 150, priority: "ease" }, 2]]);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 100, priority: "cost" });
  assert.equal(store.status(KEY), "Another window changed this card, so your last change wasn't saved.");
  // The next change starts from the newer settings and saves.
  store.set(KEY, PRINT, { budget: 150, priority: "cost" });
  await store.flush();
  assert.deepEqual(backend.saves.at(-1), { room: "t", key: KEY, fingerprint: PRINT, inputs: { budget: 150, priority: "cost" }, revision: 3 });
  assert.equal(store.status(KEY), undefined);
});

test("a change made while a refused save was on its way isn't saved over the other window either", async () => {
  const backend = host({ [KEY]: entry({ budget: 100 }, 2) });
  let answer;
  const slow = { ...backend, answerSave: (...args) => new Promise((resolve) => { answer = () => resolve(backend.answerSave(...args)); }) };
  const store = createAnswerStore(slow, "t", 1);
  await store.load();
  backend.file.cards[KEY] = entry({ budget: 400 }, 3);
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); // the save is on its way
  store.set(KEY, PRINT, { budget: 175 });
  answer();
  await wait(); await store.flush();
  assert.equal(backend.saves.length, 1);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 400 });
});

test("a failed save keeps the change on screen and says why", async () => {
  const store = createAnswerStore(host({}, { saveError: "The Mac is offline." }), "t", 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); await store.flush();
  assert.deepEqual(store.values(KEY, PRINT), { budget: 150 });
  assert.equal(store.status(KEY), "Couldn't save: The Mac is offline.");
});

test("settings that couldn't be read are never written over, and an old helper is named", async () => {
  const backend = host({}, { loadError: "Could not read saved data: expected value" });
  const store = createAnswerStore(backend, "t", 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); await store.flush();
  assert.equal(backend.saves.length, 0);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 150 }, "the change still shows");
  assert.equal(store.status(KEY), "Saved settings couldn't be read, so changes here won't be kept.");
  const old = createAnswerStore(host({}, { loadError: "unknown variant `answers_load`, expected one of `session_load`" }), "t", 1);
  await old.load();
  assert.equal(old.status(KEY), "This machine's apex-daemon is too old to keep card settings.");
});

test("listeners hear about their own card until they stop", async () => {
  const store = createAnswerStore(host(), "t", 1);
  await store.load();
  let heard = 0;
  const stop = store.subscribe(KEY, () => heard++);
  store.set("9:other", PRINT, { budget: 1 });
  store.set(KEY, PRINT, { budget: 2 });
  stop();
  store.set(KEY, PRINT, { budget: 3 });
  assert.equal(heard, 1);
  await store.flush();
  assert.deepEqual(Object.keys(store.entries()).sort(), [KEY, "9:other"].sort());
});

test("damaged saved entries are left out", () => {
  assert.deepEqual(readAnswers(null), { version: 1, cards: {} });
  assert.deepEqual(readAnswers({ cards: {
    good: { fingerprint: PRINT, inputs: { budget: 5, priority: "ease", bad: { x: 1 } }, revision: 2, at: 9 },
    noPrint: { inputs: {}, revision: 1 },
    zero: { fingerprint: PRINT, inputs: {}, revision: 0 },
  } }), { version: 1, cards: { good: { fingerprint: PRINT, inputs: { budget: 5, priority: "ease" }, revision: 2, at: 9 } } });
});
````

In `tests/command-backend.test.mjs`, add after the `artifactsSave` row of `COMMANDS`:

````js
  ['answersLoad', ['r'], 'answers_load', { room: 'r' }],
  ['answerSave', ['r', '1:c', '0a1b2c3d', { budget: 1 }, 0], 'answer_save', { room: 'r', key: '1:c', fingerprint: '0a1b2c3d', inputs: { budget: 1 }, revision: 0 }],
````

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types --test tests/answer-store.test.mjs tests/command-backend.test.mjs`
Expected: FAIL (`answerStore.ts` missing; `answersLoad` is not a function).

- [ ] **Step 3: Write the store**

`src/interactiveAnswers/answerStore.ts`:

````ts
// Interactive answers: the settings people choose on cards, kept per thread
// by the host (answers_load, answer_save). A change shows at once and is
// saved a moment later, so a dragged slider saves once. Saves go one at a
// time, each naming the revision it changed. When another window saved
// first, nothing is saved over it: its settings show, with a note saying so.
// Settings that couldn't be read are never written over.

import type { AnswerEntry, AnswerSaveResult, AnswersFile, AnswerStore, InputValues } from "./contract.ts";

/** How long a change waits for the next one before it is saved, in milliseconds. */
export const SAVE_DELAY_MS = 300;

/** The two host calls the store uses. Backend has both. */
export interface AnswerBackend {
  answersLoad(room: string): Promise<unknown>;
  answerSave(room: string, key: string, fingerprint: string, inputs: InputValues, revision: number): Promise<AnswerSaveResult>;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Read what answers_load returned. A damaged entry is left out; null reads as nothing saved. */
export function readAnswers(raw: unknown): AnswersFile {
  const cards: Record<string, AnswerEntry> = {};
  for (const [key, value] of Object.entries(record(record(raw).cards))) {
    const entry = record(value);
    if (typeof entry.fingerprint !== "string" || !Number.isInteger(entry.revision) || (entry.revision as number) < 1) continue;
    const inputs: InputValues = {};
    for (const [id, setting] of Object.entries(record(entry.inputs))) {
      if ((typeof setting === "number" && Number.isFinite(setting)) || typeof setting === "string") inputs[id] = setting;
    }
    cards[key] = { fingerprint: entry.fingerprint, inputs, revision: entry.revision as number, at: typeof entry.at === "number" ? entry.at : 0 };
  }
  return { version: 1, cards };
}

const CLASHED = "Another window changed this card, so your last change wasn't saved.";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Card {
  /** What the host has, as far as this window knows. */
  saved: AnswerEntry | null;
  /** What the card shows: the saved settings, or ones changed here. */
  shown: { fingerprint: string; inputs: InputValues } | null;
  status?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export function createAnswerStore(backend: AnswerBackend, room: string, delay = SAVE_DELAY_MS): AnswerStore {
  const cards = new Map<string, Card>();
  const listeners = new Map<string, Set<() => void>>();
  let problem: string | undefined = "Saved settings are still loading, so changes here won't be kept yet.";
  let queue: Promise<void> = Promise.resolve();

  const card = (key: string): Card => {
    let one = cards.get(key);
    if (!one) cards.set(key, (one = { saved: null, shown: null }));
    return one;
  };
  const tell = (key: string) => listeners.get(key)?.forEach((listener) => listener());

  const save = async (key: string) => {
    const one = card(key);
    const mine = one.shown;
    if (!mine || problem) return;
    let result: AnswerSaveResult;
    try {
      result = await backend.answerSave(room, key, mine.fingerprint, mine.inputs, one.saved?.revision ?? 0);
    } catch (error) {
      one.status = `Couldn't save: ${message(error)}`;
      tell(key);
      return;
    }
    if ("saved" in result) {
      one.saved = result.saved;
      one.status = undefined;
    } else {
      // Another window saved first. Its settings show, rather than these being saved over them.
      one.saved = result.conflict;
      clearTimeout(one.timer);
      one.timer = undefined;
      one.shown = null;
      one.status = CLASHED;
    }
    tell(key);
  };

  const schedule = (key: string) => {
    const one = card(key);
    one.timer = undefined;
    queue = queue.then(() => save(key));
    return queue;
  };

  return {
    async load() {
      try {
        const file = readAnswers(await backend.answersLoad(room));
        for (const [key, entry] of Object.entries(file.cards)) card(key).saved = entry;
        problem = undefined;
      } catch (error) {
        problem = /unknown variant [`'"]?answers_load|unknown command.*answers_load/i.test(message(error))
          ? "This machine's apex-daemon is too old to keep card settings."
          : "Saved settings couldn't be read, so changes here won't be kept.";
      }
      for (const key of listeners.keys()) tell(key);
    },
    values(key, print) {
      const one = cards.get(key);
      if (one?.shown?.fingerprint === print) return one.shown.inputs;
      if (one?.saved?.fingerprint === print) return one.saved.inputs;
      return null;
    },
    set(key, print, values) {
      const one = card(key);
      one.shown = { fingerprint: print, inputs: values };
      tell(key);
      if (problem) return;
      if (one.timer) clearTimeout(one.timer);
      one.timer = setTimeout(() => void schedule(key), delay);
    },
    status: (key) => problem ?? cards.get(key)?.status,
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    },
    entries() {
      const out: Record<string, AnswerEntry> = {};
      for (const [key, one] of cards) {
        const shown = one.shown ?? one.saved;
        if (shown) out[key] = { fingerprint: shown.fingerprint, inputs: shown.inputs, revision: one.saved?.revision ?? 0, at: one.saved?.at ?? 0 };
      }
      return out;
    },
    flush() {
      for (const [key, one] of cards) {
        if (!one.timer) continue;
        clearTimeout(one.timer);
        void schedule(key);
      }
      return queue;
    },
  };
}
````

- [ ] **Step 4: Add the two calls to the backends**

`src/backend.ts`: import `import type { AnswerSaveResult, AnswersFile, InputValues } from "./interactiveAnswers/contract.ts";`. In `interface Backend`, after `artifactsSave`:

````ts
  /** Settings chosen on the cards in a thread's replies (rooms/<hex id>.answers.json); answerStore.ts reads them. Null when there are none. */
  answersLoad(room: string): Promise<unknown>;
  /** Save one card's settings. `revision` is the saved revision they were changed from, 0 for none; see AnswerSaveResult. */
  answerSave(room: string, key: string, fingerprint: string, inputs: InputValues, revision: number): Promise<AnswerSaveResult>;
````

In the browser stand-in, after its `artifactsSave`:

````ts
    answersLoad: async (room) => JSON.parse(localStorage.getItem(`apex-deck.demo.answers.${room}`) ?? "null"),
    answerSave: async (room, key, fingerprint, inputs, revision) => {
      // As answer_save does: a stale revision changes nothing and gets the newer entry back.
      const name = `apex-deck.demo.answers.${room}`;
      const file: AnswersFile = JSON.parse(localStorage.getItem(name) ?? "null") ?? { version: 1, cards: {} };
      const current = file.cards[key];
      if (current && current.revision !== revision) return { conflict: current };
      const saved = { fingerprint, inputs, revision: (current?.revision ?? 0) + 1, at: Date.now() };
      file.cards[key] = saved;
      localStorage.setItem(name, JSON.stringify(file));
      return { saved };
    },
````

In the stand-in's fork, after the line that copies `apex-deck.demo.artifacts.…`:

````ts
      const answers = localStorage.getItem(`apex-deck.demo.answers.${source}`);
      if (answers) localStorage.setItem(`apex-deck.demo.answers.${target}`, answers);
````

In its `roomDelete`, after removing the artifacts: ``localStorage.removeItem(`apex-deck.demo.answers.${id}`);``

`src/commandBackend.ts`: import `import type { AnswerSaveResult } from "./interactiveAnswers/contract.ts";` and add, after `artifactsSave`:

````ts
    answersLoad: (room) => call<unknown>("answers_load", { room }),
    answerSave: (room, key, fingerprint, inputs, revision) => call<AnswerSaveResult>("answer_save", { room, key, fingerprint, inputs, revision }),
````

`src/hostBackends.ts`: add `"answerSave"` to the `writes` set, after `"artifactsSave"`.

- [ ] **Step 5: Run them and watch them pass**

Run: `node --experimental-strip-types --test tests/answer-store.test.mjs tests/command-backend.test.mjs && npm run build`
Expected: all pass (9 store tests); the build passes. Until B2 lands, the real host answers these calls with "unknown variant". The store reports that as "This machine's apex-daemon is too old to keep card settings." That is the correct behavior against an older daemon.

- [ ] **Step 6: Commit, then tell Muck that A5 is unblocked**

```bash
git add src/interactiveAnswers/answerStore.ts src/backend.ts src/commandBackend.ts src/hostBackends.ts tests/answer-store.test.mjs tests/command-backend.test.mjs
git commit -m "feat(answers): saved card settings client with revision checks"
```

### Task B2: The host keeps card settings

**Files:**
- Modify: `crates/apex-host/src/storage.rs`, `crates/apex-host/src/command.rs`, `crates/apex-host/src/host.rs`, `crates/apex-daemon/src/authority.rs`
- Test: unit tests in `storage.rs`; `crates/apex-host/tests/host.rs`; the command-count test in `command.rs`; the table test in `authority.rs`

**Interfaces:**
- Consumes: the JSON shapes in `contract.ts` (`AnswerEntry`, `AnswersFile`, `AnswerSaveResult`).
- Produces: `answers_load { room }` returns `AnswersFile | null`. `answer_save { room, key, fingerprint, inputs, revision }` returns `{"saved": AnswerEntry}` or `{"conflict": AnswerEntry}`, or an error for junk. The file `rooms/<hex id>.answers.json` is copied on fork, deleted with the thread, and keeps the id taken against `room_import`, like artifacts.

- [ ] **Step 1: Write the failing tests**

In `storage.rs`'s `mod tests`, before `fn a_damaged_artifacts_file_is_reported_not_emptied`:

````rust
    #[tokio::test]
    async fn card_settings_save_by_revision_follow_forks_and_go_with_their_thread() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.answers("chat-1").unwrap().is_none());
        let inputs = |budget: u64| serde_json::json!({ "budget": budget, "priority": "ease" }).as_object().unwrap().clone();
        let AnswerSave::Saved(first) = store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(100), 0, 5).unwrap() else { panic!("the first save was refused") };
        assert_eq!((first.revision, first.at), (1, 5));
        assert!(matches!(store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(150), 1, 6).unwrap(), AnswerSave::Saved(AnswerEntry { revision: 2, .. })));
        // A save made from revision 1 doesn't overwrite revision 2.
        let AnswerSave::Conflict(newer) = store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(999), 1, 7).unwrap() else { panic!("a stale save was kept") };
        assert_eq!((newer.revision, newer.inputs["budget"].as_u64()), (2, Some(150)));

        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("saved", &|_| {}).await;
        store.save_room("chat-1", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        store.fork_room("chat-1", "chat-2", None, None).unwrap();
        assert_eq!(store.answers("chat-2").unwrap(), store.answers("chat-1").unwrap());

        store.delete_room("chat-1").unwrap();
        assert!(store.answers("chat-1").unwrap().is_none());
        assert!(store.answers("chat-2").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_card_settings_file_is_reported_and_never_written_over() {
        let root = temp();
        let store = Store::new(root.clone());
        store.save_answer("chat-1", "1:a", "0a1b2c3d", serde_json::Map::new(), 0, 0).unwrap();
        let path = store.answers_path("chat-1");
        std::fs::write(&path, "broken").unwrap();
        assert!(store.answers("chat-1").is_err());
        assert!(store.save_answer("chat-1", "1:a", "0a1b2c3d", serde_json::Map::new(), 1, 0).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_dir_all(root).unwrap();
    }
````

In `crates/apex-host/tests/host.rs`, before `fn importing_over_leftover_artifacts_is_refused_and_keeps_them`:

````rust
#[test]
fn card_settings_save_by_revision_refuse_junk_and_keep_their_thread_id_taken() {
    let data = std::env::temp_dir().join(format!("apex-host-answers-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let host = Running::start(&data);
    assert_eq!(host.call(json!({"cmd":"answers_load","args":{"room":"t"}})).unwrap(), Value::Null);
    let save = |revision: u64, budget: u64| host.call(json!({"cmd":"answer_save","args":{"room":"t","key":"1:hosting","fingerprint":"0a1b2c3d","inputs":{"budget":budget,"priority":"ease"},"revision":revision}})).unwrap();
    assert_eq!(save(0, 100)["saved"]["revision"], 1);
    assert_eq!(save(1, 150)["saved"]["revision"], 2);
    // A window still on revision 1 doesn't overwrite revision 2.
    let stale = save(1, 999);
    assert_eq!((&stale["conflict"]["revision"], &stale["conflict"]["inputs"]["budget"]), (&json!(2), &json!(150)));
    for junk in [
        json!({"room":"t","key":"hosting","fingerprint":"0a1b2c3d","inputs":{},"revision":0}),
        json!({"room":"t","key":"1:hosting","fingerprint":"XYZ","inputs":{},"revision":0}),
        json!({"room":"t","key":"1:hosting","fingerprint":"0a1b2c3d","inputs":{"budget":{"x":1}},"revision":2}),
    ] {
        assert!(host.call(json!({"cmd":"answer_save","args":junk})).is_err(), "{junk}");
    }
    assert_eq!(host.call(json!({"cmd":"answers_load","args":{"room":"t"}})).unwrap()["cards"]["1:hosting"]["revision"], 2);
    // Settings an earlier move left behind keep the id taken, like artifacts.
    let snapshot = host.call(json!({"cmd":"room_create","args":{"id":"other","participants":[],"options":RoomOptions::default()}})).unwrap();
    let refused = host.call(json!({"cmd":"room_import","args":{"id":"t","snapshot":snapshot,"cwd":null}}));
    assert!(refused.unwrap_err().contains("a thread with that id already exists"));
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}
````

In `command.rs`'s `names_lists_every_command`, change `133` to `136` and add:

````rust
        assert!(names.contains(&"answers_load".to_string()));
        assert!(names.contains(&"answer_save".to_string()));
````

In `authority.rs`'s test table, after the `artifacts_load` row:

````rust
            ("answers_load", Some((ReadOnly, "thread")), json!({ "room": "mine" })),
            ("answer_save", Some((Chat, "thread")), json!({ "room": "mine", "key": "1:hosting", "fingerprint": "0a1b2c3d", "inputs": {}, "revision": 0 })),
````

- [ ] **Step 2: Run them and watch them fail**

Run: `TMPDIR=/tmp cargo test -p apex-host -p apex-daemon`
Expected: compile errors (`answers`, `save_answer`, `AnswerSave` not found).

- [ ] **Step 3: Storage (`crates/apex-host/src/storage.rs`)**

After `struct SavedRoom`:

````rust
/// One card's saved settings: src/interactiveAnswers/contract.ts `AnswerEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerEntry {
    pub fingerprint: String,
    pub inputs: serde_json::Map<String, serde_json::Value>,
    pub revision: u64,
    pub at: u64,
}

/// The settings people chose on a thread's cards, by card key ("<seq>:<card id>").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswersFile {
    pub version: u32,
    pub cards: std::collections::BTreeMap<String, AnswerEntry>,
}

/// What saving one card's settings did. Serialized as {"saved": …} or {"conflict": …}.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerSave {
    Saved(AnswerEntry),
    /// Another client saved first; nothing changed, and this is what it saved.
    Conflict(AnswerEntry),
}

/// The most cards one thread keeps settings for.
pub const MAX_SAVED_CARDS: usize = 500;
````

After `fn artifacts_path`:

````rust
    /// The settings chosen on a thread's cards, beside its file: "<hex id>.answers.json".
    fn answers_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("answers.json")
    }
````

Split `write` so a caller already holding the lock can write. `write` takes the lock and calls `write_held`. `write_held` is the old body without its `let _guard = …` line:

````rust
    fn write<T: Serialize>(&self, path: &Path, data: &T) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        self.write_held(path, data)
    }

    /// `write`, for a caller that already holds the write lock.
    fn write_held<T: Serialize>(&self, path: &Path, data: &T) -> Result<(), String> {
        use std::io::Write;
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        // …the rest of the old body, unchanged…
    }
````

After `save_artifacts`:

````rust
    /// The settings people chose on a thread's cards. None when there are none.
    pub fn answers(&self, id: &str) -> Result<Option<AnswersFile>, String> {
        self.read(&self.answers_path(id))
    }

    /// Save one card's settings when `revision` is still its saved revision,
    /// or nothing is saved under `key` yet. Otherwise nothing changes and the
    /// newer entry comes back. A file that can't be read is never written over.
    pub fn save_answer(&self, id: &str, key: &str, fingerprint: &str, inputs: serde_json::Map<String, serde_json::Value>, revision: u64, at: u64) -> Result<AnswerSave, String> {
        let _guard = self.writes.lock().unwrap();
        let path = self.answers_path(id);
        let mut file: AnswersFile = self.read(&path)?.unwrap_or(AnswersFile { version: 1, cards: Default::default() });
        let next = match file.cards.get(key) {
            Some(current) if current.revision != revision => return Ok(AnswerSave::Conflict(current.clone())),
            Some(current) => current.revision + 1,
            None if file.cards.len() >= MAX_SAVED_CARDS => return Err("This thread keeps settings for too many cards.".into()),
            None => 1,
        };
        let entry = AnswerEntry { fingerprint: fingerprint.to_string(), inputs, revision: next, at };
        file.cards.insert(key.to_string(), entry.clone());
        self.write_held(&path, &file)?;
        Ok(AnswerSave::Saved(entry))
    }
````

In `fork_room`, right after the artifacts copy's `match`:

````rust
        // And the settings chosen on its cards.
        match std::fs::copy(self.answers_path(source), self.answers_path(target)) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not copy the thread's card settings: {e}")),
        }
````

In `import_room`, refuse leftover card settings too. Replace `if std::fs::symlink_metadata(self.artifacts_path(id)).is_ok() {` with:

````rust
        if [self.artifacts_path(id), self.answers_path(id)].iter().any(|leftover| std::fs::symlink_metadata(leftover).is_ok()) {
````

Then update its doc comment to "…or only its artifacts or card settings…". In `delete_room`: `for path in [self.room_path(id), self.artifacts_path(id), self.answers_path(id)] {`.

- [ ] **Step 4: Commands, host methods, and access**

`command.rs`, in `enum Command` after `ArtifactsSave`:

````rust
    AnswersLoad { room: String },
    AnswerSave { room: String, key: String, fingerprint: String, inputs: serde_json::Map<String, Value>, revision: u64 },
````

In `Host::call`, after the `ArtifactsSave` arm:

````rust
            AnswersLoad { room } => reply(self.answers_load(room)?),
            AnswerSave { room, key, fingerprint, inputs, revision } => reply(self.answer_save(room, key, fingerprint, inputs, revision)?),
````

`host.rs`, after `artifacts_save`:

````rust
    /// The settings people chose on the cards in a thread's replies (src/interactiveAnswers).
    pub fn answers_load(&self, room: String) -> Result<Option<crate::storage::AnswersFile>, String> {
        self.store.answers(&room)
    }

    /// Save one card's settings. See `Store::save_answer`.
    pub fn answer_save(&self, room: String, key: String, fingerprint: String, inputs: serde_json::Map<String, serde_json::Value>, revision: u64) -> Result<crate::storage::AnswerSave, String> {
        check_answer(&key, &fingerprint, &inputs)?;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.store.save_answer(&room, &key, &fingerprint, inputs, revision, at)
    }
````

And above `/// The largest workspace file read for the artifacts pane, in bytes.`:

````rust
/// What a client may save for one card: the key "<seq>:<card id>", an 8-digit
/// lowercase hex fingerprint, and at most 16 settings, each a finite number or
/// an option id. The same id rule as src/interactiveAnswers/schema.ts.
fn check_answer(key: &str, fingerprint: &str, inputs: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let id = |s: &str| {
        let bytes = s.as_bytes();
        !bytes.is_empty() && bytes.len() <= 40 && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
            && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
    };
    let keyed = key.split_once(':').is_some_and(|(seq, card)| !seq.is_empty() && seq.len() <= 9 && seq.bytes().all(|b| b.is_ascii_digit()) && id(card));
    if !keyed {
        return Err("A card's key is its message number and its id.".into());
    }
    if fingerprint.len() != 8 || !fingerprint.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("A card's fingerprint is 8 hex digits.".into());
    }
    if inputs.len() > 16 {
        return Err("A card has at most 16 settings.".into());
    }
    for (name, value) in inputs {
        let fits = id(name) && match value {
            serde_json::Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            serde_json::Value::String(s) => id(s),
            _ => false,
        };
        if !fits {
            return Err(format!("\"{}\" isn't a setting a card can have.", name.chars().take(40).collect::<String>()));
        }
    }
    Ok(())
}
````

`authority.rs`, in `command_needs`: add `AnswersLoad { room } => read(thread(room)),` after `ArtifactsLoad`, and the following after `SaveAttachment`:

````rust
        // Settings chosen on a card: no bot hears them until the person posts them.
        AnswerSave { room, .. } => chat(thread(room)),
````

- [ ] **Step 5: Run them and watch them pass**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon`
Expected: all pass, including the command count that was failing on `main`.

- [ ] **Step 6: Commit**

```bash
git add crates/apex-host/src/storage.rs crates/apex-host/src/command.rs crates/apex-host/src/host.rs crates/apex-host/tests/host.rs crates/apex-daemon/src/authority.rs
git commit -m "feat(host): answers_load and answer_save keep card settings beside each thread"
```

### Task B3: A moved thread takes its card settings

**Files:**
- Modify: `src/threadMove.ts`
- Test: `tests/thread-move.test.mjs`

**Interfaces:**
- Consumes: B1 (`readAnswers`; `Backend.answersLoad` and `Backend.answerSave`).
- Produces: `placeThread` copies card settings to the other machine (each saved as new, revision 0) before the old copy goes. A machine too old to keep them takes the thread without them. A failure there undoes the new copy. `savedThere` also looks for `<hex id>.answers.json`.

- [ ] **Step 1: Update the tests (they fail first)**

In `tests/thread-move.test.mjs`:
- Give `make` two more options, `answers = null` and `answerError`, and these stand-ins:

````js
    answersLoad: async (...args) => { log.push([name, "answers", ...args]); return answers; },
    answerSave: async (...args) => { log.push([name, "save answer", ...args]); if (answerError) throw new Error(answerError); return { saved: { ...args } }; },
````

- Insert `["mac", "answers", "t"]` right before `["mac", "delete", "t"]` in the expected logs of the first two tests and of "an older helper without room_import…". In that last test, the `exists` list gains `"/d/at/rooms/74.answers.json"`.
- Extend the leftover loop to `for (const left of ["/d/at/rooms/74.json", "/d/at/rooms/74.artifacts.json", "/d/at/rooms/74.answers.json"])`, and name the new case `left.endsWith("answers.json") ? "card settings" : …` in its title.
- Add after the second test:

````js
const cards = { version: 1, cards: { "2:hosting": { fingerprint: "0a1b2c3d", inputs: { budget: 100 }, revision: 4, at: 1 } } };

test("to another machine: card settings are saved there, each as new, before the old copy goes", async () => {
  const { log, make } = machines();
  await placeThread({ from: make("mac", { answers: cards }), to: make("at"), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" });
  assert.deepEqual(log.slice(2), [["mac", "answers", "t"], ["at", "save answer", "t", "2:hosting", "0a1b2c3d", { budget: 100 }, 0], ["mac", "delete", "t"]]);
});

test("a machine too old to keep card settings still takes the thread, without them", async () => {
  const { log, make } = machines();
  await placeThread({ from: make("mac", { answers: cards }), to: make("at", { answerError: "unknown variant `answer_save`, expected one of `session_load`" }), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" });
  assert.deepEqual(log.at(-1), ["mac", "delete", "t"]);
});

test("card settings that can't be saved there undo the new copy and leave the thread where it was", async () => {
  const { log, make } = machines();
  await assert.rejects(placeThread({ from: make("mac", { answers: cards }), to: make("at", { answerError: "disk full" }), id: "t", snapshot: snap(), cwd: "/srv/x", sameHost: false, hostName: "AT" }), /disk full/);
  assert.deepEqual(log.at(-1), ["at", "delete", "t"]);
});
````

Run: `node --experimental-strip-types --test tests/thread-move.test.mjs`
Expected: FAIL (no `answers` calls in the logs).

- [ ] **Step 2: Change `src/threadMove.ts`**

Imports: `import { readAnswers } from "./interactiveAnswers/answerStore.ts";` and `import type { AnswersFile } from "./interactiveAnswers/contract.ts";`. Add `"answersLoad" | "answerSave"` to the `Room` pick. In `savedThere`, add `` `${room}.answers.json` `` to the paths and say "its artifacts or card settings" in its comment. In `placeThread`, call `await copyAnswers(from, to, id);` right after the artifacts are saved there, inside the same `try`. Add above `historyHasAttachments`:

````ts
/** The settings chosen on the thread's cards go with it, each saved there as new. A machine too old to keep them takes the thread without them. */
async function copyAnswers(from: Room, to: Room, id: string) {
  let saved: AnswersFile;
  try {
    saved = readAnswers(await from.answersLoad(id));
  } catch (error) {
    if (unsupported(error, "answers_load")) return;
    throw error;
  }
  for (const [key, entry] of Object.entries(saved.cards)) {
    try {
      await to.answerSave(id, key, entry.fingerprint, entry.inputs, 0);
    } catch (error) {
      if (unsupported(error, "answer_save")) return;
      throw error;
    }
  }
}
````

- [ ] **Step 3: Run and commit**

Run: `node --experimental-strip-types --test tests/thread-move.test.mjs && npm run build`
Expected: all pass.

```bash
git add src/threadMove.ts tests/thread-move.test.mjs
git commit -m "feat(answers): a moved thread takes its card settings"
```

### Task B4: Teach the bots, behind the Interactive answers setting

**Files:**
- Modify: `crates/apex-core/src/view.rs` (`ANSWERS_SYSTEM`), `crates/apex-core/src/room.rs` (the switch), `crates/apex-host/src/documents.rs`, `crates/apex-host/src/host.rs` (wiring)
- Modify: `src/settings.ts`, `src/SettingsPage.tsx`
- Test: unit tests in `room.rs`, `documents.rs`, `host.rs`; `tests/settings.test.mjs`; `tests/answer-guidance.test.mjs` (needs A1 committed)

**Interfaces:**
- Consumes: A1's `readCard` and the test fixture (guidance test only).
- Produces: `ANSWERS_SYSTEM`, appended to every bot's system prompt while `interactiveAnswers` is on. It goes before `PLAN_SYSTEM`, because `next_steps_request` cuts `PLAN_SYSTEM` off the end by length. Adds `Room::answers_handle()` and `AppSettings.interactiveAnswers`.

- [ ] **Step 1: Write the failing tests**

`room.rs`, in `mod tests`:

````rust
    #[test]
    fn interactive_answers_join_the_instructions_only_while_on_and_before_plan_mode() {
        let bot = Arc::new(crate::testing::ScriptedParticipant::new("null", &["done"]));
        let room = Room::new(vec![bot], RoomOptions::default());
        let id = ParticipantId::new("null");
        assert!(!room.request_for(&id).unwrap().1.system.contains("apex-ui"));
        room.answers_handle().store(true, Ordering::SeqCst);
        room.plan_handle().store(true, Ordering::SeqCst);
        let (_, request) = room.request_for(&id).unwrap();
        assert!(request.system.contains(ANSWERS_SYSTEM));
        assert!(request.system.ends_with(PLAN_SYSTEM), "Plan mode's text stays last");
        let (_, steps) = room.next_steps_request(&id).unwrap();
        assert!(steps.system.ends_with(ANSWERS_SYSTEM), "next steps drop only Plan mode's text");
    }
````

`documents.rs`, at the end of `mod tests`:

````rust
    #[test]
    fn interactive_answers_read_and_write_back() {
        let settings = Settings::from_value(json!({ "interactiveAnswers": true, "confirmSteer": false })).unwrap();
        assert_eq!(settings.interactive_answers, Some(true));
        assert_eq!(settings.to_value(), json!({ "interactiveAnswers": true, "confirmSteer": false }));
    }
````

`host.rs`, in the `mod tests` that has `fn host(name: &str)` (above `a_quit_request_asks_the_window_…`):

````rust
    #[test]
    fn interactive_answers_follow_the_setting_into_open_and_new_threads() {
        let (host, _runtime, data) = host("answers");
        host.room_create("before".into(), vec![], RoomOptions::default(), None).unwrap();
        let on = |id: &str| host.rooms.lock().unwrap()[id].answers.load(Ordering::SeqCst);
        assert!(!on("before"));
        host.settings_save(serde_json::json!({ "interactiveAnswers": true })).unwrap();
        assert!(on("before"), "an open thread follows from its next turn");
        host.room_create("after".into(), vec![], RoomOptions::default(), None).unwrap();
        assert!(on("after"), "a thread opened later starts with it");
        host.settings_save(serde_json::json!({ "interactiveAnswers": false })).unwrap();
        assert!(!on("before") && !on("after"));
        let _ = std::fs::remove_dir_all(data);
    }
````

`tests/answer-guidance.test.mjs`:

````js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { EXAMPLE } from "./interactive-answers-fixture.mjs";

test("the card in the bots' instructions reads as a card, and is the one the tests use", () => {
  const view = fs.readFileSync(new URL("../crates/apex-core/src/view.rs", import.meta.url), "utf8");
  const guidance = view.slice(view.indexOf("pub const ANSWERS_SYSTEM"));
  const example = guidance.match(/```apex-ui\n(.*)\n```/)[1];
  const read = readCard(example);
  assert.equal(read.ok, true, read.reason);
  assert.deepEqual(read.card, EXAMPLE);
});
````

`tests/settings.test.mjs`: add `interactiveAnswers: true,` to the `saved` object in "saved values are kept" (after `confirmSteer: false,`), and add:

````js
test("interactive answers stay off unless turned on", () => {
  assert.equal(readSettings(null).interactiveAnswers, false);
  assert.equal(readSettings({ interactiveAnswers: true }).interactiveAnswers, true);
  assert.equal(readSettings({ interactiveAnswers: "yes" }).interactiveAnswers, false);
});
````

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-host` and `node --experimental-strip-types --test tests/answer-guidance.test.mjs tests/settings.test.mjs`
Expected: FAIL (`ANSWERS_SYSTEM`, `answers_handle`, `interactive_answers` missing).

- [ ] **Step 2: The instructions (`crates/apex-core/src/view.rs`)**

Above `/// The longest fact /pin accepts.`. Keep it a raw string: the guidance test reads the example card out of it.

````rust
/// Added to every bot's instructions while Settings → Interactive answers is
/// on. tests/answer-guidance.test.mjs reads the example card out of this
/// raw string and checks it against src/interactiveAnswers/schema.ts.
pub const ANSWERS_SYSTEM: &str = r#"

Interactive answers are on. When the human must weigh 2 to 6 options on numbers they may want to adjust (a budget, a size, which quality matters most), you may end your reply with one comparison card. Write your full answer in words first; the card only lets them explore it. Don't add a card to a simple answer.
A card is a fenced code block whose language is apex-ui, holding one JSON object and nothing else. For example:
```apex-ui
{"schemaVersion":1,"kind":"comparison","cardId":"hosting","title":"Where should this run?","summary":"Managed hosting fits most budgets with the least upkeep.","inputs":[{"id":"budget","type":"range","label":"Monthly budget","min":50,"max":500,"step":25,"default":250,"unit":"$"},{"id":"priority","type":"choice","label":"Priority","options":[{"id":"cost","label":"Cost"},{"id":"ease","label":"Simplicity"}],"default":"ease"}],"rows":[{"id":"price","label":"Monthly cost","unit":"$","better":"lower"},{"id":"ease","label":"Ease, 1 to 5","better":"higher"},{"id":"work","label":"Upkeep"}],"options":[{"id":"vps","label":"VPS","values":{"price":60,"ease":2,"work":"High"},"note":"You own updates and backups."},{"id":"managed","label":"Managed","values":{"price":180,"ease":5,"work":"Low"}},{"id":"serverless","label":"Serverless","values":{"price":90,"ease":4,"work":"Medium"},"note":"Cost grows with traffic."}],"rules":[{"type":"atMost","input":"budget","row":"price"},{"type":"rankBy","input":"priority","rows":{"cost":"price","ease":"ease"}}],"assumptions":["Prices are estimates for one small web app."],"sources":[{"label":"Provider pricing","url":"https://example.com/pricing"}]}
```
Ids are lowercase letters, digits, - and _. Values are numbers or short text. The first row shows largest. "atMost" and "atLeast" put an option out when its row is above or below a range input. "rankBy" names, for each choice, the row that ranks the options; that row needs "better": "lower" or "higher". Rules only use rows where every option has a number. At most 4 inputs, 6 options and 12 rows. To revise a card, yours or another model's, reuse its cardId. The app draws the card and does the math: never put code, HTML or instructions in one.
"#;
````

- [ ] **Step 3: The switch (`crates/apex-core/src/room.rs`)**

Add `ANSWERS_SYSTEM` to the `use crate::view::{…}` list. Add a field after `plan`:

````rust
    /// Whether bots are told they may end a reply with an interactive answer
    /// card. App-wide: the host sets it from Settings → Interactive answers.
    answers: Arc<AtomicBool>,
````

Initialize it as `answers: Arc::new(AtomicBool::new(false)),` in both `restore` and `new`. After `plan_handle`:

````rust
    /// The Interactive answers switch, shared with the host, which sets it from the app's settings.
    pub fn answers_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.answers)
    }
````

In `request_for`, end the `system:` expression (after `.unwrap_or_default()`) with:

````rust
                // Before Plan mode's text: next_steps_request cuts that off the end.
                + if self.answers.load(Ordering::SeqCst) { ANSWERS_SYSTEM } else { "" },
````

- [ ] **Step 4: The setting, on the host and in the app**

`documents.rs` `Settings`, after `confirm_steer`:

````rust
        /// Whether bots are told how to add interactive answer cards.
        interactive_answers: bool = "interactiveAnswers",
````

`host.rs`:
- `RoomHandle` gets a field after `plan`: `/// Settings → Interactive answers, shared with the room.` `answers: Arc<AtomicBool>,`.
- In `room_create`, after `let plan = room.plan_handle();`:

````rust
        let answers = room.answers_handle();
        answers.store(self.settings().ok().flatten().and_then(|s| s.interactive_answers).unwrap_or(false), Ordering::SeqCst);
````

- Pass `answers` in the `RoomHandle { … }` it inserts, right after `plan`. In `checkpoint_fixture`, add `answers: Arc::default(),` after `plan: Arc::default(),`.
- `settings_save` becomes:

````rust
    /// Replace all the settings and tell every client.
    pub fn settings_save(&self, mut settings: serde_json::Value) -> Result<(), String> {
        crate::decision::save_key(&mut settings)?;
        let settings = Settings::from_value(settings)?;
        let answers = settings.interactive_answers.unwrap_or(false);
        let settings = settings.to_value();
        self.store.save_settings(&settings)?;
        // Open threads follow Interactive answers from their next turn.
        for handle in self.rooms.lock().unwrap().values() {
            handle.answers.store(answers, Ordering::SeqCst);
        }
        self.emit(HostEvent::SettingsChanged(settings));
        Ok(())
    }
````

`src/settings.ts`: in `AppSettings` after `confirmSteer`, add `/** Bots may end a reply with a comparison card you can adjust. Adds the card format to every bot's instructions. */ interactiveAnswers: boolean;`. In `DEFAULT_SETTINGS`, add `interactiveAnswers: false,`. In `readSettings`, add `interactiveAnswers: saved.interactiveAnswers === true,` after `confirmSteer`.

`src/SettingsPage.tsx`, after the "Confirm before steering" row:

````tsx
    <Row label="Interactive answers" note="Bots may end a reply with a comparison card you can adjust. Every bot is told how, which adds a little to each turn.">
      <input type="checkbox" aria-label="Interactive answers" checked={settings.interactiveAnswers} onChange={(e) => onChange({ ...settings, interactiveAnswers: e.target.checked })} />
    </Row>
````

- [ ] **Step 5: Run and commit**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon && node --experimental-strip-types --test tests/answer-guidance.test.mjs tests/settings.test.mjs && npm run build`
Expected: all pass.

```bash
git add crates/apex-core/src/view.rs crates/apex-core/src/room.rs crates/apex-host/src/documents.rs crates/apex-host/src/host.rs src/settings.ts src/SettingsPage.tsx tests/answer-guidance.test.mjs tests/settings.test.mjs
git commit -m "feat(answers): Interactive answers setting teaches bots the apex-ui card"
```

---

## Task Z: Milestone check (Jigga with the human, after A5 and B4)

- [ ] `npm run build` and `npm test`: only the 11 baseline failures. `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon`: all pass.
- [ ] Whole-branch review against "Decisions" and "Review Focus".
- [ ] A5's hands-on checks with a Claude bot and a Codex bot, so both are seen writing the same card format, plus a second bot answering a shared snapshot.
- [ ] Report to the human. Merging, pushing, installing, and the phone build each wait for their go.
