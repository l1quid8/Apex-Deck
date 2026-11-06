# CLI per-agent, per-thread settings panel — build plan

Design: `mockups/apex-cli-v6.html` (approved by Null 2026-11-05). v5 is superseded; do not build from it.
Lead: Jigga. Branch: `feat/cli-agent-settings` (create with `git switch -c`).

## Goal

From any thread, Shift-Tab opens a quiet settings panel above the composer for one agent at a
time. It sets Model, Reasoning, Speed and Access **for this thread only**. The bottom line shows
only `★ Name  ★ Name … ⇧Tab settings`.

## What already exists (verified in source)

No daemon or host changes are needed.

- **Work threads:** `room_update_participant {id, participant, base}` replaces model, effort,
  speed and access, including while a turn is running (`Room::replace_turn_settings`,
  `crates/apex-core/src/room.rs:814`). `base` gives stale-save protection.
- **Talk-only chats:** `chat_update_participant {id, participant, patch}`. The patch takes
  `model`, `effort` and `speed`, but not access (`crates/apex-host/src/chat_bots.rs:35`). Access
  stays Read.
- **Models and reasoning levels:** `agent_models` / `room_bot_models` return `ModelChoice
  {id, label, efforts}` (`crates/apex-core/src/types.rs:153`). `efforts: None` means unknown,
  and `[]` means the model has no reasoning setting. The CLI already calls these in
  `controller.rs::model_query`.
- **Speed:** `Option<Speed>` with values `standard` and `fast`. Leaving it unset follows the
  tool's own default. It is offered only where the desktop offers it (`src/speed.ts::supportsSpeed`):
  `codex` and `claude_code` agents, plus OpenAI-compatible bots whose base URL is exactly
  `https://api.openai.com/v1`. Port that rule as-is.
- **Usage:** `snapshot.usage[participant_id]`, already read by `/usage`.

## Tasks and owners

### Task 1 — panel state and key handling (`crates/apex-cli/src/state.rs`, `runtime.rs`)

- Add `SettingsPanel { agent: usize, row: Row, pending_access: Option<Access>, confirm_full: bool, saving: Option<Row>, error: Option<String> }`
  to the client state. Only one panel can be open.
- Key order: when the panel is open, it gets keys **before** the `/` and `@` menus and the
  composer.
  - `⇧Tab` (crossterm `BackTab`) opens the panel, or closes it if already open. The draft is kept.
  - `Tab` moves to the next ★ agent, then wraps to any other agent in the thread.
  - `↑↓` moves between rows. Leaving Access drops `pending_access`.
  - `←→` changes Model, Reasoning or Speed straight away (Task 2). On Access, they only
    move `pending_access`.
  - `Enter` on Access applies the pending level. If the level is Full, it first sets
    `confirm_full`, and a second `Enter` applies it.
  - `Esc` cancels the Full confirmation, then the pending access, then closes the panel. It
    **never** stops agents while the panel is open. With the panel closed, Esc keeps its
    current behaviour.
- `/model` and `/access` open the panel on their row instead of the old menus. Remove the old
  menus completely (no fallback).

### Task 2 — saving (`controller.rs`)

- Add one function, `save_setting(agent, change)`. It builds `room_update_participant` (Work)
  or `chat_update_participant` (Chat) from the participant **as last received** and passes it
  as `base`.
- While the save is in flight, show a dim `saving…` beside the value. The panel and the bottom
  line keep showing the old value until the reply comes back.
  - **Success:** clear `saving` and take the new value from the next room state. No ✓.
  - **Refused (stale base, validation, old daemon):** put the old value back and show the reason
    in red on the footer line.
- Only one save per agent at a time. Ignore arrow presses on that agent until the reply comes
  back. This keeps rapid ←→ presses from racing each other with stale `base` values.
- **Changing model:** if the current reasoning level isn't in the new model's `efforts`, send
  `effort: null` with the model change, so the agent falls back to the model's default.
- **Reasoning:** the list is the model's `efforts` plus "Default". If `efforts` is `[]`, show
  "not offered" and ignore arrow presses. If `efforts` is unknown, show the levels the desktop
  falls back to for that tool (check `BotSettings.tsx`; don't invent a list).
- **Speed:** Default · Standard · Fast. Show "not offered" when `supportsSpeed` is false.
- **Access in chats:** show `Read` with "Work threads only", and ignore all access keys.
- If the agent is busy, show the footer hint "applies from its next turn".

### Task 3 — rendering (`ui.rs`), matching v6 exactly

- Draw the panel as 7 lines above the composer:
  - a title line with the agent's name, `this thread` and `n of m · Tab next`
  - Model, Reasoning, Speed and Access rows, each showing `◂ value ▸`
  - one dim usage line
  - one footer line
- Colour: only the focused value is highlighted in cyan. Red appears only for errors. No amber,
  green or ✓.
- Footer text, depending on state:
  - normal: `←→ change · Enter apply access · Esc close`
  - pending access: `Enter applies Full · now Edits · Esc cancels`
  - Full confirmation: `<Name> can run commands without asking. Enter yes · Esc no`
  - error: the reason, in red
- Bottom status line: dim `★ Name` entries on the left and `⇧Tab settings` on the right.
  Reserve room for `⇧Tab settings` first, then fold any agents that don't fit into `+N ★`.
- Size the logo and diamond from the space left **after** the panel, using the same budget code
  as the composer.
- At 80×24, Reasoning becomes a single `◂ value ▸` value, as in the mockup's Small window tab.

### Task 4 — tests

- `tests/visuals.rs`: render-text checks for each v6 tab state at 120×40 and 80×24. No line may
  be wider than the window, and `⇧Tab settings` must stay visible with 6 ★ agents.
- `tests/state.rs`: key-routing unit tests:
  - Esc with the panel open while agents are busy closes the panel and stops nothing.
  - Leaving the Access row drops the pending level.
  - Full needs two Enters.
  - Arrow presses are ignored while a save is in flight.
  - The draft survives opening and closing the panel.
- `tests/integration.rs`, against the throwaway test daemon:
  - change model, reasoning and speed in a Work thread, then check a second client sees the change
    and the saved agent's defaults are unchanged
  - send a change with a stale `base` → the old value comes back and the error is shown
  - change settings in a chat → the chat patch is used and access is not sent
- `cargo test -p apex-cli`, then `npx tsc --noEmit`.

### Task 5 — real-terminal check (owed, not automatable)

In Ghostty with a clean environment against `~/.apex`, check that:

- ⇧Tab is delivered as BackTab
- Esc does not stop a running agent while the panel is open
- a speed change in the CLI shows up in the desktop's per-chat settings

## Owners

Jigga builds Tasks 1–4. Null reviews before merge. The user runs Task 5, or Jigga runs it in a
hidden terminal with step records.

## Out of scope

- "Save as this agent's default": `/agents edit` already does this.
- Media settings.
- Usage history.
- Any daemon or protocol change.
