# Now tier, Stage 2: attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot stopped on an approval stays flagged until you answer it, routine approvals can be answered from the attention list, Ready flags clear in one click and stay off the dock badge, an approval left waiting in the background bounces the dock once, and every pane head says what is happening.

**Architecture:** A new app-wide store, `src/approvals.ts`, keeps every open approval card (fed by `src/hub.ts` before a thread sees the event, in the pattern of `src/plans.ts`) and derives the blocking flag a thread shows. The rules for flags (`src/attention.ts`), what the attention list can answer in place (`src/answerStrip.ts`) and what a pane head says (`src/composerStatus.ts`) are pure functions with `node:test` tests; `App`, `ChatPane`, `AttentionMenu` and `TerminalPane` only wire them up. On the Rust side, cards from Codex's MCP hook carry `expires_at` (`McpCall.expires_at` copied into `ProposedAction.expires_at`) so the interface can say "Denied automatically in 6m".

**Tech Stack:** React 19 + TypeScript (Vite), `node --experimental-strip-types --test` for pure modules, Rust (apex-core, apex-adapters, Tauri 2). No new dependencies.

**Spec:** docs/superpowers/specs/2026-10-04-now-tier.md (section "Stage 2: attention"; "Shared interfaces" and "Global constraints" bind every task).

## Global Constraints

Copied from the spec. Every task's requirements include this section.

- Preserve everything in "Must keep working" of `2026-10-03-ui-review-fixes.md`: approval cards, the turn queue and steering, `/compact` `/clear` `/pin` `/diff` `/fork` `/export`, attention counts, dragging panes without remounting terminals, and the browser preview behaving like the native app.
- The browser preview backend (`src/backend.ts`, preview half) gets every new command and event the native backend gets.
- Restoring or applying anything never silently raises access or starts an agent. Keys stay out of saved state.
- Standing decisions (`2026-10-03-open-work.md`): slash commands only create something or take text you'd type; no coloured left bars on strips or rows; pins stay a collapsible row above the chat; agent colours are chosen once and saved.
- Copy: second person, plain, sentence case, verb-first buttons, "e.g." placeholders, " · " joins facts, no emoji. Attention colours always come with words. Red (`--danger`) means Failed and destructive actions only.
- No new dependencies.
- New files differ from every existing file name by more than case.
- Commit on the stage's feature branch. Don't push and don't merge to `main` unless Tyler asks. No attribution lines in commit messages.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` (the suite only passes serially).
- Shared interface **`ThreadStatus`** (stage 1, `src/types.ts`) `{ text: string; replying: string[]; waiting: string[] }`; `App` keeps `threadStatus: Record<string, ThreadStatus>`. Stage 2 (2.5) changes how `text` is computed, never the shape.
- Shared interface **`Signal.blocking?: boolean`** (stage 2, `src/attention.ts`): a flag that looking at the pane does not clear. Only open approvals set it.
- Shared interface **`src/approvals.ts`** (stage 2): app-wide store of open approval cards fed by `src/hub.ts`, in the pattern of `src/plans.ts`. Stage 2 defines its exact types; stage 3 (3.1) reads it only through its exported functions.
- Rust wire change **`McpCall.expires_at`** (stage 2), with a `crates/apex-core/tests/wire_format.rs` update. New fields on saved structs use `#[serde(default)]` so older session files still load.
- Stage 2 copy, exactly: "Null wants approval: Run npm test · +1 more" (the "+n more" only when n ≥ 1); "Denied automatically in 6m" (whole minutes, rounded up); "Wants to run a command"; **Allow once** (primary), **Deny** (danger outline), **Open thread** (ghost); "+8 −2 · src/auth/session.ts"; **Open to answer**; "Next in this thread: Edit src/auth/session.ts · +8 −2"; "No approvals waiting"; footer "Most urgent first · Mark ready as seen · ⌘J next"; "Null · Running: npm test · 1m 12s"; "2 replying · Null: Editing src/App.tsx"; "2 bots"; "Quiet 6m · stops at 15m"; "Working 4m".
- Numbers from the spec: list width 440px (was 380px); small edits are 20 changed lines or fewer; escalate after 2 minutes; quiet after 5 minutes; Codex's hook denies after 570 s.

Project facts used below:

- Frontend tests are `tests/*.test.mjs` importing `../src/*.ts`. Run all: `npm test`. One file: `node --experimental-strip-types --test tests/<name>.test.mjs`. Pure modules use type-only imports between each other, or value imports **with the `.ts` extension** (as `src/composerMenu.ts` imports `./serverRequests.ts`); no enums, no parameter properties, no React. `tsconfig.json` has `noUnusedLocals` and `noUnusedParameters`, so every parameter must be used.
- Build: `npm run build` (`tsc --noEmit && vite build`).
- Rust: `cargo test --workspace -- --test-threads=1`. One file: `cargo test -p apex-core --test wire_format -- --test-threads=1`.
- Browser preview: `npm run dev` serves http://localhost:1420/ with the stand-in backend (a "Preview mode" badge shows in the title bar).

**Line numbers** below are from `main@95d753d` plus Tyler's uncommitted composer auto-grow change (which adds 7 lines near `src/ChatPane.tsx:425`), before stage 1. Stage 1 edits `src/App.tsx`, `src/ChatPane.tsx` and `src/closing.ts`, so the numbers will have moved; every step quotes the code it changes, so find it by that.

## Review Focus

1. **Sending, queueing or steering while a bot waits on a card.** A human message makes the thread clear its own flag (`src/ChatPane.tsx:497`). A reasonable person expects the amber flag and its ⌘J spot to stay until the card is answered. Pinned by Task 3's test `sending a message while a bot waits on a card keeps its flag`.
2. **The same request id in two threads.** The native desk numbers cards per thread (`ask-1`, `ask-2` in each, `crates/apex-core/src/approval.rs:168`). Answering or resolving `ask-1` in one thread must leave the other thread's card, flag and escalation alone. Pinned by Task 2's test `cards with the same request id in two threads stay apart` (and Task 8's escalation test).
3. **A turn that ends without an `approval_resolved` for its card.** The preview's Stop drops the event (its `emit` is muted once cancelled, `src/backend.ts:221`), and a deleted thread emits nothing more (`src-tauri/src/lib.rs:299`). There must be no stuck flag, list row or strip. Pinned by Task 2's test `a turn that ends takes its cards with it, even without an answer`.
4. **A card whose content wasn't reported**: an edit with no diff (Codex's "The edit was not described.", `crates/apex-adapters/src/codex_server.rs:103`) or a command shown as "(command not given)" (`:92`). The list must offer only **Open to answer**, never Allow once on something you can't see. Pinned by Task 5's test `a card whose content wasn't reported is never answered blind`.
5. **A bot whose last step was "Waiting for approval: …" after its card is answered**, and time spent waiting on a card. The head must not keep saying "Waiting for approval", and time on a card must never count toward "Quiet". Pinned by Task 9's test `an answered card's step doesn't linger, and waiting on a card isn't silence`.

---

## File map

| File | Change |
|---|---|
| `crates/apex-core/src/approval.rs` | `ProposedAction.expires_at` (serde default, skipped when none). |
| `crates/apex-adapters/src/codex_hook.rs` | `McpCall.expires_at`, set when the hook's call arrives; copied into the card. |
| `crates/apex-adapters/src/{events,mcp,cli,codex_server}.rs`, `crates/apex-core/src/room.rs`, `src-tauri/src/lib.rs`, Rust tests | `expires_at: None` in every other `ProposedAction` and `McpCall`. |
| `crates/apex-core/tests/wire_format.rs` | The new field's JSON. |
| `src/Approvals.tsx` → `src/ApprovalCard.tsx` | Renamed (see Task 2); the card shows its deadline. Stage 5's plan names the old path and must follow the rename if it runs after this stage. |
| `src/approvals.ts` (new) | Open-card store, the blocking flag, card titles and deadlines, escalation. |
| `src/answerStrip.ts` (new) | What the attention list offers for a thread's cards. |
| `src/attention.ts` | `Signal.blocking`; flag reducers; Ready and badge rules; `Burst.runStartedAt`. |
| `src/composerStatus.ts` | `elapsed` (moved), `headLine`, `doingNow`, `quietLine`, `heardFrom`, `isCommandLine`, `workingFor`. |
| `src/hub.ts` | Feeds the store. |
| `src/ChatPane.tsx` | Cards from the store; blocking signal; head text; quiet working line. |
| `src/App.tsx` | Flag reducers; cards on list items; answer, Mark ready, badge, escalation; terminal "Working 4m". |
| `src/AttentionMenu.tsx` | Answer strips, remembered rows, footer button, 440px. |
| `src/TerminalPane.tsx` | Reports the start of each run of output. |
| `src/backend.ts` | `requestCriticalAttention`; preview: two cards at once, a tool card that expires, `stall` and `long` triggers. |
| `src/types.ts` | `ProposedAction.expires_at`. |
| `src/styles.css` | Strip, list, quiet line, card deadline, head truncation. |
| `tests/approvals.test.mjs`, `tests/answer-strip.test.mjs` (new); `tests/attention.test.mjs`, `tests/composer-status.test.mjs` | Tests below. |
| `README.md`, `SPEC.md` | Task 12. |

---

### Task 0: Preflight

**Files:** none changed.

**Interfaces:**
- Consumes: stage 1's `ThreadStatus` in `src/types.ts`, `ChatPane`'s `onStatus?: (paneId: string, status: ThreadStatus) => void`, and `App`'s `threadStatus: Record<string, ThreadStatus>`.
- Produces: branch `feat/now-2-attention`; baseline counts B<sub>ts</sub> (frontend tests) and B<sub>rs</sub> (Rust tests) that later tasks compare against.

- [ ] **Step 1: Check the working tree**

Run: `git -C /Users/tylercaldwell/Downloads/apex-deck status --short`
Expected today: ` M src/ChatPane.tsx`, ` M src/styles.css`, and untracked `docs/superpowers/specs/` and plan files.

If `src/ChatPane.tsx` or `src/styles.css` still show as modified, those are Tyler's composer auto-grow change and not part of this plan. **Stop and ask Tyler** whether to commit them first (on `main` as his own commit, or as the first commit on the stage branch; his call). Never stash, reset, restore or discard them. This plan edits and commits both files with `git add <path>`, so it cannot start while his edits are uncommitted: they would be swept into a stage commit. Leave untracked docs alone; commit steps always name their files.

- [ ] **Step 2: Find stage 1**

Stage 2 must follow stage 1 (both change how `ChatPane` reports its state). Run:

```bash
cd /Users/tylercaldwell/Downloads/apex-deck
git show main:src/types.ts | grep -n "export interface ThreadStatus"
git branch --list 'feat/now-1*'
```

- If the first command prints a line, stage 1 is merged: base on `main`.
- Otherwise, if the second lists a branch (expected `feat/now-1-safety`), confirm it has the interface with `git show feat/now-1-safety:src/types.ts | grep -n "export interface ThreadStatus"` and base on that branch. Say in your report that stage 2 is stacked on the unmerged stage 1 branch.
- If neither, **stop and ask Tyler**.

- [ ] **Step 3: Create the stage branch**

Run (with the base from Step 2): `git switch -c feat/now-2-attention main` or `git switch -c feat/now-2-attention feat/now-1-safety`
Expected: `Switched to a new branch 'feat/now-2-attention'`.

- [ ] **Step 4: Confirm stage 1's shapes**

Run: `grep -n "ThreadStatus" src/types.ts src/ChatPane.tsx src/App.tsx`
Expected: the interface in `src/types.ts` with `text`, `replying`, `waiting`; `onStatus?: (paneId: string, status: ThreadStatus) => void` in `src/ChatPane.tsx`; `Record<string, ThreadStatus>` in `src/App.tsx`. Also run `grep -n "threadStatusOf" src/composerStatus.ts src/ChatPane.tsx tests/composer-status.test.mjs`: stage 1 (its Task 1) adds `threadStatusOf(bots, working, asking): ThreadStatus` to `src/composerStatus.ts` (with `import type { ThreadStatus } from "./types";` at the top), imports it in the test file's line 3, and builds the thread's status in `ChatPane` where today's `statusText` was (`src/ChatPane.tsx:967-969`) as `const status = threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0));`. Task 10 replaces that line. If any shape differs, stop and ask.

- [ ] **Step 5: Record baselines**

Run each and write the counts in your report:

```bash
npm test 2>&1 | tail -8          # B_ts = the "ℹ pass" number (113 on main@95d753d, plus stage 1's)
npm run build 2>&1 | tail -3     # expect "✓ built in"
cargo test --workspace -- --test-threads=1 2>&1 | grep "test result"   # B_rs = sum of "passed"
```

Expected: all pass, 0 failed. If anything fails before you change a line, stop and report it.

---

### Task 1: Codex hook cards carry their deadline (`McpCall.expires_at`)

**Files:**
- Modify: `crates/apex-core/src/approval.rs:39-47` (field) and its tests `:272`, `:281-283`, `:300`
- Modify: `crates/apex-adapters/src/codex_hook.rs:163-192` (`McpCall`), `:310-319` (`serve`), tests `:441-560`
- Modify: `crates/apex-adapters/src/mcp.rs:17`, `crates/apex-adapters/src/events.rs:381-385`, `:389`, `:392`, `:941`, `:945`, `crates/apex-adapters/src/cli.rs:581`, `crates/apex-adapters/src/codex_server.rs:97`, `:104`, `:137`, `:161`, tests `:553`, `:658-661`
- Modify: `crates/apex-core/src/room.rs:743`, `crates/apex-core/tests/room.rs:512`, `:568`, `crates/apex-adapters/tests/adapters.rs:818`, `:873`, `src-tauri/src/lib.rs:934`
- Modify: `src/types.ts:9-15`
- Test: `crates/apex-core/tests/wire_format.rs`, `crates/apex-adapters/src/codex_hook.rs` (unit tests), `crates/apex-adapters/src/codex_server.rs` (unit tests)

**Interfaces:**
- Produces: Rust `ProposedAction { kind, title, detail, expires_at: Option<u64> }` (Unix milliseconds; JSON key `expires_at`, omitted when `None`); `McpCall { server, tool, arguments, expires_at: Option<u64> }`; TypeScript `ProposedAction.expires_at?: number | null` (milliseconds since the epoch, comparable with `Date.now()`).

- [ ] **Step 1: Write the failing wire test**

Append to `crates/apex-core/tests/wire_format.rs`:

```rust
#[test]
fn a_card_from_codexs_hook_says_when_it_is_denied() {
    let mut action = apex_core::ProposedAction {
        kind: apex_core::ActionKind::Tool,
        title: "x-mcp: post_tweet".into(),
        detail: "{}".into(),
        expires_at: None,
    };
    assert_eq!(to_value(&action).unwrap(), json!({ "kind": "tool", "title": "x-mcp: post_tweet", "detail": "{}" }), "no deadline, no field");
    action.expires_at = Some(1_791_100_000_000);
    assert_eq!(
        to_value(RoomEvent::ApprovalRequested { id: ParticipantId::new("null"), request: "ask-2".into(), action }).unwrap(),
        json!({ "type": "approval_requested", "id": "null", "request": "ask-2",
                "action": { "kind": "tool", "title": "x-mcp: post_tweet", "detail": "{}", "expires_at": 1_791_100_000_000u64 } })
    );
    let older: apex_core::ProposedAction = serde_json::from_value(json!({ "kind": "command", "title": "Run a command", "detail": "ls" })).unwrap();
    assert_eq!(older.expires_at, None, "JSON without the field still reads");
}
```

- [ ] **Step 2: Write the failing hook test**

In `crates/apex-adapters/src/codex_hook.rs`, inside `mod tests`, after `struct Never` and its `impl` (around `:503-508`), add:

```rust
    /// Keeps every card it is shown and refuses it.
    struct Recording(std::sync::Mutex<Vec<ProposedAction>>);
    #[async_trait::async_trait]
    impl Approver for Recording {
        async fn decide(&self, action: ProposedAction) -> Decision {
            self.0.lock().unwrap().push(action);
            Decision::Reject
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_card_says_when_the_helper_gives_up() {
        use tokio::io::AsyncWriteExt;
        let (deck_end, mut helper_end) = tokio::net::UnixStream::pair().unwrap();
        helper_end.write_all(&[CALL, &b"\n"[..]].concat()).await.unwrap();
        let asked = Recording(std::sync::Mutex::new(Vec::new()));
        let before = unix_ms();
        serve(deck_end, &mut Gates::default(), &asked, &|_: Progress<'_>| {}).await;
        let after = unix_ms();
        let deadline = HELPER_DEADLINE.as_millis() as u64;
        let cards = asked.0.lock().unwrap();
        let expires = cards[0].expires_at.expect("a card from the hook has a deadline");
        assert!((before + deadline..=after + deadline).contains(&expires), "{expires} is not {deadline} ms after the call arrived");
        assert_eq!(McpCall::from_hook("mcp__probe__place_order", json!({})).action().expires_at, None, "only calls that came through the hook expire");
    }
```

In `crates/apex-adapters/src/codex_server.rs` tests:
- in `mcp_approval_binds_exact_arguments_and_rejects_ambiguous_or_unrelated_forms`, after `assert_eq!(resolved.action().title,"probe: post: read");` (`:553`) add:

```rust
        assert_eq!(resolved.action().expires_at, None, "Codex's own MCP approval never shows a deadline");
```

- in `approval_requests_become_proposals_and_other_requests_do_not`, after the `edit` assertion (`:661`) add:

```rust
        assert_eq!((command.expires_at, edit.expires_at), (None, None), "Codex requestApproval never shows a deadline");
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: FAIL to compile, `error[E0560]: struct `ProposedAction` has no field named `expires_at``.

Run: `cargo test -p apex-adapters --lib codex -- --test-threads=1`
Expected: FAIL to compile, `no field `expires_at` on type `ProposedAction`` and `cannot find function `unix_ms``.

- [ ] **Step 4: Add the field**

In `crates/apex-core/src/approval.rs` replace the struct at `:39-47`:

```rust
/// Something a participant wants to do and is waiting for permission for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedAction {
    pub kind: ActionKind,
    /// One line, such as "Edit src/main.rs" or "Run a command".
    pub title: String,
    /// The whole of it: the diff, the command, or the tool's arguments.
    pub detail: String,
    /// When the asking tool gives up and denies it, in Unix milliseconds.
    /// Only Codex MCP calls checked by Deck's hook have one; everything
    /// else waits as long as the person takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}
```

- [ ] **Step 5: Give every other `ProposedAction` and `McpCall` no deadline**

Add `expires_at: None` to each literal below (the compiler lists any you miss as `missing field `expires_at``):

`crates/apex-core/src/approval.rs`
```rust
// :272
        let action = ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "rm -rf /".into(), expires_at: None };
// :281-283
        let app = |name: &str| ProposedAction { kind: ActionKind::Other, title: "cua_repl asks permission".into(), detail: format!("Allow Computer Use to use \"{name}\"?"), expires_at: None };
        let order = |qty: u32| ProposedAction { kind: ActionKind::Tool, title: "robinhood: place_order".into(), detail: format!("{{\"qty\":{qty}}}"), expires_at: None };
        let run = |cmd: &str| ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None };
// :300
        let run = |cmd: &str| ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None };
```

`crates/apex-core/src/room.rs:743`
```rust
        ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into(), expires_at: None }
```

`crates/apex-core/tests/room.rs:512` and `:568`
```rust
        let action = ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-a\n+b\n".into(), expires_at: None };
```
```rust
    let action = ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-a\n+b\n".into(), expires_at: None };
```

`crates/apex-core/tests/wire_format.rs:121` and `:126`
```rust
    let action = apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: "ls".into(), expires_at: None };
```
```rust
    let rule = apex_core::AllowedRule::new(&id, &apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: "npm test".into(), expires_at: None });
```

`crates/apex-adapters/src/mcp.rs:17`
```rust
    ProposedAction { kind: ActionKind::Tool, title: format!("{server}: {tool}"), detail: serde_json::to_string_pretty(arguments).expect("JSON value"), expires_at: None }
```

`crates/apex-adapters/src/events.rs:381-392`
```rust
            return ProposedAction {
                kind: ActionKind::Edit,
                title: format!("{verb} {}", change.path),
                detail: changes.iter().map(|c| c.diff.as_str()).collect::<Vec<_>>().join("\n"),
                expires_at: None,
            };
        }
        if tool == "Bash" {
            let command = input["command"].as_str().unwrap_or("").to_string();
            return ProposedAction { kind: ActionKind::Command, title: "Run a command".to_string(), detail: command, expires_at: None };
        }
        let detail = serde_json::to_string_pretty(input).unwrap_or_default();
        ProposedAction { kind: ActionKind::Other, title: self.claude_activity(tool, input), detail, expires_at: None }
```

`crates/apex-adapters/src/events.rs:941` and `:945`
```rust
        assert_eq!(edit, ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-hi\n+hello\n".into(), expires_at: None });
```
```rust
        assert_eq!(run, ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "rm -rf build".into(), expires_at: None });
```

`crates/apex-adapters/src/cli.rs:581`
```rust
        let mut waiting = timed.decide(ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into(), expires_at: None });
```

`crates/apex-adapters/src/codex_server.rs:97`, `:104`, `:137`, `:161`
```rust
            Some(ProposedAction { kind: ActionKind::Command, title: "Run a command".to_string(), detail, expires_at: None })
```
```rust
            Some(ProposedAction { kind: ActionKind::Edit, title, detail, expires_at: None })
```
```rust
    Some(McpCall { server: server.to_string(), tool: item["tool"].as_str()?.to_string(), arguments: arguments.clone(), expires_at: None })
```
```rust
    Some(ProposedAction { kind: ActionKind::Other, title: format!("{server} asks permission"), detail, expires_at: None })
```

`crates/apex-adapters/src/codex_hook.rs` test literals (`:550`, `:554`)
```rust
        let plugin = McpCall { server: "computer-history".into(), tool: "post_note".into(), arguments: json!({"text":"hi"}), expires_at: None };
```
```rust
        let app = McpCall { server: "codex_apps".into(), tool: "github.post_comment".into(), arguments: json!({"text":"hi"}), expires_at: None };
```

`crates/apex-adapters/tests/adapters.rs:818` and `:873`
```rust
        [ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "(command not given)".into(), expires_at: None }]
```
```rust
        [ProposedAction { kind: ActionKind::Edit, title: "Write hello.txt".into(), detail: "+hi\n".into(), expires_at: None }]
```

`src-tauri/src/lib.rs:934`
```rust
        let run = |cmd: &str| apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None };
```

- [ ] **Step 6: Stamp hook calls with the helper's deadline**

In `crates/apex-adapters/src/codex_hook.rs` replace `McpCall` and its `impl` (`:163-192`):

```rust
/// One MCP call, as both gates see it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct McpCall {
    pub server: String,
    pub tool: String,
    pub arguments: Value,
    /// When Deck's hook helper gives up and blocks the call, in Unix
    /// milliseconds. Only calls that came through the hook have one.
    pub expires_at: Option<u64>,
}

impl McpCall {
    /// From the hook's `tool_name`, `mcp__<server>__<tool>`. A name of any
    /// other shape keeps no server and always asks.
    pub(crate) fn from_hook(tool_name: &str, arguments: Value) -> Self {
        match crate::mcp::claude_tool(tool_name) {
            Some((server, tool)) => Self { server: server.to_string(), tool: tool.to_string(), arguments, expires_at: None },
            None => Self { server: String::new(), tool: tool_name.to_string(), arguments, expires_at: None },
        }
    }

    /// The same call, blocked by its helper at `at` (Unix milliseconds).
    #[cfg(unix)]
    pub(crate) fn expiring_at(mut self, at: u64) -> Self {
        self.expires_at = Some(at);
        self
    }

    pub(crate) fn risky(&self) -> bool {
        self.server.is_empty() || crate::mcp::needs_approval(&self.tool)
    }

    /// The card for this call. A hook call's card says when it is denied.
    pub(crate) fn action(&self) -> ProposedAction {
        let mut action = crate::mcp::action(&self.server, &self.tool, &self.arguments);
        if self.server.is_empty() {
            action.title = self.tool.clone();
        }
        action.expires_at = self.expires_at;
        action
    }
}

/// Now, in Unix milliseconds: the clock the interface reads cards by.
#[cfg(unix)]
fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}
```

In `serve` replace the `let call = …;` block (`:315-319`):

```rust
    let call = match tokio::time::timeout(Duration::from_secs(5), read.read_line(&mut line)).await {
        Ok(Ok(count)) if count > 0 => serde_json::from_str::<Value>(&line).ok()
            .and_then(|input| Some(McpCall::from_hook(input["tool_name"].as_str()?, input["tool_input"].clone())))
            // The helper started its clock as it sent the call.
            .map(|call| call.expiring_at(unix_ms() + HELPER_DEADLINE.as_millis() as u64)),
        _ => None,
    };
```

- [ ] **Step 7: Mirror the field in TypeScript**

In `src/types.ts` replace `ProposedAction` (`:9-15`):

```ts
/** Something a bot wants to do and is waiting for a yes or no on. */
export interface ProposedAction {
  kind: "edit" | "command" | "tool" | "other";
  /** One line, such as "Edit src/main.rs". */
  title: string;
  /** The diff, the command, or the tool's arguments. */
  detail: string;
  /** When Codex's hook denies it if nobody answers, in milliseconds since the epoch. Only MCP calls checked by Deck's hook have one. */
  expires_at?: number | null;
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: `test result: ok.` including `a_card_from_codexs_hook_says_when_it_is_denied`.

Run: `cargo test -p apex-adapters --lib codex -- --test-threads=1`
Expected: `test result: ok.` including `a_hook_card_says_when_the_helper_gives_up`.

Run: `cargo test --workspace -- --test-threads=1 2>&1 | grep "test result"`
Expected: every line `ok`, total passed = B<sub>rs</sub> + 2, no warnings about `unix_ms` or `expiring_at`.

Run: `npm run build`
Expected: `✓ built in`.

- [ ] **Step 9: Commit**

```bash
git add crates/apex-core/src/approval.rs crates/apex-core/src/room.rs crates/apex-core/tests/room.rs crates/apex-core/tests/wire_format.rs \
  crates/apex-adapters/src/codex_hook.rs crates/apex-adapters/src/codex_server.rs crates/apex-adapters/src/events.rs \
  crates/apex-adapters/src/mcp.rs crates/apex-adapters/src/cli.rs crates/apex-adapters/tests/adapters.rs src-tauri/src/lib.rs src/types.ts
git commit -m "feat: Codex hook cards say when they are denied automatically"
```

---

### Task 2: The open-card store (`src/approvals.ts`)

**Files:**
- Rename: `src/Approvals.tsx` → `src/ApprovalCard.tsx` (imports at `src/ChatPane.tsx:23`, `src/DiffPanel.tsx:2`)
- Create: `src/approvals.ts`
- Modify: `src/attention.ts:13-19` (`Signal`), `src/hub.ts:1-24`
- Test: `tests/approvals.test.mjs` (new)

Why the rename: with `src/approvals.ts` beside `src/Approvals.tsx`, the extensionless import `"./Approvals"` resolves to `approvals.ts` on macOS's case-insensitive disk (Vite and `tsc` try `.ts` before `.tsx`), breaking the build. The spec fixes the store's name, so the card component moves.

**Interfaces:**
- Consumes: `ProposedAction.expires_at` (Task 1).
- Produces (stage 3 reads only these):
  - `interface OpenCard { room: string; participant: string; request: string; action: ProposedAction; at: number }`
  - `type ApprovalState = Readonly<Record<string, readonly OpenCard[]>>`
  - `applyApprovalEvent(state: ApprovalState, room: string, event: RoomEvent, now: number): ApprovalState`
  - `recordApproval(room: string, event: RoomEvent): void`, `forgetRoom(room: string): void`
  - `subscribeApprovals(listener: () => void): () => void`, `approvalSnapshot(): ApprovalState`
  - `openCards(room: string, from?: ApprovalState): readonly OpenCard[]` (oldest first)
  - `cardsByBot(cards: readonly OpenCard[]): Record<string, OpenCard[]>`
  - `cardLabel(kind: ProposedAction["kind"]): string`, `cardTitle(action: ProposedAction): string`
  - `approvalSignal(cards: readonly OpenCard[], names: ReadonlyMap<string, string>, now: number): Signal | null`
  - `deadlineNote(expiresAt: number | null | undefined, now: number): string | null`
  - `Signal.blocking?: boolean` in `src/attention.ts`

- [ ] **Step 1: Rename the card component**

```bash
git mv src/Approvals.tsx src/ApprovalCard.tsx
```

In `src/ChatPane.tsx:23` change `import { ApprovalCard, type MadeChange } from "./Approvals";` to:

```ts
import { ApprovalCard, type MadeChange } from "./ApprovalCard";
```

In `src/DiffPanel.tsx:2` change `import { Diff } from "./Approvals";` to:

```ts
import { Diff } from "./ApprovalCard";
```

Run: `npm run build`
Expected: `✓ built in` (nothing else changed yet).

- [ ] **Step 2: Write the failing tests**

Create `tests/approvals.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyApprovalEvent, approvalSignal, approvalSnapshot, cardLabel, cardTitle, cardsByBot,
  deadlineNote, forgetRoom, openCards, recordApproval, subscribeApprovals,
} from "../src/approvals.ts";

const run = (detail) => ({ kind: "command", title: "Run a command", detail });
const edit = { kind: "edit", title: "Edit src/auth/session.ts", detail: "-a\n+b\n" };
const asked = (id, request, action) => ({ type: "approval_requested", id, request, action });
const answered = (id, request) => ({ type: "approval_resolved", id, request, approved: true });
const names = new Map([["null", "Null"], ["jigga", "Jigga"]]);

test("cards open in order and close when answered", () => {
  let state = {};
  state = applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 100);
  state = applyApprovalEvent(state, "t", asked("jigga", "ask-2", edit), 200);
  assert.deepEqual(openCards("t", state).map((c) => [c.room, c.participant, c.request, c.at]), [["t", "null", "ask-1", 100], ["t", "jigga", "ask-2", 200]]);
  assert.equal(applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 300), state, "the same request twice is one card");
  state = applyApprovalEvent(state, "t", answered("null", "ask-1"), 400);
  assert.deepEqual(openCards("t", state).map((c) => c.request), ["ask-2"]);
  state = applyApprovalEvent(state, "t", answered("jigga", "ask-2"), 500);
  assert.deepEqual(state, {});
  assert.equal(applyApprovalEvent(state, "t", { type: "delta", id: "null", text: "hi" }, 600), state, "other events change nothing");
  assert.equal(applyApprovalEvent(state, "t", answered("null", "ask-9"), 700), state, "an answer to nothing changes nothing");
});

test("cards with the same request id in two threads stay apart", () => {
  let state = {};
  state = applyApprovalEvent(state, "a", asked("null", "ask-1", run("npm test")), 1);
  state = applyApprovalEvent(state, "b", asked("null", "ask-1", run("cargo test")), 2);
  state = applyApprovalEvent(state, "a", answered("null", "ask-1"), 3);
  assert.deepEqual(openCards("a", state), []);
  assert.equal(openCards("b", state)[0].action.detail, "cargo test");
});

test("a turn that ends takes its cards with it, even without an answer", () => {
  let state = {};
  state = applyApprovalEvent(state, "t", asked("null", "ask-1", run("npm test")), 1);
  state = applyApprovalEvent(state, "t", asked("jigga", "ask-2", edit), 2);
  state = applyApprovalEvent(state, "t", { type: "participant_idle", id: "null" }, 3);
  assert.deepEqual(openCards("t", state).map((c) => c.participant), ["jigga"]);
  state = applyApprovalEvent(state, "t", { type: "idle" }, 4);
  assert.deepEqual(state, {});

  recordApproval("gone", asked("null", "ask-9", run("ls")));
  assert.equal(openCards("gone").length, 1);
  forgetRoom("gone");
  assert.equal(openCards("gone").length, 0, "a thread whose pane went away keeps no cards");
});

test("the store tells subscribers when cards change, and only then", () => {
  let calls = 0;
  const stop = subscribeApprovals(() => calls++);
  const before = approvalSnapshot();
  recordApproval("s", { type: "delta", id: "null", text: "x" });
  assert.equal(approvalSnapshot(), before, "the snapshot stays the same object");
  assert.equal(calls, 0);
  recordApproval("s", asked("null", "ask-1", run("ls")));
  assert.equal(calls, 1);
  forgetRoom("never-opened");
  assert.equal(calls, 1);
  recordApproval("s", answered("null", "ask-1"));
  assert.equal(calls, 2);
  stop();
  recordApproval("s", asked("null", "ask-2", run("ls")));
  assert.equal(calls, 2, "no calls once unsubscribed");
  forgetRoom("s");
});

test("the flag comes from the oldest card and counts the rest", () => {
  const cards = [
    { room: "t", participant: "null", request: "ask-1", action: run("npm test"), at: 100 },
    { room: "t", participant: "jigga", request: "ask-2", action: edit, at: 200 },
  ];
  assert.deepEqual(approvalSignal(cards, names, 300), { kind: "needs_input", note: "Null wants approval: Run npm test · +1 more", at: 100, blocking: true });
  assert.deepEqual(approvalSignal(cards.slice(1), names, 300), { kind: "needs_input", note: "Jigga wants approval: Edit src/auth/session.ts", at: 200, blocking: true });
  assert.equal(approvalSignal([], names, 300), null);
  const expired = { room: "t", participant: "null", request: "ask-3", action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", expires_at: 250 }, at: 50 };
  assert.equal(approvalSignal([expired], names, 300), null, "a card past its deadline is being denied");
  assert.equal(approvalSignal([expired, ...cards], names, 300).note, "Null wants approval: Run npm test · +1 more");
  assert.equal(approvalSignal([{ ...cards[0], participant: "ghost" }], names, 300).note, "ghost wants approval: Run npm test", "an unknown bot is named by its handle");
});

test("a command reads as Run and its first line", () => {
  assert.equal(cardTitle(run("npm test -- --run auth")), "Run npm test -- --run auth");
  assert.equal(cardTitle(run("cargo test\n\nneeds network")), "Run cargo test", "Codex's reason stays out");
  assert.equal(cardTitle(run("")), "Run a command");
  assert.equal(cardTitle(run("x".repeat(80))), `Run ${"x".repeat(59)}…`);
  assert.equal(cardTitle(edit), "Edit src/auth/session.ts");
  assert.deepEqual(["edit", "command", "tool", "other"].map(cardLabel), ["Wants to change a file", "Wants to run a command", "Wants to call an MCP tool", "Wants permission"]);
});

test("a deadline reads in whole minutes, rounded up", () => {
  const now = 1_000_000;
  assert.equal(deadlineNote(null, now), null);
  assert.equal(deadlineNote(undefined, now), null);
  assert.equal(deadlineNote(now + 570_000, now), "Denied automatically in 10m");
  assert.equal(deadlineNote(now + 5 * 60_000 + 1, now), "Denied automatically in 6m");
  assert.equal(deadlineNote(now + 6 * 60_000, now), "Denied automatically in 6m");
  assert.equal(deadlineNote(now + 10, now), "Denied automatically in 1m");
  assert.equal(deadlineNote(now - 5_000, now), "Denied automatically in 1m", "never 0m or less");
});

test("cards group by the bot that asked", () => {
  const a = { room: "t", participant: "null", request: "ask-1", action: edit, at: 1 };
  const b = { room: "t", participant: "jigga", request: "ask-2", action: edit, at: 2 };
  const c = { room: "t", participant: "null", request: "ask-3", action: edit, at: 3 };
  assert.deepEqual(cardsByBot([a, b, c]), { null: [a, c], jigga: [b] });
  assert.deepEqual(cardsByBot([]), {});
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/approvals.test.mjs`
Expected: FAIL, `Cannot find module '…/src/approvals.ts'`.

- [ ] **Step 4: Add `Signal.blocking`**

In `src/attention.ts` replace `Signal` (`:13-19`):

```ts
export interface Signal {
  kind: Attention;
  /** A few words on why, such as "Waiting for approval". */
  note: string;
  /** When it was raised, in milliseconds since the epoch. */
  at: number;
  /** A flag looking at the pane does not clear. Only open approval cards set it; see approvals.ts. */
  blocking?: boolean;
}
```

- [ ] **Step 5: Write the store**

Create `src/approvals.ts`:

```ts
// Open approval cards, kept once for the whole app.
//
// A bot set to ask first stops on a card until the person answers it. The
// thread draws the card, but the attention list, the pane's flag and the
// dock need to know about it too, wherever the person is looking. Every
// chat's events feed this store (see hub.ts) before the thread sees them.
//
// Every card ends with `approval_resolved`, including on Stop and when its
// turn is dropped. As a backstop, a bot's turn ending, the thread going
// idle, or the thread's pane going away also takes its cards down, so a
// lost event can never leave a flag stuck on.

import type { Signal } from "./attention";
import type { ProposedAction, RoomEvent } from "./types";

/** One card waiting for an answer. */
export interface OpenCard {
  /** The thread it is in: the chat pane's id, which is also its room id. */
  room: string;
  /** The bot that asked. */
  participant: string;
  /** What `roomDecide` answers. Unique within its thread only. */
  request: string;
  action: ProposedAction;
  /** When it arrived, in milliseconds since the epoch. */
  at: number;
}

/** Every open card by thread, oldest first. */
export type ApprovalState = Readonly<Record<string, readonly OpenCard[]>>;

const NONE: readonly OpenCard[] = [];

function withRoom(state: ApprovalState, room: string, cards: readonly OpenCard[]): ApprovalState {
  const { [room]: _old, ...rest } = state;
  return cards.length > 0 ? { ...rest, [room]: cards } : rest;
}

/** The cards after one room event. Events that neither open nor close a card change nothing. */
export function applyApprovalEvent(state: ApprovalState, room: string, event: RoomEvent, now: number): ApprovalState {
  const cards = state[room] ?? NONE;
  switch (event.type) {
    case "approval_requested":
      if (cards.some((card) => card.request === event.request)) return state;
      return withRoom(state, room, [...cards, { room, participant: event.id, request: event.request, action: event.action, at: now }]);
    case "approval_resolved": {
      const left = cards.filter((card) => card.request !== event.request);
      return left.length === cards.length ? state : withRoom(state, room, left);
    }
    case "participant_idle": {
      const left = cards.filter((card) => card.participant !== event.id);
      return left.length === cards.length ? state : withRoom(state, room, left);
    }
    case "idle":
      return cards.length === 0 ? state : withRoom(state, room, NONE);
    default:
      return state;
  }
}

let state: ApprovalState = {};
const listeners = new Set<() => void>();

function publish(next: ApprovalState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Feed one room event to the store. hub.ts calls this for every event. */
export function recordApproval(room: string, event: RoomEvent): void {
  publish(applyApprovalEvent(state, room, event, Date.now()));
}

/** Take down a thread's cards, as when its pane goes away. */
export function forgetRoom(room: string): void {
  if (state[room]) publish(withRoom(state, room, NONE));
}

/** For useSyncExternalStore: called whenever a card opens or closes anywhere. */
export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For useSyncExternalStore: every open card, the same object until one changes. */
export function approvalSnapshot(): ApprovalState {
  return state;
}

/** A thread's open cards, oldest first. */
export function openCards(room: string, from: ApprovalState = state): readonly OpenCard[] {
  return from[room] ?? NONE;
}

/** A thread's cards by the bot that asked, each oldest first. */
export function cardsByBot(cards: readonly OpenCard[]): Record<string, OpenCard[]> {
  const by: Record<string, OpenCard[]> = {};
  for (const card of cards) (by[card.participant] ??= []).push(card);
  return by;
}

/** The kind label a card and the attention list show. */
export function cardLabel(kind: ProposedAction["kind"]): string {
  return kind === "edit" ? "Wants to change a file" : kind === "command" ? "Wants to run a command" : kind === "tool" ? "Wants to call an MCP tool" : "Wants permission";
}

/** A card in a few words: a command as "Run" and its first line (at most 60 characters), anything else by its title. */
export function cardTitle(action: ProposedAction): string {
  if (action.kind !== "command") return action.title;
  const line = action.detail.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return action.title;
  return `Run ${line.length > 60 ? `${line.slice(0, 59)}…` : line}`;
}

/** Whether a card still waits: one past its deadline is being denied by Codex's hook. */
function waiting(card: OpenCard, now: number): boolean {
  return card.action.expires_at == null || card.action.expires_at > now;
}

/**
 * The flag a thread shows while cards are open, from its oldest card:
 * "Null wants approval: Run npm test · +1 more". It is blocking, so looking
 * at the thread doesn't clear it, and its time is the oldest card's
 * arrival, so a new card never resets "ago". No cards, no flag.
 */
export function approvalSignal(cards: readonly OpenCard[], names: ReadonlyMap<string, string>, now: number): Signal | null {
  const live = cards.filter((card) => waiting(card, now));
  const oldest = live[0];
  if (!oldest) return null;
  const more = live.length - 1;
  const who = names.get(oldest.participant) ?? oldest.participant;
  return { kind: "needs_input", note: `${who} wants approval: ${cardTitle(oldest.action)}${more >= 1 ? ` · +${more} more` : ""}`, at: oldest.at, blocking: true };
}

/** "Denied automatically in 6m": the time left on a card Codex's hook will deny, in whole minutes rounded up. Null for a card that waits as long as you take. */
export function deadlineNote(expiresAt: number | null | undefined, now: number): string | null {
  if (expiresAt == null) return null;
  return `Denied automatically in ${Math.max(1, Math.ceil((expiresAt - now) / 60_000))}m`;
}
```

- [ ] **Step 6: Feed the store from the hub**

Replace `src/hub.ts:1-24` (imports through `startHub`) with:

```ts
// One listener per event type for the whole app, fanned out by id. Panes
// register here instead of each adding its own global listener.

import { recordApproval } from "./approvals";
import type { Backend } from "./backend";
import { recordPlan } from "./plans";
import type { RoomEvent } from "./types";

type PtyHandlers = { onData: (data: string) => void; onExit: (code: number | null) => void };

const ptys = new Map<string, PtyHandlers>();
const rooms = new Map<string, (event: RoomEvent) => void>();
let started = false;

export async function startHub(backend: Backend): Promise<void> {
  if (started) return;
  started = true;
  await backend.onPtyData((id, data) => ptys.get(id)?.onData(data));
  await backend.onPtyExit((id, code) => ptys.get(id)?.onExit(code));
  await backend.onRoomEvent((room, event) => {
    // A provider's plan is the same in every chat, so it is kept app-wide.
    if (event.type === "plan_usage") recordPlan(event.provider, event.windows, event.partial);
    // So are open approval cards, and the store hears first, so a thread
    // reading it while handling this event sees the card already.
    recordApproval(room, event);
    rooms.get(room)?.(event);
  });
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/approvals.test.mjs`
Expected: PASS, 8 tests.

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 8 pass, 0 fail; `✓ built in`.

- [ ] **Step 8: Commit**

```bash
git add src/ApprovalCard.tsx src/Approvals.tsx src/ChatPane.tsx src/DiffPanel.tsx src/approvals.ts src/attention.ts src/hub.ts tests/approvals.test.mjs
git commit -m "feat: keep open approval cards app-wide"
```

(`git add src/Approvals.tsx` records the rename's deletion; `git status` must show `renamed: src/Approvals.tsx -> src/ApprovalCard.tsx`.)

---

### Task 3: Flag rules as pure functions, with blocking flags

**Files:**
- Modify: `src/attention.ts` (new section after `afterRound`, `:136`)
- Modify: `src/App.tsx:18` (import), `:349-368` (`onSignal`), `:370-386` (looking settles a flag)
- Test: `tests/attention.test.mjs`

**Interfaces:**
- Consumes: `Signal.blocking` (Task 2).
- Produces:
  - `type Flags = Record<string, Signal>`
  - `withPaneSignal(flags: Flags, paneId: string, signal: Signal | null): Flags` — a pane's own raise or clear; never touches a blocking flag
  - `withApprovals(flags: Flags, paneId: string, signal: Signal | null): Flags` — a thread's approvals raise their blocking flag, or clear it with `null`
  - `seenFlags(flags: Flags, paneId: string, terminal: boolean): Flags` — looking at a pane

- [ ] **Step 1: Write the failing tests**

In `tests/attention.test.mjs` change line 3 to:

```js
import { Burst, afterRound, ago, label, seenFlags, summarize, urgency, waitingFor, withApprovals, withPaneSignal, workspaceFlag } from "../src/attention.ts";
```

Append:

```js
test("a blocking flag stays until its approvals clear it", () => {
  const blocking = { kind: "needs_input", note: "Null wants approval: Run npm test", at: 100, blocking: true };
  let flags = withApprovals({}, "t", blocking);
  assert.deepEqual(flags.t, blocking);
  assert.equal(seenFlags(flags, "t", false), flags, "looking at the thread doesn't settle it");
  assert.equal(withPaneSignal(flags, "t", { kind: "done", note: "New reply", at: 200 }), flags, "a new reply doesn't replace it");
  flags = withApprovals(flags, "t", { ...blocking, note: "Null wants approval: Run npm test · +1 more" });
  assert.equal(flags.t.at, 100, "a second card keeps the oldest card's time");
  assert.equal(flags.t.note, "Null wants approval: Run npm test · +1 more");
  assert.equal(withApprovals(flags, "t", { ...flags.t }), flags, "the same flag again changes nothing");
  assert.deepEqual(withApprovals(flags, "t", null), {}, "the last answer clears it");
});

test("sending a message while a bot waits on a card keeps its flag", () => {
  const flags = withApprovals({}, "t", { kind: "needs_input", note: "Null wants approval: Run npm test", at: 1, blocking: true });
  // A human message makes the thread clear its own flag (ChatPane, message_added).
  assert.equal(withPaneSignal(flags, "t", null), flags);
});

test("approvals never clear a flag they did not raise", () => {
  const question = { kind: "needs_input", note: "Asked you a question", at: 5 };
  const flags = withPaneSignal({}, "t", question);
  assert.equal(withApprovals(flags, "t", null), flags);
  assert.deepEqual(seenFlags(flags, "t", false), {}, "a question stays non-blocking: looking settles it");
});

test("a pane's own flags behave as before", () => {
  const ready = { kind: "done", note: "New reply", at: 1 };
  let flags = withPaneSignal({}, "a", ready);
  assert.equal(withPaneSignal(flags, "a", { ...ready, at: 9 }), flags, "the same flag again keeps its time");
  flags = withPaneSignal(flags, "a", { kind: "failed", note: "Null could not reply", at: 10 });
  assert.equal(flags.a.kind, "failed");
  assert.deepEqual(withPaneSignal(flags, "a", null), {});
  assert.equal(withPaneSignal({}, "a", null).a, undefined);
  const waiting = { kind: "needs_input", note: "Waiting for approval", at: 3 };
  assert.equal(seenFlags({ term: waiting }, "term", true).term, waiting, "a waiting terminal keeps its flag");
  assert.deepEqual(seenFlags({ term: waiting }, "term", false), {});
  assert.deepEqual(seenFlags({}, "none", false), {});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/attention.test.mjs`
Expected: FAIL, `SyntaxError: The requested module '../src/attention.ts' does not provide an export named 'seenFlags'`.

- [ ] **Step 3: Write the reducers**

In `src/attention.ts`, insert after `afterRound` (after `:135`), before the `// --- summary` divider:

```ts
// ------------------------------------------------------------------- flags

/** Flags by pane id. */
export type Flags = Record<string, Signal>;

function without(flags: Flags, paneId: string): Flags {
  const { [paneId]: _gone, ...rest } = flags;
  return rest;
}

/**
 * A pane raises (`signal`) or clears (`null`) its own flag. A blocking
 * flag belongs to the pane's open approvals, so nothing else the pane says
 * replaces or clears it: only `withApprovals` does.
 */
export function withPaneSignal(flags: Flags, paneId: string, signal: Signal | null): Flags {
  const old = flags[paneId];
  if (old?.blocking) return flags;
  if (!signal) return old ? without(flags, paneId) : flags;
  if (old && old.kind === signal.kind && old.note === signal.note) return flags;
  return { ...flags, [paneId]: signal };
}

/** A thread's open approvals raise their blocking flag, or clear it (`null`) once the last card is answered. */
export function withApprovals(flags: Flags, paneId: string, signal: Signal | null): Flags {
  const old = flags[paneId];
  if (!signal) return old?.blocking ? without(flags, paneId) : flags;
  if (old?.blocking && old.kind === signal.kind && old.note === signal.note && old.at === signal.at) return flags;
  return { ...flags, [paneId]: { ...signal, blocking: true } };
}

/** Looking at a pane settles its flag, except a blocking one and a terminal still waiting on an answer. */
export function seenFlags(flags: Flags, paneId: string, terminal: boolean): Flags {
  const flag = flags[paneId];
  if (!flag || flag.blocking || (flag.kind === "needs_input" && terminal)) return flags;
  return without(flags, paneId);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/attention.test.mjs`
Expected: PASS, 15 tests.

- [ ] **Step 5: Use the reducers in `App`**

In `src/App.tsx:18` change the import to:

```ts
import { label, seenFlags, summarize, urgency, withPaneSignal, workspaceFlag, type Attention, type Signal } from "./attention";
```

Replace `onSignal` (`:349-368`, from the comment "A pane the person is looking at right now…" through the closing `}, []);`), keeping `watched` and `kindOf` between them as they are:

```ts
  // A pane the person is looking at right now does not need flagging,
  // except a terminal that is blocked on a question: its dot should say so.
  const watched = useRef<(paneId: string) => boolean>(() => false);
  watched.current = (paneId) => focusedPane === paneId && !picking && visiblePanes.some((p) => p.id === paneId) && (!maximized || maximized === paneId) && document.hasFocus();
  const kindOf = useRef<(paneId: string) => Pane["kind"] | undefined>(() => undefined);
  kindOf.current = (paneId) => panes.find((p) => p.id === paneId)?.kind;

  const onSignal = useCallback((paneId: string, kind: Attention | null, note = "") => {
    if (kind && watched.current(paneId) && !(kind === "needs_input" && kindOf.current(paneId) === "terminal")) return;
    setAttention((all) => withPaneSignal(all, paneId, kind ? { kind, note, at: Date.now() } : null));
  }, []);
```

Replace the settling effect (`:370-386`, from "Looking at a pane settles its flag." through its deps line), keeping the `windowFocus` state and its effect:

```ts
  // Looking at a pane settles its flag. A terminal that is still waiting on
  // an answer keeps its flag until something is typed into it, and a thread
  // stopped on an approval card keeps its flag until the card is answered.
  const [windowFocus, setWindowFocus] = useState(0);
  useEffect(() => {
    const seen = () => setWindowFocus((n) => n + 1);
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, []);
  useEffect(() => {
    if (!focusedPane || !watched.current(focusedPane)) return;
    setAttention((all) => seenFlags(all, focusedPane, kindOf.current(focusedPane) === "terminal"));
  }, [focusedPane, activeWorkspace, section, picking, maximized, windowFocus, attention]);
```

- [ ] **Step 6: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 12 pass (8 from Task 2, 4 here), 0 fail; `✓ built in`.

- [ ] **Step 7: Commit**

```bash
git add src/attention.ts src/App.tsx tests/attention.test.mjs
git commit -m "refactor: flag rules as pure functions, with blocking flags"
```

---

### Task 4: Approvals stay flagged until you answer

**Files:**
- Modify: `src/ChatPane.tsx:6` (React import), `:22` (attention import), `:59-65` (props), `:322` (signature), `:354` (`asks`), `:438-439` (refs), `:473-635` (room effect), `:1512-1520` (cards)
- Modify: `src/ApprovalCard.tsx:27-62` (deadline)
- Modify: `src/App.tsx:18`, after `onSignal`, `:687` (flag title), `:714` (ChatPane props)
- Modify: `src/backend.ts:167-172` (constant), `:253-287` (preview proposals)
- Modify: `src/styles.css:1474-1488` (approval actions)

**Interfaces:**
- Consumes: `approvalSignal`, `approvalSnapshot`, `cardsByBot`, `deadlineNote`, `forgetRoom`, `openCards`, `subscribeApprovals` (Task 2); `withApprovals` (Task 3).
- Produces: `ChatPane` prop `onApprovals?: (paneId: string, signal: Signal | null) => void`; `ApprovalCard` prop `deadline?: string | null`; preview constant `HOOK_DEADLINE_MS = 570_000`.

- [ ] **Step 1: Read cards from the store in `ChatPane`**

`src/ChatPane.tsx:6`:

```ts
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
```

Below the `ApprovalCard` import (`:23`) add:

```ts
import { approvalSignal, approvalSnapshot, cardsByBot, deadlineNote, forgetRoom, openCards, subscribeApprovals } from "./approvals";
```

`:22`:

```ts
import { afterRound, type Attention, type Signal } from "./attention";
```

In `Props`, after `onSignal` (`:64-65`) add:

```ts
  /** Raise (with the flag) or clear (with `null`) this chat's blocking flag for its open approval cards. */
  onApprovals?: (paneId: string, signal: Signal | null) => void;
```

Add `onApprovals` to the destructured props on `:322`, right after `onSignal`.

Replace `:353-354`:

```ts
  /** What each bot has proposed and is waiting on a yes or no for. */
  const [asks, setAsks] = useState<Record<string, { request: string; action: ProposedAction }[]>>({});
```

with:

```ts
  /** What each bot has proposed and is waiting on a yes or no for, from the app-wide store (approvals.ts). */
  const approvalState = useSyncExternalStore(subscribeApprovals, approvalSnapshot);
  const roomCards = openCards(pane.id, approvalState);
  const asks = useMemo(() => cardsByBot(roomCards), [roomCards]);
```

Remove `ProposedAction,` from the `import type { … } from "./types"` block (`:42`): the old `asks` state was its only use, and `noUnusedLocals` fails the build otherwise.

After `signal.current = onSignal;` (`:439`) add:

```ts
  const approvals = useRef(onApprovals);
  approvals.current = onApprovals;
```

- [ ] **Step 2: Signal from the store on every request and resolution**

Inside the room effect, after `const nameOf = …` (`:476`) add:

```ts
    /** Tell the app what this thread's open cards want. The store has seen the event already (hub.ts). */
    const reportApprovals = () => approvals.current?.(pane.id, approvalSignal(openCards(pane.id), namesRef.current, Date.now()));
```

Replace the `participant_idle` case (`:504-509`):

```ts
        case "participant_idle":
          setDrafts(({ [event.id]: _done, ...rest }) => rest);
          setWorking(({ [event.id]: _done, ...rest }) => rest);
          reportApprovals();
          turnQueue.idle(event.id);
          break;
```

Replace the `approval_requested` and `approval_resolved` cases (`:526-539`):

```ts
        case "approval_requested":
        case "approval_resolved":
          // The turn is stuck until the person answers, wherever they are
          // looking, so the flag is blocking until the last card is answered.
          reportApprovals();
          break;
```

In the `idle` case (`:597-609`) add `reportApprovals();` as its first line (before `if (turnQueue.active) break;`) and delete `setAsks({});`:

```ts
        case "idle": {
          reportApprovals();
          if (turnQueue.active) break;
          if (showChangesRef.current) refreshDiff.current();
          // A round the person stopped themselves needs no flag.
          const wants = round.current.stopped ? null : afterRound(round.current.failed, round.current.lastReply);
          if (wants) signal.current?.(pane.id, wants.kind, wants.note);
          round.current = { failed: [], lastReply: null, stopped: false };
          setBusy(turnQueue.active);
          setDrafts({});
          setWorking({});
          break;
        }
```

In the cleanup (`:628-632`) take the thread's cards and its blocking flag down. Stage 1 unmounts the threads of a workspace removed from the list while they stay in `App`'s `panes`, so `App` would otherwise keep their flag:

```ts
    return () => {
      alive = false;
      unregister();
      forgetRoom(pane.id);
      approvals.current?.(pane.id, null);
      backend.roomClose(pane.id).catch(() => {});
    };
```

Run: `grep -n "setAsks" src/ChatPane.tsx`
Expected: no output.

- [ ] **Step 3: Show the deadline on the card**

Replace the cards at `src/ChatPane.tsx:1512-1520`:

```tsx
                {(asks[id] ?? []).map((ask) => (
                  <ApprovalCard
                    key={ask.request}
                    action={ask.action}
                    deadline={deadlineNote(ask.action.expires_at, now)}
                    onDecide={(approve, always) => {
                      backend.roomDecide(pane.id, ask.request, approve, always).catch((error) => notify(`Could not send your answer: ${String(error)}`, "error"));
                    }}
                  />
                ))}
```

In `src/ApprovalCard.tsx` replace `CardProps` and `ApprovalCard` (`:27-62`). Only the `deadline` prop and its span are new; the kind label is left as it is, because stage 5 rewrites it:

```tsx
interface CardProps {
  action: ProposedAction;
  /** "Denied automatically in 6m" for a call Codex's hook will deny; null for everything else. */
  deadline?: string | null;
  /** Called once with the person's answer. `always` stops the same thing being asked again. */
  onDecide: (approve: boolean, always: boolean) => void;
}

/**
 * Something a bot wants to do, with the whole of it on show and a yes or
 * no to give. The bot's turn waits until one is chosen.
 */
export function ApprovalCard({ action, deadline = null, onDecide }: CardProps) {
  const [answered, setAnswered] = useState<Answer | null>(null);
  const decide = (answer: Answer) => {
    if (answered !== null) return;
    setAnswered(answer);
    const { approve, always } = decisionFor(answer);
    onDecide(approve, always);
  };
  return (
    <div className="approval" role="group" aria-label={`Allow or deny: ${action.title}`}>
      <div className="approval-head">
        <span className="approval-kind">{action.kind === "edit" ? "Wants to change a file" : action.kind === "command" ? "Wants to run a command" : action.kind === "tool" ? "Wants to call an MCP tool" : "Wants permission"}</span>
        <strong>{action.title}</strong>
      </div>
      {action.kind === "edit" ? <Diff text={action.detail} /> : <pre className="approval-detail">{action.detail}</pre>}
      <div className="approval-actions">
        {APPROVAL_CHOICES.map((answer) => (
          <button key={answer} className={answer === "once" ? "primary" : answer === "deny" ? "danger" : "ghost"} onClick={() => decide(answer)} disabled={answered !== null}>
            {answered === answer ? ANSWER_LABEL[answer].done : ANSWER_LABEL[answer].ask}
          </button>
        ))}
        <span className="approval-note">Nothing happens until you choose.</span>
        {deadline && <span className="approval-deadline">{deadline}</span>}
      </div>
    </div>
  );
}
```

In `src/styles.css`, replace `.approval-actions { … }` (`:1474-1479`) with:

```css
.approval-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
}
```

and after `.approval-note { … }` (`:1484-1488`) add:

```css
.approval-deadline {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
```

- [ ] **Step 4: Hold the blocking flag in `App`**

In `src/App.tsx:18` add `withApprovals` to the attention import:

```ts
import { label, seenFlags, summarize, urgency, withApprovals, withPaneSignal, workspaceFlag, type Attention, type Signal } from "./attention";
```

Right after `onSignal` add:

```ts
  // A thread's open approval cards flag it until the last one is answered,
  // whether or not it is being looked at. See approvals.ts.
  const onApprovals = useCallback((paneId: string, signal: Signal | null) => setAttention((all) => withApprovals(all, paneId, signal)), []);
```

On the `ChatPane` element (`:714`) add `onApprovals={onApprovals}` after `onSignal={onSignal}`.

Give the pane-head flag (`:687`) its full note as a tooltip, since the head truncates it:

```tsx
                    {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`} title={attention[pane.id].note || label(attention[pane.id].kind)}>{attention[pane.id].note || label(attention[pane.id].kind)}</span>}
```

- [ ] **Step 5: Let the preview open two cards at once, and expire a tool call**

In `src/backend.ts`, after `let askCount = 0;` (`:171`) add:

```ts
  /** Codex's hook denies a call nobody answered after this long (HELPER_DEADLINE in codex_hook.rs). */
  const HOOK_DEADLINE_MS = 570_000;
```

Replace the preview proposals block (`:253-287`, from `// Preview only: a bot set to ask first proposes one edit and one` through the closing `}` of `if (p.access === "ask") { … }`):

```ts
          // Preview only: a bot set to ask first proposes an edit, then a
          // command and an MCP tool call together (as a model calling two
          // tools at once does), then a tool's own permission question, so
          // the approval cards, the attention list and the changes list can
          // be seen. Like Codex's hook, the tool call is denied by itself if
          // nobody answers within 570 seconds.
          if (p.access === "ask") {
            const ask = async ({ action: proposed, change }: { action: ProposedAction; change?: FileChange }) => {
              const action = proposed.kind === "tool" ? { ...proposed, expires_at: Date.now() + HOOK_DEADLINE_MS } : proposed;
              const room = rooms.get(id);
              const rule = ruleFor(p.id, action);
              if (room?.allowed?.some(r => sameRule(r, rule))) {
                emit( { type: "activity", id: p.id, text: `Always allowed: ${action.title}` });
                if (change) emit( { type: "changed", id: p.id, change });
                return;
              }
              const request = `ask-${++askCount}`;
              emit( { type: "activity", id: p.id, text: `Waiting for approval: ${action.title}` });
              emit( { type: "approval_requested", id: p.id, request, action });
              askOwners.set(request, key);
              const expiry = action.expires_at ? setTimeout(() => asks.get(request)?.(false), action.expires_at - Date.now()) : undefined;
              const [approved, always] = await new Promise<[boolean, boolean]>((answer) => asks.set(request, (yes, forever = false) => answer([yes, forever])));
              clearTimeout(expiry);
              asks.delete(request); askOwners.delete(request);
              emit( { type: "approval_resolved", id: p.id, request, approved });
              if (approved && always && room) {
                room.allowed = [...(room.allowed ?? []), rule];
                saveRoom(id);
                emit( { type: "allowed_changed", allowed: room.allowed });
              }
              if (approved && change) emit( { type: "changed", id: p.id, change });
            };
            const steps: { action: ProposedAction; change?: FileChange }[][] = [
              [{
                action: { kind: "edit", title: "Edit README.md", detail: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n" },
                change: { path: "README.md", diff: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n", added: 2, removed: 1 },
              }],
              [
                { action: { kind: "command", title: "Run a command", detail: "npm test -- --run auth" } },
                { action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{\n  \"text\": \"Apex Deck preview\"\n}" } },
              ],
              [{ action: { kind: "other", title: "node_repl asks permission", detail: "Allow Computer Use to use \"Apex Deck\"?\n\nApp: dev.apexdeck.app\nRequested by: node_repl" } }],
            ];
            for (const step of steps) {
              await Promise.all(step.map(ask));
              await sleep(300); if (!active) return;
            }
          }
```

- [ ] **Step 6: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 12 pass, 0 fail; `✓ built in`.

- [ ] **Step 7: Check it in the browser preview**

Run `npm run dev` and open http://localhost:1420/ in the browser preview (1440×900). Setup: if there is no workspace, click **Add a workspace**; in Threads click **Start a group chat**; **+ Add model** → tool **Claude Code**, Access **Ask first**, Name `Null` → **Add to chat**; then **+ New thread** → Group chat to get a second thread (so you can look away). Go back to the first thread, type `@null fix the readme`, Enter.

Look at, and expect:
- The thread's pane head flag reads "Null wants approval: Edit README.md" (amber); the attention button reads "1 needs you".
- Click inside that thread's pane so it is focused and watched: the flag stays (before this change it vanished). ⌘J from the other thread comes back to it.
- **Allow once** on the edit card. A moment later two cards show (command `npm test -- --run auth` and `x-mcp: post_tweet`); the flag reads "Null wants approval: Run npm test -- --run auth · +1 more", and the attention list's "ago" did not reset to "just now" for the second card.
- The tool card shows "Denied automatically in 10m" after "Nothing happens until you choose."; no other card shows a deadline.
- Type `@null hello` and press Enter while the cards are open: it queues, and the flag stays.
- Answer both cards: the flag clears once the last one is answered. Answer the "node_repl asks permission" card too.
- Start again (`@null again`), and press **Stop** with a card open: the card and flag go away (no stuck "wants approval").

- [ ] **Step 8: Commit**

```bash
git add src/ChatPane.tsx src/ApprovalCard.tsx src/App.tsx src/backend.ts src/styles.css
git commit -m "feat: approvals stay flagged until you answer"
```

---

### Task 5: What the attention list can answer in place (`src/answerStrip.ts`)

**Files:**
- Create: `src/answerStrip.ts`
- Test: `tests/answer-strip.test.mjs` (new)

**Interfaces:**
- Consumes: `OpenCard`, `cardLabel`, `cardTitle` (Task 2); `Signal`, `urgency` (`src/attention.ts`).
- Produces:
  - `STRIP_EDIT_LINES = 20`
  - `editCounts(diff: string): { added: number; removed: number }`, `sizeText(diff: string): string` ("+8 −2")
  - `type StripView = { kind: "command"; label: string; command: string } | { kind: "edit"; label: string; summary: string; diff: string } | { kind: "open"; label: string }`
  - `stripView(action: ProposedAction): StripView`
  - `nextLine(cards: readonly OpenCard[]): string | null`
  - `listRows<T extends { paneId: string; signal: Signal }>(items: readonly T[], answered: readonly T[]): T[]`
  - `nextStripPane(rows: readonly { paneId: string; cards?: readonly OpenCard[] }[], answered: string): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/answer-strip.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { editCounts, listRows, nextLine, nextStripPane, sizeText, stripView } from "../src/answerStrip.ts";

const card = (request, action, at = 1) => ({ room: "t", participant: "null", request, action, at });
const run = (detail) => ({ kind: "command", title: "Run a command", detail });
const added = (n) => Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n") + "\n";
const edit = (detail, title = "Edit src/auth/session.ts") => ({ kind: "edit", title, detail });

test("a command is answered in place, with the whole command shown", () => {
  assert.deepEqual(stripView(run("npm test -- --run auth")), { kind: "command", label: "Wants to run a command", command: "npm test -- --run auth" });
});

test("a small edit is answered in place with its size, file and whole diff", () => {
  const detail = "--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1,3 +1,9 @@\n" + added(8) + "-old one\n-old two\n";
  assert.deepEqual(editCounts(detail), { added: 8, removed: 2 });
  assert.deepEqual(stripView(edit(detail)), { kind: "edit", label: "Wants to change a file", summary: "+8 −2 · src/auth/session.ts", diff: detail });
  assert.equal(stripView(edit(added(20))).kind, "edit", "20 changed lines is still small");
  assert.equal(stripView(edit("a.rs\n-x\n+y\n", "Edit a.rs")).summary, "+1 −1 · a.rs", "Codex puts the path first");
  assert.equal(stripView(edit("+hi\n", "Write hello.txt")).summary, "+1 −0 · hello.txt");
});

test("larger edits, tool calls and permission questions open the thread", () => {
  assert.deepEqual(stripView(edit(added(21))), { kind: "open", label: "Wants to change a file" });
  assert.deepEqual(stripView({ kind: "tool", title: "x-mcp: post_tweet", detail: "{}" }), { kind: "open", label: "Wants to call an MCP tool" });
  assert.deepEqual(stripView({ kind: "other", title: "node_repl asks permission", detail: "Allow?" }), { kind: "open", label: "Wants permission" });
});

test("a card whose content wasn't reported is never answered blind", () => {
  assert.equal(stripView(edit("The edit was not described.", "Edit files")).kind, "open");
  assert.equal(stripView(edit("")).kind, "open");
  assert.equal(stripView(run("")).kind, "open");
  assert.equal(stripView(run("   \n")).kind, "open");
  assert.equal(stripView(run("(command not given)")).kind, "open");
});

test("the strip names the thread's next card", () => {
  const first = card("ask-1", run("npm test"));
  assert.equal(nextLine([first]), null);
  assert.equal(nextLine([first, card("ask-2", edit("-a\n-b\n" + added(8)))]), "Next in this thread: Edit src/auth/session.ts · +8 −2");
  assert.equal(nextLine([first, card("ask-2", run("cargo build\n\nneeds network"))]), "Next in this thread: Run cargo build");
  assert.equal(nextLine([first, card("ask-2", { kind: "tool", title: "x-mcp: post_tweet", detail: "{}" })]), "Next in this thread: x-mcp: post_tweet");
  assert.equal(sizeText("+a\n-b\n"), "+1 −1");
});

test("rows answered from the list stay in place until it closes", () => {
  const signal = (kind, at) => ({ kind, note: "", at });
  const fix = { paneId: "fix", signal: signal("needs_input", 100) };
  const notes = { paneId: "notes", signal: signal("needs_input", 50) };
  const ready = { paneId: "code", signal: signal("done", 300) };
  assert.deepEqual(listRows([ready, notes, fix], []).map((r) => r.paneId), ["fix", "notes", "code"], "most urgent first, newest first");
  assert.deepEqual(listRows([ready, notes], [fix]).map((r) => r.paneId), ["fix", "notes", "code"], "an answered row keeps its place");
  const live = { ...fix, cards: [] };
  assert.equal(listRows([live], [fix])[0], live, "the live row wins over the remembered one");
  assert.equal(listRows([live], [fix]).length, 1);
});

test("after an answer, focus goes to the next card", () => {
  const rows = [
    { paneId: "fix", cards: [card("ask-2", run("ls"))] },
    { paneId: "notes", cards: [] },
    { paneId: "site", cards: [card("ask-1", run("ls"))] },
  ];
  assert.equal(nextStripPane(rows, "fix"), "fix", "its own next card first");
  assert.equal(nextStripPane([{ paneId: "fix", cards: [] }, rows[1], rows[2]], "fix"), "site", "then the next thread with cards");
  assert.equal(nextStripPane([rows[2], rows[1], { paneId: "fix", cards: [] }], "fix"), "site", "wrapping round");
  assert.equal(nextStripPane([{ paneId: "fix" }, rows[1]], "fix"), "fix", "none left: its own strip, which says so");
  assert.equal(nextStripPane([], "gone"), "gone");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/answer-strip.test.mjs`
Expected: FAIL, `Cannot find module '…/src/answerStrip.ts'`.

- [ ] **Step 3: Write the module**

Create `src/answerStrip.ts`:

```ts
// What the attention list offers for a thread's open approval cards.
//
// Routine approvals can be answered from the list: a command, or a small
// edit whose whole diff fits. Anything else (a larger edit, an MCP tool
// call, a tool's own permission question, or a card whose content wasn't
// reported) needs the thread, where the card shows everything. "Always
// allow" is never offered in the list.

import { cardLabel, cardTitle, type OpenCard } from "./approvals.ts";
import { urgency, type Signal } from "./attention.ts";
import type { ProposedAction } from "./types";

/** Edits with more changed lines than this are answered in the thread. */
export const STRIP_EDIT_LINES = 20;

/** Lines added and removed in an edit's diff. File-name lines (+++ and ---) don't count. */
export function editCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** "+8 −2", as the list writes an edit's size. */
export function sizeText(diff: string): string {
  const { added, removed } = editCounts(diff);
  return `+${added} −${removed}`;
}

/** What an edit card changes, from its title: "Edit src/a.ts" gives "src/a.ts", "Edit 3 files" gives "3 files". */
function editTarget(title: string): string {
  return title.replace(/^\S+\s+/, "");
}

export type StripView =
  | { kind: "command"; label: string; command: string }
  | { kind: "edit"; label: string; summary: string; diff: string }
  | { kind: "open"; label: string };

/** How the list offers a card: answered in place, or only opened. */
export function stripView(action: ProposedAction): StripView {
  const label = cardLabel(action.kind);
  if (action.kind === "command") {
    const command = action.detail.trim();
    // Codex sends "(command not given)" when it doesn't say (codex_server.rs).
    if (command && !command.startsWith("(command not given)")) return { kind: "command", label, command };
  }
  if (action.kind === "edit") {
    const { added, removed } = editCounts(action.detail);
    const changed = added + removed;
    if (changed >= 1 && changed <= STRIP_EDIT_LINES) return { kind: "edit", label, summary: `+${added} −${removed} · ${editTarget(action.title)}`, diff: action.detail };
  }
  return { kind: "open", label };
}

/** The muted line under a strip naming the thread's next card, or null when it has no other. */
export function nextLine(cards: readonly OpenCard[]): string | null {
  const next = cards[1];
  if (!next) return null;
  const size = next.action.kind === "edit" ? ` · ${sizeText(next.action.detail)}` : "";
  return `Next in this thread: ${cardTitle(next.action)}${size}`;
}

/**
 * The list's rows: most urgent first, newest first within a kind. A row
 * answered from the list stays (in its place) until the list closes, even
 * once its flag has gone, so its strip can say "No approvals waiting".
 */
export function listRows<T extends { paneId: string; signal: Signal }>(items: readonly T[], answered: readonly T[]): T[] {
  const live = new Set(items.map((item) => item.paneId));
  return [...items, ...answered.filter((item) => !live.has(item.paneId))]
    .sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at);
}

/**
 * Where focus goes after a card in `answered`'s strip is answered: that
 * thread's next card, else the next thread below with cards (wrapping
 * round), else its own strip, which then reads "No approvals waiting".
 */
export function nextStripPane(rows: readonly { paneId: string; cards?: readonly OpenCard[] }[], answered: string): string {
  const at = rows.findIndex((row) => row.paneId === answered);
  const ordered = at < 0 ? rows : [...rows.slice(at), ...rows.slice(0, at)];
  return ordered.find((row) => (row.cards?.length ?? 0) > 0)?.paneId ?? answered;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/answer-strip.test.mjs`
Expected: PASS, 7 tests.

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 19 pass, 0 fail; `✓ built in`.

- [ ] **Step 5: Commit**

```bash
git add src/answerStrip.ts tests/answer-strip.test.mjs
git commit -m "feat: decide what the attention list can answer in place"
```

---

### Task 6: Answer routine approvals from the attention list

**Files:**
- Modify: `src/AttentionMenu.tsx` (whole file)
- Modify: `src/App.tsx:1` (React import), after `:158` (store), `:403-411` (items), `:574` (menu props)
- Modify: `src/styles.css:1341-1369` (list and rows), `:1843` (footer)

**Interfaces:**
- Consumes: `OpenCard`, `deadlineNote`, `openCards`, `subscribeApprovals`, `approvalSnapshot` (Task 2); `listRows`, `nextLine`, `nextStripPane`, `stripView` (Task 5); `Diff` (`src/ApprovalCard.tsx`).
- Produces: `AttentionItem.cards?: readonly OpenCard[]`; `AttentionMenu` prop `onDecide: (room: string, request: string, approve: boolean) => Promise<void>`; CSS classes `attention-row`, `attention-item`, `answer-strip`, `answer-kind`, `answer-command`, `answer-summary`, `answer-actions`, `answer-next`.

- [ ] **Step 1: Rewrite `AttentionMenu`**

Replace `src/AttentionMenu.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";

import { Diff } from "./ApprovalCard";
import { deadlineNote, type OpenCard } from "./approvals";
import { listRows, nextLine, nextStripPane, stripView } from "./answerStrip";
import { ago, label, summarize, type Signal } from "./attention";

export interface AttentionItem {
  paneId: string;
  title: string;
  /** The workspace the pane belongs to. */
  workspace: string;
  /** "Code" or "Threads". */
  where: string;
  signal: Signal;
  /** A thread's open approval cards, oldest first. */
  cards?: readonly OpenCard[];
}

interface Props {
  items: AttentionItem[];
  /** Go to the pane. */
  onOpen: (paneId: string) => void;
  /** Answer a card from the list. Only Allow once and Deny are offered here. */
  onDecide: (room: string, request: string, approve: boolean) => Promise<void>;
}

/** A card's identity across threads: request ids repeat from thread to thread. */
const cardId = (card: OpenCard) => `${card.room}\u001f${card.request}`;

/**
 * Everything that wants attention, in one list, reachable from anywhere in
 * the app. It only appears when there is something in it. The most urgent
 * items come first, and choosing one goes to its pane. A thread stopped on
 * a routine approval can be answered right here; see answerStrip.ts.
 */
export function AttentionMenu({ items, onOpen, onDecide }: Props) {
  const [open, setOpen] = useState(false);
  /** Threads answered from the list since it opened. They keep their row until it closes. */
  const [answered, setAnswered] = useState<Record<string, AttentionItem>>({});
  /** The card just answered, until it leaves the list. Its strip's buttons wait meanwhile. */
  const [pending, setPending] = useState<{ paneId: string; card: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** A thread whose strip took focus saying "No approvals waiting"; a new card there takes the focus back. */
  const emptyStrip = useRef<string | null>(null);
  const rows = listRows(items, Object.values(answered));
  const cardKeys = rows.flatMap((row) => (row.cards ?? []).map(cardId)).join("\n");
  const hasCards = (paneId: string) => rows.some((row) => row.paneId === paneId && (row.cards?.length ?? 0) > 0);
  /** Move focus into a thread's strip: its first button, else the strip itself. */
  const focusStrip = (paneId: string) => requestAnimationFrame(() => {
    const strip = root.current?.querySelector<HTMLElement>(`[data-strip="${CSS.escape(paneId)}"]`);
    (strip?.querySelector<HTMLElement>("button") ?? strip)?.focus();
  });

  useEffect(() => {
    if (!open) {
      setAnswered((all) => (Object.keys(all).length > 0 ? {} : all));
      setPending(null);
      emptyStrip.current = null;
      return;
    }
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // Once the card just answered has left the list, focus moves on: to the
  // thread's next card, else the next thread below with one.
  useEffect(() => {
    if (!pending || cardKeys.split("\n").includes(pending.card)) return;
    const target = nextStripPane(rows, pending.paneId);
    setPending(null);
    emptyStrip.current = hasCards(target) ? null : target;
    focusStrip(target);
  }, [pending, cardKeys]);

  // The strip that said "No approvals waiting" is replaced when its thread
  // gets a new card, which drops focus on the page; put it on the new strip.
  useEffect(() => {
    const paneId = emptyStrip.current;
    if (!paneId || !hasCards(paneId)) return;
    emptyStrip.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    focusStrip(paneId);
  }, [cardKeys]);

  if (items.length === 0 && !(open && rows.length > 0)) return null;
  const { worst } = summarize(items.map((item) => item.signal));
  const how = (kind: Signal["kind"]) => items.filter((item) => item.signal.kind === kind).length;
  const summary = [
    how("needs_input") > 0 && `${how("needs_input")} need${how("needs_input") === 1 ? "s" : ""} you`,
    how("failed") > 0 && `${how("failed")} failed`,
    how("done") > 0 && `${how("done")} ready`,
  ]
    .filter(Boolean)
    .join(" · ") || "No approvals waiting";
  const now = Date.now();

  const go = (paneId: string) => {
    setOpen(false);
    onOpen(paneId);
  };
  const decide = (item: AttentionItem, card: OpenCard, approve: boolean) => {
    // Remembered without its cards: those come from the live item while it lasts.
    setAnswered((all) => ({ ...all, [item.paneId]: { ...item, cards: undefined } }));
    setPending({ paneId: item.paneId, card: cardId(card) });
    onDecide(card.room, card.request, approve).catch(() => setPending(null));
  };

  return (
    <div className="attention" ref={root}>
      <button ref={toggle} className={`attention-button ${worst ?? ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <span className={`dot ${worst ?? ""}`} />
        {summary}
      </button>
      {open && (
        <div className="attention-list" role="dialog" aria-label="Panes that want attention">
          {rows.map((item) => {
            const live = items.some((other) => other.paneId === item.paneId);
            const cards = item.cards ?? [];
            const card = cards[0];
            const view = card ? stripView(card.action) : null;
            const deadline = card ? deadlineNote(card.action.expires_at, now) : null;
            const next = nextLine(cards);
            const what = (
              <span className="attention-what">
                <strong>{item.title}</strong>
                {live && <span>{item.signal.note || label(item.signal.kind)}</span>}
                {deadline && <span>{deadline}</span>}
              </span>
            );
            const where = (
              <span className="attention-where">
                <span>{item.workspace} · {item.where}</span>
                <span>{ago(item.signal.at, now)}</span>
              </span>
            );
            if (card && view?.kind === "open") {
              return (
                <div key={item.paneId} className="attention-row" data-strip={item.paneId}>
                  <span className={`dot ${item.signal.kind}`} />
                  {what}
                  <button className="ghost small" onClick={() => go(item.paneId)}>Open to answer</button>
                  {where}
                </div>
              );
            }
            const waiting = pending?.paneId === item.paneId;
            return (
              <div key={item.paneId} className={`attention-item ${card || !live ? "expanded" : ""}`}>
                <button className="attention-row" onClick={() => go(item.paneId)}>
                  <span className={`dot ${live ? item.signal.kind : ""}`} />
                  {what}
                  {where}
                </button>
                {card && view && view.kind !== "open" && (
                  <div className="answer-strip" data-strip={item.paneId}>
                    <span className="answer-kind">{view.label}</span>
                    {view.kind === "command"
                      ? <code className="answer-command">{view.command}</code>
                      : <><span className="answer-summary">{view.summary}</span><Diff text={view.diff} /></>}
                    <div className="answer-actions">
                      <button className="primary" disabled={waiting} onClick={() => decide(item, card, true)}>Allow once</button>
                      <button className="danger" disabled={waiting} onClick={() => decide(item, card, false)}>Deny</button>
                      <button className="ghost" onClick={() => go(item.paneId)}>Open thread</button>
                    </div>
                    {next && <span className="answer-next">{next}</span>}
                  </div>
                )}
                {!live && <div className="answer-strip empty" data-strip={item.paneId} tabIndex={-1}>No approvals waiting</div>}
              </div>
            );
          })}
          <div className="attention-foot">
            <span>Most urgent first</span>
            <span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘J" : "Ctrl+Shift+J"}</kbd> next</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Give the list its cards and answers in `App`**

`src/App.tsx:1`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
```

Below the `ConfirmDialog` import (`:21`) add:

```ts
import { approvalSnapshot, openCards, subscribeApprovals } from "./approvals";
```

After `const lastOutput = useRef(new Map<string, number>());` (`:158`) add:

```ts
  /** Every open approval card, app-wide (approvals.ts). */
  const approvalState = useSyncExternalStore(subscribeApprovals, approvalSnapshot);
```

Replace `attentionItems` (`:403-411`):

```ts
  const attentionItems: AttentionItem[] = panes
    .filter((pane) => attention[pane.id])
    .map((pane) => ({
      paneId: pane.id,
      title: pane.title,
      workspace: workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "",
      where: pane.kind === "chat" ? "Threads" : "Code",
      signal: attention[pane.id],
      cards: pane.kind === "chat" ? openCards(pane.id, approvalState) : undefined,
    }));
```

Replace the `AttentionMenu` element (`:574`):

```tsx
        <AttentionMenu
          items={attentionItems}
          onOpen={(paneId) => { const pane = panes.find((p) => p.id === paneId); if (pane) focusPane(pane); }}
          onDecide={(room, request, approve) => backend.roomDecide(room, request, approve, false)}
        />
```

- [ ] **Step 3: Style the list and its strips**

In `src/styles.css` replace the `.attention-list { … }`, `.attention-list button { … }` and `.attention-list button:hover { … }` rules (`:1341-1369`) with:

```css
.attention-list {
  position: absolute;
  left: 0;
  top: calc(100% + 8px);
  z-index: 40;
  width: min(440px, calc(100vw - 32px));
  max-height: 70vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
}
.attention-list .attention-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 9px 10px;
  border-radius: 7px;
}
.attention-list button.attention-row:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
}
.attention-row > .ghost.small {
  flex: none;
  padding: 3px 8px;
  font-size: 12px;
}
.attention-item.expanded {
  border-radius: 7px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
/* An approval answered in place. Neutral panel and hairline, no coloured bar. */
.answer-strip {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 10px 10px 29px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.answer-strip.empty { color: var(--muted); font-size: 12px; }
.answer-kind { font-size: 11px; font-weight: 600; color: var(--warn); }
.answer-command {
  display: block;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.answer-summary { font-size: 12px; font-variant-numeric: tabular-nums; }
.answer-strip .diff { max-height: 200px; border: 1px solid var(--line); border-radius: 8px; }
.answer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.answer-actions button { padding: 5px 10px; font-size: 12px; }
.answer-next { color: var(--muted); font-size: 12px; }
```

Replace `.attention-foot { … }` (`:1843`) with:

```css
.attention-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 6px 10px 4px; margin-top: 2px; border-top: 1px solid var(--line); font-size: 11px; color: var(--muted); }
.attention-foot button { padding: 3px 8px; font-size: 11px; }
```

- [ ] **Step 4: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 19 pass, 0 fail; `✓ built in`.

- [ ] **Step 5: Check it in the browser preview**

With `npm run dev` running, open http://localhost:1420/ in the browser preview at 1440×900. Setup: if there is no workspace, click **Add a workspace**; in Threads click **Start a group chat**; **+ Add model** → tool **Claude Code**, Access **Ask first**, Name `Null` → **Add to chat**; then **+ New thread** → Group chat for a second thread. In the first thread send `@null fix the readme`, then focus the second thread so you are looking elsewhere.

Look at, and expect:
- The attention list is 440px wide. The first thread's row is expanded: "Wants to change a file", "+2 −1 · README.md", the diff, then **Allow once** (primary), **Deny** (danger outline), **Open thread** (ghost). No **Always allow** anywhere in the list.
- **Allow once**: the list stays open. When the command and tool cards arrive, the row's note reads "Null wants approval: Run npm test -- --run auth · +1 more", the strip shows "Wants to run a command" with `npm test -- --run auth` in mono, and "Next in this thread: x-mcp: post_tweet".
- **Allow once** on the command: focus lands on **Open to answer** in the same row, which now shows "Null wants approval: x-mcp: post_tweet" and "Denied automatically in 10m" under it; there is no strip for it.
- **Open to answer** closes the list and opens the thread at the tool card.
- In the thread, answer the tool card and the "node_repl asks permission" card with **Always allow**, so later runs skip them. Send `@null again`, look elsewhere, open the list and answer the edit with **Allow once**: for a moment the row reads "No approvals waiting" (focus on it), then the command strip arrives and focus moves to its **Allow once**. Answer it: the row reads "No approvals waiting" and keeps focus until you close the list (Escape returns focus to the attention button).
- A terminal row (type `ask` then Enter in a Code terminal, look elsewhere) behaves as before: one row, click goes to the pane.
- At about 820×1400 the list still fits with 16px to spare and the strip buttons wrap rather than overflow.

- [ ] **Step 6: Commit**

```bash
git add src/AttentionMenu.tsx src/App.tsx src/styles.css
git commit -m "feat: answer routine approvals from the attention list"
```

---

### Task 7: Mark ready as seen, and a dock badge for Needs you and Failed

**Files:**
- Modify: `src/attention.ts` (after `seenFlags`)
- Modify: `src/AttentionMenu.tsx` (props, footer)
- Modify: `src/App.tsx` (attention import, `:388-401` flag effect, `AttentionMenu` element)
- Modify: `src/backend.ts:74-76` (doc)
- Test: `tests/attention.test.mjs`

**Interfaces:**
- Consumes: `Flags` (Task 3), `AttentionMenu` (Task 6).
- Produces: `clearReady(flags: Flags): Flags`; `badgeCount(signals: readonly Signal[]): number`; `AttentionMenu` prop `onMarkReadySeen: () => void`.

- [ ] **Step 1: Write the failing tests**

In `tests/attention.test.mjs` change line 3 to:

```js
import { Burst, afterRound, ago, badgeCount, clearReady, label, seenFlags, summarize, urgency, waitingFor, withApprovals, withPaneSignal, workspaceFlag } from "../src/attention.ts";
```

Append:

```js
test("Mark ready as seen clears Ready and nothing else", () => {
  const flags = {
    a: { kind: "done", note: "New reply", at: 1 },
    b: { kind: "needs_input", note: "Null wants approval: Run npm test", at: 2, blocking: true },
    c: { kind: "failed", note: "Null could not reply", at: 3 },
    d: { kind: "done", note: "Finished working", at: 4 },
  };
  assert.deepEqual(Object.keys(clearReady(flags)), ["b", "c"]);
  const none = { b: flags.b };
  assert.equal(clearReady(none), none, "nothing to clear changes nothing");
});

test("the dock badge counts Needs you and Failed, not Ready", () => {
  const at = 0;
  assert.equal(badgeCount([]), 0);
  assert.equal(badgeCount([{ kind: "done", note: "", at }, { kind: "needs_input", note: "", at }, { kind: "failed", note: "", at }]), 2);
  assert.equal(badgeCount([{ kind: "done", note: "", at }]), 0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/attention.test.mjs`
Expected: FAIL, `does not provide an export named 'badgeCount'`.

- [ ] **Step 3: Write the rules**

In `src/attention.ts`, after `seenFlags`, add:

```ts
/** Every flag except Ready, as Mark ready as seen leaves them. */
export function clearReady(flags: Flags): Flags {
  const kept = Object.fromEntries(Object.entries(flags).filter(([, signal]) => signal.kind !== "done"));
  return Object.keys(kept).length === Object.keys(flags).length ? flags : kept;
}

/** The number on the dock icon: what needs you or failed. Ready shows only in the title bar and rail. */
export function badgeCount(signals: readonly Signal[]): number {
  return signals.filter((signal) => signal.kind !== "done").length;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/attention.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Add the footer button**

In `src/AttentionMenu.tsx` add to `Props`:

```ts
  /** Clear every Ready flag, leaving Needs you and Failed. */
  onMarkReadySeen: () => void;
```

change the signature to `export function AttentionMenu({ items, onOpen, onDecide, onMarkReadySeen }: Props) {`, and replace the footer:

```tsx
          <div className="attention-foot">
            <span>Most urgent first</span>
            {items.some((item) => item.signal.kind === "done") && <button className="ghost small" onClick={onMarkReadySeen}>Mark ready as seen</button>}
            <span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘J" : "Ctrl+Shift+J"}</kbd> next</span>
          </div>
```

- [ ] **Step 6: Wire it, and count only urgent flags on the dock**

In `src/App.tsx` add `badgeCount` and `clearReady` to the attention import:

```ts
import { badgeCount, clearReady, label, seenFlags, summarize, urgency, withApprovals, withPaneSignal, workspaceFlag, type Attention, type Signal } from "./attention";
```

Replace the flag effect (`:388-401`):

```ts
  // Flags for panes that no longer exist are dropped. The app's icon counts
  // what needs you or failed; Ready shows only in the title bar and rail. A
  // new one of those raised while the app is in the background also draws
  // the eye to the icon. Looking at the app (it has focus) never does.
  const flagged = useRef(0);
  useEffect(() => {
    const live = Object.keys(attention).filter((id) => panes.some((p) => p.id === id));
    if (live.length !== Object.keys(attention).length) {
      setAttention((all) => Object.fromEntries(Object.entries(all).filter(([id]) => panes.some((p) => p.id === id))));
      return;
    }
    const urgent = badgeCount(live.map((id) => attention[id]));
    const grew = urgent > flagged.current;
    flagged.current = urgent;
    backend?.flagAttention(urgent, grew && !document.hasFocus()).catch(() => {});
  }, [attention, panes, backend]);
```

Add to the `AttentionMenu` element:

```tsx
          onMarkReadySeen={() => setAttention(clearReady)}
```

In `src/backend.ts` replace the `flagAttention` doc (`:74-75`):

```ts
  /** Show on the app's icon how many panes need you or failed (Ready is left out). With `nudge`,
   *  also draw the eye to the icon once, for when the app is in the background. */
```

- [ ] **Step 7: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 21 pass, 0 fail; `✓ built in`.

- [ ] **Step 8: Check it in the browser preview**

With `npm run dev` running: in Code, open a Codex terminal, type `work` then Enter, and switch to Threads before it finishes (about 6 s). In a thread with a bot (a Read only bot is fine), send `@<handle> hi` and focus another thread before the reply lands. In a second terminal, type `ask` then Enter and look away.

Look at, and expect:
- The attention button reads "1 needs you · 2 ready". The browser tab title (the preview's stand-in for the dock badge) reads "(1) Apex Deck", not "(3)".
- The list footer reads "Most urgent first", **Mark ready as seen**, "⌘J next".
- **Mark ready as seen**: both Ready rows go; the Needs you row stays; the button reads "1 needs you"; the button disappears from the footer.
- With only Ready flags (answer the `ask` terminal by typing in it), the tab title is "Apex Deck" while the rail and title bar still show Ready.

- [ ] **Step 9: Commit**

```bash
git add src/attention.ts src/AttentionMenu.tsx src/App.tsx src/backend.ts tests/attention.test.mjs
git commit -m "feat: Mark ready as seen; the dock badge counts only Needs you and Failed"
```

---

### Task 8: Escalate an approval left waiting

**Files:**
- Modify: `src/approvals.ts` (end of file)
- Modify: `src/backend.ts:76` (interface), `:109-115` (native), `:379-381` (preview)
- Modify: `src/App.tsx:155` (tick), approvals import, after the flag effect
- Test: `tests/approvals.test.mjs`

**Interfaces:**
- Consumes: `OpenCard`, `openCards`, `approvalState` (Tasks 2, 6); blocking flags (Task 4).
- Produces: `ESCALATE_AFTER_MS = 120_000`; `escalationKey(card: OpenCard): string`; `dueEscalations(threads: readonly (readonly OpenCard[])[], escalated: ReadonlySet<string>, focused: boolean, now: number): OpenCard[]`; `Backend.requestCriticalAttention(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

In `tests/approvals.test.mjs` add `ESCALATE_AFTER_MS, dueEscalations, escalationKey` to the import list, then append:

```js
test("an approval left waiting escalates once, and only in the background", () => {
  const card = { room: "t", participant: "null", request: "ask-1", action: run("npm test"), at: 0 };
  assert.deepEqual(dueEscalations([[card]], new Set(), false, ESCALATE_AFTER_MS - 1), []);
  assert.deepEqual(dueEscalations([[card]], new Set(), true, ESCALATE_AFTER_MS), [], "the window has focus");
  assert.deepEqual(dueEscalations([[card]], new Set(), false, ESCALATE_AFTER_MS), [card]);
  assert.deepEqual(dueEscalations([[card]], new Set([escalationKey(card)]), false, 10 * ESCALATE_AFTER_MS), [], "never again for the same card");
  const twin = { ...card, room: "u" };
  assert.deepEqual(dueEscalations([[twin]], new Set([escalationKey(card)]), false, ESCALATE_AFTER_MS), [twin], "the same request id in another thread is another card");
  const expired = { ...card, request: "ask-0", action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", expires_at: 1 } };
  assert.deepEqual(dueEscalations([[expired, card]], new Set(), false, ESCALATE_AFTER_MS), [card], "a card being denied doesn't count");
  assert.deepEqual(dueEscalations([[]], new Set(), false, ESCALATE_AFTER_MS), []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/approvals.test.mjs`
Expected: FAIL, `does not provide an export named 'ESCALATE_AFTER_MS'`.

- [ ] **Step 3: Write the rule**

Append to `src/approvals.ts`:

```ts
/** How long a card waits, with the window in the background, before the dock asks harder. */
export const ESCALATE_AFTER_MS = 2 * 60_000;

/** A card's identity for escalation: its thread, its request and when it arrived. */
export function escalationKey(card: OpenCard): string {
  return `${card.room}\u001f${card.request}\u001f${card.at}`;
}

/**
 * The cards to escalate now, from each blocked thread's cards. A thread's
 * oldest waiting card escalates once, when it has been open for 2 minutes
 * and the window doesn't have focus; `escalated` holds the keys of cards
 * already escalated, which never escalate again.
 */
export function dueEscalations(threads: readonly (readonly OpenCard[])[], escalated: ReadonlySet<string>, focused: boolean, now: number): OpenCard[] {
  if (focused) return [];
  return threads
    .map((cards) => cards.find((card) => waiting(card, now)))
    .filter((card): card is OpenCard => card !== undefined && now - card.at >= ESCALATE_AFTER_MS && !escalated.has(escalationKey(card)));
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --experimental-strip-types --test tests/approvals.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the backend call**

In `src/backend.ts`, after `flagAttention(count: number, nudge: boolean): Promise<void>;` (`:76`) add:

```ts
  /** Ask for Critical attention (on macOS the dock bounces until the window is focused), for an approval left waiting. */
  requestCriticalAttention(): Promise<void>;
```

In `tauriBackend`, after `flagAttention` (`:115`) add:

```ts
    requestCriticalAttention: async () => {
      const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
      // Not available on every system; the app works without it.
      await getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
    },
```

(`core:window:allow-request-user-attention` is already granted in `src-tauri/capabilities/default.json`.)

In `demoBackend`, after `flagAttention` (`:381`) add:

```ts
    // The browser has no dock; the console says what the desktop app would do.
    requestCriticalAttention: async () => {
      console.info("[preview] Critical attention requested");
    },
```

- [ ] **Step 6: Escalate from `App`**

`src/App.tsx:155`: change `const [, setTick] = useState(0);` to:

```ts
  const [tick, setTick] = useState(0);
```

Extend the approvals import:

```ts
import { approvalSnapshot, dueEscalations, escalationKey, openCards, subscribeApprovals } from "./approvals";
```

After the flag effect (the `useEffect` that calls `backend?.flagAttention(urgent, …)`) add:

```ts
  // An approval left waiting for 2 minutes while the window is in the
  // background asks for Critical attention, once per card. Ready flags and
  // terminal flags never escalate.
  const escalated = useRef(new Set<string>());
  useEffect(() => {
    if (!backend) return;
    const threads = panes.filter((p) => p.kind === "chat" && attention[p.id]?.blocking).map((p) => openCards(p.id, approvalState));
    const due = dueEscalations(threads, escalated.current, document.hasFocus(), Date.now());
    if (due.length === 0) return;
    for (const card of due) escalated.current.add(escalationKey(card));
    backend.requestCriticalAttention().catch(() => {});
  }, [tick, attention, approvalState, panes, backend]);
```

- [ ] **Step 7: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 22 pass, 0 fail; `✓ built in`.

- [ ] **Step 8: Check it in the browser preview**

With `npm run dev` running and a new thread with a Claude Code bot `Null` on **Ask first**: send `@null fix the readme` so the edit card opens, then move focus away from the preview window (click another app or tab) and wait 2 minutes.

Look at, and expect:
- The browser console (read it with the preview's console tool) shows "[preview] Critical attention requested" exactly once, about 2 minutes after the card opened.
- Wait another minute away: no second message for that card. Come back, answer the edit card; when the command and tool cards open, leave again for 2 minutes: one more message (a new card), and no message for a Ready flag or a terminal `ask` prompt left the same way.
- With the window focused the whole time, no message at all.

- [ ] **Step 9: Commit**

```bash
git add src/approvals.ts src/backend.ts src/App.tsx tests/approvals.test.mjs
git commit -m "feat: escalate an approval left waiting in the background"
```

---

### Task 9: Head lines for working and quiet bots (`src/composerStatus.ts`)

**Files:**
- Modify: `src/composerStatus.ts` (type import at the top; new functions appended after stage 1's `threadStatusOf`)
- Modify: `src/ChatPane.tsx:3` (import), `:267-272` (remove `elapsed`)
- Test: `tests/composer-status.test.mjs`

**Interfaces:**
- Produces:
  - `elapsed(ms: number): string` (moved from `ChatPane`)
  - `QUIET_AFTER_MS = 300_000`, `SILENCE_LIMIT_MINUTES = 15`
  - `isCommandLine(backend: ParticipantBackend): boolean`
  - `heardFrom(event: RoomEvent): string | null`
  - `doingNow(turn: { phase: "thinking" | "tool" | "writing"; steps: readonly string[] }): string`
  - `quietLine(since: number | null, now: number): string | null`
  - `interface BotProgress { name: string; doing: string; startedAt: number; heardAt: number | null }`
  - `headLine(bots: number, replying: readonly BotProgress[], now: number): string`

- [ ] **Step 1: Write the failing tests**

In `tests/composer-status.test.mjs` change line 3 (stage 1 made it import `threadStatusOf` too; keep it) to:

```js
import { composerCopy, doingNow, elapsed, headLine, heardFrom, isCommandLine, joinNames, quietLine, replyingVerb, threadStatusOf } from "../src/composerStatus.ts";
```

Append:

```js
const bot = (name, doing, startedAt = 0, heardAt = null) => ({ name, doing, startedAt, heardAt });

test("one bot at work: its name, its step and how long", () => {
  assert.equal(headLine(2, [bot("Null", "Running: npm test", 0, 60_000)], 72_000), "Null · Running: npm test · 1m 12s");
  assert.equal(headLine(1, [bot("Null", "Thinking")], 8_000), "Null · Thinking · 8s");
});

test("two or more at work: how many, and what one of them is doing", () => {
  assert.equal(headLine(3, [bot("Null", "Editing src/App.tsx"), bot("Jigga", "Thinking")], 5_000), "2 replying · Null: Editing src/App.tsx");
});

test("nobody at work: how many bots", () => {
  assert.equal(headLine(0, [], 0), "No bots yet");
  assert.equal(headLine(1, [], 0), "1 bot");
  assert.equal(headLine(2, [], 0), "2 bots");
});

test("a command-line bot silent for 5 minutes reads as quiet, with the cutoff", () => {
  assert.equal(quietLine(0, 5 * 60_000 - 1), null);
  assert.equal(quietLine(0, 5 * 60_000), "Quiet 5m · stops at 15m");
  assert.equal(quietLine(0, 6 * 60_000 + 59_000), "Quiet 6m · stops at 15m");
  assert.equal(quietLine(null, 60 * 60_000), null, "API bots have no silence limit");
  assert.equal(headLine(1, [bot("Null", "Running: sleep 600", 0, 0)], 6 * 60_000), "Null · Quiet 6m · stops at 15m");
  assert.equal(headLine(2, [bot("Null", "Reading a.ts", 0, 6 * 60_000), bot("Jigga", "Running: sleep 600", 0, 0)], 6 * 60_000), "2 replying · Jigga: Quiet 6m · stops at 15m", "the quiet one is named");
});

test("only command-line bots have the silence limit", () => {
  assert.equal(isCommandLine({ kind: "agent", tool: "codex", model: null }), true);
  assert.equal(isCommandLine({ kind: "cli", program: "mytool", args: [] }), true);
  assert.equal(isCommandLine({ kind: "open_ai_compatible", base_url: "http://localhost:11434/v1", model: "llama3", api_key_env: null }), false);
  assert.equal(isCommandLine({ kind: "scripted", lines: [] }), false);
});

test("an answered card's step doesn't linger, and waiting on a card isn't silence", () => {
  assert.equal(doingNow({ phase: "tool", steps: ["Reading a.ts", "Waiting for approval: Run a command"] }), "Working");
  assert.equal(doingNow({ phase: "tool", steps: ["Running: npm test"] }), "Running: npm test");
  assert.equal(doingNow({ phase: "writing", steps: ["Running: npm test"] }), "Writing");
  assert.equal(doingNow({ phase: "thinking", steps: [] }), "Thinking");
  assert.equal(heardFrom({ type: "approval_resolved", id: "null", request: "ask-1", approved: true }), "null", "an answer starts the clock again");
  assert.equal(heardFrom({ type: "approval_requested", id: "null", request: "ask-1", action: { kind: "command", title: "Run a command", detail: "ls" } }), null);
  assert.equal(heardFrom({ type: "delta", id: "null", text: "hi" }), "null");
  assert.equal(heardFrom({ type: "activity", id: "null", text: "Reading a.ts" }), "null");
  assert.equal(heardFrom({ type: "turn_started", id: "null" }), "null");
  assert.equal(heardFrom({ type: "usage", id: "null", input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(heardFrom({ type: "editor_changed", id: null }), null);
  assert.equal(heardFrom({ type: "idle" }), null);
});

test("elapsed time reads as seconds, then minutes and seconds", () => {
  assert.equal(elapsed(8_000), "8s");
  assert.equal(elapsed(65_000), "1m 05s");
  assert.equal(elapsed(-50), "0s");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: FAIL, `does not provide an export named 'doingNow'`.

- [ ] **Step 3: Write the functions**

At the top of `src/composerStatus.ts`, replace stage 1's `import type { ThreadStatus } from "./types";` with:

```ts
import type { ParticipantBackend, RoomEvent, ThreadStatus } from "./types";
```

Leave `joinNames`, `replyingVerb`, `composerCopy` and `threadStatusOf` as they are, and append at the end of the file:

```ts
/** Time since a turn began: 8s, 1m 05s. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** After this long with nothing heard, a command-line bot reads as quiet. */
export const QUIET_AFTER_MS = 5 * 60_000;
/** Command-line turns stop after this many minutes of silence (TURN_TIMEOUT in crates/apex-adapters/src/cli.rs). */
export const SILENCE_LIMIT_MINUTES = 15;

/** Whether a bot runs as a command-line tool, which the silence limit applies to. */
export function isCommandLine(backend: ParticipantBackend): boolean {
  return backend.kind === "agent" || backend.kind === "cli";
}

const HEARD = new Set<RoomEvent["type"]>(["turn_started", "delta", "activity", "changed", "context_usage", "tool_servers", "approval_resolved"]);

/**
 * The bot an event shows is alive, as the silence limit counts it: any
 * update from its turn, or an answer to its card (waiting on a card never
 * counts as silence). Null for every other event.
 */
export function heardFrom(event: RoomEvent): string | null {
  if (!HEARD.has(event.type) || !("id" in event) || typeof event.id !== "string") return null;
  return event.id;
}

/** What a bot is doing now: its latest step while it uses a tool, else Thinking or Writing. A step saying it waits for approval is over once that is answered. */
export function doingNow(turn: { phase: "thinking" | "tool" | "writing"; steps: readonly string[] }): string {
  const step = turn.steps[turn.steps.length - 1];
  if (turn.phase === "tool" && step && !step.startsWith("Waiting for approval: ")) return step;
  return turn.phase === "tool" ? "Working" : turn.phase === "writing" ? "Writing" : "Thinking";
}

/** "Quiet 6m · stops at 15m", once a command-line bot has said nothing for 5 minutes. Null before then, and for other bots (`since` null). */
export function quietLine(since: number | null, now: number): string | null {
  if (since === null || now - since < QUIET_AFTER_MS) return null;
  return `Quiet ${Math.floor((now - since) / 60_000)}m · stops at ${SILENCE_LIMIT_MINUTES}m`;
}

/** One bot producing a reply, as the pane head describes it. */
export interface BotProgress {
  name: string;
  /** From doingNow. */
  doing: string;
  /** When its turn started, in milliseconds since the epoch. */
  startedAt: number;
  /** When it was last heard from, for command-line bots; null for others. */
  heardAt: number | null;
}

/**
 * The muted words in a thread's pane head when no flag shows
 * (ThreadStatus.text): "Null · Running: npm test · 1m 12s" for one bot at
 * work, "2 replying · Null: Editing src/App.tsx" for more, and the number
 * of bots otherwise. A quiet command-line bot is named first, with its
 * warning in place of its step.
 */
export function headLine(bots: number, replying: readonly BotProgress[], now: number): string {
  if (replying.length === 0) return bots === 0 ? "No bots yet" : bots === 1 ? "1 bot" : `${bots} bots`;
  if (replying.length === 1) {
    const bot = replying[0];
    return `${bot.name} · ${quietLine(bot.heardAt, now) ?? `${bot.doing} · ${elapsed(now - bot.startedAt)}`}`;
  }
  const named = replying.find((bot) => quietLine(bot.heardAt, now) !== null) ?? replying[0];
  return `${replying.length} replying · ${named.name}: ${quietLine(named.heardAt, now) ?? named.doing}`;
}
```

- [ ] **Step 4: Use the moved `elapsed` in `ChatPane`**

`src/ChatPane.tsx:3`:

```ts
import { composerCopy, elapsed, joinNames, replyingVerb } from "./composerStatus";
```

Delete the local `elapsed` (`:267-272`, from `/** Time since a turn began: 8s, 1m 05s. */` through its closing `}`).

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --experimental-strip-types --test tests/composer-status.test.mjs`
Expected: PASS, 13 tests (stage 1's 6 and these 7).

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 29 pass, 0 fail; `✓ built in`.

- [ ] **Step 6: Commit**

```bash
git add src/composerStatus.ts src/ChatPane.tsx tests/composer-status.test.mjs
git commit -m "feat: pane head lines for working and quiet bots"
```

---

### Task 10: Thread heads say what is happening, with a quiet warning

**Files:**
- Modify: `src/ChatPane.tsx:3` (import), `:442` (heard ref), `:478` (handler top), `participant_idle` case, stage 1's `const status = threadStatusOf(…)` (today's `:967-968`), `:1484-1533` (draft working line)
- Modify: `src/backend.ts:242-252` (preview `stall`)
- Modify: `src/styles.css:353-356` (`.pane-folder`), after `:737` (quiet line)

**Interfaces:**
- Consumes: `doingNow`, `elapsed`, `headLine`, `heardFrom`, `isCommandLine`, `quietLine`, `BotProgress` (Task 9); stage 1's `ThreadStatus`, `threadStatusOf` and its `status` / `statusKey` / `onStatus` effect in `ChatPane`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Track when each bot was last heard from**

`src/ChatPane.tsx:3`:

```ts
import { composerCopy, doingNow, elapsed, headLine, heardFrom, isCommandLine, joinNames, quietLine, replyingVerb, threadStatusOf, type BotProgress } from "./composerStatus";
```

After the `round` ref (`:442`) add:

```ts
  /** When each bot was last heard from in its turn, for the quiet warning. See heardFrom. */
  const heard = useRef(new Map<string, number>());
```

In the room handler, right after `activity.current(pane.id);` (`:478`) add:

```ts
      const heardId = heardFrom(event);
      if (heardId) heard.current.set(heardId, Date.now());
```

In the `participant_idle` case add `heard.current.delete(event.id);` before `break;`.

- [ ] **Step 2: Build the head's text with `headLine`**

Stage 1 put these lines where today's `statusText` was (`:967-969`):

```ts
  // The pane head's words, and who is replying or stopped on a card, for App.
  const status = threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0));
  const statusKey = JSON.stringify(status);
```

Replace the comment and the `const status = …` line, keeping `statusKey` and stage 1's `onStatus` effect below them. The shape stays; only `text` changes:

```ts
  // The pane head's words (see headLine), and who is replying or stopped on a card, for App.
  const headBots: BotProgress[] = participants
    .filter((p) => working[p.id] && !asks[p.id]?.length)
    .map((p) => ({
      name: p.display_name,
      doing: doingNow(working[p.id]),
      startedAt: working[p.id].startedAt,
      heardAt: isCommandLine(p.backend) ? heard.current.get(p.id) ?? working[p.id].startedAt : null,
    }));
  const status: ThreadStatus = { ...threadStatusOf(participants, Object.keys(working), Object.keys(asks).filter((id) => asks[id].length > 0)), text: headLine(participants.length, headBots, now) };
```

(`ThreadStatus` is already imported on line 1 by stage 1. `now` ticks once a second while any turn runs, `:637-643`, so `statusKey` changes and the head updates each second; no new timer.)

- [ ] **Step 3: Say "Quiet" on the working line**

In the drafts map (`:1484-1533`), after `const hidden = steps.length - shown.length;` add:

```ts
          const config = configOf(id);
          const quiet = turn && !asks[id]?.length && config && isCommandLine(config.backend) ? quietLine(heard.current.get(id) ?? turn.startedAt, now) : null;
```

and replace the working line (`:1521-1529`):

```tsx
                <div className={`working-line ${asks[id]?.length ? "asking" : quiet ? "quiet" : ""}`} role="status">
                  <span className="working-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{asks[id]?.length ? "Waiting for you" : quiet ?? phaseLabel(turn?.phase)}</span>
                  {turn && !quiet && <span className="working-time">{elapsed(now - turn.startedAt)}</span>}
                </div>
```

In `src/styles.css`, replace `.pane-folder { … }` (`:353-356`):

```css
.pane-folder {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 12px;
}
```

and after `.working-time { … }` (`:733-736`) add:

```css
/* A command-line bot that has said nothing for a while: muted, not alarming. */
.working-line.quiet { color: var(--muted); }
.working-line.quiet .working-dots i { background: var(--muted); }
```

- [ ] **Step 4: Let the preview go quiet on request**

In `src/backend.ts`, inside `runPreview`'s agent branch, after the steps loop (`:248-251`, `for (const step of ["Reading README.md", …]) { … }`) add:

```ts
          // Preview only: a message with "stall" in it leaves the bot silent
          // for six minutes, so the quiet warning can be seen.
          const said = [...room.transcript].reverse().find((m) => m.speaker.kind === "human")?.text ?? "";
          if (/\bstall\b/i.test(said)) {
            emit( { type: "activity", id: p.id, text: "Running: sleep 360" });
            await sleep(6 * 60_000); if (!active) return;
          }
```

- [ ] **Step 5: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 29 pass, 0 fail; `✓ built in`.

- [ ] **Step 6: Check it in the browser preview**

With `npm run dev` running: a thread with a Claude Code bot `Null` (Read only) and a Codex bot `Jigga` (Read only). Look at the pane head (the muted text after the title).

Look at, and expect:
- Idle: "2 bots".
- Send `@null hi`: the head reads "Null · Thinking · 0s", then "Null · Reading README.md · 2s", "Null · Running: ls src · 3s" as steps arrive, then "Null · Writing · 5s"; back to "2 bots" when the reply lands.
- Send `@all hi`: "2 replying · Null: Reading README.md" (one bot named).
- Switch Null to **Ask first** (Edit in its ⋯ menu), send `@null fix it`: while the edit card is open the head shows the amber flag, not the text; after **Allow once** the head says "Null · Working · …" or the next step, never "Waiting for approval: Edit README.md".
- Send `@jigga stall` and wait 5 minutes: the head reads "Jigga · Quiet 5m · stops at 15m" and the draft's working line reads the same in muted grey, without the elapsed time; a minute later "Quiet 6m". Press Stop to end it.
- A long head truncates with an ellipsis in a narrow pane (drag a divider), and the × and □ buttons stay visible.

- [ ] **Step 7: Commit**

```bash
git add src/ChatPane.tsx src/backend.ts src/styles.css
git commit -m "feat: thread heads say what is happening, with a quiet warning"
```

---

### Task 11: Terminal heads say how long they have been working

**Files:**
- Modify: `src/attention.ts:86-114` (`Burst`)
- Modify: `src/composerStatus.ts` (end of file)
- Modify: `src/TerminalPane.tsx:11-20` (props), `:41-46` (signature, callbacks), `:72`, `:86-93` (onData)
- Modify: `src/App.tsx:158` (ref), after `:232` (`onRun`), `:434` (closePane), `:686` (head), `:712` (TerminalPane)
- Modify: `src/backend.ts:345-356` (preview `long`)
- Test: `tests/attention.test.mjs`, `tests/composer-status.test.mjs`

**Interfaces:**
- Consumes: `QUIET_MS` (`src/attention.ts:36`).
- Produces: `Burst.runStartedAt(): number`; `workingFor(startedAt: number, now: number): string`; `TerminalPane` prop `onRun?: (paneId: string, startedAt: number) => void`.

- [ ] **Step 1: Write the failing tests**

In `tests/attention.test.mjs` change line 3 to add `QUIET_MS`:

```js
import { Burst, QUIET_MS, afterRound, ago, badgeCount, clearReady, label, seenFlags, summarize, urgency, waitingFor, withApprovals, withPaneSignal, workspaceFlag } from "../src/attention.ts";
```

Append:

```js
test("a run of output starts with the first output after a quiet gap", () => {
  const run = new Burst();
  assert.equal(run.runStartedAt(), 0);
  run.output(1000, 10);
  run.output(1500, 10);
  assert.equal(run.runStartedAt(), 1000);
  run.output(1500 + QUIET_MS + 1, 10);
  assert.equal(run.runStartedAt(), 1500 + QUIET_MS + 1);
});
```

In `tests/composer-status.test.mjs` add `workingFor` to the import on line 3, then append:

```js
test("a terminal's head says how long it has been working", () => {
  assert.equal(workingFor(0, 59_999), "Working");
  assert.equal(workingFor(0, 60_000), "Working 1m");
  assert.equal(workingFor(0, 4 * 60_000 + 30_000), "Working 4m");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/attention.test.mjs tests/composer-status.test.mjs`
Expected: FAIL, `run.runStartedAt is not a function` and `does not provide an export named 'workingFor'`.

- [ ] **Step 3: Write the two functions**

In `src/attention.ts`, inside `class Burst`, after `typed(now: number): void { … }` add:

```ts
  /** When the current run of output began, in milliseconds; 0 before any output. */
  runStartedAt(): number {
    return this.startedAt;
  }
```

Append to `src/composerStatus.ts`:

```ts
/** A terminal's head while output keeps coming: "Working", then "Working 4m" once a run passes a minute. */
export function workingFor(startedAt: number, now: number): string {
  const minutes = Math.floor((now - startedAt) / 60_000);
  return minutes >= 1 ? `Working ${minutes}m` : "Working";
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --experimental-strip-types --test tests/attention.test.mjs tests/composer-status.test.mjs`
Expected: PASS, 18 + 14 tests.

- [ ] **Step 5: Report run starts from `TerminalPane`**

In `src/TerminalPane.tsx` add to `Props` (`:11-20`):

```ts
  /** A new run of output began at `startedAt` (ms since the epoch), for the head's "Working 4m". */
  onRun?: (paneId: string, startedAt: number) => void;
```

Replace `:41-46`:

```ts
export function TerminalPane({ pane, cwd, backend, focused, onActivity, onExit, onSignal, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  // Keep the latest callbacks without restarting the terminal when they change.
  const callbacks = useRef({ onActivity, onExit, onSignal, onRun });
  callbacks.current = { onActivity, onExit, onSignal, onRun };
```

After `let waiting = false;` (`:72`) add `let reportedRun = 0;`, and replace `onData` (`:87-93`):

```ts
      onData: (data) => {
        term.write(data);
        callbacks.current.onActivity(pane.id);
        burst.output(Date.now(), data.length);
        // A new run of output: the pane head times it from here.
        const run = burst.runStartedAt();
        if (run !== reportedRun) {
          reportedRun = run;
          callbacks.current.onRun?.(pane.id, run);
        }
        clearTimeout(quiet);
        quiet = setTimeout(settle, QUIET_MS);
      },
```

- [ ] **Step 6: Show "Working 4m" in `App`**

In `src/App.tsx` add below the attention import:

```ts
import { workingFor } from "./composerStatus";
```

After `const lastOutput = useRef(new Map<string, number>());` (`:158`) add:

```ts
  /** When each terminal's current run of output began, for "Working 4m". */
  const runStart = useRef(new Map<string, number>());
```

After `onExit` (`:230-232`) add:

```ts
  const onRun = useCallback((paneId: string, startedAt: number) => {
    runStart.current.set(paneId, startedAt);
  }, []);
```

In `closePane`'s `end` (`:432-436`) add `runStart.current.delete(id);` after `lastOutput.current.delete(id);`.

In the pane head (`:686`) replace the terminal part `status === "working" ? "Working" : status === "exited" ? "Exited" : "Idle"` with:

```tsx
status === "working" ? workingFor(runStart.current.get(pane.id) ?? Date.now(), Date.now()) : status === "exited" ? "Exited" : "Idle"
```

On the `TerminalPane` element (`:712`) add `onRun={onRun}` after `onSignal={onSignal}`. (`App` already re-renders once a second, `:221-225`; no new timer.)

- [ ] **Step 7: Give the preview a long run**

In `src/backend.ts` `ptyWrite` (`:345-356`), change the comment to "Preview only: typing "ask" then Enter shows an approval prompt, "work" prints for a few seconds and "long" for 90 seconds, so the attention states and working times can be seen." and after the `work` block add:

```ts
      if (line.endsWith("long\r")) {
        for (let i = 1; i <= 180; i++) setTimeout(() => emitData(id, `\r\nstep ${i} of 180 ...`), i * 500);
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 181 * 500);
      }
```

- [ ] **Step 8: Run all checks**

Run: `npm test && npm run build`
Expected: B<sub>ts</sub> + 31 pass, 0 fail; `✓ built in`.

- [ ] **Step 9: Check it in the browser preview**

With `npm run dev` running, in Code open a Terminal pane. Type `long` then Enter.

Look at, and expect:
- The head reads "Working" for the first minute, then "Working 1m" until the run ends at about 90 s, then "Idle" (and a Ready flag if you were looking elsewhere).
- Typing in an idle terminal shows "Working" briefly while the echo prints, never "Working 1m".
- Type `work` then Enter: "Working" for about 6 s, then "Idle".

- [ ] **Step 10: Commit**

```bash
git add src/attention.ts src/composerStatus.ts src/TerminalPane.tsx src/App.tsx src/backend.ts tests/attention.test.mjs tests/composer-status.test.mjs
git commit -m "feat: terminal heads say how long they have been working"
```

---

### Task 12: Docs, checks and the walkthrough

**Files:**
- Modify: `README.md:19-30` (Layout), `:34-48` (Attention), `:61-66` (Approvals), `:144-146` (preview), `:290` (Codex approvals), `:311-322` (Project layout)
- Modify: `SPEC.md:48`, `:50`, `:69-77`, `:83-91`

**Interfaces:**
- Consumes: everything above.
- Produces: the finished stage.

- [ ] **Step 1: Update `README.md`**

Stage 1 also edits some of these paragraphs; change only the sentences named here.

In **Layout** (`:24-26`) replace "and its head says what it is doing: Working, Idle or Exited for a terminal, and how many bots a thread has." with:

```markdown
and its head says what it is doing. A terminal reads Working (with minutes
  once a run passes one, such as "Working 4m"), Idle or Exited. A thread
  names the bot at work and what it is doing, such as "Null · Running: npm
  test · 1m 12s" or "2 replying · Null: Editing src/App.tsx", and otherwise
  how many bots it has. A command-line bot that has said nothing for 5
  minutes reads "Quiet 6m · stops at 15m"; time waiting on you doesn't count.
```

In **Attention** (`:47-48`) replace "Looking at a pane clears its flag; a waiting terminal keeps its flag until you type in it." with:

```markdown
Looking at a pane clears its flag, with two exceptions: a waiting terminal
  keeps its flag until you type in it, and a thread whose bot is stopped on
  an approval card keeps "Null wants approval: …" until every card is
  answered. The list answers routine approvals in place: a command, or an
  edit of 20 changed lines or fewer, gets **Allow once**, **Deny** and
  **Open thread** (never Always allow); anything else gets **Open to
  answer**. **Mark ready as seen** clears every Ready flag. The number on
  the Dock icon counts only what needs you or failed, and an approval left
  waiting for 2 minutes while Apex Deck is in the background bounces the
  Dock until you come back, once per card.
```

In **Approvals** (`:63-66`) replace "and an Approve and a Reject button. Nothing happens until you choose, the pane is flagged as waiting on you, and" with:

```markdown
with **Allow once**, **Always allow** and **Deny**. Nothing happens until
  you choose, the thread stays flagged as waiting on you until you answer
  (even while you look at it), and
```

In the preview paragraph (`:144-146`) append after "a badge in the title bar says so.":

```markdown
In that mode, typing `ask`, `work` or `long` in a terminal shows a prompt, a
short run or a 90-second run; a bot set to Ask first proposes an edit, then a
command and an MCP tool call together; and a message containing `stall`
leaves a bot silent for six minutes.
```

In **Codex approvals** (`:290`) after "before Codex's 10-minute hook limit." insert:

```markdown
The card and the attention list say so: "Denied automatically in 6m".
```

In **Project layout** (`:311-322`), after the `src/attention.ts` row add:

```markdown
| `src/approvals.ts` | Open approval cards for the whole app, and the flag they raise, with no interface code. |
| `src/answerStrip.ts` | What the attention list offers for a thread's approval cards. |
```

- [ ] **Step 2: Update `SPEC.md`**

Replace `:48`:

```markdown
| A reply in progress is shown as a draft with its steps, a thinking, working or writing status and elapsed time, so it is not mistaken for the final message; a command-line bot silent for 5 minutes reads "Quiet 6m · stops at 15m" | done |
```

Replace `:50`:

```markdown
| "Ask first" access: a bot proposes each edit and command, and waits for Allow once, Always allow or Deny in the chat | done for Claude Code (checked against the real tool) and Codex (checked against its message format and a stand-in server only) |
```

In **How asking works** (`:69-77`), after "Waiting does not count against the turn's time limit." insert:

```markdown
Cards from Codex's MCP hook carry `expires_at` (the helper denies after 570
s), and say "Denied automatically in 6m". Open cards are also kept app-wide
(`src/approvals.ts`) so a thread stays flagged until each is answered.
```

Replace `:89`:

```markdown
| The app's icon counts what needs you or failed (Ready shows in the title bar and rail), and draws the eye once when one of those is flagged in the background | done (not yet seen on a real Mac) |
```

and insert after `:88`:

```markdown
| An open approval card keeps its thread flagged, and its ⌘J place, until it is answered, wherever you look | done |
| Answer routine approvals (commands, edits of 20 changed lines or fewer) from the list; Mark ready as seen | done |
| An approval left waiting 2 minutes in the background asks for Critical attention, once per card | done (not yet seen on a real Mac) |
| Pane heads say what is happening: the bot at work and its step, a quiet warning before the 15-minute cutoff, and how long a terminal has been working | done |
```

- [ ] **Step 3: Run every check**

```bash
npm test 2>&1 | tail -8
npm run build 2>&1 | tail -3
cargo test --workspace -- --test-threads=1 2>&1 | grep "test result"
git diff --check
```

Expected: B<sub>ts</sub> + 31 pass, 0 fail; `✓ built in`; every Rust line `ok` with B<sub>rs</sub> + 2 passed; `git diff --check` prints nothing.

- [ ] **Step 4: Walk through every change in the browser preview**

Run `npm run dev`, open http://localhost:1420/ in the browser preview, and do the whole list at **1440×900**, then again at about **820×1400**. Setup: **Add a workspace**; in Threads **Start a group chat** ("Fix login"), **+ Add model** → Claude Code, **Ask first**, `Null`; add a Codex bot `Jigga` (Read only); **+ New thread** → a second thread ("Notes"); in Code, two Terminal panes.

Expect, item by item:
1. **Approvals stay flagged (2.1).** In Fix login send `@null fix the readme`. The head flag reads "Null wants approval: Edit README.md"; focusing the pane does not clear it; ⌘J from Notes returns to it. After **Allow once**, the flag reads "Null wants approval: Run npm test -- --run auth · +1 more", with the first card's "ago". Queueing `@null hello` keeps the flag. The tool card shows "Denied automatically in 10m"; no other card shows a deadline. **Stop** with a card open leaves no flag.
2. **Answer from the list (2.2).** From Notes, open the list (440px). Fix login's strip: "Wants to change a file", "+2 −1 · README.md", the diff, **Allow once** / **Deny** / **Open thread**; then the command strip with "Next in this thread: x-mcp: post_tweet"; after answering, focus on **Open to answer** with "Denied automatically in 10m". Answer the tool and node_repl cards in the thread with **Always allow**, send `@null again`, and answer the edit and the command from the list: the row reads "No approvals waiting" and keeps focus until the list closes. No **Always allow** in the list. Terminal rows open their pane.
3. **Ready and the badge (2.3).** With a Ready flag and a Needs you flag: the footer shows **Mark ready as seen**, which clears only Ready; the tab title counts only Needs you and Failed.
4. **Escalation (2.4).** Leave a card open and move focus off the window for 2 minutes: the console shows "[preview] Critical attention requested" once, never again for that card.
5. **Pane heads (2.5).** "2 bots" idle; "Null · Reading README.md · 2s" with one bot; "2 replying · Null: …" with `@all hi`; `@jigga stall` gives "Jigga · Quiet 5m · stops at 15m" after 5 minutes (head and working line, muted); a terminal running `long` reads "Working 1m" after a minute.
6. **Must keep working.** Cards in the thread still answer with Allow once / Always allow / Deny; the queue and Steer (⌘↵) work; `/pin x`, `/diff`, `/fork`, `/export`, `/compact`, `/clear` behave as before; tab, workspace and title-bar counts match the list; dragging a terminal pane onto another does not restart it (its scrollback stays).
7. At 820×1400: the attention list fits with a 16px margin, strip buttons wrap, pane heads truncate with an ellipsis, nothing scrolls sideways.

Report what you saw for each item, and list as untested anything only the desktop app can show: the real dock badge and Critical bounce, a real Codex hook card's deadline, and the quiet warning against a real silent agent.

- [ ] **Step 5: Commit**

```bash
git add README.md SPEC.md
git commit -m "docs: attention stage in README and SPEC"
```

Don't push and don't merge. Report the branch, the commits, the check results with counts, and the walkthrough notes.
