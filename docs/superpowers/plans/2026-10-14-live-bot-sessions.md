# Live Bot Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one Claude Code or Codex program open per active bot per room, so each turn sends only what is new in the chat instead of the whole room, while Deck's transcript stays the single record of the group chat.

**Architecture:** `CliParticipant` (one per bot per room, built in `crates/apex-host/src/host.rs:582`) gains a shared slot holding a live session. A turn first renders the bot's view as today, then asks the slot whether the live program's history is an exact prefix of that view. If it is, only the new tail is sent; if anything earlier changed (edit, delete, fork, summary, roster, pins, settings), the program is closed and a fresh one gets the full prompt, exactly like every turn today. Claude stays on its two-way stream-json mode (`claude_session.rs`); Codex keeps one app server and one in-memory thread (`codex_server.rs`, still `"ephemeral": true`).

**Tech Stack:** Rust (tokio), Claude Code CLI stream-json protocol, Codex `app-server` JSON-RPC.

**Spec:** No separate spec. The decisions below were agreed in the Deck chat with the Human on 2026-10-14 and are the spec.

## Decisions (the spec)

1. One live program per active Claude or Codex bot per room, on the machine that runs that bot. Mac, Hetzner and the phone relay each manage only their own.
2. Deck's transcript is the record. A live program is a cache of it and is thrown away whenever the two could disagree.
3. Each continued turn sends only the messages added since that bot last spoke, in the same `[Name]: text` format the full prompt uses.
4. A program closes after 20 minutes without a turn (Claude programs with a known cache lifetime: when that cache expires, Task 9), when its settings change, when its room/bot is removed, on Stop, on the silence timeout, and when Deck quits.
5. Claude and Codex ship in the same build. No Claude-first release.
6. Claude bots stop writing session files (`--no-session-persistence`), on both the live and one-shot paths. Codex threads stay ephemeral, so Codex writes none either.
7. Venice, Muse, Antigravity/Gemini, Grok and custom-command bots are unchanged (one program per turn).
8. Deleting the old Claude session files (2,137 on 2026-10-14, 2,722 on 2026-11-08) is a separate manual step that needs the Human's explicit OK (Task 8).
9. Long idle threads (Task 9): Claude programs stay open for their whole cache lifetime. Then, behind a setting that ships off, each long idle Claude bot's session is compacted with Claude's own `/compact` in a fork just before its cache expires, and the fork is used only after that. Deck's room and transcript never change; typed `/compact` and `/curate` stay manual tools. The default is decided from measured costs after a recall check. Added 2026-11-08 at the Human's request: returning to long idle threads is a main use case.

## Global Constraints

- Branch: `git switch -c feat/live-bot-sessions` in `/Users/tylercaldwell/Downloads/apex-deck`. No extra worktree folders.
- Run `git status` before every commit; other bots edit this checkout. Stage only this plan's hunks.
- Idle close: `LIVE_IDLE = Duration::from_secs(20 * 60)`; Task 9 replaces it per Claude session with that session's cache expiry, when the lifetime is known.
- Most live programs per machine: `LIVE_CAP = 6`. Starting a seventh closes the least recently used idle one; if none is idle, the turn runs one-shot.
- Kill switch: environment variable `APEX_DECK_ONE_SHOT_BOTS=1` on the daemon turns live sessions off everywhere.
- `BuildContext::live_sessions` defaults to `false`. Only the host turns it on. Every existing adapter test therefore keeps its one-shot behavior.
- Codex `thread/start` keeps `"ephemeral": true`.
- Tests: `cargo test -p apex-core -p apex-adapters -p apex-host`. Inside Deck panes run with `TMPDIR=/tmp` (3 `codex_hook` socket tests fail otherwise).
- Before merge: `npx tsc --noEmit` must pass, Null reviews, the Human approves. Delete the branch after the merge.
- Dev check only via `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev` from the repo root.

## Review Focus

1. **Plan-mode approval leaking into later turns (Claude).** Approving "Start the work?" sends `setMode … destination: "session"`, which in a live program would keep the raised mode for later planning turns. Expected: a session in which ExitPlanMode was approved is retired at the end of that turn. Test in Task 5.
2. **Codex token and cost counts growing every turn.** `events.rs:839` treats the thread total as the turn total ("one thread is one turn here"). In a live thread the total accumulates. Expected: each reply reports only its own tokens. Test in Task 6. Claude's `total_cost_usd` may be cumulative too; Task 1 checks, Task 5 tests.
3. **Output arriving between turns.** A background shell or helper finishing after the reply could make the CLI start a turn on its own while Deck isn't listening. Expected: anything turn-like seen while idle retires the session, so the next turn starts fresh. Tests in Tasks 5 and 6.
4. **A dead program reused.** Stop, the silence timeout and `Registry::terminate_all` kill the process group out from under the session. Expected: the next turn notices before sending, starts fresh, and the reply is normal. Test in Task 7.
5. **"Always allow" must keep today's one-turn scope.** In a live program a session-wide grant (Codex `acceptForSession`, Claude's "always" permission answer) would outlive the turn, which is a security change. Expected: any turn in which the user chose Always allow retires the session at the end of that turn, so the next turn starts a program with no grants. Costs one full cache write after such a turn; never widens access. Tests in Tasks 5 and 6.

## Why now: measured cost (2026-11-08)

Measured by `scripts/measure-claude-cache.py` from Claude's own session logs (no API calls). Rerun:

```bash
python3 -I scripts/measure-claude-cache.py --deck-match pingdotgg/t3code --speaker "You are Jigga" \
  --exclude 49e42606 --plain 2c6f97d4 8032d0d8 --csv /tmp/turns.csv
```

Room: the T3-compare room, Jigga (Opus 5.5), 16 reply turns + 4 suggested-replies calls. Prices are API list, 1-hour cache: $4/MTok input, $20 output, $8 cache write, $0.20 cache read. The user is on a subscription, so read dollars as plan usage.

| Deck turn | first-call cache read | first-call cache write | first-call cost | turn cost |
|---|---|---|---|---|
| 9455f548 | 14,641 | 48,040 | $0.39 | $1.64 |
| ed5cdfe6 | 14,641 | 52,702 | $0.45 | $0.60 |
| f1a87b75 | 14,641 | 54,112 | $0.48 | $4.55 |
| fc7a22c5 | 14,641 | 62,730 | $0.51 | $4.59 |
| 69cd0d00 | 14,641 | 63,833 | $0.52 | $1.07 |
| 68cd5265 | 14,641 | 64,649 | $0.54 | $0.63 |
| 039fa8b4 | 14,641 | 64,647 | $0.53 | $0.53 |
| eab3e8a7 | 14,641 | 65,298 | $0.53 | $0.60 |
| fa3bdf13 | 14,392 | 67,974 | $0.55 | $0.63 |
| dd724df0 | 14,641 | 69,404 | $0.57 | $1.80 |
| c3a5155b | 14,641 | 74,256 | $0.61 | $1.05 |
| ef7316a5 | 14,641 | 74,745 | $0.60 | $0.65 |
| e8e4040d | 14,641 | 74,744 | $0.60 | $3.79 |
| 5ffff3c5 | 14,641 | 75,538 | $0.61 | $1.22 |
| bc0662e6 | 14,641 | 77,886 | $0.63 | $1.14 |
| 1b48cc95 | 14,641 | 77,666 | $0.63 | $1.58 |
| **16 turns** | | **1,068,224** | **$8.55** | **$26.07** |

Suggested-replies calls (1efd4e27, 3071cb7f, b4e85878, 607a951d): each writes the whole room again (47K–60K), $1.73 total.

Plain Claude Code (sessions 2c6f97d4, 8032d0d8, 13 turns): after the first turn, the first call of each turn reads the whole earlier conversation (65K → 159K) and writes only 73–1,772 tokens ($0.02–$0.06).

What this does and doesn't show:
- **Measured:** every Deck turn is a fresh session; the cached prefix stops at the ~14.6K system+tools block; the room (48K → 78K) is written at full cache-write price every turn. That is 33% of this room's reply cost.
- **Estimate, not measured:** with one resumed session per bot, each turn would write only the new messages and read the rest. Roughly $8.55 of writes becomes ~$0.6 of writes + ~$0.2 of reads, about $7.7 (about 28% of $27.80, replies plus suggestions) saved for this room. The plain sessions were different work, so they show the cache pattern only, not a like-for-like cost. Task 8 is the like-for-like test: the same scripted turns with and without `APEX_DECK_ONE_SHOT_BOTS=1`, measured with the same script.

## Recovery rules

One rule covers all of them: **the live program is a cache of Deck's transcript. When Deck can't prove the two match, it throws the program away and sends the full prompt, which is exactly what every turn does today.** Being wrong costs one full cache write, never a wrong answer.

| Situation | Rule | Test |
|---|---|---|
| Deck or the daemon restarts | Live programs are children of the daemon and die with it. Nothing about them is saved. The first turn after a restart is a full prompt. Deck never `--resume`s a bot's session from disk; the one exception is Task 9's idle-compaction fork, made in the same daemon run and used only behind the prefix check. | Task 7: kill the daemon between turns, next turn is `fresh` and correct |
| Program died between turns (Stop, silence timeout, `terminate_all`, crash, OOM) | Before sending, check the process is alive and stdin accepts the write. If not, discard and start fresh in the same turn. The user sees a normal reply. | Task 7 (Review Focus 4) |
| Program dies mid-turn | The turn fails exactly as today. The session is discarded; the next turn is full. No retry inside the same turn, so a reply is never sent twice. | Task 5 / 6 |
| Interrupted turn (Stop mid-reply, approval left waiting, silence timeout) | Any turn that does not end with a clean `result` (Claude) or `turn/completed` (Codex) retires the session. The CLI's history may hold a half reply Deck didn't keep, so it can't be trusted. | Task 5 / 6 |
| Room history edited (edit, delete, fork, `/curate` or compaction summary, roster, pins, settings) | Each session stores `Sent`: the exact rendered conversation text it has seen, including the bot's own reply as Deck stored it. Every turn renders the full view first. If `Sent` is not an exact prefix of it, retire and send in full. Only the tail after the prefix is ever sent. | Task 3 (pure prefix tests), Task 8 Step 2 edit check |
| The bot's own reply edited by the user | Same prefix rule: the stored reply no longer matches, so the session is retired. | Task 3 |
| Access, model, effort or bot settings change | These are part of the `SessionKey`; a different key never reuses a session. | Task 3 |
| User chose "Always allow" in a turn | Retire at the end of that turn, so the grant lasts one turn as today. | Task 5 / 6 (Review Focus 5) |
| Attachments, phone vs desktop client, tool/MCP context change | Images on new messages travel with the follow-up; client-specific instructions and the tool menu are part of the `SessionKey` or `notes`, so a change starts fresh; an attachment removed from an earlier message breaks the prefix. | Task 3 / 7 invalidation tests |
| Output while idle (background shell, helper finishing) | Anything turn-like between turns retires the session. | Task 5 / 6 (Review Focus 3) |
| The CLI compacts its own history (Claude `compact_boundary`) | Retire at the end of that turn: compaction Deck didn't ask for is never trusted. Idle compaction (Task 9) runs only in a separate fork, never in the live program. Typed `/compact` and `/curate` (which hides old messages; it does not summarise) stay the manual ways to trim history. | Task 5 |
| Plan-mode approval raised the mode | Retire at the end of that turn. | Task 5 (Review Focus 1) |
| Idle past the cache lifetime (see Task 9), cap of 6 reached, room or bot removed, Deck quits | Close the program. The next turn is full. | Task 3 / 7 / 9 |
| Idle compaction fork (Task 9) | A fork is one more cached copy of the transcript for one bot. It is used only after that bot's `warm_until`, only if its `SessionKey` matches and what it has seen is an exact prefix of the current view (the same `continuation()` check), and only while the setting is on. Any turn on the live program, an unclean end, a settings change or roster removal discards it. The room, the transcript and other bots' views never change, so no room-wide check is needed. | Task 9 |
| A fork finishes after it was cancelled (message arrived, setting toggled, session replaced) | Each bot's ledger entry has a generation that every turn start, setting-off and drop bumps. A fork is stored only if its ticket's generation, session, `SessionKey` and `Sent` still match, and used only after the same checks in the one locked step that starts the turn and takes it. A stale fork is thrown away, never kept for later. | Task 9 Steps 6–7 |
| A fork tries a tool, or a source session held a grant | Tools in a fork are blocked before they run (deny-all `PreToolUse` hook, Deck denies every permission request, backstop kill), with the tool menu unchanged so the cache still matches. A turn that chose Always allow, approved a plan or saw the CLI compact drops the bot's ledger entry, so that session is never forked or resumed. Every fork and resume passes the current access flags. | Task 9 Steps 5–7 |
| Cache lifetime unknown (fields missing) | 20-minute idle close and no idle compaction for that bot while its guard is active. The guard lives in the host's cache ledger, so closing the program does not lift it. It lifts **only** at its own deadline, `result_seen_at + 1 h + 30 s` (no Claude cache outlives that). A later turn that reports a known lifetime adds its windows beside the guard but never clears it. Other bots in the room are unaffected, because a fork changes nothing they see. Logged once. | Task 9 |
| Turn ends without a clean `result` (crash, OOM, Stop, interrupt, silence timeout) | The session is discarded (above), and so are the bot's ledger entry and any fork. Its next turn is a fresh prompt with a new clock. Nothing else depends on that bot's cache, because idle compaction never changes the room. | Task 9 |
| Mixed cache lifetimes (a 5-minute write after a 1-hour write) | Each lifetime keeps its own window and deadlines only ever move later, so a short write never shortens a longer one. | Task 9 |
| Daemon restart | The cache ledger and forks are in memory, so after a restart no fork is used and every bot's next turn is a fresh full prompt, as in Tasks 1–8. | Task 9 |

## Open question for the Human before building: Decision 6

Decision 6 (`--no-session-persistence`) turns off the Claude session files. Since 2026-10-16 we know those files are the only full record of a bot's steps (Deck keeps only the last 4 and saves none), and they are what this measurement was read from. The cost saving does not depend on Decision 6. **Recommendation: drop Decision 6 and Task 4 from this build**, keep the files until Deck saves steps itself, and keep the old-file cleanup (Task 8 Step 5) on hold. The live program still writes one session file per bot per room instead of one per turn, so the pile grows far more slowly. **Task 9's idle compaction also needs these files:** it forks the bot's saved session, so Task 9 Steps 5–9 can't be built if Decision 6 stays. (Deck-started session files in this project: 2,722 on 2026-11-08, up from 2,137 on 2026-10-14.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/apex-core/src/participant.rs` | Modify | `TurnRequest` gains `notes` (per-turn text that must not count as history) and `one_shot` (never use a live session). |
| `crates/apex-core/src/view.rs` | Modify | `render_conversation`, `render_follow_up`; `render_prompt` uses them. |
| `crates/apex-core/src/room.rs` | Modify | Move the MCP-request section into `notes`; mark next-steps and compaction requests `one_shot`. |
| `crates/apex-adapters/src/live_session.rs` | Create | Pure pieces: `SessionKey`, `Sent`, `continuation()`, the global pool (cap + idle), kill switch. |
| `crates/apex-adapters/src/presets.rs` | Modify | `--no-session-persistence` for Claude. |
| `crates/apex-adapters/src/claude_session.rs` | Modify | Turn loop that leaves the program open; `ClaudeLive`. |
| `crates/apex-adapters/src/codex_server.rs` | Modify | Setup split from turn; request-id counter; `CodexLive`. |
| `crates/apex-adapters/src/events.rs` | Modify | Codex usage measured from a per-turn baseline. |
| `crates/apex-adapters/src/cli.rs` | Modify | Shared live slot on `CliParticipant`; route Claude/Codex turns through it. |
| `crates/apex-adapters/src/lib.rs` | Modify | `BuildContext::live_sessions`; `mod live_session`. |
| `crates/apex-host/src/host.rs` | Modify | Turn `live_sessions` on unless the kill switch is set. |
| `crates/apex-adapters/tests/adapters.rs` | Modify | Multi-turn fake Claude and fake Codex tests. |
| `crates/apex-host/src/idle_compact.rs` | Create (Task 9) | The cache ledger; when to fork-and-compact an idle Claude bot; which start a returning bot gets; per-bot timer. |

---

### Task 1: Probe the real CLIs and record the facts

No code. Every later task depends on these answers. Write each result under "Probe results" at the end of this file and commit it.

**Files:**
- Modify: `docs/superpowers/plans/2026-10-14-live-bot-sessions.md` (append "Probe results")
- Scratch scripts in `/tmp/live-probe/` (not committed)

- [ ] **Step 1: Claude takes two turns on one process**

```bash
mkdir -p /tmp/live-probe && cd /tmp/live-probe
{ printf '%s\n' '{"type":"user","message":{"role":"user","content":"Remember the word PINEAPPLE. Reply OK."}}'
  sleep 25
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"What word did I ask you to remember?"}}'
  sleep 25; } | claude -p --input-format stream-json --output-format stream-json --verbose \
    --permission-prompt-tool stdio --permission-mode default --no-session-persistence --model haiku > claude.jsonl
grep -c '"type":"result"' claude.jsonl          # expect 2
grep '"type":"result"' claude.jsonl | tail -1   # expect PINEAPPLE in "result"
grep -c '"subtype":"init"' claude.jsonl         # 1 or 2? record it
```

Record: two `result` events (yes/no); whether `system/init` repeats per turn; whether `total_cost_usd` and `usage` in the second `result` are per-turn or cumulative (compare to the first).

- [ ] **Step 2: Claude writes no session file with the flag**

```bash
before=$(find ~/.claude/projects -name '*.jsonl' -newer /tmp/live-probe/claude.jsonl | wc -l)
echo '{"type":"user","message":{"role":"user","content":"Say hi"}}' | claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --model haiku >/dev/null
after=$(find ~/.claude/projects -name '*.jsonl' -newer /tmp/live-probe/claude.jsonl | wc -l)
echo "$before -> $after"   # expect no change
```

- [ ] **Step 3: Claude interrupt and idle output**

Send a long task, then `{"type":"control_request","request_id":"i1","request":{"subtype":"interrupt"}}` after 3 seconds. Record whether a `result` follows and whether the process stays usable for a third turn. Separately start `sleep 20 && echo done` as a background Bash task (in `--permission-mode bypassPermissions`), let the turn end, and record whether anything is printed after the `result` while stdin stays open.

- [ ] **Step 4: Codex takes two turns on one ephemeral thread**

Using `codex app-server`, send `initialize`, `initialized`, `thread/start` with `"ephemeral": true`, then `turn/start` id 2 ("Remember PINEAPPLE"), wait for `turn/completed`, then `turn/start` id 3 on the same `threadId` ("What word?"). Record: second turn answers PINEAPPLE (yes/no); `thread/tokenUsage/updated` `total` grows across turns while `last` is per request (yes/no); nothing new under `~/.codex/sessions`.

- [ ] **Step 5: Codex idle notifications**

Leave the server from Step 4 open 2 minutes after the second turn. Record every method printed while idle.

- [ ] **Step 6: Commit the results**

```bash
git add docs/superpowers/plans/2026-10-14-live-bot-sessions.md
git commit -m "docs: record live-session probe results"
```

**Gate:** if Step 1 or Step 4 fails, stop and report to the Human; the design does not hold. If cost is not cumulative, drop the cost baseline from Task 5 and note it.

---

### Task 2: Split per-turn notes from the system prompt and add the follow-up renderer

**Files:**
- Modify: `crates/apex-core/src/participant.rs:9-25`
- Modify: `crates/apex-core/src/view.rs:292-310`
- Modify: `crates/apex-core/src/room.rs:728-780` and `:606`
- Modify: every `TurnRequest { … }` literal (`apex-host/src/personal_worker.rs:429`, `apex-host/src/monitor_check.rs:192`, `apex-adapters/src/media.rs:622`, `apex-adapters/src/attachments.rs:195`, `apex-adapters/tests/adapters.rs:26`, any other `rg 'TurnRequest \{'` hit)

**Interfaces:**
- Produces: `TurnRequest.notes: String`, `TurnRequest.one_shot: bool`; `apex_core::render_conversation(&[ViewTurn]) -> String`; `apex_core::render_follow_up(new: &str, notes: &str) -> String`; `render_prompt` unchanged in signature and output.

- [ ] **Step 1: Write the failing tests** (in `view.rs` tests)

```rust
#[test]
fn the_full_prompt_is_the_system_then_the_conversation() {
    let turns = vec![
        ViewTurn { role: Role::User, content: "[Human]: hi".into() },
        ViewTurn { role: Role::Assistant, content: "hello".into() },
    ];
    assert_eq!(render_conversation(&turns), "[Human]: hi\n\n[You]: hello\n\n");
    assert_eq!(
        render_prompt("SYS\n", &turns),
        "SYS\n\n--- Conversation so far ---\n[Human]: hi\n\n[You]: hello\n\n--- Your reply ---\n"
    );
}

#[test]
fn a_follow_up_carries_only_the_new_messages_and_this_turns_notes() {
    assert_eq!(
        render_follow_up("[Human]: next\n\n", ""),
        "--- New in the conversation since your last reply ---\n[Human]: next\n\n--- Your reply ---\n"
    );
    assert_eq!(
        render_follow_up("[Null]: done\n\n", "\nUse the docs server.\n"),
        "--- New in the conversation since your last reply ---\n[Null]: done\n\nUse the docs server.\n\n--- Your reply ---\n"
    );
}
```

And in `room.rs` tests:

```rust
#[test]
fn the_mcp_request_line_is_a_note_not_part_of_the_system_prompt() {
    let mut room = test_room_with(&["jigga"]);
    room.push_human("@jigga use @docs please");
    let (_, request) = room.request_for(&ParticipantId::new("jigga")).unwrap();
    assert!(request.notes.contains("asked you to use these MCP servers"));
    assert!(!request.system.contains("asked you to use these MCP servers"));
    assert!(!request.one_shot);
}

#[test]
fn next_steps_and_compaction_never_use_a_live_session() {
    let mut room = test_room_with(&["jigga"]);
    room.push_human("hi");
    let (_, request) = room.next_steps_request(&ParticipantId::new("jigga")).unwrap();
    assert!(request.one_shot);
}
```

Use the room test helpers that already exist in `room.rs` tests (`rg 'fn .*room' crates/apex-core/src/room.rs` inside `mod tests`); rename `test_room_with`/`push_human` to whatever they are called there. Do not add new helpers if one exists.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p apex-core render_ notes one_shot`
Expected: compile errors (`render_conversation`, `notes`, `one_shot` not found).

- [ ] **Step 3: Implement**

`participant.rs`, add to `TurnRequest`:

```rust
    /// Text for this turn only, such as the MCP servers the latest message
    /// asked for. Sent after the conversation, never kept as history, so a
    /// live session isn't restarted because it changed.
    pub notes: String,
    /// Run this turn in a fresh program even when the bot has a live one:
    /// next-step suggestions and summaries must not enter its history.
    pub one_shot: bool,
```

`view.rs`, replace `render_prompt` with:

```rust
/// The conversation part of a prompt: each turn, then a blank line.
pub fn render_conversation(turns: &[ViewTurn]) -> String {
    let mut out = String::new();
    for turn in turns {
        if turn.role == Role::Assistant {
            out.push_str("[You]: ");
        }
        out.push_str(&turn.content);
        out.push_str("\n\n");
    }
    out
}

/// Flatten a system prompt and a view into one block of text, for backends
/// that take a single prompt (command-line tools).
pub fn render_prompt(system: &str, turns: &[ViewTurn]) -> String {
    format!("{}\n\n--- Conversation so far ---\n{}--- Your reply ---\n", system.trim_end(), render_conversation(turns))
}

/// The message for a live session that already has the conversation up to
/// its last reply: what's new, then this turn's notes.
pub fn render_follow_up(new: &str, notes: &str) -> String {
    let mut out = String::from("--- New in the conversation since your last reply ---\n");
    out.push_str(new);
    if !notes.trim().is_empty() {
        out.push_str(notes.trim());
        out.push_str("\n\n");
    }
    out.push_str("--- Your reply ---\n");
    out
}
```

Export both from `apex-core/src/lib.rs` next to `render_prompt`.

`room.rs` `request_for_capability`: build `system` without the `prompt_section` term and set

```rust
            notes: self.transcript.iter().rev().find(|m| m.speaker == Speaker::Human)
                .map(|m| crate::server_request::prompt_section(&m.text)).unwrap_or_default(),
            one_shot: false,
```

In `next_steps_request_with_answers` add `request.one_shot = true;`. In the compaction request at `room.rs:606` add `notes: String::new(), one_shot: true`. All other literals get `notes: String::new(), one_shot: false` (monitor and persona turns: `one_shot: true`).

In `cli.rs` `respond_with_approvals`, keep today's one-shot prompt identical in content by rendering `render_prompt(&(request.system.clone() + &request.notes), &request.turns)`. Do the same in any other adapter that calls `render_prompt(&request.system, …)` (`rg 'render_prompt\(' crates`), so no bot loses the MCP-request line.

- [ ] **Step 4: Run tests**

Run: `cargo test -p apex-core && cargo test -p apex-adapters && cargo test -p apex-host`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-core crates/apex-adapters crates/apex-host
git commit -m "refactor: separate per-turn notes from the system prompt; add follow-up prompt"
```

---

### Task 3: The pure live-session logic

**Files:**
- Create: `crates/apex-adapters/src/live_session.rs`
- Modify: `crates/apex-adapters/src/lib.rs` (add `mod live_session;`)

**Interfaces:**
- Consumes: `apex_core::render_conversation`.
- Produces:
  - `pub(crate) struct SessionKey(u64)` with `SessionKey::of(parts: &[&str]) -> SessionKey`.
  - `pub(crate) struct Sent { pub conversation: String, pub reply: Option<String> }`.
  - `pub(crate) fn continuation(sent: &Sent, now: &str) -> Option<String>`.
  - `pub(crate) const LIVE_IDLE: Duration`, `pub(crate) const LIVE_CAP: usize`.
  - `pub(crate) fn switched_off() -> bool` (reads `APEX_DECK_ONE_SHOT_BOTS`).
  - `pub(crate) struct Pool` (global, see Step 3) with `Pool::global()`, `admit(&self, id: u64, retire_idle: impl Fn(u64) -> bool) -> bool`, `touch(&self, id: u64)`, `forget(&self, id: u64)`, `idle_ids(&self, now: Instant) -> Vec<u64>`.

- [ ] **Step 1: Write the failing tests** (bottom of `live_session.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sent(conversation: &str, reply: Option<&str>) -> Sent {
        Sent { conversation: conversation.into(), reply: reply.map(Into::into) }
    }

    #[test]
    fn new_messages_after_the_bots_own_reply_are_the_continuation() {
        let s = sent("[Human]: hi\n\n", Some("hello"));
        let now = "[Human]: hi\n\n[You]: hello\n\n[Human]: next\n\n[Null]: me too\n\n";
        assert_eq!(continuation(&s, now).as_deref(), Some("[Human]: next\n\n[Null]: me too\n\n"));
    }

    #[test]
    fn a_pass_that_was_not_saved_still_continues() {
        // `reply: None` means the bot passed and Deck saved nothing.
        let s = sent("[Human]: hi\n\n", None);
        assert_eq!(continuation(&s, "[Human]: hi\n\n[Human]: again\n\n").as_deref(), Some("[Human]: again\n\n"));
    }

    #[test]
    fn a_deleted_own_reply_starts_over() {
        let s = sent("[Human]: hi\n\n", Some("hello"));
        assert_eq!(continuation(&s, "[Human]: hi\n\n[Human]: next\n\n"), None);
    }

    #[test]
    fn an_edited_or_deleted_message_starts_over() {
        let s = sent("[Human]: hi\n\n[Null]: a\n\n", Some("b"));
        assert_eq!(continuation(&s, "[Human]: hi\n\n[Null]: A\n\n[You]: b\n\n"), None);
        assert_eq!(continuation(&s, "[Human]: hi\n\n[You]: b\n\n"), None);
    }

    #[test]
    fn a_summary_starts_over() {
        let s = sent("[Human]: hi\n\n", Some("b"));
        assert_eq!(continuation(&s, "Summary of the earlier conversation:\n…\n\n[Human]: next\n\n"), None);
    }

    #[test]
    fn a_reply_saved_differently_from_what_the_bot_said_starts_over() {
        let s = sent("[Human]: hi\n\n", Some("hello"));
        assert_eq!(continuation(&s, "[Human]: hi\n\n[You]: hello, edited\n\n[Human]: x\n\n"), None);
    }

    #[test]
    fn nothing_new_starts_over_rather_than_sending_an_empty_turn() {
        let s = sent("[Human]: hi\n\n", Some("hello"));
        assert_eq!(continuation(&s, "[Human]: hi\n\n[You]: hello\n\n"), None);
    }

    #[test]
    fn the_key_changes_with_any_part() {
        assert_eq!(SessionKey::of(&["claude", "--model", "a", "SYS"]), SessionKey::of(&["claude", "--model", "a", "SYS"]));
        assert_ne!(SessionKey::of(&["claude", "--model", "a", "SYS"]), SessionKey::of(&["claude", "--model", "b", "SYS"]));
        assert_ne!(SessionKey::of(&["ab", "c"]), SessionKey::of(&["a", "bc"]));
    }

    #[test]
    fn the_pool_admits_up_to_the_cap_then_retires_the_oldest_idle() {
        let pool = Pool::default();
        for id in 0..LIVE_CAP as u64 { assert!(pool.admit(id, |_| false)); }
        let mut retired = Vec::new();
        assert!(pool.admit(99, |id| { retired.push(id); true }));
        assert_eq!(retired, [0]);
        let pool = Pool::default();
        for id in 0..LIVE_CAP as u64 { pool.admit(id, |_| false); }
        assert!(!pool.admit(99, |_| false), "every program busy: the turn runs one-shot");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p apex-adapters live_session`
Expected: FAIL, module empty.

- [ ] **Step 3: Implement**

```rust
//! What a live bot program has already been told, and when it can be told
//! only what's new.
//!
//! Deck's transcript is the record. A live Claude or Codex program holds a
//! copy of the bot's view of it. Before each turn the view is rendered as it
//! is now; when the program's copy is an exact beginning of it, only the
//! rest is sent. Anything else (an edit, a deletion, a summary, a reply
//! saved differently) starts a fresh program with the full prompt.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A program unused this long is closed. Provider prompt caches expire well
/// before this, so keeping it longer saves little.
pub(crate) const LIVE_IDLE: Duration = Duration::from_secs(20 * 60);

/// At most this many live programs per machine (about 400 MB each for
/// Claude and 190 MB for Codex, before MCP helpers).
pub(crate) const LIVE_CAP: usize = 6;

/// `APEX_DECK_ONE_SHOT_BOTS=1` turns live sessions off.
pub(crate) fn switched_off() -> bool {
    std::env::var_os("APEX_DECK_ONE_SHOT_BOTS").is_some_and(|v| v == "1")
}

/// Everything a program was started with. A different key means a
/// different program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionKey(u64);

impl SessionKey {
    pub(crate) fn of(parts: &[&str]) -> Self {
        let mut hasher = DefaultHasher::new();
        for part in parts {
            part.len().hash(&mut hasher);
            part.hash(&mut hasher);
        }
        Self(hasher.finish())
    }
}

/// The conversation a live program has, as `render_conversation` wrote it,
/// and the reply Deck saved from its last turn. `None` only for a pass
/// (Deck saves nothing). Failed turns never reach here: they close the session.
#[derive(Debug, Clone, Default)]
pub(crate) struct Sent {
    pub conversation: String,
    pub reply: Option<String>,
}

/// The new part of `now`, or `None` when the program's copy no longer
/// matches and it must start over.
pub(crate) fn continuation(sent: &Sent, now: &str) -> Option<String> {
    let rest = now.strip_prefix(sent.conversation.as_str())?;
    // The program already has its own reply. Deck saves it unless it was a
    // pass, and saves it trimmed, which is how the adapters return it.
    let rest = match &sent.reply {
        // Strict: a saved reply that is now missing or different means the
        // room was edited, so the copies differ.
        Some(reply) => rest.strip_prefix(&format!("[You]: {reply}\n\n"))?,
        None => rest,
    };
    // A reply of this bot's that the program didn't write, anywhere in
    // what's new, means the copies differ.
    if rest.is_empty() || rest.starts_with("[You]: ") || rest.contains("\n\n[You]: ") {
        return None;
    }
    Some(rest.to_string())
}

/// Which live programs exist on this machine and when each was last used.
#[derive(Default)]
pub(crate) struct Pool {
    live: Mutex<Vec<(u64, Instant)>>,
}

impl Pool {
    pub(crate) fn global() -> &'static Pool {
        static POOL: OnceLock<Pool> = OnceLock::new();
        POOL.get_or_init(Pool::default)
    }

    /// Make room for program `id`. When full, `retire_idle` is offered the
    /// least recently used first and returns true once it closed one that
    /// wasn't mid-turn. False: no room, run this turn one-shot.
    pub(crate) fn admit(&self, id: u64, mut retire_idle: impl FnMut(u64) -> bool) -> bool {
        let mut live = self.live.lock().unwrap();
        if live.len() >= LIVE_CAP {
            live.sort_by_key(|(_, used)| *used);
            let Some(index) = live.iter().position(|(other, _)| retire_idle(*other)) else { return false };
            live.remove(index);
        }
        live.push((id, Instant::now()));
        true
    }

    pub(crate) fn touch(&self, id: u64) {
        if let Some(entry) = self.live.lock().unwrap().iter_mut().find(|(other, _)| *other == id) {
            entry.1 = Instant::now();
        }
    }

    pub(crate) fn forget(&self, id: u64) {
        self.live.lock().unwrap().retain(|(other, _)| *other != id);
    }

    pub(crate) fn idle_ids(&self, now: Instant) -> Vec<u64> {
        self.live.lock().unwrap().iter().filter(|(_, used)| now.duration_since(*used) >= LIVE_IDLE).map(|(id, _)| *id).collect()
    }
}
```

(`retire_idle` is `FnMut`; the test closure pushing to `retired` needs that.)

- [ ] **Step 4: Run tests**

Run: `cargo test -p apex-adapters live_session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters/src/live_session.rs crates/apex-adapters/src/lib.rs
git commit -m "feat: live-session continuation and pool logic"
```

---

### Task 4: Claude bots stop saving session files

**Files:**
- Modify: `crates/apex-adapters/src/presets.rs:150-190`

- [ ] **Step 1: Write the failing test** (in `presets.rs` tests)

```rust
#[test]
fn claude_turns_save_no_session_files() {
    for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
        for plan in [false, true] {
            let (_, args) = agent_command_with(AgentTool::ClaudeCode, None, None, None, access, plan);
            assert!(args.iter().any(|a| a == "--no-session-persistence"), "{access:?} plan={plan}");
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p apex-adapters claude_turns_save_no_session_files`
Expected: FAIL.

- [ ] **Step 3: Implement** — right after `push(&["-p"]);`:

```rust
            // Deck's transcript is the record; the CLI's own session files
            // were never read and piled up at one per reply.
            push(&["--no-session-persistence"]);
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p apex-adapters presets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters/src/presets.rs
git commit -m "fix: Claude bots stop writing unused session files"
```

---

### Task 5: Claude live session

**Files:**
- Modify: `crates/apex-adapters/src/claude_session.rs`
- Test: `crates/apex-adapters/src/claude_session.rs` (unit, fake `sh` program like `a_reply_waits_for_its_helpers_and_adds_what_they_found`)

**Interfaces:**
- Consumes: `live_session::{SessionKey, Sent}`.
- Produces:

```rust
pub(crate) struct ClaudeLive {
    pub key: SessionKey,
    pub sent: Sent,
    /// Set when the program must not be reused (plan approved, idle
    /// output, protocol error). Checked by the caller after each turn.
    pub spoiled: bool,
    child: OwnedChild,
    stdin: ChildStdin,
    lines: tokio::sync::mpsc::UnboundedReceiver<String>,
    stderr: tokio::task::JoinHandle<String>,
    cost_so_far: u64,
}

impl ClaudeLive {
    pub(crate) fn start(child: OwnedChild, key: SessionKey) -> Self;
    /// True when the process has exited or printed anything since its last turn.
    pub(crate) fn stale(&mut self) -> bool;
    pub(crate) async fn turn(&mut self, prompt: &str, cwd: Option<String>, on_progress: ProgressSink<'_>, approver: &dyn Approver, after_plan: Option<Access>, images: &[crate::attachments::Image]) -> std::io::Result<TurnOutcome>;
    pub(crate) async fn close(self) -> Option<String>; // cleanup error
}

pub(crate) struct TurnOutcome { pub reader: EventReader, pub success: bool }
```

- [ ] **Step 1: Write the failing tests**

```rust
/// A stand-in Claude that answers every user line with its length and the
/// running count, and stays open between turns.
const LIVE_FAKE: &str = r#"n=0
while IFS= read -r line; do
  case "$line" in *'"type":"user"'*) ;; *) continue ;; esac
  n=$((n+1))
  echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"turn $n\"}]},\"parent_tool_use_id\":null}"
  echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"turn $n\",\"total_cost_usd\":0.0$n,\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}"
done"#;

fn live_fake(script: &str) -> ClaudeLive {
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", script]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let child = crate::owned_process::Registry::default().spawn(&mut command).unwrap();
    ClaudeLive::start(child, crate::live_session::SessionKey::of(&["test"]))
}

#[tokio::test]
async fn one_program_answers_several_turns() {
    let mut live = live_fake(LIVE_FAKE);
    let sink = |_: Progress<'_>| {};
    let first = live.turn("one", None, &sink, &apex_core::NoApprover, None, &[]).await.unwrap();
    assert_eq!(first.reader.outcome().text, "turn 1");
    assert!(!live.stale());
    let second = live.turn("two", None, &sink, &apex_core::NoApprover, None, &[]).await.unwrap();
    assert_eq!(second.reader.outcome().text, "turn 2", "same process, so it counted on");
    assert!(live.close().await.is_none());
}

#[tokio::test]
async fn each_turn_reports_its_own_cost_not_the_running_total() {
    // Only if Task 1 found total_cost_usd cumulative; otherwise delete this test.
    let mut live = live_fake(LIVE_FAKE);
    let sink = |_: Progress<'_>| {};
    let _ = live.turn("one", None, &sink, &apex_core::NoApprover, None, &[]).await.unwrap();
    let second = live.turn("two", None, &sink, &apex_core::NoApprover, None, &[]).await.unwrap();
    assert_eq!(second.reader.outcome().cost_micros, Some(10_000), "0.02 total minus 0.01 already counted");
}

#[tokio::test]
async fn output_while_idle_makes_the_program_stale() {
    let mut live = live_fake(r#"IFS= read -r line
echo '{"type":"result","is_error":false,"result":"done"}'
sleep 0.2
echo '{"type":"system","subtype":"init"}'
cat >/dev/null"#);
    let sink = |_: Progress<'_>| {};
    let _ = live.turn("one", None, &sink, &apex_core::NoApprover, None, &[]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(live.stale());
}

#[tokio::test]
async fn approving_the_plan_spoils_the_session() {
    let mut live = live_fake(r#"IFS= read -r line
echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"1. Do it"}}}'
IFS= read -r answer
echo '{"type":"result","is_error":false,"result":"started"}'
cat >/dev/null"#);
    struct Yes;
    #[async_trait::async_trait]
    impl apex_core::Approver for Yes {
        async fn decide(&self, _: ProposedAction) -> Decision { Decision::Approve }
        async fn ask(&self, _: Vec<Question>) -> Answer { Answer::Skipped }
    }
    let sink = |_: Progress<'_>| {};
    let _ = live.turn("plan", None, &sink, &Yes, Some(Access::Full), &[]).await.unwrap();
    assert!(live.spoiled, "the raised mode would carry into the next planning turn");
}
```

Check the `Approver` trait's real shape in `apex-core` (`rg 'trait Approver' -A8 crates/apex-core`) and match it in `Yes`; `cli.rs` tests define similar stubs.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p apex-adapters claude_session`
Expected: compile error, `ClaudeLive` not found.

- [ ] **Step 3: Implement**

1. Move the body of the `loop { … }` in `run_with_images` (from `let mut reader = EventReader::new(…)` through `report(reader.finish(), on_progress);` and the `gave_up` note) into

```rust
/// One turn on an open program: send the message, answer its requests,
/// and read until the reply and any helpers are done. Leaves it open.
async fn drive(
    stdin: &mut ChildStdin,
    lines: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    prompt: &str,
    cwd: Option<String>,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    after_plan: Option<Access>,
    tools_disabled: bool,
    images: &[crate::attachments::Image],
    plan_approved: &mut bool,
) -> std::io::Result<EventReader>
```

   Replace `lines.next_line().await?` with `lines.recv().await` (`None` = the program closed its output, same as today's `None`). Where `plan_exit_response` is built, set `*plan_approved = decision.approved() && own != Access::Read;`.
2. Add `fn read_lines(stdout: ChildStdout) -> UnboundedReceiver<String>` that spawns a task pushing each `BufReader::lines()` line into the channel and ends on EOF or error.
3. `run_with_images` (one-shot) becomes: take the streams, `read_lines`, `drive(…)`, then the existing close-and-wait code unchanged. Its behavior must not change; the existing tests in this file and in `tests/adapters.rs` prove it.
4. `ClaudeLive::start` takes the streams, spawns `read_lines` and the stderr reader. `turn` calls `drive`, then:

```rust
        let mut reader = drive(&mut self.stdin, &mut self.lines, prompt, cwd, on_progress, approver, after_plan, false, images, &mut plan_approved).await?;
        if plan_approved { self.spoiled = true; }
        // Claude reports the session's running cost on each result.
        if let Some(total) = reader.cost_micros() {
            reader.set_cost_micros(total.saturating_sub(self.cost_so_far));
            self.cost_so_far = total;
        }
        let success = reader.turn_over() && reader.outcome().error.is_none();
        Ok(TurnOutcome { reader, success })
```

   Add `cost_micros(&self) -> Option<u64>` and `set_cost_micros(&mut self, u64)` to `EventReader` in `events.rs` if no equivalent exists; keep them `pub(crate)`. Skip this block if Task 1 found per-turn cost.
5. `stale(&mut self)`: `self.child.try_wait()` is `Ok(Some(_))` or `Err(_)` → true; `self.lines.try_recv()` returns a line → log it with `eprintln!("[apex-deck] Claude printed while idle: {line}")` and return true; `Err(Disconnected)` → true; `Err(Empty)` → false.
6. `close(self)`: drop `stdin`, wait up to 5 s for exit, else kill, then `terminate_tree()` and return its error, the same steps as the one-shot path.
7. `impl Drop for ClaudeLive`: if `tokio::runtime::Handle::try_current()` works, spawn a task that runs `terminate_tree` on the child (move it out with `std::mem::replace` on an `Option<OwnedChild>` field; make `child` an `Option` if needed). This covers a bot removed or rebuilt while its program is open.

- [ ] **Step 4: Run tests**

Run: `cargo test -p apex-adapters claude`
Expected: PASS, including every existing Claude test.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters/src/claude_session.rs crates/apex-adapters/src/events.rs
git commit -m "feat: Claude turns on a program that stays open"
```

---

### Task 6: Codex live session

**Files:**
- Modify: `crates/apex-adapters/src/codex_server.rs`
- Modify: `crates/apex-adapters/src/events.rs:839-860`
- Test: `crates/apex-adapters/src/codex_server.rs` tests and `crates/apex-adapters/src/events.rs` tests

**Interfaces:**
- Consumes: `live_session::SessionKey`; `codex_hook::Hook`.
- Produces:

```rust
pub(crate) struct CodexLive {
    pub key: SessionKey,
    pub sent: Sent,
    pub spoiled: bool,
    child: Option<OwnedChild>,
    stdin: ChildStdin,
    lines: tokio::sync::mpsc::UnboundedReceiver<String>,
    thread: String,
    default_model: Option<String>,
    hook: Option<Hook>,
    menu: Option<Vec<apex_core::server_request::ToolServer>>,
    next_id: u64,
    usage_so_far: (u64, u64), // input, output
}

impl CodexLive {
    /// initialize, hook or MCP inventory, thread/start. Nothing is asked of the model.
    pub(crate) async fn start(child: OwnedChild, turn: &Turn<'_>, hook: Option<Hook>, key: SessionKey, on_progress: ProgressSink<'_>) -> Result<Self, TurnError>;
    pub(crate) fn stale(&mut self) -> bool;
    pub(crate) async fn turn(&mut self, turn: &Turn<'_>, prompt: &str, on_progress: ProgressSink<'_>, approver: &dyn Approver, images: &[crate::attachments::Image]) -> Result<Reply, TurnError>;
    pub(crate) async fn close(self) -> Option<String>;
}
```

- `turn_start_with` gains an `id: u64` parameter; every caller passes one.
- `EventReader::usage_baseline(&mut self, input: u64, output: u64)` and `EventReader::thread_totals(&self) -> Option<(u64, u64)>`.

- [ ] **Step 1: Write the failing tests**

In `events.rs` tests:

```rust
#[test]
fn a_live_codex_turn_counts_only_its_own_tokens() {
    let mut reader = EventReader::new(OutputFormat::CodexServer, None);
    reader.usage_baseline(700, 30);
    reader.push(r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"total":{"inputTokens":1000,"outputTokens":45},"last":{"inputTokens":300,"outputTokens":15}}}}
"#);
    let outcome = reader.outcome();
    assert_eq!((outcome.input_tokens, outcome.output_tokens), (Some(300), Some(15)));
    assert_eq!(reader.thread_totals(), Some((1000, 45)));
}
```

In `codex_server.rs` tests, a fake server that keeps a turn counter and checks the thread id:

```rust
const LIVE_CODEX: &str = r#"n=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
  *'"initialize"'*) echo '{"id":0,"result":{"userAgent":"fake"}}' ;;
  *'"mcpServerStatus/list"'*) echo "{\"id\":$id,\"result\":{\"data\":[],\"nextCursor\":null}}" ;;
  *'"plugin/list"'*) echo "{\"id\":$id,\"result\":{\"marketplaces\":[]}}" ;;
  *'"thread/start"'*) echo '{"id":1,"result":{"thread":{"id":"T"},"model":"m"}}' ;;
  *'"turn/start"'*'"threadId":"T"'*)
    n=$((n+1))
    echo "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"u$n\",\"status\":\"inProgress\"}}}"
    echo "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"T\",\"item\":{\"type\":\"agentMessage\",\"id\":\"m$n\",\"text\":\"turn $n\"}}}"
    echo "{\"method\":\"thread/tokenUsage/updated\",\"params\":{\"threadId\":\"T\",\"tokenUsage\":{\"total\":{\"inputTokens\":$((n*100)),\"outputTokens\":$((n*10))},\"last\":{\"inputTokens\":100,\"outputTokens\":10}}}}"
    echo '{"method":"turn/completed","params":{"threadId":"T","turn":{"status":"completed"}}}' ;;
  *'"account/rateLimits/read"'*) echo "{\"id\":$id,\"result\":{}}" ;;
  esac
done"#;

#[tokio::test]
async fn one_codex_thread_answers_several_turns_with_their_own_counts() {
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", LIVE_CODEX]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let child = Registry::default().spawn(&mut command).unwrap();
    let turn = Turn { model: None, effort: None, service_tier: None, access: Access::Read, cwd: None, plan: false };
    let sink = |_: Progress<'_>| {};
    let mut live = CodexLive::start(child, &turn, None, crate::live_session::SessionKey::of(&["t"]), &sink).await.ok().unwrap();
    let first = live.turn(&turn, "one", &sink, &apex_core::NoApprover, &[]).await.ok().unwrap();
    let second = live.turn(&turn, "two", &sink, &apex_core::NoApprover, &[]).await.ok().unwrap();
    assert_eq!((first.text.as_str(), second.text.as_str()), ("turn 1", "turn 2"));
    assert_eq!((second.input_tokens, second.output_tokens), (Some(100), Some(10)));
    assert!(live.close().await.is_none());
}

#[tokio::test]
async fn a_turn_started_while_idle_makes_the_codex_session_stale() {
    // Start as above, run one turn, then have the fake print
    // {"method":"turn/started","params":{"threadId":"T"}} 200 ms after
    // turn/completed (add `(sleep 0.2; echo …) &` after the turn/completed
    // echo in a copy of LIVE_CODEX). After 400 ms, assert live.stale().
}

#[tokio::test]
async fn always_allow_lasts_for_the_session_and_the_key_includes_access() {
    let read = Turn { model: None, effort: None, service_tier: None, access: Access::Read, cwd: None, plan: false };
    let full = Turn { access: Access::Full, ..read };
    assert_ne!(codex_key(&read, "SYS", false), codex_key(&full, "SYS", false), "a different access level never reuses a program");
    assert_eq!(codex_key(&read, "SYS", false), codex_key(&Turn { effort: Some("high"), ..read }, "SYS", false), "effort is per turn");
}
```

Write the stale test body out in full (copy the setup lines from the test above); the comment says what to put there. `Turn` needs `#[derive(Clone, Copy)]` for the struct-update syntax; add it (all fields are `Copy` except `cwd: Option<String>` — use `.clone()` and `..read.clone()` instead if `Copy` won't derive).

- [ ] **Step 2: Run to verify they fail**

Run: `TMPDIR=/tmp cargo test -p apex-adapters codex`
Expected: compile errors.

- [ ] **Step 3: Implement**

1. `events.rs` `thread/tokenUsage/updated`: store the raw totals in a new `thread_totals: Option<(u64, u64)>` field, and set `input_tokens`/`output_tokens` to `total - baseline` (saturating). Default baseline `(0, 0)` keeps one-shot results unchanged. Replace the comment "One thread is one turn here…" with "A live thread runs many turns; the baseline is the thread total before this one."
2. Split `run_with_images` at `let mut reader = EventReader::new(OutputFormat::CodexServer, …)`:
   - everything above (initialize, `hook_ready`/`mcp_inventory`, `thread/start`) becomes `async fn setup(stdin, lines, turn, hook, on_progress) -> Result<(String /*thread*/, Option<String> /*model*/, Option<Vec<ToolServer>>), TurnError>`;
   - everything from the reader through the rate-limit read becomes `async fn drive(stdin, lines, thread, default_model, turn, prompt, images, on_progress, approver, hook, next_id: &mut u64, baseline: (u64, u64)) -> Result<(Reply, Option<(u64, u64)>), TurnError>`.
   - The one-shot `run_with_images` calls `setup` then `drive` with `next_id` starting at 2 and baseline `(0, 0)`, then closes as today.
   Use the same `read_lines` channel helper as Task 5 (move it to `live_session.rs` as `pub(crate) fn read_lines(stdout) -> UnboundedReceiver<String>` and use it from both files). `answer`/`answer_within`/`answers` take the receiver instead of `Lines<…>`.
3. Request ids: `drive` takes `turn/start` id from `*next_id` and bumps it; follow-up nudges and `account/rateLimits/read` take the next ids too. Delete the `FOLLOW_UP` constant.
4. `CodexLive::start` calls `setup` and keeps the menu; `CodexLive::turn` re-sends the cached menu as `Progress::ToolServers` (only on the non-hooked path, as today), calls `drive` with `self.usage_so_far` as the baseline, and stores the returned totals.
5. `fn codex_key(turn: &Turn, system: &str, hooked: bool) -> SessionKey` = `SessionKey::of(&[model, service_tier, sandbox(access), approval_policy(access).to_string(), cwd, hooked, system])`. Effort and plan mode are per turn (`turn/start` carries both) and stay out of the key. Plan mode forces `Access::Read` in `cli.rs`, which is in the key.
6. `stale`: process exited, channel disconnected, or any queued line that has a `threadId` equal to `self.thread` or a method starting with `turn/` or `item/`. Other idle lines (`account/rateLimits/updated`, `remoteControl/status/changed`, MCP status) are read and dropped, not counted as stale, so they don't fill the channel.
7. `close`: drop stdin, wait 5 s, kill, `terminate_tree`, drop the `Hook` (its socket folder is removed by its own `Drop`). `Drop for CodexLive` as in Task 5.
8. Update the module doc comment at the top of `codex_server.rs`: "The server is started fresh for each turn…" becomes a description of both paths.

- [ ] **Step 4: Run tests**

Run: `TMPDIR=/tmp cargo test -p apex-adapters`
Expected: PASS, including `codex_app_server_streams_the_reply_in_pieces_and_declines_when_nobody_can_be_asked` and the helpers test.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters/src/codex_server.rs crates/apex-adapters/src/events.rs crates/apex-adapters/src/live_session.rs crates/apex-adapters/src/claude_session.rs
git commit -m "feat: Codex turns on one app server and thread that stay open"
```

---

### Task 7: Wire live sessions into Claude and Codex bots

**Files:**
- Modify: `crates/apex-adapters/src/lib.rs:60-100` (`BuildContext`)
- Modify: `crates/apex-adapters/src/cli.rs`
- Modify: `crates/apex-host/src/host.rs` (where `BuildContext` is built for rooms)
- Test: `crates/apex-adapters/tests/adapters.rs`

**Interfaces:**
- Consumes: `ClaudeLive`, `CodexLive`, `live_session::*`, `TurnRequest.notes/one_shot`, `render_conversation`, `render_follow_up`.
- Produces: `BuildContext::live_sessions: bool`.

- [ ] **Step 1: Write the failing tests** (in `tests/adapters.rs`)

```rust
/// A Claude that stays open, numbers its turns, and echoes each prompt's
/// first line, so a test can see whether it got the full prompt or a follow-up.
#[cfg(unix)]
const FAKE_CLAUDE_LIVE: &str = r#"#!/bin/sh
echo "$$" >> pids
n=0
while IFS= read -r line; do
  case "$line" in *'"type":"user"'*) ;; *) continue ;; esac
  n=$((n+1))
  case "$line" in *'Conversation so far'*) kind=full ;; *'New in the conversation'*) kind=follow-up ;; *) kind=other ;; esac
  echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"turn $n $kind\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}"
done
"#;

#[cfg(unix)]
fn live_context(dir: &std::path::Path) -> BuildContext {
    BuildContext { live_sessions: true, ..context_in(dir) }
}

#[cfg(unix)]
fn chat(turns: &[(Role, &str)]) -> TurnRequest {
    TurnRequest {
        turns: turns.iter().map(|(role, content)| ViewTurn { role: *role, content: (*content).into() }).collect(),
        ..request("unused")
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_live_claude_bot_gets_the_full_chat_once_then_only_whats_new() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-live", "claude", FAKE_CLAUDE_LIVE);
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &live_context(&dir));
    let none = |_: apex_core::Progress<'_>| {};

    let first = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi")]), &none).await.unwrap();
    assert_eq!(first.text, "turn 1 full");
    let second = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi"), (Role::Assistant, "turn 1 full"), (Role::User, "[Human]: next")]), &none).await.unwrap();
    assert_eq!(second.text, "turn 2 follow-up");

    // An earlier message changed: a fresh program, the full chat again.
    let third = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi (edited)"), (Role::Assistant, "turn 1 full"), (Role::User, "[Human]: next")]), &none).await.unwrap();
    assert_eq!(third.text, "turn 1 full");
    assert_eq!(std::fs::read_to_string(dir.join("pids")).unwrap().lines().count(), 2);
    drop(bot);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_one_shot_request_never_enters_the_live_program() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-live-oneshot", "claude", FAKE_CLAUDE_LIVE);
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &live_context(&dir));
    let none = |_: apex_core::Progress<'_>| {};
    let _ = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi")]), &none).await.unwrap();
    let suggest = TurnRequest { one_shot: true, ..chat(&[(Role::User, "[Human]: hi"), (Role::Assistant, "turn 1 full"), (Role::User, "What next?")]) };
    assert_eq!(bot.respond_with_progress(suggest, &none).await.unwrap().text, "turn 1 full");
    let next = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi"), (Role::Assistant, "turn 1 full"), (Role::User, "[Human]: next")]), &none).await.unwrap();
    assert_eq!(next.text, "turn 2 follow-up", "the live program never saw the suggestion turn");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn after_stop_the_next_turn_starts_fresh_and_works() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-live-stop", "claude", FAKE_CLAUDE_LIVE);
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &live_context(&dir));
    let none = |_: apex_core::Progress<'_>| {};
    let _ = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi")]), &none).await.unwrap();
    bot.cancel_active_turn().await.unwrap();
    let next = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi"), (Role::Assistant, "turn 1 full"), (Role::User, "[Human]: next")]), &none).await.unwrap();
    assert_eq!(next.text, "turn 1 full");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn changing_access_starts_a_new_program() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-live-access", "claude", FAKE_CLAUDE_LIVE);
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &live_context(&dir));
    let none = |_: apex_core::Progress<'_>| {};
    let _ = bot.respond_with_progress(chat(&[(Role::User, "[Human]: hi")]), &none).await.unwrap();
    let scoped = TurnRequest { access: Some(Access::Ask), ..chat(&[(Role::User, "[Human]: hi"), (Role::Assistant, "turn 1 full"), (Role::User, "[Human]: next")]) };
    assert_eq!(bot.respond_with_progress(scoped, &none).await.unwrap().text, "turn 1 full");
    std::fs::remove_dir_all(&dir).unwrap();
}
```

Add the same first test for Codex, using a copy of `LIVE_CODEX` from Task 6 with a `#!/bin/sh` line, `[ "$1" = app-server ] || exit 2`, and an `echo "$$" >> pids` line, and asserting `turn 1 full`, `turn 2 follow-up`, then two pids after an edited first message. Name it `a_live_codex_bot_gets_the_full_chat_once_then_only_whats_new` and write it out in full.

`FAKE_CLAUDE_LIVE` ignores `--no-session-persistence` and the other flags, so it doesn't need a `case "$*"` check.

- [ ] **Step 2: Run to verify they fail**

Run: `TMPDIR=/tmp cargo test -p apex-adapters --test adapters live`
Expected: compile error, `live_sessions` field missing.

- [ ] **Step 3: Implement**

`lib.rs` `BuildContext`:

```rust
    /// Keep one Claude or Codex program open per bot between turns and send
    /// only what's new. Off by default; the host turns it on.
    pub live_sessions: bool,
```

`cli.rs`:

```rust
enum Live {
    Claude(claude_session::ClaudeLive),
    Codex(codex_server::CodexLive),
}

/// The bot's open program, shared by the scoped copies a turn makes of
/// this participant (access, plan, effort), so they all see the same one.
type LiveSlot = std::sync::Arc<tokio::sync::Mutex<Option<Live>>>;
```

Add `live: Option<LiveSlot>` and `live_id: u64` to `CliParticipant`. `with_context` sets `live = context.live_sessions.then(Default::default)` and `live_id` from a global `AtomicU64` counter. Every `Self { … }` that builds a scoped copy in `respond_with_approvals` passes `live: self.live.clone(), live_id: self.live_id`.

In the `turn` async block, before the existing Claude and Codex branches:

```rust
            if let (Some(slot), false) = (&self.live, request.one_shot || self.tools_disabled || live_session::switched_off()) {
                if let Some(reply) = self.live_turn(slot, &request, &prompt_parts, &images, on_progress, &approver).await {
                    return reply;
                }
                // None: no room in the pool or the slot is busy; fall through to one-shot.
            }
```

Implement `async fn live_turn(&self, slot, request, …) -> Option<Result<Reply, ParticipantError>>`:

1. `let Ok(mut guard) = slot.try_lock() else { return None };` (a turn already holds it).
2. `let conversation = render_conversation(&request.turns);` and `let key = …` — Claude: `SessionKey::of(&[program, &args.join("\u{1f}"), cwd, path, &request.system])` (args already include model, effort, speed, access and plan). Codex: `codex_key(&turn, &request.system, hook.is_some())`.
3. If the slot holds a session whose key differs, which is `spoiled`, or `stale()`, take it out and `close().await` it (log any cleanup error), then `Pool::global().forget(self.live_id)`.
4. If a session is left: `match continuation(&live.sent, &conversation)`:
   - `Some(new)` → `prompt = render_follow_up(&new, &request.notes)`.
   - `None` → close it and forget it as in 3.
5. No session: `if !Pool::global().admit(self.live_id, retire_idle) { return None }`, start the program with `self.start`/`self.start_with` (same args and env as today), `ClaudeLive::start` or `CodexLive::start`, and use the full prompt `render_prompt(&(request.system.clone() + &request.notes), &request.turns)`. `retire_idle` cannot reach other participants' slots, so keep a global `Mutex<HashMap<u64, Weak<tokio::sync::Mutex<Option<Live>>>>>` in `cli.rs`; `retire_idle(id)` upgrades the weak slot, `try_lock`s it, and on success takes the session and spawns `close()`; it returns whether it did.
6. Run the turn. On success set `live.sent = Sent { conversation, reply }` where `reply` is `None` for a pass and `Some(reply.text.clone())` otherwise. **Any turn that fails, is interrupted, or ends spoiled (Always allow chosen, plan approved, CLI compacted) closes the session**: no failed session is kept, matching the recovery rules. `Pool::global().touch(self.live_id)` only for a kept session.
7. Settle the Claude result through the existing `self.settle(...)`, so errors and sign-in hints read the same as today.
8. Invalidation tests (add to the Task 7 `adapters.rs` set): an image attached to a new message reaches the follow-up turn; a different interactive-answer instruction (phone vs desktop client) starts fresh; a change to the tool/MCP menu starts fresh; removing an attachment from an earlier message starts fresh; an Always-allow turn is followed by a fresh turn with no grant.
9. Log one line per live turn: `eprintln!("[apex-deck] live {tool} turn for {id}: {kind}, {} prompt chars", prompt.len())` where `kind` is `fresh` or `continued`. Task 8 uses it.

Idle closing: the first time a `CliParticipant` with `live` is built, spawn one global reaper task (guard with a `OnceLock<()>`) that every 60 s calls `Pool::global().idle_ids(Instant::now())` and runs the same `retire_idle` on each.

`cancel_active_turn` stays `self.processes.terminate_all()`. The live program was started through `self.processes`, so Stop and the silence timeout kill it too; the next turn finds it `stale()` (exited) and starts fresh. That is the tested behavior.

`host.rs`: where the room `BuildContext` is built (the `context` passed to `apex_adapters::build` at `host.rs:582`, `:863`, `:893`), set `live_sessions: !apex_adapters::live_sessions_switched_off()` (re-export `live_session::switched_off` from `lib.rs` under that name). The summarizer at `host.rs:1023` and the `assistant_service.rs:2308` check keep `live_sessions: false`.

- [ ] **Step 4: Run tests**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters crates/apex-host
git commit -m "feat: Claude and Codex bots keep one program open per room and send only what's new"
```

---

### Task 8: Measure on the dev build, then the old-file cleanup (needs the Human's OK)

**Files:**
- Modify: this plan, "Results" section.

- [ ] **Step 0: Teach the measurement script live sessions**

With live sessions one Deck session file holds many turns. Change `scripts/measure-claude-cache.py` so a Deck session splits into turns at each Deck-written user prompt (the same rule `--plain` uses), and add a test fixture with a two-turn Deck session. Rerun the 2026-11-08 command and check the one-shot totals are unchanged ($26.07 / $1.73).

- [ ] **Step 1: Start the dev build**

```bash
cd /Users/tylercaldwell/Downloads/apex-deck
APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev
```

- [ ] **Step 2: Run a 10-turn chat with one Claude bot and one Codex bot in the same room**

Use a throwaway room with no real data. For each turn record from the daemon log the `live … turn` line (fresh/continued, prompt chars) and the reply's input tokens and cost from the chat's usage line. Then repeat the same 10 turns with `APEX_DECK_ONE_SHOT_BOTS=1` set before starting the dev build.

Expected: after the first turn every turn is `continued`; prompt chars stay small instead of growing; billed input per turn drops. Edit one earlier message and check that the next turn for both bots is `fresh` and answers correctly.

- [ ] **Step 3: Check memory and cleanup**

`ps -o rss,command -ax | grep -E 'claude|codex app-server'` during the chat; then wait 21 minutes (Codex) and 58 minutes (Claude, after Task 9) and confirm the programs are gone. Quit Deck and confirm no Claude or Codex program from Deck is left running. Confirm no new files under `~/.claude/projects` or `~/.codex/sessions` from the test room.

- [ ] **Step 4: Write the numbers into "Results" and commit**

```bash
git add docs/superpowers/plans/2026-10-14-live-bot-sessions.md
git commit -m "docs: live-session measurements"
```

- [ ] **Step 5: Old Claude session files (only after the Human says yes)**

List first and show the Human the count and size:

```bash
grep -rl -- '--- Conversation so far ---' ~/.claude/projects --include='*.jsonl' > /tmp/deck-sessions.txt
wc -l < /tmp/deck-sessions.txt
tr '\n' '\0' < /tmp/deck-sessions.txt | xargs -0 du -ch | tail -1
```

Only after an explicit OK in the chat: `tr '\n' '\0' < /tmp/deck-sessions.txt | xargs -0 rm --`. The marker only appears in prompts Deck wrote, so the Human's own Claude Code sessions stay.

---

### Task 9: Long idle threads stay cheap (after Tasks 1–8 pass)

**Order (agreed with the Human on 2026-11-08).** Each stage starts only after the one before it has passed.

1. **Live sessions first** (Steps 1–3): keep each Claude program open for its whole cache lifetime. It makes no extra model calls, so it ships on for everyone.
2. **Recall check** (Step 4): does a compacted agent still remember the thread's early decisions? This is a gate and needs no app code.
3. **Idle compaction as a setting that ships off** (Steps 5–8).
4. **Measure after expiry** (Step 9). The Human decides the default from the measured numbers.

**Why:** the Human often comes back to long threads after a break. Claude keeps a thread cheap to re-read for 1 hour on the subscription (5 minutes on an API key), counted from the start of the last request that used it. Two things waste money even with Tasks 1–8:

1. **The program closes too early.** Tasks 1–8 close a live program after 20 idle minutes. The cache still has about 40 minutes left, but a new program sends the room as one fresh prompt, which doesn't match the cached history, so a return at minute 30 pays the full write anyway.
2. **After the cache expires, the next turn writes the whole long thread again.** A compacted copy made while the cache was still warm is much smaller to write.

**What was measured** (Null, 2026-11-08, `~/Downloads/claude-compaction-compare/REPORT.md`; API list prices; one real thread, not a benchmark):
- Claude's own `/compact`, run in a fork of a real Deck bot session (Deck's exact launch arguments plus `--resume <id> --fork-session`), read **101,555 cached tokens** (97% of its input) and cost **$0.13**. Loading the compacted fork afterwards and replying cost **$0.28**; it wrote about 34K tokens. A full re-write of the same thread would be about $0.84 (105K tokens at $8/MTok).
- **Not measured yet:** compacting a real Deck thread after its cache has expired, and whether the summary keeps what matters. Steps 4 and 9 measure them.

**Why a fork, and why the summary stays private to that agent.** Three facts decide the design:
- Deck's typed `/compact` and `/curate` each run a separate one-shot call with its own system prompt (`COMPACT_SYSTEM`, `CURATE_SYSTEM`), so they share no cache with the bot. Only the bot's own session does, so only a fork of that session can compact cheaply.
- Claude's compaction keeps the newest messages word for word (`compact_metadata.preserved_segment`), and its summary says it "was written without seeing them". So the summary cannot be stored as the room's `Compaction`, the way typed `/compact` stores its own summary: every bot would lose those newest messages.
- Compacting inside the live program would replace its full history the moment it ran, so a return just before expiry would lose the cheap full re-read.

So the compacted fork is **one more cached copy of Deck's transcript, for one bot**, under the same rule as the live program: Deck uses it only when its `SessionKey` matches and what it has seen is an exact prefix of the bot's current view (`continuation()`). Deck never changes the room, the transcript or any other bot's view. Typed `/compact` and `/curate` stay exactly as they are, as manual tools.

**What this drops from the earlier `/curate` version.** The room fingerprint, the apply step under the room lock, waiting for every bot's `cold_after`, the room-wide block for an unknown lifetime, the unknown guard after an unclean end, and the one-hour hold after a restart all existed because idle `/curate` changed what every bot saw. A fork changes nothing in the room, so the existing prefix check and `SessionKey` already cover edits, deletes, pins, roster and settings. The cache-clock rules stay, because they decide the timing. **The per-bot checks stay too:** a fork is still checked, under the ledger lock, against that bot's generation, settings, transcript prefix and the setting, both when it is stored and when it is used (Part C, "Fork generation").

**Needs Decision 6 dropped.** The fork reads the bot's saved Claude session file. With `--no-session-persistence` there is no file to fork, so Steps 5–9 can't be built. Steps 1–4 don't need the files.

**Cost model** (sets the default in Step 9). It is counted per **eligible idle episode**, not per thread. One thread can have many episodes.

**Eligible idle episode.** This one rule is used here and in Step 9 (d), with nothing added or left out in either place. An episode is one Claude bot turn whose `result` reports its cache lifetime and at least 100K prompt tokens, followed by an idle gap that **reaches that turn's `pick_at`**. `pick_at` is worked out exactly as `pick_at()` does it (Part C): about minute 57 on a 1-hour cache, 2 minutes after the request start on a 5-minute one. A gap reaches `pick_at` when nothing ends it first. These end it first, and the turn is then **not** an episode:
- the bot's next turn in that room starts before `pick_at`. That costs `w` in every option, so it can't change the choice;
- the turn has no `pick_at` because it is guarded (no cache fields in its `result`);
- the bot's ledger entry is gone by `pick_at`: an unclean end, a spoiled turn (Always allow, a plan approval, Claude compacting its own history), a `SessionKey` change, the bot removed, the room moved to Trash or deleted, or a daemon restart. In each case no fork would run. A room moved to Trash before `pick_at` stays out even if it is restored later: Trash drops the entry and closes the program whatever the setting, so the bot's next turn is a fresh full prompt in every option.

With the setting on, every episode pays the fork, `C`, including the ones where the fork is then discarded because the Human came back first. What each episode costs, by how it ends:

| Episode ends with | Setting off | Setting on | Compact on return (the alternative Step 9 measures) |
|---|---|---|---|
| a return from `pick_at` to the original `warm_until` (≈ minute 57–60) | warm read, `w` | `w` + `C` (fork paid, then discarded) | `w` (still warm, nothing to compact) |
| a return from the original `warm_until` to the refreshed `cold_after` (≈ minute 60–118) | full write, `W_full` | `w` + `C` (fork discarded, but its cache read kept the program warm) | `C_cold` + `R_cold` |
| a return after the refreshed `cold_after` | `W_full` | compacted reload `R` + `C`; `W_full` + `C` if the daemon restarted in between (the fork is in memory) | `C_cold` + `R_cold` |
| a return after the room was moved to Trash (after `pick_at`) and then restored | `W_full` (Trash closed the program) | `W_full` + `C` (the fork was paid, then dropped with the entry) | `W_full` |
| **no return possible**: the bot was removed, or the room permanently deleted, after `pick_at` | 0 | `C` | 0 |
| not returned within the observation window, including rooms still in Trash | 0 so far | `C` | 0 so far |

Trash is not final, because a room can be restored. Moving a room to Trash drops the bot's entry, its fork and its program, and a restore brings none of them back. So a return after a restore is a fresh full prompt in every option, plus the fork already paid for with the setting on. Only the "no return possible" row is final: that bot can't take another turn there, so its cost is known. The last row is **not** "never": those episodes were still open when counted, and the Human may yet come back. A room still in Trash belongs there too. Step 9 counts only the last row as unknown and bounds the estimate (see "(d)" there).

With `s_mid` and `s_late` the shares of eligible episodes in the second and third rows (a return after a restore from Trash is in its own row and saves nothing), the setting saves money when `s_mid × (W_full − w) + s_late × (W_full − R) > C`. The middle row's saving comes from the fork's cache read, not from the summary, so Step 9 reports it on its own line. With the one-thread numbers above and only late returns counted, the break-even is `s_late` ≈ 0.13 / (0.84 − 0.28), about **23%**. These are one thread's numbers; Step 9 replaces all of them.

| Return after | Tasks 1–8 | With Task 9 |
|---|---|---|
| 30 minutes | full write, ~$0.84 | cached re-read, ~$0.02 (Part B, everyone) |
| 2 hours or more | full write, ~$0.84 | compacted reload ~$0.28, plus ~$0.13 compaction paid while idle (Part C, setting on) |
| not reopened | nothing | ~$0.13 compaction (Part C, setting on) |

Illustration only: a 105K-token thread at API list prices.

**Design.** Three parts, each on the machine that runs the bot.

**Part A: track when each Claude session's cache expires.** Unchanged from the version Null signed off, except that the unknown guard now applies to one bot instead of the whole room.
- Deck cannot see when Claude's last API request really started, so each live session keeps **two bounds** instead of one guess:
  - `warm_until = last_request_start + ttl`, the **earliest** the cache can expire. `last_request_start` is the time Deck wrote the turn to the program, moved forward each time Deck sees a tool result go back to Claude. It is never later than the real start. A long turn with many tool calls keeps moving it.
  - `cold_after = result_seen_at + ttl + COLD_MARGIN` (`COLD_MARGIN = 30 s`), the **latest** the cache can still be warm. The real last request started before Deck saw the turn's `result`, so the real expiry is never later than this.
  - Rule: anything that must happen *before* expiry (the fork) uses `warm_until`. Anything that must not happen *until* expiry (retiring the program) uses `cold_after`.
- **One window per lifetime, never shortened.** Claude lets one request write some cache entries for 1 hour and others for 5 minutes ([mixed lifetimes](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)), and each entry expires on its own clock. So a bot's cache state is a `CacheClock` with up to two windows, `h1` and `m5`, each holding its own `warm_until` / `cold_after`. Each `result` updates it from `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` and `cache_read_input_tokens` (Task 1 confirms the names):
  - a 1-hour write sets `h1` from this turn; a 5-minute write sets `m5` from this turn;
  - a cache read refreshes every window already present (a continued session re-reads its whole prefix, and a read renews an entry at its own lifetime). This is why a cache-only turn keeps the 1-hour lifetime;
  - **deadlines only move later** (`max` of old and new), so a later 5-minute-only turn cannot pull the 1-hour deadline in;
  - the bot's `warm_until` is the latest `warm_until` of its windows, and its `cold_after` the latest `cold_after`.
- **The unknown guard is explicit, per bot.** A `result` without the cache fields sets `unknown_until = result_seen_at + MAX_TTL + COLD_MARGIN` (`MAX_TTL = 1 h`, the longest lifetime Claude offers). While `now < unknown_until` the bot is *guarded*: it uses the plain `LIVE_IDLE` (20 min) close and gets no idle compaction. Like every deadline it only moves later, and **nothing clears it early**: a later turn that reports a 5-minute or 1-hour write adds its windows beside the guard, because a fresh report says nothing about an unreported entry that may still be warm. Other bots in the room are unaffected, because a fork changes nothing they see. Deck logs "cache lifetime unknown" once per session, so it shows up in Step 9.
- **Unclean ends.** A turn that ends without a clean `result` (crash, OOM, Stop, interrupt, silence timeout) already discards the session (Recovery rules). It now also drops the bot's ledger entry and any fork. The bot's next turn is a fresh prompt with a new clock. That prompt shares no history cache with the old session, so no guard is needed.

**Part B: retire the program when its cache expires, not before.** Idle close for a Claude session with a known lifetime is `cold_after`, and never sooner than `LIVE_IDLE` after the turn. Closing up to ~30 s after the real expiry costs nothing extra, because a cold cache pays the full write either way. The full warm window is used: a return at minute 59 still continues the live program. A guarded session closes after `LIVE_IDLE`. Codex keeps 20 minutes, because its cache isn't measured. `LIVE_CAP = 6` still bounds memory; least-recently-used idle programs close first, as before.

**Part C: compact in a fork before expiry, and use the fork only after it.**
- **Cache ledger.** The host keeps one `CacheLedger` entry per (room, bot): the session id, `SessionKey`, `Sent`, `CacheClock`, the last turn's prompt tokens, and the fork if there is one. The entry outlives the program, so an idle close or `LIVE_CAP` eviction at minute 30 doesn't stop the fork at minute 57: the session file is still on disk. An entry is dropped on an unclean end, a `SessionKey` change, roster removal, the room moving to Trash (Deck refuses work in a trashed room, `host.rs:1125`) or room deletion, and once its `cold_after` and any guard have passed with no fork. Moving a room to Trash also closes its bots' programs and kills any running fork. Restoring it brings none of them back: each bot's next turn is a fresh full prompt, and a fork already paid for is lost. The ledger is in memory only: after a daemon restart there are no forks, and every bot's next turn is a fresh prompt, as in Tasks 1–8.
- **When.** `pick_at = warm_until − PICK_LEAD` (3 minutes; the measured compaction took about 45 s). At `pick_at` the host forks if all of these hold:
  - the setting is on (it ships off) and `APEX_DECK_ONE_SHOT_BOTS` is unset;
  - the bot isn't guarded, has no turn running and nothing queued for it;
  - its last turn used at least `COMPACT_MIN_TOKENS = 100_000` prompt tokens (input + cache read + cache write);
  - no fork has been made or tried for this `Sent`, so an unchanged thread is never compacted twice;
  - `now < warm_until`. A missed pick is skipped, never run late: compacting after expiry is the "compact on return" option that Step 9 measures, not this one.
- **How.** The host starts a one-shot Claude program with the bot's exact launch arguments (the parts of its `SessionKey`: same folder, model, access and tool menu, so the cached prefix matches) plus `--resume <session id> --fork-session`, and sends one message: `/compact ` followed by `IDLE_COMPACT_ASK`. That text carries the summary rules from `COMPACT_SYSTEM` (what the user wants, decisions and who made them, work done, open questions, exact names, @handles, paths and values). Deck reads `compact_boundary` and the `result`'s usage, then offers the result to the ledger (below). Talk-only chats work the same way, inside their isolated folder with no tools, so the old "Work threads only" limit is gone.
- **Nothing in a fork can run a tool: blocked before it runs, not noticed afterwards.** The tool menu has to stay identical, or the cached prefix changes and the fork pays the full write, so tools can't simply be removed. They are blocked at three points, any one of which stops a call before it runs:
  1. **A deny-all `PreToolUse` hook** is added to the fork's `--settings` (`"matcher": "*"`, exits 2 with "Idle compaction runs without tools."). Claude runs `PreToolUse` hooks before its own permission check, so it holds in every access level, including Full (`bypassPermissions`), Edits (`acceptEdits`), Read's `--allowedTools` and the `TaskCreate` / `TaskUpdate` allow rule, and it covers MCP tools. Step 5 confirms both that it blocks and that it leaves the cache read unchanged. Before forking, the host checks that hooks aren't switched off (`disableAllHooks` or `allowManagedHooksOnly` in the user, project or managed Claude settings); if they are, that bot gets no fork.
  2. **Deck answers every permission request with "deny"**: the fork runs with the existing `tools_disabled` path (`claude_session.rs:303`), which also answers any other control request, `ExitPlanMode` included, with an error. So the fork can never raise its own mode.
  3. **Backstop only:** the first `tool_use` seen in the fork's output kills it, and the fork counts as failed.
- **No grants carry into a fork, and none come out of one.**
  - **Always allow:** for Claude, Deck keeps this grant in its own approver for one turn and never sends it to Claude (`permission_response`, `claude_session.rs:38`). Nothing of it is in the session file, so a fork can't inherit it.
  - **Plan approval** sends Claude `setMode … destination: "session"` (`claude_session.rs:138`), which raises the live program's mode. A turn that does this, or picks Always allow, or in which the CLI compacts itself, already retires the program (Review Focus 1 and 5). It now also drops the bot's ledger entry (`drop_bot`), so a session that ever held a raised mode or a grant is **never forked and never resumed**.
  - **Every start passes the mode explicitly.** The fork and a program resumed from a fork get `--permission-mode` (or Read's `--allowedTools` / `--disallowedTools`) from the bot's *current* `SessionKey`, never from the session file. Step 5 checks that `--resume` doesn't bring back a mode the source session was raised to; if it does, a session with any mode change in its history is never resumed. A program resumed from a fork starts with no grants and asks as usual.
- **Fork generation: a cancelled fork can never become usable later.** Each ledger entry has a `generation` counter. It goes up when a turn starts for that bot, on `record_turn` and `drop_bot`, and when the setting is turned off (which also drops every stored fork). Starting a fork takes a `ForkTicket` holding the generation, the parent session id, the `SessionKey` and the `Sent`. All ledger changes happen under the ledger's lock, so they are checked twice:
  - **When storing:** the result is kept only if the entry still exists, its generation equals the ticket's, its session id, `SessionKey` and `Sent` are the ticket's, and the setting is on. Otherwise it is thrown away and logged. So a fork that finishes after a message arrived, after a settings change, after the setting was turned off and on again, or after the bot's session was replaced is never stored, even if killing it lost the race.
  - **When using:** the turn's start is chosen and the generation bumped in one locked step, which *takes* the fork out of the entry. It is used only if its generation is still the entry's, its `SessionKey` matches the current one, `continuation(fork.sent, view)` returns the tail, and the setting is on. Two starts can never both use one fork, and a fork that fails these checks is dropped, never kept for later.
  - A discarded fork's session file is left on disk like any other session file; Deck only ever resumes a fork id it stored.
- **The fork's own spend counts.** Its usage goes on that bot's meter. Its cache read also refreshes the bot's cached history, so its `result` updates the bot's `CacheClock` like a turn does, and the live program may stay open up to an hour longer. There is one fork per `Sent`, so this never repeats.
- **A failed fork is dropped.** If there is no `compact_boundary`, a tool is attempted, it errors or it times out, the host kills it, logs it, keeps nothing and doesn't retry for this `Sent`.
- **A message during the fork doesn't wait.** The turn starts at once on the live program (or fresh, as in Tasks 1–8). Starting the turn bumps the generation first, then the fork is killed; if its result arrives anyway, the store check refuses it. The timer is rescheduled after that turn. Any turn on the live program discards the bot's fork.
- **At the bot's next turn**, in one locked step, in this order:
  1. If `now < warm_until` and the live program is open, continue it: the full history is read cheaply. Discard the fork.
  2. If a fork exists and passes every check under "When using", start the program with `--resume <fork id>` and send only the tail. It becomes the bot's live program. This also applies between `warm_until` and `cold_after`, where the cache may already be cold: the fork's worst case (~$0.28) beats a full re-write (~$0.84).
  3. Otherwise, as in Tasks 1–8: use the live program if it is still open, else send a fresh full prompt. Discard any fork.
- **Each Claude bot is handled on its own.** A room with two Claude bots may make two forks, each from its own warm cache. Codex bots are unchanged, because Codex compaction isn't measured.

What the Human sees: Settings → General gains **Compact long idle threads**, **off by default** until Step 9. When a turn starts from a fork, the thread shows one quiet notice: "<Bot> continued from a summary of the earlier conversation, made while idle." Nothing else in the thread changes.

**Files:**
- Modify: `crates/apex-adapters/src/live_session.rs` (`CacheClock` with `h1` / `m5` windows, per-session idle close)
- Modify: `crates/apex-adapters/src/claude_session.rs` (read the cache fields; move `last_request_start` on each tool result; start with `--resume <id>`, with or without `--fork-session`, always with the current access flags; run the one-shot `/compact` with `tools_disabled` and the deny-all hook, kill it on any `tool_use`, and read `compact_boundary`)
- Modify: `crates/apex-core` usage type (carry `warm_until`, `cold_after`, `ttl` and prompt tokens on the reply)
- Create: `crates/apex-host/src/idle_compact.rs` (the `CacheLedger` with generations and `ForkTicket`s, pure `pick_due` / `choose_start`, `fork_settings`, the per-bot timer, `IDLE_COMPACT_ASK`)
- Modify: `crates/apex-host/src/host.rs` (reschedule at turn end, run the fork, bump the generation and then kill the fork on an incoming message, `drop_bot` after a spoiled turn, `set_enabled` from the setting, pass the chosen start to the participant, post the notice, put the fork's usage on the meter)
- Modify: Settings → General (one toggle, off) and the notice text
- Unchanged: `crates/apex-core/src/room.rs` (`/compact` and `/curate` stay as they are)

- [ ] **Step 1: Parts A and B, pure rules, failing tests first**

```rust
// live_session.rs
pub(crate) struct Window { pub warm_until: Instant, pub cold_after: Instant }
pub(crate) struct CacheClock { h1: Option<Window>, m5: Option<Window>, unknown_until: Option<Instant> }
pub(crate) struct TurnCache { wrote_1h: u64, wrote_5m: u64, read: u64, fields_present: bool, request_start: Instant, result_seen: Instant }
pub(crate) fn record(prev: Option<CacheClock>, turn: &TurnCache) -> CacheClock // deadlines never move earlier; never clears unknown_until
pub(crate) fn retire_at(clock: &CacheClock, turn_end: Instant, now: Instant) -> Instant // max(cold_after, turn_end + LIVE_IDLE); turn_end + LIVE_IDLE while guarded
```

Tests:
- `record`: 1-hour write → `h1` window; 5-minute-only write → `m5` window; cache-only turn after a 1-hour write refreshes `h1` (not downgraded); fields missing → guard until `result_seen + 1 h + 30 s`.
- **Mixed lifetimes:** a 1-hour write at t0, then a 5-minute-only turn with no cache read at t0+10 min → `cold_after` stays t0+60 min+30 s (not t0+15 min); the same turn with a cache read → t0+70 min+30 s. A sequence of turns never moves any deadline earlier.
- **A known write never clears a guard:** fields missing at t0 (guard to t0+60 min+30 s), then a 5-minute-only turn at t0+10 min → the bot is still guarded at t0+59 min; the same with a 1-hour write or a cache-only turn → still guarded until t0+60 min+30 s; after that, only the Known windows count.
- Bounds: a turn whose `result` arrives 90 s after its last tool result gives `cold_after − warm_until = 90 s + COLD_MARGIN`.
- `retire_at`: a 1-hour turn → its `cold_after`; a 5-minute turn → 20 minutes after the turn (the `LIVE_IDLE` floor); a guarded bot → 20 minutes after the turn.

- [ ] **Step 2: Parts A and B in the adapter.** With the fake Claude from Task 5 and a paused tokio clock:
  - a 1-hour `result` keeps the program past 20 idle minutes and closes it at `cold_after`;
  - a turn with tool calls spread over 70 minutes moves `warm_until` to 60 minutes after the last tool result, and `cold_after` to 60 minutes + 30 s after the `result`;
  - a cache-only follow-up turn keeps the 1-hour lifetime;
  - a 1-hour turn followed by a 5-minute-only turn: the program still closes at the 1-hour `cold_after`;
  - a `result` without cache fields closes at 20 minutes and logs "cache lifetime unknown" once;
  - a fake CLI killed mid-turn: the session is discarded as in Tasks 5–7, and no clock is kept for it.

- [ ] **Step 3: Run tests and commit (live sessions done)**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host && npx tsc --noEmit`

```bash
git add crates/apex-core crates/apex-adapters
git commit -m "feat: keep Claude programs open for their whole cache lifetime"
```

- [ ] **Step 4: Recall check (a gate; no app code)**

Question: after Claude compacts a long Deck thread, does the agent still know the thread's early decisions?
- Use Null's fork harness in `~/Downloads/claude-compaction-compare/`. Forks are read-only, each source session's hash is checked before and after, and no real room is touched.
- Pick 3 real long Deck threads whose Claude bot session last read at least 100K tokens. At least one must have two or more bots.
- For each thread, someone who will not answer writes 5 questions about decisions, constraints and facts from the first half of the thread, each with its reference answer and the message it comes from.
- Per thread: (a) one uncompacted fork, as the control; (b) one compacted fork, made with `/compact ` + `IDLE_COMPACT_ASK` exactly as Part C will send it. Compaction runs once per thread. Then fork the compacted session twice more with `--resume <b> --fork-session`, so the two checks never see each other:
  - (b1) gets all 5 questions in one message; the control (a) gets the same message;
  - (b2) is used only for the first-reply check below and never sees the quiz.
- A grader who doesn't know which fork wrote which answers marks each one right, partly right, wrong or "doesn't know". Questions the control gets wrong are dropped as unfair.
- First-reply check: send fork (b2) one ordinary new message in the thread's style, as its first message after compaction. The reply must answer that message, not pick up old work or redo finished tasks. Claude's summary text tells the model to "pick up the last task as if the break never happened", so this needs checking. Run it with the Part C tool gate on, so nothing can change on disk; the grader also reads any blocked tool calls, and one that restarts old work counts as a failure.
- **Pass:** the compacted forks get at least 80% of the remaining questions right, never state a wrong decision as fact ("doesn't know" is acceptable), and pass all 3 first-reply checks. If they fail, change `IDLE_COMPACT_ASK` once and rerun on fresh forks. If they fail again, stop after Step 3 and report to the Human.
- Record the questions, answers, grades and cost in "Results". Expected cost: a few dollars at API-equivalent prices (a rough guess).

- [ ] **Step 5: Probe the fork against a live program (no app code)**

On the dev build, with a throwaway data folder (never the real one) and a live Claude program from Tasks 5–7 open and idle on a throwaway copy of a real long thread, confirm:
- a fork with the program's exact arguments plus `--resume <id> --fork-session` reads about the last turn's cache read + write from cache;
- the source session file's hash is unchanged afterwards, and the live program's next turn is still `continued`;
- the fork's output has `compact_boundary` and a `result` with per-call usage;
- `--resume <fork id>` in live stream-json mode accepts a follow-up tail and replies;
- a turn that starts on the live program while the fork is launching leaves both session files readable.
- **The tool gate holds before execution.** Fork a throwaway Full-access (`bypassPermissions`) bot's session with the gate on and ask it to create `/tmp/t9-canary`, run `touch /tmp/t9-canary2` and call one MCP tool. None of the three may happen (the files must not exist), the hook must have fired for each, and Deck must have seen no permission request it allowed. Repeat at Edits and at Read.
- **The gate leaves the cache alone.** The fork's cache read with the hook added must match a fork without it (within a few hundred tokens). If the hook changes the cached prefix, stop and report: Part C rests on this too.
- **No raised mode comes back.** In a throwaway session started with `--permission-mode default`, approve a plan so Claude records `setMode acceptEdits`, then end it. `--resume` it, and a fork of it, with `--permission-mode default`, and ask for an edit: Deck must get a permission request. If either skips the request, record it: Part C then also refuses to fork or resume any session with a mode change in its history (it already never forks one, because such turns drop the ledger entry).

Record the results in "Probe results". If the warm read, the gate or the cache check fails, stop and report: Part C rests on them.

- [ ] **Step 6: Part C, pure rules, failing tests first**

```rust
// idle_compact.rs
pub(crate) const PICK_LEAD: Duration = Duration::from_secs(3 * 60);
pub(crate) const COMPACT_MIN_TOKENS: u64 = 100_000;
pub(crate) struct ForkTicket { pub generation: u64, pub parent: String, pub key: SessionKey, pub sent: Sent }
pub(crate) struct Fork { pub session_id: String, pub generation: u64, pub key: SessionKey, pub sent: Sent }
pub(crate) struct Entry {
    pub session_id: String, pub key: SessionKey, pub sent: Sent, pub clock: CacheClock,
    pub prompt_tokens: u64, pub fork: Option<Fork>,
    pub generation: u64,    // bumped by every turn start, record_turn, drop_bot and the setting turning off
    pub tried: Option<u64>, // hash of the Sent last forked or tried
}
/// Held behind one Mutex in the host; every method below runs under it.
pub(crate) struct CacheLedger { /* (room, bot) -> Entry; outlives the program; enabled flag */ }
impl CacheLedger {
    pub fn record_turn(&mut self, room: &str, bot: &str, session_id: &str, key: SessionKey, sent: &Sent, turn: &TurnCache, prompt_tokens: u64); // bumps generation, discards any fork
    pub fn begin_fork(&mut self, room: &str, bot: &str, now: Instant) -> Option<ForkTicket>; // pick_due + marks this Sent tried
    pub fn store_fork(&mut self, room: &str, bot: &str, ticket: ForkTicket, fork_id: &str, turn: &TurnCache) -> bool; // false = stale, thrown away; the fork's read refreshes the clock only when stored
    pub fn drop_bot(&mut self, room: &str, bot: &str);      // unclean end, spoiled turn (Always allow, plan approval, CLI compaction), key change, roster removal, room trashed or deleted
    pub fn set_enabled(&mut self, on: bool);                // off: bump every generation, drop every fork
    pub fn begin_turn(&mut self, room: &str, bot: &str, program_open: bool, key: &SessionKey, view: &str, now: Instant) -> Start; // chooses, bumps generation, takes the fork
    pub fn entry(&mut self, room: &str, bot: &str, now: Instant) -> Option<&Entry>; // drops entries that can no longer matter
}
pub(crate) fn pick_at(entry: &Entry) -> Option<Instant>; // warm_until − PICK_LEAD; None while guarded
pub(crate) fn pick_due(entry: &Entry, busy: bool, enabled: bool, hooks_allowed: bool, now: Instant) -> bool;
pub(crate) enum Start { Continue, ResumeFork { session_id: String, tail: String }, Fresh }
pub(crate) fn choose_start(entry: Option<&Entry>, program_open: bool, key: &SessionKey, view: &str, enabled: bool, now: Instant) -> Start; // pure; begin_turn wraps it
pub(crate) fn fork_settings(bot_settings: &str) -> String; // the bot's --settings JSON plus the deny-all PreToolUse hook
```

Tests:
- `pick_at`: `warm_until` − 3 min; for a 5-minute cache, 2 minutes after the request start; `None` while guarded.
- `pick_due`: false with the setting off (the default) or the kill switch set; false when hooks are switched off in Claude's settings; false under 100K prompt tokens; false while the bot is busy or has a message queued; false when a fork already exists or was tried for this `Sent`; true at `pick_at`, not a second sooner; false at or after `warm_until`, so a missed pick never runs late.
- **Stale forks are never stored** (`store_fork` returns false and the entry is unchanged, clock included): a turn started after `begin_fork`; `record_turn` replaced the session; `drop_bot` ran; the `SessionKey` changed; the `Sent` changed; the setting was turned off, or off and on again; the entry was dropped and a new one made for the same bot.
- **Stale forks are never used:** a fork stored, then the generation bumped by any of the above → `begin_turn` gives `Fresh` or `Continue` and the fork is gone afterwards; two `begin_turn` calls after one stored fork → only the first gets `ResumeFork`; a fork that fails the prefix or key check is removed, not kept for a later turn.
- **Grants:** `drop_bot` after a turn that chose Always allow, approved a plan or saw the CLI compact → no entry, so no `begin_fork` and no `ResumeFork` afterwards.
- `fork_settings`: keeps the bot's `permissions` and `fastMode` keys unchanged and adds a `PreToolUse` hook with `matcher: "*"` that exits 2.
- `choose_start`:
  - before `warm_until` with the program open → `Continue`, and the fork is discarded;
  - after `warm_until` with a matching fork → `ResumeFork` with exactly the new tail;
  - a fork whose `SessionKey` differs (model, access, effort, prompt, pins, roster) → `Fresh`;
  - a fork whose `Sent` is no longer a prefix (an edited, deleted or hidden message, or the bot's own reply edited) → `Fresh`;
  - the setting turned off after the fork → the fork is not used;
  - no fork, program open, before `cold_after` → `Continue`; after `cold_after` → `Fresh`.
- Ledger: an entry and its fork survive idle close and `LIVE_CAP` eviction; `record_turn` discards the fork; `drop_bot` runs on an unclean end, a key change, roster removal, moving the room to Trash and room deletion; a room moved to Trash after its fork was stored, then restored, gives `Fresh`, never `ResumeFork` or `Continue`; a fresh ledger after a restart gives `Fresh`.
- Per-bot guard: in a room with two Claude bots, a guarded bot gets no pick while the other still gets its own.
- Fork refresh: a fork at t0+57 min whose `result` read the cache moves `warm_until` to about t0+117 min, so the program stays open, and no second pick happens for the same `Sent`.

- [ ] **Step 7: Part C in the adapter and host.** With the fake Claude and a paused tokio clock:
  - an idle thread over the threshold with the setting on: one fork at `pick_at`, started with the bot's exact arguments plus `--resume <id> --fork-session`, sending `/compact ` + `IDLE_COMPACT_ASK`; the fork's usage shows on the bot's meter;
  - with the setting off (the default), no fork ever starts;
  - a return at minute 90 continues the live program, and the fork is discarded;
  - a return after the program retired starts the program with `--resume <fork id>`, sends only the tail, shows the notice once, and the reply is normal;
  - a message during the fork starts its turn at once; the fork process is killed, no notice appears, and the timer is rescheduled after that turn;
  - **kill loses the race:** a fake fork that ignores the kill and prints `compact_boundary` and a `result` after the message's turn has started → nothing stored; the bot's next return (after the program retires) is `Fresh`, not `ResumeFork`;
  - **late result after a toggle:** a fork still running when the setting is turned off and back on → its result is refused and never used;
  - **tool gate:** the fork's launch line carries `fork_settings` (the deny-all hook) and the bot's own access flags; a fake fork that sends `can_use_tool` gets "deny", one that sends any other control request (an `ExitPlanMode` approval included) gets an error, and one that prints a `tool_use` is killed and counted as failed;
  - **grants:** a turn that approves a plan, then idles past `pick_at` → no fork; a turn with Always allow, then idle → no fork; at Ask, the program resumed from a fork is launched with `--permission-mode default` and asks Deck before its first edit;
  - a fork that fails, returns no `compact_boundary` or attempts a tool is discarded and logged, isn't retried for that `Sent`, and the next turn runs as in Tasks 1–8;
  - editing an old message, pinning a fact, changing the bot's model, removing the bot or turning the setting off between the fork and the return → no resume; a fresh full prompt;
  - two Claude bots each fork at their own time; one guarded bot doesn't stop the other;
  - a talk-only chat's fork runs in the chat's isolated folder with no tools;
  - a daemon restart after a fork → the next turn is fresh;
  - deleting the room, or moving it to Trash, kills a running fork, closes the program and cancels its timers; after a restore from Trash, the bot's next turn is a fresh full prompt and no compaction notice appears.

- [ ] **Step 8: Run tests and commit**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host && npx tsc --noEmit`

```bash
git add crates/apex-core crates/apex-adapters crates/apex-host src
git commit -m "feat: compact long idle Claude threads in a fork before the cache expires (off by default)"
```

- [ ] **Step 9: Measure after expiry, then the Human picks the default**

On the dev build with a throwaway data folder (never the real one), using throwaway copies of one real long thread over 100K prompt tokens.

**Same conditions in every arm.** Each arm starts from its own copy of the same thread, primed by the same last turn, and returns with the same follow-up message. Arms that are compared return after **exactly the same delay**. Each copy's first message carries a unique marker, so copies running at the same time can't warm each other's history cache; only the shared system and tool block (about 14.6K) is common, and it is the same in every arm.

| Return delay | Setting on | Setting off | Compact on return |
|---|---|---|---|
| 58 min (inside the pick window) | (a1) fork at ~57 min is paid, then discarded; turn continues warm | (b1) turn continues warm | (c1) = (b1): the cache is still warm, so compact-on-return takes the same path as off; reuse (b1)'s numbers |
| 90 min (between the two expiries) | (a2) fork paid, then discarded; its cache read keeps the program warm | (b2) program retired; fresh full prompt | (c2) Null's harness on the cold session: compact, then reload |
| 2 h 15 min (after the refreshed `cold_after`) | (a3) turn resumes the fork | (b3) fresh full prompt | (c3) Null's harness on the cold session: compact, then reload |

- From these: `C` (the fork, measured in every "on" arm), `w` (a1, b1), `W_full` (b2 for the middle row, b3 for the late row), `R` (a3), and `C_cold` + `R_cold` (c2 for the middle row, c3 for the late row). Each row uses the numbers measured at its own delay, so every option in a row is compared at the same return time. The discarded forks in (a1) and (a2) are counted as spent, not left out.
- Record the wait before the first reply in each arm too: compact-on-return makes the Human wait for the compaction, and the setting doesn't.
- **(d) Return times per eligible idle episode.** From Deck's saved rooms and Claude's session logs (no API calls), last 30 days.
  - **Which turns count:** exactly the cost model's "Eligible idle episode" rule, applied to each Claude bot turn. The lifetime and prompt tokens come from the turn's `result`, and `pick_at` from the same formula as `pick_at()`. Spoiled turns and `SessionKey` changes come from Deck's room records, and restarts from the `apex-daemon: listening on` lines in `~/Library/Logs/Apex Deck/apex-daemon.log`. Write the rule as one function in `scripts/measure-claude-cache.py`, with a comment pointing at `pick_at()` and `pick_due`, so the two can't drift apart unnoticed. Report how many turns over 100K were left out for each reason in the rule. Gaps that ended before `pick_at` cost the same in every option, so leaving them out is fair. Restarts before `pick_at` are left out too, but they aren't the same in every option: compact-on-return would still compact them on return. So report their count beside the compact-on-return result.
  - **Each episode ends one of three ways:**
    - **Returned:** the bot's next turn in the same room. Its start time puts it in one of the first three cost-model rows, unless the room was moved to Trash after `pick_at` and restored before that turn. Then it goes in the restored row, whatever its start time.
    - **No return possible:** the bot was removed, or the room was permanently deleted, before the bot's next turn. This is a final outcome with a known cost, not an open one. Counting it as open would assume those bots come back at the usual rate, which makes returns look more common than they are.
    - **Open:** neither yet. This includes a room still in Trash (`trashed_at` set), because it can still be restored. Its observation window is its age when counted. Don't call it "never": the Human may still come back.
  - **Restores leave no time.** A restore clears `trashed_at` (`host.rs:1135`). The provenance receipts do keep each `room_set_trashed` command with its room id and `trashed: false`, but no time. So a restored room's return can't be placed against `pick_at`. Work the result out twice: once with every episode in a room that has a restore receipt in the window counted in the restored row (the side that hurts "setting on"), and once counted by start time as ordinary returns. Report how many episodes this covers. If the cheapest option differs between the two, report it as undecided, as below.
  - **Shares:** estimate the share of episodes in each of the six cost-model rows up to a fixed horizon `H = 7 days`. Use a cumulative-incidence (Aalen–Johansen) estimate, the version of Kaplan–Meier for more than one kind of ending. It keeps each open episode in the count as "nothing yet" up to its own window, and never leaves open episodes out, which would also make returns look more common. Report the share in each return row, the share with **no return possible**, and the share **still open at H**. Also report how many episodes were open, how many of those are in rooms still in Trash, and their median window.
  - **When the time of an ending is missing:** Deck keeps no time for a permanent delete. `delete_room` removes the room's files (`storage.rs:1060`), and the provenance receipts carry no timestamp. The time a bot was removed may be missing too. If the time is missing, it isn't known whether the gap reached `pick_at` first. Put those episodes on the side that hurts "setting on" in each bound below: in "none return" they count as eligible and paid `C`; in "all return late" they are left out. Report how many there were.
  - **Restarts:** for returns after the refreshed `cold_after`, count how many came after a daemon restart, using the same log lines. Those returns cost `W_full` + `C` with the setting on, not `R` + `C`.

Record every run with `scripts/measure-claude-cache.py` (after Task 8 Step 0) in "Results", with each fork on its own line, including discarded ones. Work out each option's **expected cost per eligible episode** from the cost-model table and the measured shares:
- setting off;
- setting on, with the middle row's saving reported on its own line, because it comes from the fork's cache read and not from the summary;
- compact on return, which pays `C_cold + R_cold` on returns after expiry and nothing on episodes not reopened.

**Bound the unknown share.** Only the episodes still open at `H` are what the data can't show. "No return possible" episodes are not part of this: their cost is known (0 off, `C` on, 0 compact-on-return) and is the same in both bounds. The open ones are treated differently by each option: with the setting on, each has already paid `C`; off and compact-on-return have paid nothing, and would pay later only if the Human comes back. So work out each option's expected cost twice: **if none of them return**, and **if all of them return late**, after the refreshed `cold_after`. An open episode in a room still in Trash can only come back through a restore, so in "all return late" it costs the restored row (`W_full` off, `W_full` + `C` on, `W_full` compact-on-return), not the usual late row. Episodes whose ending has no time go on the side given in (d). Report both numbers for every option.

**Default:** on only if Step 4 passed and "setting on" is clearly cheapest per eligible episode **under both assumptions**. If "compact on return" is cheaper under both, report that instead, because it may be the better design. If the cheapest option differs between the two, report it as undecided and rerun (d) once more days of data have built up. The Human makes the call.

---

## Follow-ups (not in this build)

- Change access and effort on a live program without restarting it (Claude `set_permission_mode` control request; Codex per-turn overrides on `turn/start`), once probed. Today every access or effort change costs one fresh start.
- Stop that interrupts the reply instead of killing the program (Claude `interrupt` control request, Codex `turn/interrupt`), so Stop doesn't cost a fresh start.
- Phone and desktop clients get different interactive-answer instructions, so switching between them restarts a bot's program once.
- If Task 9 Step 9 shows most of the saving is in the middle row (returns between the two expiries), a plain cache-refresh call with no summary may buy it for less than a fork. Measure that then.

## Probe results

(Task 1 and Task 9 Step 5 fill this in.)

## Results

(Tasks 8 and 9 fill this in.)
