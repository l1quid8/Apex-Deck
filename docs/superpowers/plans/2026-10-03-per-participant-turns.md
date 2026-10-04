# Per-participant turns and a compact queue

Written 2026-10-03 by Jigga for Null to build on `feat/thread-commands`. Approved direction: the person can talk to an idle model while another model keeps working, without interrupting it.

## Why it blocks today

The lock is in Rust as well as the UI, so a UI change alone won't fix it.

- `room_post` (`src-tauri/src/lib.rs:237`) holds `tokio::sync::Mutex<Room>` for the whole of `Room::post_human`, including every wave and bot hop. A second post waits for the lock.
- `Room` has one `stop: Arc<AtomicBool>` (`crates/apex-core/src/room.rs:421`). Stop and Steer end every running turn, and `post_human` clears the flag at the start.
- `src/turnQueue.ts` has one queue per room, and `ChatPane.tsx` has one `busy` flag that switches the composer into Queue/Steer/Stop mode.

## Goal

- A message to an idle model starts right away, even while another model is working.
- A message to a busy model waits in that model's queue only.
- Stop and Steer apply to one model.
- Only one model edits files at a time.
- The queue takes one line, and the composer keeps its normal size.

## Targeting rules (unchanged)

Keep `targets_for_human` exactly as it is: @mentions, then the room policy (sticky mention, everyone, round-robin). The only change is the frontend asking the backend for the resolved targets before queuing, so it knows which models are busy. (Correction to my chat message: an unmentioned message does not go to Everyone under the default policy. It goes to the last targets.)

## Design

### 1. Rust: run turns without holding the room lock

`crates/apex-core/src/room.rs`

- Split `post_human` into phases. Each phase takes the lock only briefly.
  1. `begin_post(text) -> Vec<ParticipantId>`: push the human message and resolve the targets.
  2. `request_for(id)` (already exists): build the request while holding the lock.
  3. Run `interruptible(...)` **without** the lock.
  4. `settle(id, shown, outcome)`: take the lock again, push the reply, update cursors and changes, and return the addressed ids.
- Change `stop` to `HashMap<ParticipantId, Arc<AtomicBool>>` (one flag per participant). Add `stop_handle(id)`. Clear a participant's flag when **its** turn starts, not on every post.
- Bot hops: after a reply settles, hop to each addressed participant that is idle and has not reached the hop limit. If the addressed participant is busy, add the hop to that participant's queue (see 2). Keep `max_bot_hops` per chain by carrying a hop count with each queued turn.
- Keep `run_wave` for the existing parallel and round-robin behaviour inside one chain. Two different chains may now run at the same time.
- Order the transcript by settle time. `seq` stays the push index, which already happens. A model that started earlier may see messages added after its request was built in its next turn's `unseen`. That is correct.

`src-tauri/src/lib.rs`

- Replace `room_post` with:
  - `room_targets(id, text) -> Vec<String>`: a dry-run of the target resolution that does **not** update `last_targets`.
  - `room_post_to(id, text, targets)`: pushes the message once and starts one task per target. It returns after the human message is saved. Turn results still arrive as `room-event`s.
  - `room_turn(id, participant)`: runs the next queued turn for that participant (called from the frontend queue; see 2).
- `room_stop(id, participant: Option<String>)`: `None` stops everything (the current behaviour), and `Some` stops one model. Only reject approvals that belong to that participant. `ApprovalDesk` needs `reject_for(id)`.
- Saving: `store.save_room` can now run from concurrent tasks. Protect the checkpoint with one `Mutex<SavedRoom>` per room on `RoomHandle` instead of a local in `room_post`, so two chains don't overwrite each other's transcript.
- Emit `RoomEvent::Idle { id }` per participant as well as the existing room-wide `Idle` when nothing is running.

### 2. Frontend: one queue per participant

`src/turnQueue.ts` becomes `ParticipantQueues`:

```ts
interface QueuedMessage { id: number; text: string; kind: TurnKind; to: string[] } // to = resolved targets
state: Record<participantId, "idle" | "working">
```

- `send(text)`: call `roomTargets`. If all targets are idle, `roomPostTo` right away. Otherwise post the message **once, when the last busy target is free**. Simpler alternative that I recommend: post immediately to the idle targets, and queue one copy for each busy target as a `room_turn` (the human message is already in the transcript, so the busy model reads it as unseen on its next turn). No duplicate human messages.
- `steer(id, text)`: stop that participant only, then put the text at the front of that participant's queue.
- `halt(id?)`: per participant or everyone.
- `/compact` and `/clear` still need the whole room idle. Keep the room-wide check (`busy` = any participant working).
- Keep the pause-on-error behaviour, per participant.
- Rewrite `tests/turn-queue.test.mjs` for the new class. It needs at least these tests:
  - Idle Jigga starts while Null is working.
  - A message for busy Null waits and runs when Null's turn ends.
  - Steering Null leaves Jigga's turn running.
  - Stopping one model leaves the other's queue intact.
  - An error pauses only that participant.

### 3. One editor at a time

- Room state holds `editor: Option<ParticipantId>`. It is set when a turn **with `Access` Ask, Edits or Full** starts, and cleared when that turn settles.
- If another participant's turn starts while `editor` is held by someone else, run it with effective access `Access::Read` for this turn only. Build the request with that access so the system prompt says read-only (`view.rs:74`), and pass Read to the adapter so the CLI is actually sandboxed. Don't rely on the prompt alone.
- Exception: the participant may write `docs/superpowers/plans/*.md`. Only implement this if the adapters can scope a write path. Otherwise leave it out and note it, and the reader model pastes the plan into chat.
- Emit `RoomEvent::EditorChanged { id: Option<..> }`.
- Later (not in this plan): a separate git worktree per model instead of read-only.

### 4. UI

`src/ChatPane.tsx`, `src/styles.css`

- **Participant chips:** add a status dot (idle / thinking / running a tool), a `n queued` count, and an `editing` badge for the editor. Clicking still inserts the @mention.
- **Composer stays the same size while busy.** Remove the Queue/Steer/Stop column. There is one send button. Next to it, a small `⋯` menu lists `Steer <name>` and `Stop <name>` for each working model, plus `Stop all`.
- **Recipient line** above the textarea, only while someone is busy: `To Jigga · starts now` or `To Null · queued (busy)`. It updates from `roomTargets` as the person types (debounced).
- **Queue:** one collapsed row, `Queued (2) · Null: "lets cut our first…"`. Click to expand into the existing edit/remove rows, with the recipient shown on each. Neutral background, thin border, no colored left bar.
- **Hint:** `Enter sends · ⌘Enter steers the busy model you mentioned`.

## Build order (one commit each, tests passing after each)

1. Rust: per-participant stop flags, lock only around build/settle, `room_targets`, `room_post_to`, `room_turn`, and per-participant `room_stop`. Add `apex-core` tests with the fake participant in `testing.rs`. A slow participant must not block a fast one, and stopping one must leave the other running.
2. Rust: one-editor rule, with tests showing the second model gets `Access::Read`.
3. Frontend: `ParticipantQueues` with tests, and wire it into `ChatPane` (minimal UI).
4. UI: chips, compact queue, composer menu, and hint, all checked in the browser preview.
5. Update `src/backend.ts` mock (the browser preview hub) to match the new commands.

## Done when

- In the desktop app, with Null running a long task, a message to @jigga gets an answer before Null finishes, and Null's turn is not interrupted.
- A message to @null while Null is busy shows as `Queued (1)` on one line, and runs when Null finishes.
- `Stop Null` leaves Jigga's turn running.
- While Null is editing, Jigga's turn is read-only. Check by asking Jigga to touch a file and seeing it refused.
- All frontend and Rust tests pass. Run the Rust tests serially (`--test-threads=1`); the storage test is flaky in parallel.

## Out of scope

- Codex native mid-turn steering (still stop and restart).
- Worktrees per model.
- `/mcp` comes next after this.
