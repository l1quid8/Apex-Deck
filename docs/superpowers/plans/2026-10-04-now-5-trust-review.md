# Now tier, Stage 5: trust and review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approval cards say exactly what Always allow covers and Remove really takes it back; low batteries stop borrowing the Failed red and each thread's token totals survive a restart; and the thread's change goes to a reviewer bot as a patch file in one click.

**Architecture:** Rust gains the shared wire fields `ProposedAction.risky` (set by the adapters from `mcp::needs_approval` and Codex `riskLevel: "high"`) and `AllowedRule.allowed_at`, plus two fields only this stage uses: `AllowedRule.risky` (older rules load through a private `SavedRule` shim) and `RoomSnapshot.usage` (per-bot `TokenTotals` that `Room` adds up and the desktop shell checkpoints). Codex is told `persist: "session"` at most, a silent rule match is answered as a plain yes, and a Codex command's reason moves into the card title, so the thread's saved list is the only lasting record and a rule covers exactly one command. Every new piece of copy lives in a pure module (`approvalChoices.ts`, `allowedRules.ts`, `battery.ts`, new `review.ts`) with node:test tests; the React components only render it, and the browser preview backend mirrors each change.

**Tech Stack:** Rust 2021 (serde, apex-core, apex-adapters, Tauri 2 shell), React 19 + TypeScript 7, Vite 8, node:test under `--experimental-strip-types`.

**Spec:** docs/superpowers/specs/2026-10-04-now-tier.md

## Global Constraints

Copied from the spec's "Global constraints", "Shared interfaces" and Stage 5 sections. Every task includes these.

- Preserve everything in "Must keep working" of `2026-10-03-ui-review-fixes.md`: approval cards, the turn queue and steering, `/compact` `/clear` `/pin` `/diff` `/fork` `/export`, attention counts, dragging panes without remounting terminals, and the browser preview behaving like the native app.
- The browser preview backend (`src/backend.ts`, preview half) gets every new command and event the native backend gets.
- Restoring or applying anything never silently raises access or starts an agent. Keys stay out of saved state.
- Standing decisions (`2026-10-03-open-work.md`): slash commands only create something or take text you'd type; no coloured left bars on strips or rows; pins stay a collapsible row above the chat; agent colours are chosen once and saved.
- Copy: second person, plain, sentence case, verb-first buttons, "e.g." placeholders, " · " joins facts, no emoji. Attention colours always come with words. Red (`--danger`) means Failed and destructive actions only.
- No new dependencies.
- New files differ from every existing file name by more than case. (This plan creates `src/review.ts` and `tests/review.test.mjs`.)
- Commit on the stage's feature branch. Don't push and don't merge to `main` unless Tyler asks.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` (the suite only passes serially).
- Shared interface names, exactly: `ProposedAction.risky` and `AllowedRule.allowed_at`, each with a `crates/apex-core/tests/wire_format.rs` update. New fields on saved structs use `#[serde(default)]` so older session files still load.
- Stage 5 copy, exactly: the risky kind label adds " · can spend money or publish"; "Always allow lets Null call x-mcp: post_tweet in this thread with any arguments, without asking."; "Always allow lets Jigga run this exact command in this thread without asking."; risky cards replace "Nothing happens until you choose." with the scope line; rows read "Allowed Oct 4" plus " · can spend money or publish" for risky rules; after Remove "Removed. Null asks again next time."; the usage card says "in this thread"; **Ask for review ▾**; scope line "Since this thread started · 6 files · +73 −16"; muted "Can edit files"; file `review-since-start-<n>.patch`; composer "@ada Review this change." plus "Attached file: <path>"; it never sends; over 2,000 lines offer "One file per patch"; a bot that can't read the folder says "Can't read attachments".
- Battery: low cells draw in the agent's own colour with a hairline outline; critical gets a thicker outline and the word "low"; no `--danger`, no red pulse.
- No extra confirm step on Always allow (c259fac put it on every card on purpose).
- Pure modules (anything a test imports) use type-only imports for types, no enums, no parameter properties and no React; a runtime import of another pure module carries the `.ts` extension, as `src/composerMenu.ts:2` does.

## Review Focus

1. **A thread saved before this change.** Its Always allow rules have no date and no risk flag. They must still match and Remove must still work, the row must read "Allowed earlier" (never "Jan 1, 1970"), and a saved tool rule must still say it can spend money or publish. Pinned by Task 3's `rules_saved_before_dates_and_risk_still_load_and_match` and Task 6's `rules saved before dates were kept read Allowed earlier`.
2. **Codex asks about the same command with different reason text, or about a longer command that starts the same way** (`cargo test`, then `cargo test\n\nrm -rf ~`). One Always allow must cover that exact command whatever the reason, and never a longer one. Pinned by Task 4's `a_codex_command_rule_covers_that_command_whatever_the_reason_and_nothing_longer`.
3. **Changes with no patch text** (the folder isn't a git repository, the thread hasn't sent a message yet, or git cleaned up the starting snapshot). Ask for review must never attach an empty patch: the bot rows are disabled and the menu says why. Pinned by Task 10's `changes with no patch text never make an empty patch file`.
4. **A draft already in the composer when you pick a reviewer.** Your text stays below the request, and nothing is sent. Pinned by Task 10's `picking a reviewer keeps a draft you already typed`.
5. **An edit card for several files, or one Codex didn't describe.** Edit rules match by title, so "Edit 3 files" covers any 3-file edit. The scope line must say what the rule really matches and never name one file. Pinned by Task 5's `scope lines say what the rule really matches for every kind of card`.

---

## File map

| File | What changes | Task |
|---|---|---|
| `crates/apex-core/src/approval.rs` | `ProposedAction.risky`; `AllowedRule.allowed_at`, `AllowedRule.risky`, `SavedRule` shim; `Decision::ApproveAlways` doc | 1, 3 |
| `crates/apex-core/src/room.rs` | silent rule match answers `Approve`; `RoomSnapshot.usage`, `Room::usage()` | 4, 8 |
| `crates/apex-core/src/types.rs`, `src/lib.rs` | `TokenTotals` | 8 |
| `crates/apex-core/tests/wire_format.rs`, `tests/room.rs` | wire and room tests | 1, 3, 8 |
| `crates/apex-adapters/src/mcp.rs`, `codex_hook.rs`, `codex_server.rs`, `events.rs`, `cli.rs`, `tests/adapters.rs` | risky marking, persist `session`, command title | 1, 2, 4 |
| `src-tauri/src/lib.rs` | checkpoint `Usage` events | 1, 8 |
| `src/types.ts` | mirrors of every wire change | 1, 3, 8 |
| `src/approvalChoices.ts`, `src/Approvals.tsx` | kind label, scope line | 5 |
| `src/allowedRules.ts` | dates, risk, Removed note | 6 |
| `src/battery.ts`, `src/Avatar.tsx` | no red, outline, "low", token sentence | 7, 9 |
| `src/review.ts` (new), `src/DiffPanel.tsx`, `src/ThreadDetails.tsx`, `src/App.tsx` | Ask for review | 10, 11 |
| `src/ChatPane.tsx`, `src/backend.ts`, `src/styles.css` | wiring, preview, styles | 5, 6, 7, 9, 11 |
| `README.md`, `SPEC.md` | docs | 12 |

**Not in this plan** (said here so nobody builds them by accident):
- Gating is unchanged. A Codex MCP call whose tool name looks like a read (`get_…`) still goes through without a card even if Codex marks it `riskLevel: "high"`; `risky` only changes how a card that does show is labelled.
- Edit rules still match by title, so "Edit 3 files" covers any 3-file edit. The scope line now says so (Task 5); narrowing those rules is a separate decision for Tyler.
- The word "low" is not drawn on 21px chip avatars; the chip's own text already reads "ctx 5% low".

**If stage 2 (`2026-10-04-now-2-attention.md`) is already merged** when you start, it has changed some of the same code. Adjust as follows and say so in your report:
- `ProposedAction` and `McpCall` also carry `expires_at`. Wherever this plan shows a whole `ProposedAction { … }` literal or function body, keep the `expires_at` field or line stage 2 added. The Task 1 `perl` command still works on literals ending in `expires_at: None }`; in Task 1 Step 5, any extra line the `grep` lists must be a signature, the struct, or a multi-line literal whose `risky:` sits on a later line (check each).
- `src/Approvals.tsx` is now `src/ApprovalCard.tsx`, and `src/DiffPanel.tsx` imports `Diff` from `"./ApprovalCard"`. In Task 5 edit `src/ApprovalCard.tsx`, keep its `deadline` prop and its `{deadline && <span className="approval-deadline">{deadline}</span>}` after the note, and write `kindLabel` on top of stage 2's `cardLabel` instead of repeating the four labels:
  ```ts
  import { cardLabel } from "./approvals.ts";

  export function kindLabel(action: ProposedAction): string {
    const kind = cardLabel(action.kind);
    return action.risky ? kind + RISKY_NOTE : kind;
  }
  ```
  then use `kindLabel(action)` where the card calls `cardLabel(action.kind)`. In Task 11's new `DiffPanel.tsx`, import `Diff` from `"./ApprovalCard"`.
- Stage 2 rewrites the preview's proposals in `src/backend.ts`. In Task 5 Step 6, add the x-mcp: post_tweet proposal after the `npm run build` command in whatever list is there.
- In Task 5 Step 5, find `<ApprovalCard` in `src/ChatPane.tsx` wherever stage 2 left it and add `name={names.get(id) ?? id}` (or the bot id variable used there).

**Line numbers** below are from `main@95d753d` with Tyler's uncommitted composer change in `src/ChatPane.tsx` (it adds 7 lines at line 425, so ChatPane numbers after 425 are 7 higher than in `main`). Stage 1 (`2026-10-04-now-1-safety.md`) changes `ChatPane.tsx`, `App.tsx`, `closing.ts` and `src-tauri/src/lib.rs`, so on the stage branch some lines will have moved. Every edit quotes the code it anchors on: find that code, not the number.

---

### Task 0: Preflight

**Files:** none changed.

- [ ] **Step 1: Check the working tree**

Run: `cd /Users/tylercaldwell/Downloads/apex-deck && git status --short`
Expected today:
```
 M src/ChatPane.tsx
 M src/styles.css
?? docs/superpowers/specs/
```
(plus untracked plans under `docs/superpowers/plans/`).

`src/ChatPane.tsx` and `src/styles.css` hold Tyler's own composer auto-grow change. It is not part of this plan. **Stop and ask Tyler**, in these words: "src/ChatPane.tsx and src/styles.css have your uncommitted composer auto-grow change. Tasks 5, 6, 7, 9 and 11 edit both files, and I can't stage only my hunks here (interactive `git add -p` isn't available), so my commits would carry your change. Do you want to commit it first (tell me the message and the branch), or handle it yourself?" Wait for the answer. Never stash, reset, checkout or discard those edits. If Tyler commits them, `git status --short` shows only untracked docs afterwards.

- [ ] **Step 2: Create the stage branch**

Stage 5 builds on stage 1. Run:
```bash
cd /Users/tylercaldwell/Downloads/apex-deck
git log --oneline main | head -20
git branch -a --list '*now-1*'
```
- If stage 1's commits (its plan is `docs/superpowers/plans/2026-10-04-now-1-safety.md`) are on `main`: `git switch -c feat/now-5-trust-review main`.
- If they are not merged but the stage 1 branch exists: `git switch -c feat/now-5-trust-review <that branch>` and tell Tyler: "Stage 1 isn't merged yet, so I branched stage 5 from <that branch>."
- If neither: stop and ask Tyler whether to start from `main` anyway. Nothing in this plan calls stage 1 code, but the spec orders stage 5 after it.

Expected: `Switched to a new branch 'feat/now-5-trust-review'`.

- [ ] **Step 3: Record baselines**

Run each and write the numbers in your report:
- `npm test` — on `main@95d753d`: `ℹ tests 113`, `ℹ pass 113`, `ℹ fail 0`.
- `npm run build` — expected to finish with Vite's `✓ built in …`.
- `cargo test --workspace -- --test-threads=1` — record every `test result: ok. N passed` line. Any failure here is not yours; report it before going on.

- [ ] **Step 4: No commit**

This task changes no files.

---

### Task 1: `ProposedAction.risky` on the wire

**Files:**
- Modify: `crates/apex-core/src/approval.rs:39-47` (struct) and test literals at `:272`, `:281-283`, `:300`
- Modify: `crates/apex-core/src/room.rs:743`
- Modify: `crates/apex-core/tests/room.rs:512`, `:568`
- Modify: `crates/apex-core/tests/wire_format.rs:121-125`
- Modify: `crates/apex-adapters/src/events.rs:381-385`, `:389`, `:392`, `:941`, `:945`
- Modify: `crates/apex-adapters/src/codex_server.rs:97`, `:104`, `:161`
- Modify: `crates/apex-adapters/src/mcp.rs:17`
- Modify: `crates/apex-adapters/src/cli.rs:581`
- Modify: `crates/apex-adapters/tests/adapters.rs:818`, `:873`
- Modify: `src-tauri/src/lib.rs:934`
- Modify: `src/types.ts:8-15`
- Test: `crates/apex-core/tests/wire_format.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: Rust `apex_core::ProposedAction { kind: ActionKind, title: String, detail: String, risky: bool }` with `#[serde(default)]` on `risky`; JSON `"risky": false|true`. TS `ProposedAction.risky?: boolean` (missing means no). Every adapter sets `risky: false` here; Task 2 sets real values.

- [ ] **Step 1: Write the failing test**

In `crates/apex-core/tests/wire_format.rs`, change the expected JSON at line 124 from
```rust
        json!({ "type": "approval_requested", "id": "opus", "request": "ask-1", "action": { "kind": "command", "title": "Run a command", "detail": "ls" } })
```
to
```rust
        json!({ "type": "approval_requested", "id": "opus", "request": "ask-1", "action": { "kind": "command", "title": "Run a command", "detail": "ls", "risky": false } })
```
and add this test at the end of the file:
```rust
#[test]
fn proposed_actions_say_whether_they_are_risky() {
    let risky = apex_core::ProposedAction { kind: apex_core::ActionKind::Tool, title: "x-mcp: post_tweet".into(), detail: "{}".into(), risky: true };
    assert_eq!(
        to_value(&risky).unwrap(),
        json!({ "kind": "tool", "title": "x-mcp: post_tweet", "detail": "{}", "risky": true })
    );
    // Actions written before `risky` existed read as not risky.
    let old: apex_core::ProposedAction =
        serde_json::from_value(json!({ "kind": "command", "title": "Run a command", "detail": "ls" })).unwrap();
    assert!(!old.risky);
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: compile error `error[E0560]: struct `ProposedAction` has no field named `risky``.

- [ ] **Step 3: Add the field**

In `crates/apex-core/src/approval.rs`, replace lines 39-47:
```rust
/// Something a participant wants to do and is waiting for permission for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedAction {
    pub kind: ActionKind,
    /// One line, such as "Edit src/main.rs" or "Run a command".
    pub title: String,
    /// The whole of it: the diff, the command, or the tool's arguments.
    pub detail: String,
    /// It can spend money or publish: an MCP tool whose name says so
    /// (`mcp::needs_approval` in apex-adapters) or a request Codex marks
    /// `riskLevel: "high"`. The card says so, always shows what Always allow
    /// would cover, and the saved rule remembers it.
    #[serde(default)]
    pub risky: bool,
}
```

- [ ] **Step 4: Give every struct literal a value**

Seventeen one-line literals end in `detail: … }`. This appends `, risky: false` to each (checked against the current files: it changes exactly 17 lines):
```bash
cd /Users/tylercaldwell/Downloads/apex-deck
perl -pi -e 's/(ProposedAction \{ kind: .*?detail: .*?) \}/$1, risky: false }/g' \
  crates/apex-adapters/tests/adapters.rs crates/apex-adapters/src/events.rs crates/apex-adapters/src/cli.rs \
  crates/apex-core/tests/wire_format.rs crates/apex-core/src/room.rs crates/apex-core/tests/room.rs \
  src-tauri/src/lib.rs crates/apex-core/src/approval.rs
```
Then edit the six literals the command can't reach by hand:

`crates/apex-adapters/src/events.rs:381-385` becomes:
```rust
            return ProposedAction {
                kind: ActionKind::Edit,
                title: format!("{verb} {}", change.path),
                detail: changes.iter().map(|c| c.diff.as_str()).collect::<Vec<_>>().join("\n"),
                risky: false,
            };
```
`crates/apex-adapters/src/events.rs:392` becomes:
```rust
        ProposedAction { kind: ActionKind::Other, title: self.claude_activity(tool, input), detail, risky: false }
```
`crates/apex-adapters/src/codex_server.rs:97` becomes:
```rust
            Some(ProposedAction { kind: ActionKind::Command, title: "Run a command".to_string(), detail, risky: false })
```
`crates/apex-adapters/src/codex_server.rs:104` becomes:
```rust
            Some(ProposedAction { kind: ActionKind::Edit, title, detail, risky: false })
```
`crates/apex-adapters/src/codex_server.rs:161` becomes:
```rust
    Some(ProposedAction { kind: ActionKind::Other, title: format!("{server} asks permission"), detail, risky: false })
```
`crates/apex-adapters/src/mcp.rs:17` becomes:
```rust
    ProposedAction { kind: ActionKind::Tool, title: format!("{server}: {tool}"), detail: serde_json::to_string_pretty(arguments).expect("JSON value"), risky: false }
```

- [ ] **Step 5: Check nothing was missed**

Run: `cargo build --workspace --all-targets`
Expected: `Finished` with no errors and no warnings.

Run: `grep -rn "ProposedAction {" crates src-tauri/src | grep -v risky`
Expected, in any order, exactly these six lines (signatures, the struct, and the multi-line literal whose `risky` sits on a later line):
```
crates/apex-core/src/approval.rs:41:pub struct ProposedAction {
crates/apex-core/src/room.rs:742:    fn action() -> ProposedAction {
crates/apex-adapters/src/events.rs:374:    pub(crate) fn claude_action(&self, tool: &str, input: &Value) -> ProposedAction {
crates/apex-adapters/src/events.rs:381:            return ProposedAction {
crates/apex-adapters/src/codex_hook.rs:185:    pub(crate) fn action(&self) -> ProposedAction {
crates/apex-adapters/src/mcp.rs:16:pub(crate) fn action(server: &str, tool: &str, arguments: &Value) -> ProposedAction {
```

- [ ] **Step 6: Run the tests**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: `test result: ok. 10 passed`.

Run: `cargo test --workspace -- --test-threads=1`
Expected: every `test result: ok.`, with the Task 0 counts plus 1 for `wire_format`.

- [ ] **Step 7: Mirror it in TypeScript**

In `src/types.ts`, replace lines 8-15:
```ts
/** Something a bot wants to do and is waiting for a yes or no on. */
export interface ProposedAction {
  kind: "edit" | "command" | "tool" | "other";
  /** One line, such as "Edit src/main.rs". */
  title: string;
  /** The diff, the command, or the tool's arguments. */
  detail: string;
  /** It can spend money or publish. Missing means no. */
  risky?: boolean;
}
```
Run: `npm run build`
Expected: passes (`✓ built in …`).

- [ ] **Step 8: Commit**

```bash
git add crates src-tauri/src/lib.rs src/types.ts
git commit -m "feat: approval proposals say whether they can spend money or publish"
```

---

### Task 2: Adapters mark risky actions

**Files:**
- Modify: `crates/apex-adapters/src/mcp.rs:16-18` and its tests (module at `:160`)
- Modify: `crates/apex-adapters/src/codex_hook.rs:185-191` and its tests (module at `:378`)
- Modify: `crates/apex-adapters/src/codex_server.rs:146-162`, `:432-441` and its tests (module at `:544`)
- Modify: `crates/apex-adapters/tests/adapters.rs:1014`, `:1059`

**Interfaces:**
- Consumes: `ProposedAction.risky` (Task 1).
- Produces: `mcp::action(server, tool, arguments)` returns `risky: needs_approval(tool)`; `McpCall::action()` returns `risky: self.risky()`; in `codex_server.rs`, `fn high_risk(params: &Value) -> bool` and `fn call_action(call: &McpCall, params: &Value) -> ProposedAction`, and `mcp_question` sets `risky: high_risk(params)`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module of `crates/apex-adapters/src/mcp.rs`:
```rust
    #[test]
    fn a_tool_that_can_spend_money_or_publish_makes_a_risky_action() {
        assert!(action("x-mcp", "post_tweet", &json!({"text": "hi"})).risky);
        assert!(!action("github", "fetch_pr_patch", &json!({})).risky);
    }
```
Add to the `tests` module of `crates/apex-adapters/src/codex_hook.rs`:
```rust
    #[test]
    fn hook_cards_are_risky_when_the_call_is() {
        assert!(McpCall::from_hook("mcp__probe__place_order", json!({})).action().risky);
        assert!(McpCall::from_hook("not_an_mcp_name", json!({})).action().risky, "a name Deck can't split always asks");
        assert!(!McpCall::from_hook("mcp__probe__get_balance", json!({})).action().risky);
    }
```
Add to the `tests` module of `crates/apex-adapters/src/codex_server.rs`:
```rust
    #[test]
    fn codex_high_risk_marks_the_card_risky() {
        let ask = json!({"serverName":"computer-use", "mode":"form", "message":"Allow Codex to use Terminal?",
            "requestedSchema":{"type":"object","properties":{}}, "_meta":{"codex_approval_kind":"app_approval","riskLevel":"high"}});
        assert!(mcp_question(&ask).unwrap().risky);
        let mut low = ask.clone(); low["_meta"]["riskLevel"] = json!("low");
        assert!(!mcp_question(&low).unwrap().risky);
        let read = McpCall { server: "probe".into(), tool: "get_balance".into(), arguments: json!({}) };
        assert!(!call_action(&read, &json!({"_meta":{}})).risky);
        assert!(call_action(&read, &json!({"_meta":{"riskLevel":"high"}})).risky, "Codex's own mark is kept");
        let order = McpCall { server: "probe".into(), tool: "place_order".into(), arguments: json!({}) };
        assert!(call_action(&order, &json!({"_meta":{}})).risky, "the name alone is enough");
    }
```
In `crates/apex-adapters/tests/adapters.rs`, after line 1014 (`assert_eq!(action.title, "probe: place_order");`) add:
```rust
            assert!(action.risky, "place_order can spend money");
```
and change line 1059 to:
```rust
        assert!(asked.iter().all(|a| a.kind==ActionKind::Tool && a.title=="probe: place_order" && a.risky));
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p apex-adapters --lib -- --test-threads=1`
Expected: compile error `cannot find function `call_action` in this scope`.

- [ ] **Step 3: Mark risky actions**

In `crates/apex-adapters/src/mcp.rs`, `action` (lines 16-18), change `risky: false` (from Task 1) to `risky: needs_approval(tool)`, so the function reads:
```rust
pub(crate) fn action(server: &str, tool: &str, arguments: &Value) -> ProposedAction {
    ProposedAction { kind: ActionKind::Tool, title: format!("{server}: {tool}"), detail: serde_json::to_string_pretty(arguments).expect("JSON value"), risky: needs_approval(tool) }
}
```
In `crates/apex-adapters/src/codex_hook.rs`, `McpCall::action` (lines 185-191), add two lines just before the final `action` that returns it, keeping every line already there:
```rust
        // A name Deck can't split always asks, so its card is risky too.
        action.risky = self.risky();
```
so the function reads (on `main`):
```rust
    pub(crate) fn action(&self) -> ProposedAction {
        let mut action = crate::mcp::action(&self.server, &self.tool, &self.arguments);
        if self.server.is_empty() {
            action.title = self.tool.clone();
        }
        // A name Deck can't split always asks, so its card is risky too.
        action.risky = self.risky();
        action
    }
```
In `crates/apex-adapters/src/codex_server.rs`, change the last line of `mcp_question` (line 161, from Task 1) to:
```rust
    Some(ProposedAction { kind: ActionKind::Other, title: format!("{server} asks permission"), detail, risky: high_risk(params) })
```
and add these two functions right after `mcp_question` (after line 162):
```rust
/// Codex marks some approval requests `riskLevel: "high"` in their `_meta`.
fn high_risk(params: &Value) -> bool {
    params["_meta"]["riskLevel"] == "high"
}

/// The card for an in-flight MCP call Codex asked about: risky when the
/// tool's name says so or Codex marks the request high risk.
fn call_action(call: &McpCall, params: &Value) -> ProposedAction {
    let mut action = call.action();
    action.risky |= high_risk(params);
    action
}
```
In `run`, inside the `mcpServer/elicitation/request` branch (lines 432-441), change
```rust
                                None => {
                                    let action = call.action();
```
to
```rust
                                None => {
                                    let action = call_action(&call, params);
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p apex-adapters --lib -- --test-threads=1`
Expected: `test result: ok.` with 3 more tests than the Task 0 count for this target.

Run: `cargo test -p apex-adapters --test adapters -- --test-threads=1`
Expected: `test result: ok.`

- [ ] **Step 5: Commit**

```bash
git add crates/apex-adapters
git commit -m "feat: MCP cards that can spend money or publish are marked risky"
```

---

### Task 3: `AllowedRule.allowed_at` and `risky`, older saves still load

**Files:**
- Modify: `crates/apex-core/src/approval.rs:49-78` (rule), `:83-86` (stale doc on `Decision::ApproveAlways`), tests module at `:240`
- Modify: `crates/apex-core/tests/wire_format.rs:126-130`
- Modify: `src/types.ts:87-96`
- Test: `crates/apex-core/tests/wire_format.rs`, `crates/apex-core/src/approval.rs`

**Interfaces:**
- Consumes: `ProposedAction.risky` (Task 1).
- Produces: `AllowedRule { by, kind, title, what, allowed_at: u64, risky: bool }`. `allowed_at` is Unix seconds, 0 for rules saved before Deck recorded it. `AllowedRule::new(by, action)` stamps the time and copies `action.risky`. `covers` still matches on `by`, `kind` and `what` only. Deserializing goes through a private `SavedRule`: a missing `allowed_at` is 0 and a missing `risky` is `kind == Tool`. JSON adds `"allowed_at": <u64>, "risky": <bool>`. TS `AllowedRule.allowed_at?: number`, `AllowedRule.risky?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `crates/apex-core/tests/wire_format.rs`, replace lines 126-130 with:
```rust
    let mut rule = apex_core::AllowedRule::new(&id, &apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: "npm test".into(), risky: false });
    rule.allowed_at = 1_791_100_800;
    assert_eq!(
        to_value(RoomEvent::AllowedChanged { allowed: vec![rule] }).unwrap(),
        json!({ "type": "allowed_changed", "allowed": [{ "by": "opus", "kind": "command", "title": "Run a command", "what": "npm test", "allowed_at": 1791100800, "risky": false }] })
    );
```
and add at the end of the file (Review Focus 1, Rust half):
```rust
#[test]
fn rules_saved_before_dates_and_risk_still_load_and_match() {
    let old: Vec<apex_core::AllowedRule> = serde_json::from_value(json!([
        { "by": "null", "kind": "tool", "title": "x-mcp: post_tweet", "what": "x-mcp: post_tweet" },
        { "by": "null", "kind": "command", "title": "Run a command", "what": "npm test" }
    ]))
    .unwrap();
    assert_eq!((old[0].allowed_at, old[0].risky), (0, true), "only risky tools ever reached a card");
    assert_eq!((old[1].allowed_at, old[1].risky), (0, false));
    let null = ParticipantId::new("null");
    let run = apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: "npm test".into(), risky: false };
    assert!(old[1].covers(&null, &run), "an old rule still answers");
    let desk = apex_core::ApprovalDesk::default();
    desk.set_allowed(old.clone());
    assert!(desk.forget(&old[1]), "Remove still works on an old rule");
    assert!(!desk.always_allowed(&null, &run));
}
```
In `crates/apex-core/src/approval.rs`, add to the `tests` module:
```rust
    #[test]
    fn a_rule_records_when_it_was_allowed_and_whether_it_was_risky() {
        let bot = ParticipantId::new("null");
        let tweet = ProposedAction { kind: ActionKind::Tool, title: "x-mcp: post_tweet".into(), detail: "{}".into(), risky: true };
        let before = now_seconds();
        let rule = AllowedRule::new(&bot, &tweet);
        assert!(rule.allowed_at >= before && rule.allowed_at <= now_seconds());
        assert!(rule.risky);
        let mut older = rule.clone();
        older.allowed_at = 0;
        older.risky = false;
        assert!(older.covers(&bot, &tweet), "the date and the risk are labels, not part of the match");
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: compile error `no field `allowed_at` on type `AllowedRule``.

- [ ] **Step 3: Implement the rule**

Replace `crates/apex-core/src/approval.rs:49-78` (from `/// Something the person chose "Always allow" for.` to the end of `impl AllowedRule`) with:
```rust
/// Something the person chose "Always allow" for. Saved with the thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "SavedRule")]
pub struct AllowedRule {
    /// The bot it applies to.
    pub by: ParticipantId,
    pub kind: ActionKind,
    /// The card's title when it was allowed, for the list in thread details.
    pub title: String,
    /// What it covers: the same tool (its title, without the arguments), the
    /// same command, edits to the same file, or the same permission question,
    /// which for Computer Use names the app. Allowing one app or command
    /// doesn't allow another.
    pub what: String,
    /// When it was allowed, in Unix seconds. 0 for rules saved before Deck
    /// recorded it.
    pub allowed_at: u64,
    /// The card it came from could spend money or publish.
    pub risky: bool,
}

/// A rule as it is read from a saved thread. Rules saved before this
/// version have no `allowed_at` or `risky`.
#[derive(Deserialize)]
struct SavedRule {
    by: ParticipantId,
    kind: ActionKind,
    title: String,
    what: String,
    #[serde(default)]
    allowed_at: u64,
    risky: Option<bool>,
}

impl From<SavedRule> for AllowedRule {
    fn from(saved: SavedRule) -> Self {
        // Before `risky` was saved, the only MCP tools that reached a card
        // were ones that can spend money or publish, so a saved tool rule
        // was always one of them.
        let risky = saved.risky.unwrap_or(saved.kind == ActionKind::Tool);
        Self { by: saved.by, kind: saved.kind, title: saved.title, what: saved.what, allowed_at: saved.allowed_at, risky }
    }
}

/// What a rule made from `action` covers. See `AllowedRule::what`.
fn scope(action: &ProposedAction) -> &str {
    match action.kind {
        ActionKind::Tool | ActionKind::Edit => &action.title,
        ActionKind::Command | ActionKind::Other => &action.detail,
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl AllowedRule {
    pub fn new(by: &ParticipantId, action: &ProposedAction) -> Self {
        Self {
            by: by.clone(),
            kind: action.kind,
            title: action.title.clone(),
            what: scope(action).to_string(),
            allowed_at: now_seconds(),
            risky: action.risky,
        }
    }

    /// Whether this rule covers `action` from `by`. The title, the date and
    /// the risk are only labels.
    pub fn covers(&self, by: &ParticipantId, action: &ProposedAction) -> bool {
        &self.by == by && self.kind == action.kind && self.what == scope(action)
    }
}
```
Then fix the stale comment on `Decision::ApproveAlways` (`approval.rs:84-86` in `main`, now a little lower: the three `///` lines starting "Approve, and don't ask again about the same thing in this thread" above `ApproveAlways`). It says "until the app quits", but rules are saved with the thread:
```rust
    /// Approve, and don't ask again about the same thing in this thread. The
    /// rule is saved with the thread and lasts until the person removes it
    /// in thread details. Codex is told to remember it only for its own
    /// session, which ends with the turn, so the saved list is the only
    /// lasting record.
    ApproveAlways,
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p apex-core --test wire_format -- --test-threads=1`
Expected: `test result: ok. 11 passed`.

Run: `cargo test --workspace -- --test-threads=1`
Expected: every `test result: ok.` (`always_allowed_list_is_saved_and_survives_reopening` in `src-tauri/src/lib.rs` still passes unchanged).

- [ ] **Step 5: Mirror it in TypeScript**

In `src/types.ts`, replace lines 87-96:
```ts
/** Something a bot may do without asking, because the person chose "Always allow". */
export interface AllowedRule {
  /** The bot it applies to. */
  by: string;
  kind: ProposedAction["kind"];
  /** The card's title when it was allowed. */
  title: string;
  /** What it covers: a tool's title, a command, a file's edit title, or a permission question. */
  what: string;
  /** When it was allowed, in Unix seconds. 0 or missing for rules saved before Deck recorded it. */
  allowed_at?: number;
  /** The card it came from could spend money or publish. */
  risky?: boolean;
}
```
Run: `npm run build`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add crates/apex-core src/types.ts
git commit -m "feat: Always allow rules remember when they were given and whether they were risky"
```

---

### Task 4: Codex keeps no lasting approvals, and command rules ignore the reason

**Files:**
- Modify: `crates/apex-core/src/room.rs:133-137` and the test at `:788-789`
- Modify: `crates/apex-adapters/src/codex_server.rs:88-98` (command proposal), `:119-126` (`mcp_response`), tests at `:588-595` and `:658-659`
- Test: `crates/apex-adapters/src/codex_server.rs`, `crates/apex-core/src/room.rs`

**Interfaces:**
- Consumes: `AllowedRule::new`, `AllowedRule::covers` (Task 3).
- Produces: `RoomApprover::decide` answers a silent rule match with `Decision::Approve`; `mcp_response(id, Decision::ApproveAlways)` sends `"_meta": {"persist": "session"}`; a Codex command proposal is `ProposedAction { kind: Command, title: "Run a command" | "Run a command · <reason on one line>", detail: <command only>, risky: false }`.

- [ ] **Step 1: Write the failing tests**

In `crates/apex-adapters/src/codex_server.rs`, replace the test `always_allow_sends_codexs_persist_choice_and_nothing_else_does` (lines 587-595) with:
```rust
    #[test]
    fn always_allow_asks_codex_to_remember_only_for_its_session() {
        let always = mcp_response(&json!(9), Decision::ApproveAlways);
        assert_eq!(always, json!({"id":9,"result":{"action":"accept","content":{},"_meta":{"persist":"session"}}}));
        assert!(!always.to_string().contains("\"always\""), "nothing Codex keeps after the turn");
        let once = mcp_response(&json!(9), Decision::Approve);
        assert_eq!(once, json!({"id":9,"result":{"action":"accept","content":{}}}));
        let deny = mcp_response(&json!(9), Decision::Reject);
        assert_eq!(deny, json!({"id":9,"result":{"action":"decline","content":null}}));
    }
```
In the test `approval_requests_become_proposals_and_other_requests_do_not`, change lines 658-659 to:
```rust
        let command = proposal("item/commandExecution/requestApproval", &json!({ "itemId": "i0", "command": "cargo test", "reason": "needs network" }), &reader).unwrap();
        assert_eq!((command.kind, command.title.as_str(), command.detail.as_str()), (ActionKind::Command, "Run a command · needs network", "cargo test"));
```
and add this test (Review Focus 2):
```rust
    #[test]
    fn a_codex_command_rule_covers_that_command_whatever_the_reason_and_nothing_longer() {
        let reader = EventReader::new(OutputFormat::CodexServer, None);
        let ask = |command: &str, reason: &str| {
            proposal("item/commandExecution/requestApproval", &json!({ "command": command, "reason": reason }), &reader).unwrap()
        };
        let null = apex_core::ParticipantId::new("null");
        let rule = apex_core::AllowedRule::new(&null, &ask("cargo test", "needs network"));
        assert!(rule.covers(&null, &ask("cargo test", "wants to write to target/")), "a different reason is the same command");
        assert!(rule.covers(&null, &ask("cargo test", "")), "no reason at all");
        assert!(!rule.covers(&null, &ask("cargo test\n\nrm -rf ~", "needs network")), "a longer command asks again");
        assert!(!rule.covers(&null, &ask("cargo test --release", "needs network")));
        assert_eq!(ask("ls", "line one\n  line two").title, "Run a command · line one line two");
    }
```
In `crates/apex-core/src/room.rs`, in `always_allow_skips_the_card_next_time`, change lines 788-789 to:
```rust
        let second = approver.decide(action()).now_or_never();
        assert_eq!(second, Some(Decision::Approve), "answered without waiting, as a plain yes so no tool is told to remember it");
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p apex-adapters --lib codex_server -- --test-threads=1`
Expected: FAIL in `always_allow_asks_codex_to_remember_only_for_its_session` (`"always"` where `"session"` was expected), `approval_requests_become_proposals_and_other_requests_do_not` (title is `"Run a command"`), and `a_codex_command_rule_covers_…` (the rule doesn't cover the same command with another reason).

Run: `cargo test -p apex-core --lib approver_tests -- --test-threads=1`
Expected: FAIL in `always_allow_skips_the_card_next_time` (`Some(ApproveAlways)` where `Some(Approve)` was expected).

- [ ] **Step 3: Implement**

`crates/apex-core/src/room.rs:133-137` becomes:
```rust
        if self.desk.always_allowed(self.id, &action) {
            eprintln!("[apex-deck] answered without a card (always allowed): {}", action.title);
            (self.on_event)(RoomEvent::Activity { id: self.id.clone(), text: format!("Always allowed: {}", action.title) });
            // A plain yes: the thread's saved rule answered, so no tool is
            // told to remember anything, and removing the rule takes it back.
            return Decision::Approve;
        }
```
`crates/apex-adapters/src/codex_server.rs:91-98` (the `item/commandExecution/requestApproval` arm) becomes:
```rust
        "item/commandExecution/requestApproval" => {
            let command = params["command"].as_str().unwrap_or("(command not given)");
            // The reason goes in the title. An Always allow rule matches a
            // command's detail, so it then covers this command whatever
            // Codex says about it, and never a different command.
            let title = match reason {
                Some(reason) => format!("Run a command · {}", reason.split_whitespace().collect::<Vec<_>>().join(" ")),
                None => "Run a command".to_string(),
            };
            Some(ProposedAction { kind: ActionKind::Command, title, detail: command.to_string(), risky: false })
        }
```
`crates/apex-adapters/src/codex_server.rs:119-126` becomes:
```rust
/// MCP approval is an elicitation, not a command approval. "Always allow"
/// tells Codex to remember the choice for its session only. Each turn is a
/// fresh session, so the thread's saved list stays the one lasting record
/// and Remove in thread details really takes it back.
fn mcp_response(id: &Value, decision: Decision) -> Value {
    let mut result = json!({"action": if decision.approved() {"accept"} else {"decline"},
        "content": if decision.approved() {json!({})} else {Value::Null}});
    if decision == Decision::ApproveAlways { result["_meta"] = json!({"persist": "session"}); }
    json!({"id":id,"result":result})
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p apex-adapters --lib codex_server -- --test-threads=1` and `cargo test -p apex-core --lib -- --test-threads=1`
Expected: `test result: ok.` for both.

Run: `cargo test --workspace -- --test-threads=1`
Expected: every `test result: ok.` (`codex_app_server_asks_before_a_command_when_access_is_ask_first` still expects title "Run a command" and detail "(command not given)": that request has no reason).

- [ ] **Step 5: Commit**

```bash
git add crates
git commit -m "fix: Codex keeps no lasting approvals and command rules ignore the reason text"
```

---

### Task 5: The approval card says what Always allow covers

**Files:**
- Modify: `src/approvalChoices.ts` (append)
- Modify: `src/Approvals.tsx:1-4`, `:27-62`
- Modify: `src/ChatPane.tsx:1512-1520`
- Modify: `src/backend.ts:256-263` (preview proposals)
- Modify: `src/styles.css:1484-1488` (after `.approval-note`)
- Test: `tests/approval-choices.test.mjs`

**Interfaces:**
- Consumes: `ProposedAction.risky?` (Task 1).
- Produces (in `src/approvalChoices.ts`): `export const RISKY_NOTE = " · can spend money or publish"`; `export function kindLabel(action: ProposedAction): string`; `export function scopeLine(name: string, action: ProposedAction): string`. `ApprovalCard` props become `{ action: ProposedAction; name: string; onDecide: (approve: boolean, always: boolean) => void }`.

- [ ] **Step 1: Write the failing tests**

In `tests/approval-choices.test.mjs`, change the import to
```js
import { APPROVAL_CHOICES, decisionFor, kindLabel, scopeLine } from "../src/approvalChoices.ts";
```
and add:
```js
const tweet = { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", risky: true };

test("a risky card says it can spend money or publish", () => {
  assert.equal(kindLabel(tweet), "Wants to call an MCP tool · can spend money or publish");
  assert.equal(kindLabel({ kind: "command", title: "Run a command", detail: "ls" }), "Wants to run a command");
  assert.equal(kindLabel({ kind: "edit", title: "Edit a.ts", detail: "", risky: false }), "Wants to change a file");
  assert.equal(kindLabel({ kind: "other", title: "node_repl asks permission", detail: "x", risky: true }), "Wants permission · can spend money or publish");
});

// Review Focus 5
test("scope lines say what the rule really matches for every kind of card", () => {
  assert.equal(scopeLine("Null", tweet), "Always allow lets Null call x-mcp: post_tweet in this thread with any arguments, without asking.");
  assert.equal(scopeLine("Jigga", { kind: "command", title: "Run a command · needs network", detail: "npm test" }), "Always allow lets Jigga run this exact command in this thread without asking.");
  assert.equal(scopeLine("Jigga", { kind: "edit", title: "Edit src/auth/session.ts", detail: "" }), "Always allow lets Jigga edit src/auth/session.ts in this thread without asking.");
  assert.equal(scopeLine("Jigga", { kind: "edit", title: "Write notes.txt", detail: "" }), "Always allow lets Jigga write notes.txt in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "edit", title: "Edit 3 files", detail: "" }), "Always allow lets Null make any 3-file edit in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "edit", title: "Edit files", detail: "" }), "Always allow lets Null make edits it doesn't describe in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "other", title: "node_repl asks permission", detail: "Allow Computer Use to use \"Apex Deck\"?" }), "Always allow lets Null have this exact permission in this thread without asking.");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --experimental-strip-types --test tests/approval-choices.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../src/approvalChoices.ts' does not provide an export named 'kindLabel'`.

- [ ] **Step 3: Write the copy**

Add to the top of `src/approvalChoices.ts`:
```ts
import type { ProposedAction } from "./types";
```
and append:
```ts
/** Said after the kind of action when it can cost money or go public. */
export const RISKY_NOTE = " · can spend money or publish";

/** The card's small label: what kind of thing the bot wants, and whether it is risky. */
export function kindLabel(action: ProposedAction): string {
  const kind = action.kind === "edit" ? "Wants to change a file" : action.kind === "command" ? "Wants to run a command" : action.kind === "tool" ? "Wants to call an MCP tool" : "Wants permission";
  return action.risky ? kind + RISKY_NOTE : kind;
}

/**
 * What Always allow would let `name` do from now on in this thread, in the
 * terms the saved rule really matches (`AllowedRule::new` in apex-core): a
 * tool by its name with any arguments, a command or permission question by
 * its exact text, an edit by its title.
 */
export function scopeLine(name: string, action: ProposedAction): string {
  const lets = `Always allow lets ${name}`;
  const here = "in this thread without asking.";
  switch (action.kind) {
    case "tool":
      return `${lets} call ${action.title} in this thread with any arguments, without asking.`;
    case "command":
      return `${lets} run this exact command ${here}`;
    case "other":
      return `${lets} have this exact permission ${here}`;
  }
  if (action.title === "Edit files") return `${lets} make edits it doesn't describe ${here}`;
  const several = /^Edit (\d+) files$/.exec(action.title);
  if (several) return `${lets} make any ${several[1]}-file edit ${here}`;
  const one = /^(Edit|Write) (.+)$/.exec(action.title);
  if (one) return `${lets} ${one[1].toLowerCase()} ${one[2]} ${here}`;
  return `${lets} make any edit titled “${action.title}” ${here}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/approval-choices.test.mjs`
Expected: `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Show it on the card**

In `src/Approvals.tsx`, change lines 1-4 to:
```tsx
import { useId, useState } from "react";

import { ANSWER_LABEL, APPROVAL_CHOICES, decisionFor, kindLabel, scopeLine, type Answer } from "./approvalChoices";
import type { FileChange, ProposedAction } from "./types";
```
and replace lines 27-62 (`interface CardProps` through the end of `ApprovalCard`) with:
```tsx
interface CardProps {
  action: ProposedAction;
  /** The bot's name, for the line that says what Always allow covers. */
  name: string;
  /** Called once with the person's answer. `always` stops the same thing being asked again. */
  onDecide: (approve: boolean, always: boolean) => void;
}

/**
 * Something a bot wants to do, with the whole of it on show and a yes or
 * no to give. The bot's turn waits until one is chosen. A risky card always
 * says what Always allow would cover; others say it while Always allow is
 * hovered or focused.
 */
export function ApprovalCard({ action, name, onDecide }: CardProps) {
  const [answered, setAnswered] = useState<Answer | null>(null);
  /** Always allow is hovered or focused, so its scope line shows. */
  const [previewing, setPreviewing] = useState(false);
  const scopeId = useId();
  const decide = (answer: Answer) => {
    if (answered !== null) return;
    setAnswered(answer);
    const { approve, always } = decisionFor(answer);
    onDecide(approve, always);
  };
  const preview = (on: boolean) => () => setPreviewing(on);
  return (
    <div className="approval" role="group" aria-label={`Allow or deny: ${action.title}`}>
      <div className="approval-head">
        <span className="approval-kind">{kindLabel(action)}</span>
        <strong>{action.title}</strong>
      </div>
      {action.kind === "edit" ? <Diff text={action.detail} /> : <pre className="approval-detail">{action.detail}</pre>}
      <div className="approval-actions">
        {APPROVAL_CHOICES.map((answer) => {
          const always = answer === "always";
          return (
            <button
              key={answer}
              className={answer === "once" ? "primary" : answer === "deny" ? "danger" : "ghost"}
              onClick={() => decide(answer)}
              disabled={answered !== null}
              aria-describedby={always ? scopeId : undefined}
              onMouseEnter={always ? preview(true) : undefined}
              onMouseLeave={always ? preview(false) : undefined}
              onFocus={always ? preview(true) : undefined}
              onBlur={always ? preview(false) : undefined}
            >
              {answered === answer ? ANSWER_LABEL[answer].done : ANSWER_LABEL[answer].ask}
            </button>
          );
        })}
        {!action.risky && <span className="approval-note">Nothing happens until you choose.</span>}
      </div>
      <p id={scopeId} className="approval-scope" hidden={!action.risky && !previewing}>{scopeLine(name, action)}</p>
    </div>
  );
}
```
(`aria-describedby` reads a `hidden` element's text, so screen readers get the scope line on every card.)

In `src/ChatPane.tsx`, in the drafts loop (lines 1512-1520), give the card its bot's name:
```tsx
                {(asks[id] ?? []).map((ask) => (
                  <ApprovalCard
                    key={ask.request}
                    action={ask.action}
                    name={names.get(id) ?? id}
                    onDecide={(approve, always) => {
                      backend.roomDecide(pane.id, ask.request, approve, always).catch((error) => notify(`Could not send your answer: ${String(error)}`, "error"));
                    }}
                  />
                ))}
```

In `src/styles.css`, after the `.approval-note { … }` rule (lines 1484-1488) add:
```css
/* What Always allow covers: always on risky cards, on hover or focus otherwise. */
.approval-scope {
  margin: 0;
  padding: 0 12px 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 17px;
}
```

- [ ] **Step 6: Preview proposes a risky tool**

In `src/backend.ts`, in the preview's `proposals` list (lines 256-263), add a risky tool call after the `npm run build` command:
```ts
              { action: { kind: "command", title: "Run a command", detail: "npm run build" } },
              { action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{\n  \"text\": \"apex-deck v0.3.1 is out\"\n}", risky: true } },
```

- [ ] **Step 7: Build and run everything**

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, two more passes than Task 0.

- [ ] **Step 8: Check it in the browser preview**

Run `npm run dev` and open `http://localhost:1420` (stand-in backend). Open a thread, **+ Add model** → Claude Code, Access **Ask first**, Add to chat; send `hello`. The preview proposes four cards one after another:
- Edit README.md: label "Wants to change a file", note "Nothing happens until you choose." and no scope line. Hover **Always allow**: the line "Always allow lets <Name> edit README.md in this thread without asking." appears under the buttons and goes when the pointer leaves. Tab to Always allow: the same line shows while it has focus. Answer **Allow once**.
- `npm run build`: hover Always allow shows "Always allow lets <Name> run this exact command in this thread without asking."
- x-mcp: post_tweet: amber label "Wants to call an MCP tool · can spend money or publish"; the line "Always allow lets <Name> call x-mcp: post_tweet in this thread with any arguments, without asking." shows without hovering; there is no "Nothing happens until you choose."
- node_repl: hover shows "… have this exact permission …".

Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/approvalChoices.ts src/Approvals.tsx src/ChatPane.tsx src/backend.ts src/styles.css tests/approval-choices.test.mjs
git commit -m "feat: approval cards say what Always allow covers"
```

---

### Task 6: Always allowed rows show the date and risk, and Remove says the bot asks again

**Files:**
- Modify: `src/allowedRules.ts:1-9` and append
- Modify: `src/ChatPane.tsx:24` (import), `:327` (state), `:1340-1351` (list)
- Modify: `src/backend.ts:44-46` (stale doc on `roomDecide`)
- Modify: `src/styles.css:1876-1881` (append after the allowed rules)
- Test: `tests/allowed-rules.test.mjs`

**Interfaces:**
- Consumes: `RISKY_NOTE` from `src/approvalChoices.ts` (Task 5); `AllowedRule.allowed_at?`, `AllowedRule.risky?` (Task 3).
- Produces (in `src/allowedRules.ts`): `ruleFor(by: string, action: ProposedAction, nowSeconds = Math.floor(Date.now() / 1000)): AllowedRule` now sets `allowed_at` and `risky`; `export const REMOVED_NOTE_MS = 8000`; `export function allowedLine(rule: AllowedRule, now: Date): string`; `export function removedLine(name: string): string`.

- [ ] **Step 1: Write the failing tests**

In `tests/allowed-rules.test.mjs`, change the import to
```js
import { allowedLine, describeRule, removedLine, ruleFor, sameRule } from "../src/allowedRules.ts";
```
and add:
```js
const oct4 = new Date(2026, 9, 4, 12, 0, 0);
const at = (date) => Math.floor(date.getTime() / 1000);

test("a new rule records when it was allowed and whether it was risky", () => {
  const rule = ruleFor("null", { ...order(1), risky: true }, at(oct4));
  assert.equal(rule.allowed_at, at(oct4));
  assert.equal(rule.risky, true);
  assert.equal(ruleFor("null", order(1)).risky, false);
  assert.ok(sameRule(rule, ruleFor("null", order(5), 0)), "the date and the risk are labels, not part of the match");
});

test("rows say when a rule was allowed, with the year only when it isn't this year", () => {
  const rule = ruleFor("null", { kind: "command", title: "Run a command", detail: "npm test" }, at(new Date(2026, 9, 3, 9)));
  assert.equal(allowedLine(rule, oct4), "Allowed Oct 3");
  assert.equal(allowedLine({ ...rule, allowed_at: at(new Date(2025, 11, 31, 9)) }, oct4), "Allowed Dec 31, 2025");
  assert.equal(allowedLine({ ...rule, risky: true }, oct4), "Allowed Oct 3 · can spend money or publish");
});

// Review Focus 1
test("rules saved before dates were kept read Allowed earlier", () => {
  const old = { by: "null", kind: "tool", title: "x-mcp: post_tweet", what: "x-mcp: post_tweet" };
  assert.equal(allowedLine(old, oct4), "Allowed earlier");
  // What the desktop app sends for that rule: Rust reads it as allowed_at 0, risky true.
  assert.equal(allowedLine({ ...old, allowed_at: 0, risky: true }, oct4), "Allowed earlier · can spend money or publish");
});

test("after Remove the list says the bot asks again", () => {
  assert.equal(removedLine("Null"), "Removed. Null asks again next time.");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --experimental-strip-types --test tests/allowed-rules.test.mjs`
Expected: FAIL with `does not provide an export named 'allowedLine'`.

- [ ] **Step 3: Implement**

Replace `src/allowedRules.ts:1-9` with:
```ts
import { RISKY_NOTE } from "./approvalChoices.ts";
import type { AllowedRule, ProposedAction } from "./types";

/** How long "Removed. Null asks again next time." stays after Remove. */
export const REMOVED_NOTE_MS = 8000;

/** The rule an "Always allow" makes. Mirrors `AllowedRule::new` in apex-core:
 *  a tool or an edit is matched by its title, a command or permission question
 *  by its detail, so allowing one app or command doesn't allow another. */
export function ruleFor(by: string, action: ProposedAction, nowSeconds = Math.floor(Date.now() / 1000)): AllowedRule {
  const what = action.kind === "tool" || action.kind === "edit" ? action.title : action.detail;
  return { by, kind: action.kind, title: action.title, what, allowed_at: nowSeconds, risky: action.risky === true };
}
```
and append:
```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The row's second line: "Allowed Oct 4", with the year when it isn't this
 *  year, plus " · can spend money or publish" for a risky rule. Rules saved
 *  before dates were kept read "Allowed earlier". */
export function allowedLine(rule: AllowedRule, now: Date): string {
  let when = "Allowed earlier";
  if (rule.allowed_at) {
    const at = new Date(rule.allowed_at * 1000);
    when = `Allowed ${MONTHS[at.getMonth()]} ${at.getDate()}${at.getFullYear() === now.getFullYear() ? "" : `, ${at.getFullYear()}`}`;
  }
  return rule.risky ? when + RISKY_NOTE : when;
}

/** Said under the list after Remove. */
export function removedLine(name: string): string {
  return `Removed. ${name} asks again next time.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/allowed-rules.test.mjs`
Expected: `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Show it in thread details**

In `src/ChatPane.tsx`, change line 24 to:
```tsx
import { REMOVED_NOTE_MS, allowedLine, describeRule, removedLine } from "./allowedRules";
```
After line 327 (`const [allowed, setAllowed] = useState<AllowedRule[]>([]);`) add:
```tsx
  /** "Removed. Null asks again next time.", shown for a moment after Remove. */
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  useEffect(() => {
    if (!removedNote) return;
    const timer = setTimeout(() => setRemovedNote(null), REMOVED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [removedNote]);
```
Replace the `allowedList` (lines 1340-1351, from `const allowedList = allowed.length === 0` to the closing `</ul>;`) with:
```tsx
  /** Take an Always allow back. The bot asks again next time. */
  const forgetRule = (rule: AllowedRule) => backend.roomForgetAllowed(pane.id, rule)
    .then(() => setRemovedNote(removedLine(names.get(rule.by) ?? rule.by)))
    .catch((error) => notify(`Could not remove it: ${String(error)}`, "error"));
  const allowedList = <>
    {allowed.length === 0
      ? <p className="muted allowed-empty">Nothing yet. Choose Always allow on an approval card and it shows here, so you can take it back.</p>
      : <ul className="allowed-list" aria-label="Always allowed">
        {allowed.map((rule) => <li key={`${rule.by}\u001f${rule.kind}\u001f${rule.what}`}>
          <span className="allowed-copy">
            <strong style={{ color: color(rule.by) }}>{names.get(rule.by) ?? rule.by}</strong>
            <span className={`allowed-what${rule.kind === "command" || rule.kind === "tool" ? " mono" : ""}`} title={rule.what}>{describeRule(rule)}</span>
            <span className="allowed-when">{allowedLine(rule, new Date())}</span>
          </span>
          <button className="ghost small" aria-label={`Stop always allowing ${describeRule(rule)} for ${names.get(rule.by) ?? rule.by}`} onClick={() => void forgetRule(rule)}>Remove</button>
        </li>)}
      </ul>}
    {removedNote && <p className="allowed-removed" role="status"><span aria-hidden="true">✓</span>{removedNote}</p>}
  </>;
```
In `src/backend.ts`, replace lines 44-46 (the two doc lines above `roomDecide`; the second says "until the app quits", which is no longer true):
```ts
  /** Answer an action a bot proposed, named by the `request` from its event.
   *  `always` saves a rule with the thread, so the same thing isn't asked again
   *  until it is removed in thread details. */
  roomDecide(id: string, request: string, approve: boolean, always?: boolean): Promise<void>;
```
In `src/styles.css`, after `.allowed-copy strong { font-weight: 650; }` (line 1881) add:
```css
.allowed-copy > .allowed-what { color: var(--text); }
.allowed-copy > .allowed-what.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.allowed-copy > .allowed-when { font-size: 11px; }
.allowed-removed { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; padding: 7px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: 12px; }
.allowed-removed > span { color: var(--text); }
```
(The preview's `roomForgetAllowed` and Always allow paths already use `ruleFor` and `sameRule`, so new preview rules get a date and risk with no other change.)

- [ ] **Step 6: Build and run everything**

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, six more passes than Task 0.

- [ ] **Step 7: Check it in the browser preview**

`npm run dev`, `http://localhost:1420`. In a thread with an "Ask first" Claude Code bot, send `hello` and choose **Always allow** on the x-mcp: post_tweet card. Open thread details → **Always allowed**. You should see a row with the bot's name in its colour, `x-mcp: post_tweet` in mono in the text colour, and under it "Allowed <today's date, e.g. Oct 4> · can spend money or publish". Rules saved by the preview before this change read "Allowed earlier". Press **Remove**: the row goes and "✓ Removed. <Name> asks again next time." shows under the list for about 8 seconds. Send `hello` again: the post_tweet card asks again. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/allowedRules.ts src/ChatPane.tsx src/backend.ts src/styles.css tests/allowed-rules.test.mjs
git commit -m "feat: Always allowed rows show when and how risky, and Remove says the bot asks again"
```

---

### Task 7: Battery colours without red

**Files:**
- Modify: `src/battery.ts:10-13`, `:27-35`, `:106`, `:110-111`
- Modify: `src/Avatar.tsx:31-46`
- Modify: `src/styles.css:634-649`, `:657-660`
- Modify: `src/backend.ts:302` (preview "drain")
- Test: `tests/battery.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BatteryCell` without `red` (`{ ...IdenticonCell, side, fill, alpha }`); `shellState(levels)` unchanged (`"ok" | "low" | "critical"`); class `identicon-low` on a `<b>` inside a critical battery.

- [ ] **Step 1: Write the failing tests**

In `tests/battery.test.mjs`, add at the top:
```js
import { readFileSync } from 'node:fs';
```
change line 58 to:
```js
  assert.ok(cells.every((c) => c.fill === 1 && c.alpha === 1));
```
replace the test `'a side at or under 20% is red, and at or under 8% the shell pulses'` (lines 70-81) with:
```js
test('a low side keeps the agent colour: at or under 20% the shell reads low, at or under 8% critical', () => {
  assert.ok(isLow(0.2) && isLow(0.1) && !isLow(0.21) && !isLow(null));
  assert.ok(isCritical(0.08) && !isCritical(0.09) && !isCritical(null));
  const low = batteryCells(solid, { context: 0.18, plan: 0.9 });
  assert.ok(low.every((cell) => !('red' in cell)), 'no cell is drawn in another colour');
  assert.equal(at(low, 4, 0).alpha, 1, 'charge on the low side draws at full strength');
  assert.equal(shellState({ context: 0.18, plan: 0.9 }), 'low');
  assert.equal(shellState({ context: 0.9, plan: 0.05 }), 'critical');
  assert.equal(shellState({ context: 0.5, plan: 0.5 }), 'ok');
});
```
and add:
```js
test('battery styles never borrow the danger colour or pulse', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rules = css.split('}').filter((rule) => rule.includes('.identicon'));
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.ok(!rule.includes('--danger'), rule.trim());
  assert.ok(!css.includes('battery-critical'), 'no pulsing keyframes');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --experimental-strip-types --test tests/battery.test.mjs`
Expected: FAIL in "a low side keeps the agent colour…" (`no cell is drawn in another colour`) and "battery styles never borrow the danger colour or pulse" (the `.identicon.battery.low, .identicon.battery.critical` rule uses `--danger`).

- [ ] **Step 3: Implement**

`src/battery.ts:10-13` becomes:
```ts
/** At or under this much left, a side reads low: the shell gets a hairline outline. */
export const LOW = 0.2;
/** At or under this much left, the outline thickens and the avatar says "low". */
export const CRITICAL = 0.08;
```
`src/battery.ts:27-35` becomes:
```ts
export interface BatteryCell extends IdenticonCell {
  side: Side;
  /** How much of this cell's row is below the level, 0 to 1. */
  fill: number;
  /** How strongly the cell is drawn, 0 to 1. Always in the agent's colour. */
  alpha: number;
}
```
`src/battery.ts:106` becomes:
```ts
    return { ...cell, side, fill, alpha };
```
`src/battery.ts:110` (the doc above `shellState`) becomes:
```ts
/** What the shell shows: a hairline outline when either side is low, a
 *  thicker outline and the word "low" when critical. Low is not a failure,
 *  so it never uses the danger colour. */
```
In `src/Avatar.tsx`, replace lines 31-46 with:
```tsx
  const battery = batteryCells(cells, levels);
  const shell = shellState(levels);
  return (
    <span className={`identicon battery identicon-${size}${working ? " working" : ""}${shell === "ok" ? "" : ` ${shell}`}`} style={{ "--who": color } as CSSProperties} aria-hidden="true">
      {battery.map((cell, i) => {
        const refill = cell.on && refilling.some((side) => side === cell.side || cell.side === "both");
        const style: Record<string, string> = { "--a": `${Math.round(cell.alpha * 100)}%` };
        if (refill) style.animationDelay = `${refillDelay(Math.floor(i / 5))}ms`;
        else if (cell.on && working) style.animationDelay = `${cell.wave * 80}ms`;
        const classes = [cell.on ? "on" : "", refill ? "refill" : ""].filter(Boolean).join(" ");
        // A new key restarts the refill each time it plays.
        return <i key={refill ? `r${i}-${refills?.context}-${refills?.plan}` : i} className={classes || undefined} style={style as CSSProperties} />;
      })}
      {/* The word, so critical never relies on the outline alone. */}
      {shell === "critical" && <b className="identicon-low">low</b>}
    </span>
  );
```
In `src/styles.css`, replace lines 634-649 (from `/* The battery (battery.ts): each cell is drawn at its own strength, in the` through the closing `}` of `@keyframes battery-critical`) with:
```css
/* The battery (battery.ts): each cell is drawn at its own strength, always
   in the agent's colour. Low is not a failure, so it never borrows the
   danger colour: a low side gets a hairline outline, and a critical one a
   thicker outline and the word "low". */
.identicon.battery {
  position: relative;
}
.identicon.battery i {
  background: color-mix(in srgb, var(--who) var(--a), transparent);
}
.identicon.battery.low {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 70%, transparent);
}
.identicon.battery.critical {
  box-shadow: 0 0 0 2px var(--text);
}
.identicon-low {
  position: absolute;
  left: 50%;
  bottom: -7px;
  transform: translateX(-50%);
  padding: 0 3px;
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
  font-size: 9px;
  font-weight: 650;
  line-height: 12px;
}
/* A chip's 21px avatar is too small for the word; the chip says "low" beside it. */
.identicon-sm .identicon-low {
  display: none;
}
```
and replace the reduced-motion block (lines 657-660 before this edit) with:
```css
@media (prefers-reduced-motion: reduce) {
  .identicon.battery i.refill { animation: none; }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/battery.test.mjs`
Expected: `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 5: Let the preview reach critical**

The preview's Claude Code agents start at 18% context (low). To see critical, a message with "drain" in it leaves a bot at 5%. In `src/backend.ts`, replace line 302 (`reportContext(id, p, 2_400);`) with:
```ts
          // Preview only: a message with "drain" in it leaves this bot at 5%
          // context, so the critical battery can be seen.
          const asked = room.transcript.filter((m) => m.speaker.kind === "human").at(-1)?.text ?? "";
          const size = WINDOWS[p.backend.tool];
          if (size && /\bdrain\b/i.test(asked)) contextUsed.set(`${id}:${p.id}`, Math.round(size * 0.95) - 2_400);
          reportContext(id, p, 2_400);
```

- [ ] **Step 6: Build and run everything**

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, seven more passes than Task 0.

- [ ] **Step 7: Check it in the browser preview**

`npm run dev`, `http://localhost:1420`. Add a Claude Code bot to a thread (it starts at 18% context). Its avatars in the chip, in the transcript and in thread details show cells in the bot's own colour (no red cells) and a thin light outline around the avatar; the chip reads "ctx 18% low". Send `drain`. After the reply: transcript and sidebar avatars get a thicker outline and a small "low" under them; the chip avatar gets the thicker outline but no word (its text reads "ctx 5% low"); nothing pulses. In devtools run `[...document.querySelectorAll('.identicon i')].some((i) => getComputedStyle(i).backgroundColor.includes('248, 113, 113'))`: expected `false`. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/battery.ts src/Avatar.tsx src/styles.css src/backend.ts tests/battery.test.mjs
git commit -m "fix: low batteries keep the agent's colour and stop borrowing the Failed red"
```

---

### Task 8: Token totals saved on the room snapshot

**Files:**
- Modify: `crates/apex-core/src/types.rs` (append after `PlanUsage`, line 171)
- Modify: `crates/apex-core/src/lib.rs:28-31`
- Modify: `crates/apex-core/src/room.rs:14`, `:197-238`, `:241-311`, `:446-449`, `:559-566`
- Modify: `src-tauri/src/lib.rs:268-282` and its tests module (`:854`)
- Modify: `src/types.ts:73-85` and append
- Test: `crates/apex-core/tests/room.rs`, `crates/apex-core/tests/wire_format.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `apex_core::TokenTotals { input: u64, output: u64, turns: u64 }` with `add(&mut self, input: Option<u64>, output: Option<u64>)`; `RoomSnapshot.usage: HashMap<ParticipantId, TokenTotals>` (`#[serde(default, skip_serializing_if = "HashMap::is_empty")]`); `Room::usage(&self) -> &HashMap<ParticipantId, TokenTotals>`. `/clear` keeps totals; `RoomSnapshot::fork` starts with none. `persist_event` saves `RoomEvent::Usage` as it arrives. TS `TokenTotals { input; output; turns }` and `RoomSnapshot.usage?: Record<string, TokenTotals>`.

- [ ] **Step 1: Write the failing tests**

In `crates/apex-core/tests/room.rs`, add `TokenTotals` to the `use apex_core::{…}` list (lines 5-9) and add after `activity_and_token_use_are_reported_alongside_the_reply`:
```rust
#[test]
fn token_totals_add_up_per_bot_survive_a_restart_and_clear_but_not_a_fork() {
    let id = ParticipantId::new("worker");
    let config = ParticipantConfig {
        id: id.clone(),
        display_name: "worker".into(),
        backend: Backend::Scripted { lines: vec![] },
        persona: String::new(),
        access: Access::Read,
        effort: None,
        appearance: None,
    };
    let quiet = bot("quiet", &["hello", "again"]);
    let roster: Vec<Arc<dyn Participant>> = vec![Arc::new(WorkingBot(config.clone())), quiet.clone()];
    let mut room = Room::new(roster, RoomOptions { policy: TurnPolicy::RoundRobin, max_bot_hops: 0 });
    say(&mut room, "go");
    say(&mut room, "again");
    assert_eq!(room.usage().get(&id), Some(&TokenTotals { input: 240, output: 14, turns: 2 }));
    assert!(room.usage().get(&ParticipantId::new("quiet")).is_none(), "a bot that reports nothing has no totals");

    let snapshot = room.snapshot();
    let saved = serde_json::to_value(&snapshot).unwrap();
    let reopened = Room::restore(vec![Arc::new(WorkingBot(config))], serde_json::from_value(saved).unwrap());
    assert_eq!(reopened.usage(), room.usage(), "totals survive a restart");

    room.clear();
    assert_eq!(room.usage().get(&id).map(|t| t.turns), Some(2), "/clear keeps what the thread has spent");
    assert!(snapshot.fork(1).usage.is_empty(), "a fork starts at zero");
}
```
In `crates/apex-core/tests/wire_format.rs`, add `assert!(snapshot.usage.is_empty());` as the last line of `old_snapshots_without_pins_still_load`, and add:
```rust
#[test]
fn token_totals_are_saved_per_bot() {
    let mut snapshot: apex_core::RoomSnapshot = serde_json::from_value(
        json!({ "participants": [], "transcript": [], "options": { "policy": "mention", "max_bot_hops": 3 } }),
    )
    .unwrap();
    assert!(to_value(&snapshot).unwrap().get("usage").is_none(), "nothing written until a bot reports");
    let mut totals = apex_core::TokenTotals::default();
    totals.add(Some(1840), None);
    snapshot.usage.insert(ParticipantId::new("opus"), totals);
    assert_eq!(to_value(&snapshot).unwrap()["usage"], json!({ "opus": { "input": 1840, "output": 0, "turns": 1 } }));
}
```
In `src-tauri/src/lib.rs`, add to the `tests` module:
```rust
    #[test]
    fn token_totals_are_saved_as_each_turn_reports_them() {
        let (handle, store, path) = checkpoint_fixture("usage");
        let null = ParticipantId::new("null");
        for (input, output) in [(Some(100), Some(5)), (Some(20), None)] {
            persist_event(&handle, &store, "room", &RoomEvent::Usage { id: null.clone(), input_tokens: input, output_tokens: output }).unwrap();
        }
        let saved = store.room("room").unwrap().unwrap().snapshot;
        assert_eq!(saved.usage.get(&null), Some(&apex_core::TokenTotals { input: 120, output: 5, turns: 2 }));
        std::fs::remove_dir_all(path).unwrap();
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p apex-core --test room -- --test-threads=1`
Expected: compile error `unresolved import `apex_core::TokenTotals``.

- [ ] **Step 3: Add `TokenTotals`**

Append to `crates/apex-core/src/types.rs` after `PlanUsage` (after line 171):
```rust
/// Tokens a participant has used in one thread, over the turns that
/// reported a count. Saved with the thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    /// Turns that reported a count.
    pub turns: u64,
}

impl TokenTotals {
    /// Count one turn. A side the backend didn't report adds nothing.
    pub fn add(&mut self, input: Option<u64>, output: Option<u64>) {
        self.input = self.input.saturating_add(input.unwrap_or(0));
        self.output = self.output.saturating_add(output.unwrap_or(0));
        self.turns += 1;
    }
}
```
In `crates/apex-core/src/lib.rs`, lines 28-31 become:
```rust
pub use types::{
    Access, AgentTool, Backend, ContextUse, Message, ModelChoice, ParticipantConfig, ParticipantId, PlanUsage,
    PlanWindow, Speaker, TokenTotals,
};
```

- [ ] **Step 4: Let the room add them up**

In `crates/apex-core/src/room.rs`:

Line 14 becomes:
```rust
use crate::types::{AgentTool, Message, ParticipantConfig, ParticipantId, PlanWindow, Speaker, TokenTotals};
```
In `RoomSnapshot`, after the `allowed` field (line 218) add:
```rust
    /// Tokens each participant has used in this thread. `/clear` keeps
    /// them; a fork starts without them.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub usage: HashMap<ParticipantId, TokenTotals>,
```
In `RoomSnapshot::fork`, after `allowed: Vec::new(),` (line 235) add:
```rust
            usage: HashMap::new(),
```
In `struct Room`, after `baseline: Option<String>,` (line 250) add:
```rust
    /// Tokens each participant has used in this thread.
    usage: HashMap<ParticipantId, TokenTotals>,
```
In `Room::snapshot`, after `allowed: self.desk.allowed(),` add `usage: self.usage.clone(),`. In `Room::restore`, after `baseline: snapshot.baseline,` add `usage: snapshot.usage,`. In `Room::new`, after `baseline: None,` add `usage: HashMap::new(),`. After `pub fn baseline(&self)` (lines 315-317) add:
```rust
    /// Tokens each participant has used in this thread.
    pub fn usage(&self) -> &HashMap<ParticipantId, TokenTotals> {
        &self.usage
    }
```
In `compact`, lines 447-449 become:
```rust
        if reply.input_tokens.is_some() || reply.output_tokens.is_some() {
            self.usage.entry(id.clone()).or_default().add(reply.input_tokens, reply.output_tokens);
            on_event(RoomEvent::Usage { id: id.clone(), input_tokens: reply.input_tokens, output_tokens: reply.output_tokens });
        }
```
In `settle`, lines 560-566 become:
```rust
                if reply.input_tokens.is_some() || reply.output_tokens.is_some() {
                    self.usage.entry(id.clone()).or_default().add(reply.input_tokens, reply.output_tokens);
                    on_event(RoomEvent::Usage {
                        id: id.clone(),
                        input_tokens: reply.input_tokens,
                        output_tokens: reply.output_tokens,
                    });
                }
```

- [ ] **Step 5: Save them as each turn reports them**

In `src-tauri/src/lib.rs`, `persist_event` (lines 268-282) becomes:
```rust
fn persist_event(handle: &RoomHandle, store: &Store, id: &str, event: &RoomEvent) -> Result<(), String> {
    if !matches!(event, RoomEvent::MessageAdded { .. } | RoomEvent::Changed { .. } | RoomEvent::AllowedChanged { .. } | RoomEvent::Usage { .. }) { return Ok(()); }
    let mut checkpoint = handle.checkpoint.lock().unwrap();
    if handle.deleted.load(Ordering::SeqCst) { return Ok(()); }
    match event {
        RoomEvent::MessageAdded { message } => checkpoint.snapshot.transcript.push(message.clone()),
        RoomEvent::Changed { id, change } => {
            let seq = checkpoint.snapshot.transcript.len();
            checkpoint.snapshot.changes.push(apex_core::ChangeRecord { by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq });
        }
        RoomEvent::AllowedChanged { allowed } => checkpoint.snapshot.allowed = allowed.clone(),
        // The room adds these up too; a full checkpoint replaces this copy
        // with the room's, so nothing is counted twice. Saving each one now
        // keeps the totals if the app quits before the chain ends.
        RoomEvent::Usage { id, input_tokens, output_tokens } => checkpoint.snapshot.usage.entry(id.clone()).or_default().add(*input_tokens, *output_tokens),
        _ => {}
    }
    store.save_room(id, &checkpoint)
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test -p apex-core --test room -- --test-threads=1` — expected: `test result: ok.`
Run: `cargo test -p apex-core --test wire_format -- --test-threads=1` — expected: `test result: ok. 12 passed`.
Run: `cargo test -p apex-deck --lib -- --test-threads=1` — expected: `test result: ok.`
Run: `cargo test --workspace -- --test-threads=1` — expected: every `test result: ok.`

- [ ] **Step 7: Mirror it in TypeScript**

In `src/types.ts`, add to `RoomSnapshot` after `allowed?: AllowedRule[];` (line 84):
```ts
  /** Tokens each bot has used in this thread. /clear keeps them; a fork starts without them. */
  usage?: Record<string, TokenTotals>;
```
and after the `AllowedRule` interface add:
```ts
/** Tokens a bot has used in one thread, over the turns that reported a count. */
export interface TokenTotals {
  input: number;
  output: number;
  turns: number;
}
```
Run: `npm run build` — expected: passes.

- [ ] **Step 8: Commit**

```bash
git add crates/apex-core src-tauri/src/lib.rs src/types.ts
git commit -m "feat: each bot's token totals are saved with the thread"
```

---

### Task 9: The usage card shows the saved totals "in this thread"

**Files:**
- Modify: `src/battery.ts:7-8` (import), append after `contextLine` (line 135)
- Modify: `src/ChatPane.tsx:19`, `:33-47`, `:274-284`, `:343-344`, `:614-620`, `:721-733`, `:1019`
- Modify: `src/backend.ts:8`, `:153`, `:160-166`, `:372`, `:488-490`
- Test: `tests/battery.test.mjs`

**Interfaces:**
- Consumes: `TokenTotals`, `RoomSnapshot.usage?` (Task 8).
- Produces: `tokenLine(use: TokenTotals | undefined): string` in `src/battery.ts`. Preview rooms keep `usage` like the native app (saved, kept by `/clear`, dropped by a fork).

- [ ] **Step 1: Write the failing test**

In `tests/battery.test.mjs`, add `tokenLine` to the import list from `'../src/battery.ts'` and add:
```js
test('token totals say they are for this thread', () => {
  assert.equal(tokenLine(undefined), 'No tokens used in this thread yet.');
  assert.equal(tokenLine({ input: 0, output: 0, turns: 0 }), 'No tokens used in this thread yet.');
  assert.match(tokenLine({ input: 1840, output: 26, turns: 1 }), /^1\D?840 in, 26 out over 1 turn in this thread\. Input includes the conversation/);
  assert.match(tokenLine({ input: 3680, output: 52, turns: 2 }), /over 2 turns in this thread\./);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --experimental-strip-types --test tests/battery.test.mjs`
Expected: FAIL with `does not provide an export named 'tokenLine'`.

- [ ] **Step 3: Implement**

`src/battery.ts:8` becomes:
```ts
import type { PlanWindow, TokenTotals } from "./types";
```
and after `contextLine` (after line 135) add:
```ts
/** The usage card's token sentence for one bot. The totals are saved with the thread. */
export function tokenLine(use: TokenTotals | undefined): string {
  if (!use || use.turns === 0) return "No tokens used in this thread yet.";
  const turns = use.turns === 1 ? "1 turn" : `${use.turns} turns`;
  return `${use.input.toLocaleString()} in, ${use.output.toLocaleString()} out over ${turns} in this thread. Input includes the conversation and files the tool re-read from its cache.`;
}
```

- [ ] **Step 4: Run the test**

Run: `node --experimental-strip-types --test tests/battery.test.mjs`
Expected: `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Use the saved totals in the thread**

In `src/ChatPane.tsx`:
- Line 19: add `tokenLine` to the battery import: `import { contextLevel, contextLine, isLow, percent, planLevel, planLine, tokenLine, type Levels } from "./battery";`
- Lines 33-47: add `TokenTotals,` to the `import type { … } from "./types";` list.
- Delete lines 274-284 (the `TokenUse` interface and `tokenDetail`).
- Lines 343-344 (`/** Tokens each participant has used in this chat since the app opened. */` and `const [used, setUsed] = useState<Record<string, TokenUse>>({});`) become:
```tsx
  /** Tokens each participant has used in this thread, saved with it. */
  const [used, setUsed] = useState<Record<string, TokenTotals>>({});
```
- In the `roomCreate(…).then((saved) => { … })` block, after `setAllowed(saved.allowed ?? []);` (line 620) add:
```tsx
        setUsed(saved.usage ?? {});
```
- In `clearChat` (lines 721-733) delete the line `setUsed({});` (`/clear` keeps what the thread has spent, as `Room::clear` does).
- Line 1019 in `usageCard` (`<p className="usage-note">{used[p.id] ? tokenDetail(used[p.id]) : "No tokens used in this chat yet."}</p>`) becomes:
```tsx
        <p className="usage-note">{tokenLine(used[p.id])}</p>
```
The `usage` event handler (lines 546-551) stays as it is: it already adds `input`, `output` and `turns`.

- [ ] **Step 6: Keep the totals in the preview**

In `src/backend.ts`:
- Line 8: add `TokenTotals` to the type import list.
- Line 153: add `usage?: Record<string, TokenTotals>;` to the preview room's type, after `allowed?: AllowedRule[];`.
- Lines 160-166 (`emitRoom`) become:
```ts
  const emitRoom = (id: string, event: RoomEvent) => {
    if (event.type === "message_added") {
      rooms.get(id)?.transcript.push(event.message);
      saveRoom(id);
    }
    // Like the desktop app, each bot's token totals are saved with the thread.
    if (event.type === "usage") {
      const room = rooms.get(id);
      if (room) {
        const before = room.usage?.[event.id] ?? { input: 0, output: 0, turns: 0 };
        room.usage = { ...room.usage, [event.id]: { input: before.input + (event.input_tokens ?? 0), output: before.output + (event.output_tokens ?? 0), turns: before.turns + 1 } };
        saveRoom(id);
      }
    }
    roomListeners.forEach((cb) => cb(id, event));
  };
```
- Line 372 (`roomCreate`'s return) becomes:
```ts
      return { participants: [...room.participants], options: { ...room.options }, transcript: [...room.transcript], compaction: room.compaction ?? null, pins: room.pins ?? [], allowed: room.allowed ?? [], usage: room.usage ?? {} };
```
- In `roomFork`, after `fork.stopped = false;` (line 489) add:
```ts
      // As in the desktop app, a fork starts without the source's Always allow rules and token totals.
      delete fork.allowed;
      delete fork.usage;
```

- [ ] **Step 7: Build and run everything**

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, eight more passes than Task 0.

- [ ] **Step 8: Check it in the browser preview**

`npm run dev`, `http://localhost:1420`. In a thread with a Claude Code bot, send `hello`. Hover the bot's chip: the usage card reads "1,840 in, 26 out over 1 turn in this thread. Input includes the conversation and files the tool re-read from its cache." Reload the page: the same line is still there. Send `/clear`: still there. `/fork` the thread and open the fork: "No tokens used in this thread yet." Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/battery.ts src/ChatPane.tsx src/backend.ts tests/battery.test.mjs
git commit -m "feat: usage cards show each bot's saved token totals for this thread"
```

---

### Task 10: Review patch, file names and reviewer rows

**Files:**
- Create: `src/review.ts`
- Test: `tests/review.test.mjs` (new)

**Interfaces:**
- Consumes: `DiffFile`, `ParticipantBackend`, `ParticipantConfig`, `AgentTool` from `src/types.ts`.
- Produces (all exported from `src/review.ts`):
  - `LARGE_REVIEW_LINES = 2000`
  - `filesLine(files: DiffFile[]): string` → `"6 files · +73 −16"` (`"1 file · …"` for one)
  - `reviewScope(files: DiffFile[]): string` → `"Since this thread started · 6 files · +73 −16"`
  - `reviewPatches(files: DiffFile[]): string[]` (one per file that has a patch, each ending in `\n`)
  - `reviewPatch(files: DiffFile[]): string | null` (all joined; `null` when no file has a patch)
  - `patchLines(text: string): number`
  - `offersSplit(lines: number): boolean` (`lines > LARGE_REVIEW_LINES`)
  - `sizeLine(lines: number): string` → `"3,412 lines in one file"`
  - `nextReviewNumber(texts: string[]): number`
  - `reviewFileNames(n: number, count: number): string[]`
  - `reviewDraft(handle: string, draft: string): string`
  - `toolName(backend: ParticipantBackend): string`
  - `canReadAttachments(backend: ParticipantBackend): boolean`
  - `interface Reviewer { id: string; name: string; label: string; note: string }`
  - `reviewerRows(participants: ParticipantConfig[]): Reviewer[]`

- [ ] **Step 1: Check which bots can read the attachments folder**

The spec asks for this check before the rows can say "Can't read attachments". Claude Code gets the folder with `--add-dir` and Gemini CLI with `--include-directories` (`crates/apex-adapters/src/presets.rs:74-76`, `:128-130`). Codex runs in its own sandbox; custom commands run with no sandbox as you (`crates/apex-adapters/src/cli.rs:83-117`, `start_with`). Check both:
```bash
probe="$HOME/Library/Application Support/dev.apexdeck.app/attachments/deck-read-check"
mkdir -p "$probe" && printf 'readable\n' > "$probe/probe.txt"
cd /Users/tylercaldwell/Downloads/apex-deck
codex sandbox -C "$PWD" -c 'sandbox_mode="read-only"' --log-denials -- cat "$probe/probe.txt"
sh -c 'cat "$1"' sh "$probe/probe.txt"
rm "$probe/probe.txt" && rmdir "$probe"
```
Expected: `readable` from both, and no denial listed for the probe path. (If `--log-denials` itself errors because `log stream` isn't allowed, run the `codex sandbox` line again without it.)
- If both print `readable`: write `canReadAttachments` in Step 4 as shown.
- If Codex prints `Operation not permitted` or lists a denial: in Step 4 write the function as `return (backend.kind === "agent" && backend.tool !== "codex") || backend.kind === "cli";`, change its doc comment to "Codex's read-only sandbox can't open the folder (checked with `codex sandbox`)", change Null's expected row in Step 2 to `["Null", "Codex", "Can't read attachments · Can edit files"]`, and tell Tyler in your report.

- [ ] **Step 2: Write the failing tests**

Create `tests/review.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  LARGE_REVIEW_LINES, filesLine, nextReviewNumber, offersSplit, patchLines, reviewDraft, reviewFileNames,
  reviewPatch, reviewPatches, reviewScope, reviewerRows, sizeLine,
} from "../src/review.ts";

const file = (path, patch, added = 1, removed = 0) => ({ path, added, removed, patch, by: [] });
const bot = (id, backend, access = "read") => ({ id, display_name: id[0].toUpperCase() + id.slice(1), backend, persona: "", access, effort: null });

test("the scope line counts what Changes lists", () => {
  const files = [file("a.ts", "x", 31, 5), file("b.ts", "y", 42, 11)];
  assert.equal(reviewScope(files), "Since this thread started · 2 files · +73 −16");
  assert.equal(filesLine([file("a.ts", "x")]), "1 file · +1 −0");
  assert.equal(filesLine([]), "0 files · +0 −0");
});

test("patches join into one file in the order Changes lists them, each ending its last line", () => {
  const files = [file("a.ts", "diff --git a/a.ts b/a.ts\n+a\n"), file("b.ts", "diff --git a/b.ts b/b.ts\n+b")];
  assert.equal(reviewPatch(files), "diff --git a/a.ts b/a.ts\n+a\ndiff --git a/b.ts b/b.ts\n+b\n");
  assert.deepEqual(reviewPatches(files), ["diff --git a/a.ts b/a.ts\n+a\n", "diff --git a/b.ts b/b.ts\n+b\n"]);
  assert.equal(patchLines("one\ntwo\n"), 2);
  assert.equal(patchLines("one\ntwo"), 2);
  assert.equal(patchLines(""), 0);
});

// Review Focus 3
test("changes with no patch text never make an empty patch file", () => {
  const reportedOnly = [file("a.ts", ""), file("b.ts", "  \n")];
  assert.equal(reviewPatch(reportedOnly), null);
  assert.deepEqual(reviewPatches(reportedOnly), []);
  assert.equal(reviewPatch([file("a.ts", ""), file("c.ts", "+c\n")]), "+c\n", "files without a patch are left out");
});

test("one file per patch is offered only over 2,000 lines", () => {
  assert.equal(LARGE_REVIEW_LINES, 2000);
  assert.equal(offersSplit(2000), false);
  assert.equal(offersSplit(2001), true);
  assert.equal(sizeLine(3412), "3,412 lines in one file");
});

test("review files are numbered after the highest number the thread already used", () => {
  assert.equal(nextReviewNumber([]), 1);
  assert.equal(nextReviewNumber(["@ada Review this change.\n\nAttached file: /x/review-since-start-2.patch", "review-since-start-1.patch"]), 3);
  assert.deepEqual(reviewFileNames(3, 1), ["review-since-start-3.patch"]);
  assert.deepEqual(reviewFileNames(3, 2), ["review-since-start-3-1.patch", "review-since-start-3-2.patch"]);
});

// Review Focus 4
test("picking a reviewer keeps a draft you already typed", () => {
  assert.equal(reviewDraft("ada", ""), "@ada Review this change.");
  assert.equal(reviewDraft("ada", "  "), "@ada Review this change.");
  assert.equal(reviewDraft("ada", "Focus on the token refresh."), "@ada Review this change.\n\nFocus on the token refresh.");
});

test("read-only bots come first, and each row says what the bot can do", () => {
  const rows = reviewerRows([
    bot("jigga", { kind: "agent", tool: "claude_code", model: "opus" }, "ask"),
    bot("ada", { kind: "agent", tool: "gemini", model: null }),
    bot("null", { kind: "agent", tool: "codex", model: null }, "full"),
    bot("opus", { kind: "open_ai_compatible", base_url: "http://localhost:11434/v1", model: "llama3", api_key_env: null }),
    bot("tool", { kind: "cli", program: "mytool", args: [] }),
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.label, r.note]), [
    ["Ada", "Gemini CLI · Read only", ""],
    ["Opus", "API · Read only", "Can't read attachments"],
    ["Tool", "Command · Read only", ""],
    ["Jigga", "Claude Code", "Can edit files"],
    ["Null", "Codex", "Can edit files"],
  ]);
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `node --experimental-strip-types --test tests/review.test.mjs`
Expected: FAIL with `Cannot find module '…/src/review.ts'`.

- [ ] **Step 4: Write the module**

Create `src/review.ts`:
```ts
// Ask for review: the thread's change as a patch file for one of its bots.
// These are plain functions so the menu, the file names and the composer
// stay in step and can be tested on their own.

import type { AgentTool, DiffFile, ParticipantBackend, ParticipantConfig } from "./types";

/** Over this many lines, one file per patch is offered instead of one big file. */
export const LARGE_REVIEW_LINES = 2000;

/** "6 files · +73 −16" for what Changes lists. */
export function filesLine(files: DiffFile[]): string {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${files.length === 1 ? "1 file" : `${files.length} files`} · +${added} −${removed}`;
}

/** The menu's first line: "Since this thread started · 6 files · +73 −16". */
export function reviewScope(files: DiffFile[]): string {
  return `Since this thread started · ${filesLine(files)}`;
}

/** The patches Changes shows, in its order, each ending in a newline. Files
 *  Changes lists without a patch (only the models' reported edit is known)
 *  are left out. */
export function reviewPatches(files: DiffFile[]): string[] {
  return files.filter((f) => f.patch.trim() !== "").map((f) => (f.patch.endsWith("\n") ? f.patch : `${f.patch}\n`));
}

/** Every patch joined into one file, or null when there is no patch to send. */
export function reviewPatch(files: DiffFile[]): string | null {
  const patches = reviewPatches(files);
  return patches.length > 0 ? patches.join("") : null;
}

/** How many lines a patch has. */
export function patchLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Whether a patch this long gets the "One file per patch" choice. */
export function offersSplit(lines: number): boolean {
  return lines > LARGE_REVIEW_LINES;
}

/** "3,412 lines in one file", shown when one file would be over the limit. */
export function sizeLine(lines: number): string {
  return `${lines.toLocaleString("en-US")} lines in one file`;
}

/** One more than the highest review number in `texts`: the thread's sent
 *  messages and the files already attached to the composer. */
export function nextReviewNumber(texts: string[]): number {
  let highest = 0;
  for (const text of texts) {
    for (const match of text.matchAll(/review-since-start-(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** "review-since-start-3.patch", or with one file per patch
 *  "review-since-start-3-1.patch", "review-since-start-3-2.patch", … */
export function reviewFileNames(n: number, count: number): string[] {
  if (count <= 1) return [`review-since-start-${n}.patch`];
  return Array.from({ length: count }, (_, i) => `review-since-start-${n}-${i + 1}.patch`);
}

/** The composer after picking a reviewer. The request leads, so its mention
 *  picks who answers; a draft you already typed stays below it. */
export function reviewDraft(handle: string, draft: string): string {
  const ask = `@${handle} Review this change.`;
  return draft.trim() ? `${ask}\n\n${draft}` : ask;
}

const TOOL_NAMES: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

/** The tool a bot runs on, as the menu names it. */
export function toolName(backend: ParticipantBackend): string {
  if (backend.kind === "agent") return TOOL_NAMES[backend.tool];
  if (backend.kind === "open_ai_compatible") return "API";
  if (backend.kind === "cli") return "Command";
  return "Scripted";
}

/**
 * Whether a bot can open a file in Deck's attachments folder. Claude Code and
 * Gemini CLI are given the folder (`--add-dir`, `--include-directories`);
 * Codex's sandbox reads files anywhere, even at read only (checked with
 * `codex sandbox`); a custom command runs as you with no sandbox. API models
 * only see the conversation's text, and scripted bots read nothing.
 */
export function canReadAttachments(backend: ParticipantBackend): boolean {
  return backend.kind === "agent" || backend.kind === "cli";
}

/** One row of the Ask for review menu. */
export interface Reviewer {
  id: string;
  name: string;
  /** "Gemini CLI · Read only", or just "Claude Code" for a bot that can edit. */
  label: string;
  /** Muted words at the row's end, e.g. "Can edit files". Empty when there is nothing to say. */
  note: string;
}

/** The thread's bots for the Ask for review menu: read-only bots first, then the rest, each in room order. */
export function reviewerRows(participants: ParticipantConfig[]): Reviewer[] {
  const rows = participants.map((p) => {
    const canEdit = p.access !== "read";
    const tool = toolName(p.backend);
    const note = [canReadAttachments(p.backend) ? "" : "Can't read attachments", canEdit ? "Can edit files" : ""].filter(Boolean).join(" · ");
    return { canEdit, row: { id: p.id, name: p.display_name, label: canEdit ? tool : `${tool} · Read only`, note } };
  });
  return [...rows.filter((r) => !r.canEdit), ...rows.filter((r) => r.canEdit)].map((r) => r.row);
}
```

- [ ] **Step 5: Run the tests**

Run: `node --experimental-strip-types --test tests/review.test.mjs`
Expected: `ℹ pass 7`, `ℹ fail 0`.

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, fifteen more passes than Task 0.

- [ ] **Step 6: Commit**

```bash
git add src/review.ts tests/review.test.mjs
git commit -m "feat: review patches, file names and reviewer rows for Ask for review"
```

---

### Task 11: Ask for review in the Changes head

**Files:**
- Modify: `src/ThreadDetails.tsx:4-13`
- Modify: `src/App.tsx:125-126`
- Modify: `src/DiffPanel.tsx` (whole file, 54 lines)
- Modify: `src/ChatPane.tsx:26` (imports), after `:830` (new `askForReview`), `:1354` (DiffPanel props)
- Modify: `src/backend.ts:439-451` (preview "big diff")
- Modify: `src/styles.css` (append after the rules Task 6 added)

**Interfaces:**
- Consumes: everything `src/review.ts` exports (Task 10); `track(name, preview, save)` in `ChatPane` (`src/ChatPane.tsx:812`); `backend.saveAttachment(room, name, bytes)`.
- Produces: `DetailsHost.overlay: boolean`; `DiffPanel` props add `appearanceOf: (id: string) => { seed: string; color: string }`, `reviewers: Reviewer[]`, `onReview: (id: string, split: boolean) => void`; `ChatPane`'s `askForReview(id: string, split: boolean): void` (attaches and fills the composer, never sends).

- [ ] **Step 1: Tell the thread whether its details sidebar overlays it**

In `src/ThreadDetails.tsx`, add to `DetailsHost` after `open: boolean;` (line 6):
```ts
  /** True when the sidebar covers the conversation (narrow windows). */
  overlay: boolean;
```
In `src/App.tsx`, line 125 becomes:
```tsx
  const detailsHostBase = { slot: detailsSlot, open: detailsOpen && section === "threads", overlay: overlayDetails, collapsed: detailsCollapsed,
```

- [ ] **Step 2: Add the menu to the Changes head**

Replace all of `src/DiffPanel.tsx` with:
```tsx
import { useEffect, useRef, useState } from "react";
import { Diff } from "./Approvals";
import { Avatar } from "./Avatar";
import { groupDiff } from "./diffGroups";
import { filesLine, offersSplit, patchLines, reviewPatch, reviewScope, sizeLine, type Reviewer } from "./review";
import type { ThreadDiff } from "./types";

interface Props {
  diff: ThreadDiff | null;
  loading: boolean;
  order: string[];
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  /** Each bot's saved look, for its avatar in Ask for review. */
  appearanceOf: (id: string) => { seed: string; color: string };
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  /** The thread's bots for Ask for review, read-only ones first (`reviewerRows`). */
  reviewers: Reviewer[];
  /** Attach the change for bot `id` to review: one file, or one file per patch. It never sends. */
  onReview: (id: string, split: boolean) => void;
}

/** Everything that changed in the folder since this thread started, under
 *  the agent that changed it, and a way to hand it to a reviewer. */
export function DiffPanel({ diff, loading, order, nameOf, colorOf, appearanceOf, onReveal, onRefresh, onClose, reviewers, onReview }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [split, setSplit] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  const askMenu = useRef<HTMLDivElement>(null);
  const files = diff?.files ?? [];
  const patch = reviewPatch(files);
  const lines = patch ? patchLines(patch) : 0;
  const large = offersSplit(lines);
  useEffect(() => {
    if (!asking) return;
    askMenu.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".review-menu, .review-ask")) setAsking(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close only this menu, not the overlaid sidebar behind it.
      event.stopPropagation();
      setAsking(false);
      askButton.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [asking]);
  const pick = (id: string) => {
    setAsking(false);
    onReview(id, large && split);
  };
  return (
    <aside className="changes" aria-label="Changes since this thread started">
      <header className="changes-head">
        <strong>Since this thread started</strong>
        <span className="muted">{loading ? "Reading…" : filesLine(files)}</span>
        <button className="ghost small" onClick={onRefresh} disabled={loading}>Refresh</button>
        <button
          ref={askButton}
          className="ghost small review-ask"
          aria-haspopup="dialog"
          aria-expanded={asking}
          disabled={loading || files.length === 0 || reviewers.length === 0}
          title={reviewers.length === 0 ? "Add a bot to ask for a review" : undefined}
          onClick={() => setAsking((now) => !now)}
        >
          Ask for review <span aria-hidden="true">▾</span>
        </button>
        {onClose && <button className="icon small" aria-label="Close changes" onClick={onClose}>×</button>}
      </header>
      {asking && (
        <div ref={askMenu} className="review-menu" role="dialog" aria-label="Ask for review">
          <p className="review-line">{reviewScope(files)}</p>
          {!patch && <p className="review-line">There's no patch to send: this thread only knows the edits the models reported.</p>}
          {large && <p className="review-line">{sizeLine(lines)}</p>}
          {large && <label className="review-split"><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> One file per patch</label>}
          <span className="pane-menu-sep" role="separator" />
          {reviewers.map((r) => {
            const look = appearanceOf(r.id);
            return (
              <button key={r.id} className="review-bot" disabled={!patch} onClick={() => pick(r.id)}>
                <Avatar seed={look.seed} color={look.color} size="sm" />
                <span className="review-bot-name"><strong>{r.name}</strong> · {r.label}</span>
                {r.note && <span className="review-bot-note">{r.note}</span>}
              </button>
            );
          })}
        </div>
      )}
      {diff?.note && <p className="changes-note">{diff.note}</p>}
      {!loading && files.length === 0 && <p className="muted changes-empty">Nothing has changed yet.</p>}
      {groupDiff(files, order).map((group) => (
        <section key={group.by ?? "none"} className="diff-group">
          <h4 style={group.by ? { color: colorOf(group.by) } : undefined}>{group.by ? nameOf(group.by) : "Not reported by a model"}</h4>
          {group.files.map((file) => {
            const key = `${group.by}:${file.path}`;
            return (
              <div key={key} className="diff-file">
                <button className="diff-file-row" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                  <span className="path">{file.path}</span>
                  <span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
                </button>
                <button className="ghost small" onClick={() => onReveal(file.path)}>Show in folder</button>
                {open === key && (file.patch ? <Diff text={file.patch} /> : <p className="diff-none">Only the reported edit is available for this file.</p>)}
              </div>
            );
          })}
        </section>
      ))}
    </aside>
  );
}
```
(The menu sits in the sidebar's flow under the head, so the 320px sidebar never clips it. The Changes head also stops saying "1 files".)

- [ ] **Step 3: Attach the patch and fill the composer**

In `src/ChatPane.tsx`, after line 26 (`import { DiffPanel } from "./DiffPanel";`) add:
```tsx
import { nextReviewNumber, reviewDraft, reviewFileNames, reviewPatch, reviewPatches, reviewerRows } from "./review";
```
After `attachFiles` (it ends at line 830) add:
```tsx
  /** Ask for review: attach the thread's change as a patch for `id` and fill
   *  the composer with the request. It never sends. */
  const askForReview = (id: string, split: boolean) => {
    const files = diff?.files ?? [];
    const whole = reviewPatch(files);
    const parts = split ? reviewPatches(files) : whole ? [whole] : [];
    if (parts.length === 0) return;
    const taken = [...messagesOf(entries).filter((m) => m.speaker.kind === "human").map((m) => m.text), ...attached.map((a) => a.name)];
    const fileNames = reviewFileNames(nextReviewNumber(taken), parts.length);
    parts.forEach((text, i) => track(fileNames[i], undefined, () => backend.saveAttachment(pane.id, fileNames[i], new TextEncoder().encode(text))));
    setText((draft) => reviewDraft(id, draft));
    // In a narrow window the sidebar covers the composer; get it out of the way.
    if (details?.overlay) details.close();
    input.current?.focus();
  };
```
In the `ThreadDetails` portal (line 1354), replace the `changes={<DiffPanel … />}` prop with:
```tsx
changes={<DiffPanel diff={diff} loading={diffLoading} order={participants.map(p => p.id)} onRefresh={loadDiff} nameOf={id => names.get(id) ?? id} colorOf={color} appearanceOf={appearance} onReveal={path => openTarget(path, true)} reviewers={reviewerRows(participants)} onReview={askForReview} />}
```
When the message is sent, `withAttachments` (`src/attachments.ts:28`) adds the standard "Attached file: <path>" line for each patch.

- [ ] **Step 4: Style the menu**

Append to `src/styles.css` after the allowed rules from Task 6:
```css
/* Ask for review (DiffPanel): opens under the Changes head, in the sidebar's flow so it is never clipped. */
.review-menu { display: flex; flex-direction: column; margin: 8px 0 4px; padding: 4px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45); }
.review-line { margin: 0; padding: 6px 10px 5px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.review-split { display: flex; align-items: center; gap: 8px; padding: 4px 10px 6px; font-size: 12px; }
.review-bot { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 10px; background: transparent; border-color: transparent; font-size: 12px; text-align: left; }
.review-bot:hover:not(:disabled), .review-bot:focus-visible { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.review-bot-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.review-bot-name strong { font-weight: 650; }
.review-bot-note { flex: none; color: var(--muted); font-size: 11px; }
```

- [ ] **Step 5: Let the preview show a large change**

In `src/backend.ts`, replace the preview `roomDiff` (lines 439-451) with:
```ts
    roomDiff: async (id) => {
      const room = rooms.get(id);
      const [first, second] = room?.participants ?? [];
      const patch = "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-const title = \"Deck\";\n+const title = \"Apex Deck\";\n export default App;\n";
      const files = [
        { path: "src/App.tsx", added: 1, removed: 1, patch, by: first ? [first.id] : [] },
        { path: "README.md", added: 3, removed: 0, patch: "+## Commands\n+\n+/pin, /diff, /fork, /export\n", by: [first, second].filter(Boolean).map((p) => p.id) },
        { path: "package-lock.json", added: 12, removed: 4, patch: "", by: [] },
      ];
      // Preview only: after a message with "big diff" in it, a 2,400-line
      // file joins the list, so Ask for review's "One file per patch" can be seen.
      if (room?.transcript.some((m) => m.speaker.kind === "human" && /big diff/i.test(m.text))) {
        files.push({ path: "dist/bundle.js", added: 2400, removed: 0, by: [],
          patch: "--- a/dist/bundle.js\n+++ b/dist/bundle.js\n@@ -0,0 +1,2400 @@\n" + Array.from({ length: 2400 }, (_, i) => `+line ${i + 1}\n`).join("") });
      }
      return { note: "Preview: these changes are made up. The desktop app reads them from git.", files };
    },
```

- [ ] **Step 6: Build and run everything**

Run: `npm run build` — expected: passes.
Run: `npm test` — expected: `ℹ fail 0`, fifteen more passes than Task 0.

- [ ] **Step 7: Check it in the browser preview**

`npm run dev`, `http://localhost:1420`, window 1440×900. In a thread, add a Claude Code bot with Read only, a Codex bot with Can edit files, and an Ollama bot (quick add → Ollama). Send `hello`, then `/diff`.
- The Changes head shows "Since this thread started", "3 files · +16 −5", **Refresh** and **Ask for review ▾**.
- **Ask for review ▾** opens a panel under the head: "Since this thread started · 3 files · +16 −5", a separator, then the Claude Code bot "… · Claude Code · Read only", the Ollama bot "… · API · Read only" with "Can't read attachments" at its end, then the Codex bot "… · Codex" with "Can edit files". Focus lands on the first row. Escape closes the panel (the sidebar stays) and focus returns to the button; a click outside closes it too.
- Pick the Claude Code bot: the panel closes, the composer reads "@<handle> Review this change.", an attachment chip "review-since-start-1.patch" appears, and nothing new is posted in the transcript.
- Type "Focus on the title." on a new line, open the menu again and pick the Codex bot: the composer reads "@<codex handle> Review this change." then a blank line then the earlier text, and a second chip "review-since-start-2.patch" appears. Remove both chips and clear the composer.
- Send `big diff`, then **Refresh** in Changes. The menu now also shows "2,412 lines in one file" and an unticked "One file per patch". Tick it and pick a bot: three chips, `review-since-start-<n>-1.patch` to `-3.patch`.
- Set the window to about 820×1400: thread details overlays the thread. Pick a bot from Ask for review: the overlay closes and the composer has focus with the request in it.

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/ThreadDetails.tsx src/App.tsx src/DiffPanel.tsx src/ChatPane.tsx src/backend.ts src/styles.css
git commit -m "feat: Ask for review attaches the thread's change as a patch for a bot"
```

---

### Task 12: Docs, every check, and the preview walkthrough

**Files:**
- Modify: `README.md:61-66`, `:76-77`, `:104-111`, `:113-115`, `:240-241`, `:273-279`
- Modify: `SPEC.md:50-51`, `:54`, `:61`, `:69-77`

**Interfaces:**
- Consumes: everything above.
- Produces: docs that match the behaviour.

- [ ] **Step 1: Update README.md**

Replace the "Approvals." bullet (lines 61-66) with:
```markdown
- **Approvals.** Set a Claude Code or Codex participant to "Ask first" and
  it stops before every file edit and every command. The chat shows what it
  wants to do, with the change drawn as added and removed lines, and **Allow
  once**, **Always allow** and **Deny**. Nothing happens until you choose, the
  pane is flagged as waiting on you, and the time you take does not count
  against the reply's time limit. Stop rejects whatever is waiting.
- **Always allow.** It saves a rule with the thread, so that bot may do the
  same thing again in this thread without a card: a tool with any arguments,
  that exact command, edits with the same title (one file, or any edit of the
  same number of files), or the same permission question. The card says what
  the rule would cover before you choose: always on cards that can spend money
  or publish, and while Always allow is hovered or focused on the others.
  Thread details lists each rule with the date it was allowed; **Remove** takes
  it back at once and the bot asks again next time. Codex is only told to
  remember a choice for its own session, which ends with the turn, so the
  thread's list is the only lasting record.
```
Replace the "Changes." bullet (lines 76-77) with:
```markdown
- **Changes.** `/diff` opens Changes in thread details, comparing the workspace
  against the thread's starting snapshot and grouping files by reported editor.
  **Ask for review ▾** in its head attaches the whole change as one patch file
  (`review-since-start-<n>.patch`) and fills the composer with "@name Review
  this change." for the bot you pick; it never sends. Over 2,000 lines it
  offers one file per patch. Bots that can't open the attachments folder (API
  models and scripted bots) say "Can't read attachments".
```
In the "Avatar batteries." bullet (lines 104-111), replace
```markdown
  half the provider account's plan remaining. Usage cards show reset times,
  other plan windows and session token totals, with a Compact now button.
```
with
```markdown
  half the provider account's plan remaining. A low side gets a thin outline;
  a critical one a thicker outline and the word "low". The cells keep the
  agent's colour, because red means something failed. Usage cards show reset
  times, other plan windows and the bot's token totals for this thread, with
  a Compact now button.
```
In "Live activity and token counts." (lines 113-115), replace `token counts for the chat.` with `token counts for the thread, saved with it.`

Replace lines 240-241:
```markdown
bubble is replaced by the final reply, and the bot's chip shows the tokens
it has used in this chat; hover for the split between input and output.
```
with
```markdown
bubble is replaced by the final reply. Hover the bot's chip for the tokens it
has used in this thread, split into input and output. The totals are saved
with the thread; `/clear` keeps them and a fork starts at zero.
```
In the MCP paragraph (lines 273-279), replace
```markdown
require Approve or Reject every time, even at Full access. The card shows the
server, tool name, and complete JSON arguments; approval is for that call only.
```
with
```markdown
ask every time, even at Full access, unless you chose Always allow for that
tool in this thread. Their cards say "can spend money or publish" and show the
server, tool name, and complete JSON arguments; Allow once is for that call only.
```

- [ ] **Step 2: Update SPEC.md**

After the "Ask first" row (line 50) add:
```markdown
| Always allow: a rule saved with the thread; the card says what it covers, thread details shows when it was given, Remove takes it back | done (a later match is a plain yes; Codex is told to remember it for its session only) |
```
After the Changes row (line 51) add:
```markdown
| Ask for review: attach the thread's change as a patch for a bot, with a request in the composer | done (never sends; one file per patch over 2,000 lines) |
```
Replace line 54 with:
```markdown
| Per-participant token meter | done for Claude Code, Codex and API models (totals for each thread, saved with it; /clear keeps them, a fork starts at zero) |
```
At the end of line 61's state cell, before the final `|`, add `; low readings get an outline and the word "low", never the Failed red`.

Append to the "How asking works." paragraph (after line 77):
```markdown
Always allow saves an `AllowedRule` (with the date and whether the card was
risky) on the room snapshot. A later match is answered as a plain yes, and
Codex is sent `persist: "session"` at most, so removing the rule in thread
details takes it back. A Codex command rule matches the command alone, not
the reason Codex gives for it.
```

- [ ] **Step 3: Run every check**

Run: `npm test`
Expected: `ℹ fail 0`, `ℹ pass` = the Task 0 count + 15 (128 if the baseline was 113).

Run: `npm run build`
Expected: passes.

Run: `cargo test --workspace -- --test-threads=1`
Expected: every `test result: ok.`, 10 more tests than Task 0 in total, and no warnings.

Run: `git diff --check $(git merge-base HEAD main)`
Expected: no output.

- [ ] **Step 4: Walk through every change in the preview**

`npm run dev`, `http://localhost:1420`. Do this once at 1440×900 and again at about 820×1400 (thread details overlays at that size). Set up a thread with a Claude Code bot on Ask first, a Codex bot on Can edit files and an Ollama bot.
1. Send `hello`. The edit card shows "Nothing happens until you choose."; hovering or tabbing to **Always allow** shows its scope line under the buttons. The `npm run build` card says "… run this exact command …". The x-mcp: post_tweet card reads "Wants to call an MCP tool · can spend money or publish" and shows its scope line without hovering.
2. Choose **Always allow** on post_tweet. Thread details → Always allowed: "Allowed <today> · can spend money or publish". **Remove** → "✓ Removed. <Name> asks again next time.", gone after about 8 s. The next `hello` asks again.
3. Batteries: the Claude Code bot (18% context) has an outline and no red cells; after sending `drain`, a thicker outline and "low" under transcript and sidebar avatars; nothing pulses.
4. Chip usage card: "… in this thread." Reload: same totals. `/clear`: same totals.
5. `/diff` → **Ask for review ▾**: the scope line and the rows as in Task 11 Step 7, including "Can't read attachments" on the Ollama bot. Pick one: the composer is filled, a chip is attached, nothing is sent. At 820×1400 the overlay closes first.
6. Must keep working: Allow once and Deny still answer cards; Stop still rejects a waiting card; the thread's attention flag still shows while a card waits; `/pin`, `/compact`, `/fork`, `/export` still work; dragging a terminal pane doesn't restart it.

Write down anything that didn't match. Report as untested anything only the desktop app can show: Codex receiving `persist: "session"`, a real Codex request marked `riskLevel: "high"`, a real Codex or custom command opening a review patch, and the totals surviving a desktop restart (`npm run tauri dev`).

- [ ] **Step 5: Commit**

```bash
git add README.md SPEC.md
git commit -m "docs: Always allow scope, battery outlines, saved token totals and Ask for review"
```
