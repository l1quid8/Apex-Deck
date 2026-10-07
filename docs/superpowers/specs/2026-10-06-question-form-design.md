# Question form above the composer

Status: agreed 2026-10-06. When a bot asks the person something mid-task, or
when a reply is done and there are obvious next moves, Deck shows a
multiple-choice form attached to the top of the composer, the way Claude and
ChatGPT do. Every form has an "Other…" row for a typed answer.

## Why
- Claude's `AskUserQuestion` tool and Codex's ask-the-user request reach Deck
  today and are refused ("Apex Deck does not support this request"), so the bot
  gives up or guesses.
- After a reply the next move is usually obvious ("commit it", "check it in the
  app"). The `next-steps` Claude Code plugin offers these in the terminal, but it
  draws on the terminal's prompt band, so it shows nothing in Deck and does not
  exist for Codex, Gemini or Grok. Deck borrows its method instead.
- The form belongs on the composer, not under a reply: it is waiting on the
  person, and that is where they look.

## Two sources, one form

### Mid-task questions (Claude, Codex)
- **Claude.** Every Claude turn already runs with `--permission-prompt-tool
  stdio` (`presets.rs`). A `can_use_tool` request whose `tool_name` is
  `AskUserQuestion` becomes a question instead of an approval card. The answer
  goes back as an allow `control_response` whose `updatedInput` is the tool's
  input plus the answers; a skip is a deny with the message "The person skipped
  this question." The turn continues with the answer.
- **Codex.** Its ask-the-user server request is answered the same way instead
  of the current `-32601` refusal in `codex_server.rs`.
- **Open checks, done before anything builds on them:**
  1. Under `--permission-mode bypassPermissions` (Full access), does Claude still
     send `AskUserQuestion` through `can_use_tool`, or answer it itself?
  2. Does Codex send its ask-the-user request outside plan mode? If it never
     does in a normal chat, Codex questions are left out for now and only Claude
     gets mid-task questions.

### Next steps (every bot)
Deck does not keep a live session per bot: each turn starts fresh and is handed
the whole transcript (`TurnRequest.turns`). So "fork the bot" is one more short
turn of the same participant:
- Same `system` and `turns` as the reply that just finished, plus the reply,
  plus the plugin's question: predict up to 3 next prompts in the person's
  voice, as a JSON array of `{label, prompt}`, or `[]` when the conversation is
  clearly finished or nothing useful comes to mind.
- One added line: if the reply ends by asking the person something in plain
  text, the suggestions are answers to that question.
- The fork runs read-only, with no tools and `NoApprover`, so it can never edit,
  run or approve anything. The prefix is identical to the reply's, so Claude and
  Codex prompt caches make it cost about one short reply.
- Skipped when: the reply is under 80 characters, the reply failed or was
  stopped, a mid-task question is open for that thread, or another message has
  arrived since the reply.
- Timeout 20 s. Failure, timeout or unparseable output shows nothing and
  reports nothing.
- A late result (a newer reply or message exists) is dropped.
- Output is cleaned in the host with the plugin's rules before it leaves for any
  client: refuse text with Unicode tag characters; strip terminal escapes,
  control, format, unassigned, private-use and surrogate characters, variation
  selectors and blank-rendering letters; fold whitespace; at most three
  combining marks in a row; label ≤ 48 characters, prompt ≤ 600.

## The waiting list
- One list per thread on the host, built like `ApprovalDesk`: a question is
  opened with an id, resolved once (first answer wins; a second resolve returns
  false), and dropped with a reason.
- Order: mid-task questions first, oldest first; then the thread's current next
  steps (at most one set; a newer set replaces it).
- Events reach desktop and phone through the same stream as
  `approval_requested` / `approval_resolved`: `question_requested`,
  `question_resolved` (with how: answered, skipped, dropped), `next_steps`
  (list, possibly empty to clear).
- Answering posts the person's message in the transcript, addressed to the bot
  that asked: the chosen label(s) or the typed text. For a mid-task question the
  same text also goes back to the paused turn; for a next step it is sent as a
  new message right away.

## The form

### Desktop
```
┌─ 🟣 Claude asks · 1 of 2 ───────────────────────── ✕ ┐
│ Which database should the sync use?                 │
│ ❯ 1  SQLite (Recommended)                           │
│      One file, no setup                             │
│   2  Postgres                                       │
│      Needs a running server                         │
│   3  Other…  [ type your own answer          ] ↵    │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ Message Claude…                                     │
└─────────────────────────────────────────────────────┘

  Next ─────────────────────────────────────────── ✕
   1  Commit the fix    2  Check it in the app    3  Rebuild the DMG
```
- Attached to the top of the composer, its full width, above the existing
  who's-working line.
- A mid-task question is a full card: bot name and avatar, "n of m" when more
  wait, the question, options with their descriptions, and "Other…".
- Multi-select questions show checkboxes and a Submit button. A request with
  several questions steps through them with Back / Next and sends all answers
  together.
- A question with no options shows only the question and the "Other…" box.
- Next steps are one compact row of buttons so they never look as urgent as a
  paused bot. While the fork runs, a faint "next steps…" holds the place.

### Keyboard
- `1`–`4` pick an option and `↑`/`↓` + `Enter` move and pick, only while the
  composer is empty (numbers can still be typed in a message).
- `Esc` dismisses next steps. On a mid-task question it only collapses the card
  to a one-line "Claude is waiting on you" bar; the bot stays paused.
- `✕` on a question skips it and tells the bot so.
- The top next step is the empty composer's ghost text; `Tab` puts it in the box
  as a draft to edit.

### Phone
- The same form above the phone composer. Options are full-width rows at least
  44 pt tall; next steps are a sideways-scrolling row of chips; tapping
  "Other…" focuses that row's field.
- A mid-task question counts as "needs you" in the attention list and phone
  notifications, like an approval card. Next steps do not.

## Edge cases
| Situation | Behaviour |
|---|---|
| Stop pressed, or the turn fails, with a question open | Question dropped; the form closes |
| Host restarts mid-question | Dropped, as open approvals are; muted line "Claude's question was dropped when Deck restarted" |
| Desktop and phone both answer | First wins; the other closes with "Answered on your phone" / "on desktop" |
| Two bots ask at once | Both queued ("1 of 2"); each answer goes only to its asker |
| A normal message is sent while a question is open | Sent as normal; the question stays; next steps clear |
| Thread move with a question open | A paused question counts as still working; the move asks to answer or skip first |
| Fork fails, times out or returns junk | Nothing shown |
| New reply or message while the fork runs | Fork result dropped |

## Testing
1. Run the two open checks above against the real `claude` and `codex` with a
   throwaway prompt in a scratch folder, and report before building on them.
2. Rust: fake Claude and Codex scripts (as in `crates/apex-adapters/tests/adapters.rs`)
   ask a question and the answer goes back in each one's format; skip goes back
   as a deny; fork output parsing with cleaning, the 3-item cap and `[]`; a late
   fork result is dropped; a second resolve of the same question is refused;
   drops on stop and on restart.
3. TypeScript: the order of what the form shows, the empty-composer rule for
   number keys, `Esc` collapsing versus `✕` skipping, multi-question stepping.
4. Real app: a hidden second Deck with its own `APEX_DECK_DATA_DIR`, driven with
   a scripted bot: a question appears above the composer, answering resumes the
   bot, next steps appear and a click sends one. Screenshots of desktop and of
   the phone layout at phone width.

## Not in scope
- Bots writing their own choices block in replies (the fork replaces it).
- Approval cards keep their current place and look.

## Plan switch (added 2026-10-06)

Probes: `docs/superpowers/notes/2026-10-06-question-probes.md`. Codex only asks
questions in its planning mode, and planning mode forbids edits, so planning
becomes a switch the person turns on and off.

- **Where:** "Plan" in the composer's `+` menu, and `/plan`. Both toggle it.
  Saved with the thread; stays on until turned off.
- **Shows as:** a small cyan chip, "◇ Plan ✕", the TL;DR pill's size, first in
  the bot row under the message box (just ◇ when the row is folded). The
  message box border turns steady cyan (`#1ed7ee`, no animation) and the hint
  reads "Plan with the bots — nothing gets changed…". Bots at work show
  "Planning…". TL;DR's glow wins the border when both are on.
- **Every bot plans:** each turn runs read-only and its system prompt says to
  explore, change nothing, ask what only the person can decide, and end with
  a step-by-step plan.
  - Codex: its own planning mode (`collaborationMode: plan`); its
    `item/tool/requestUserInput` questions use the form.
  - Claude Code: `--permission-mode plan`. When it calls `ExitPlanMode`, Deck
    shows an approval card, "Start the work?". Approve: Plan turns off for the
    thread and Claude carries on in the same turn with its own access
    (`setMode`: Full → bypassPermissions, Edits → acceptEdits, Ask → default).
    Keep planning: denied with "The person wants to keep planning." A
    read-only bot's request is denied without a card ("This bot can only
    read").
  - Other agents and API bots: read-only plus the instruction.
  - Custom command bots cannot be held to read-only, so they sit out while
    Plan is on, with a line saying so.
- **Phone:** shows the chip; ✕ turns Plan off. Turning it on is desktop-only
  for now.
