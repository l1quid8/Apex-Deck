# Thread Commands (/pin, /diff, /fork, /export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four slash commands to group chats: `/pin` keeps a fact in every model's context, `/diff` shows what changed in the folder since the thread started and which agent changed it, `/fork` copies a thread into a new one, and `/export` saves a thread as Markdown or JSON.

**Architecture:** One pure TypeScript parser decides whether composer text is a command. Pins, file-change records, fork truncation and the diff starting point are part of the saved room snapshot in `apex-core`. Git snapshots, file writes and new Tauri commands live in `src-tauri`. React only parses input, calls the backend and presents results. The browser preview (`src/backend.ts`) fakes each new call so every feature can be seen without the desktop app.

**Tech Stack:** Rust (apex-core, src-tauri, Tauri 2), React + TypeScript, `node --test` for TS tests, the `git` CLI for `/diff`. No new dependencies.

**Spec:** Group-chat decisions from 2026-10-03, recorded below. There is no separate spec file.
- The Human chose `/fork` and `/export`, then added `/pin` and `/diff`. Commands that only duplicate a button were rejected.
- `/pin <fact>`: the fact goes to every model on every turn for the rest of the thread. It survives `/compact` and `/clear`.
- `/diff`: every file changed in the workspace since the thread started, grouped by agent.
- `/fork [name]`: copies participants, settings, pins, the saved summary and messages into a new thread. A fork icon on each message branches from that point. Both threads share one folder, and the app says so. `/fork --worktree` is out of scope for this plan.
- `/export` writes Markdown; `/export json` writes the raw thread for a later re-import. Local notes and the compaction divider are left out of Markdown.
- Commands never reach the models. An unknown `/word` warns instead of being sent. `//` at the start sends a literal slash.

## Global Constraints

- Work on a new branch `feat/thread-commands` off `feat/identicon-battery` (`ae42506`). Don't push or merge.
- Layering: room state in `crates/apex-core`, processes/files/git in `src-tauri`, presentation in `src/`. Adapters are untouched.
- Old saved threads must still load: every new `RoomSnapshot` field is `#[serde(default)]` and optional in `src/types.ts`.
- `/diff` must never change the person's git index, branches, stash, HEAD or working files. It writes only unreferenced objects through a private index file.
- `/diff` runs `git` with the login PATH (`agents::login_path()`), like the agents. Never a hard-coded path.
- No made-up data: when git can't produce a diff, say why and list only what the models reported.
- Copy rules: no colored left bars, neutral styling like the quote strip; sentence-case labels; don't put "AI" in UI text.
- All of `cargo test --workspace`, `npm test`, `npx tsc --noEmit` and `npm run build` pass at the end of every task.
- Keep the production app running. Verify in the browser preview (`http://localhost:1431/`) and then in a dev build; report which was which.

## Review Focus

1. **Text that only looks like a command.** `/Users/me/file.txt is broken` or a pasted path must go to the models as a normal message. The parser only treats `/word` followed by whitespace or end of text as a command (Task 1 test `paths and slashes inside words are plain text`).
2. **`//compact` typed on purpose.** It must reach the models as `/compact` and never run compaction, including when it waits in the queue (Task 1 test `a doubled slash escapes`, plus `postable` test).
3. **`/diff` on a folder that isn't a git repo, or a thread from before this update.** Show the models' reported edits with a plain note, not an error (Task 6 tests `no repository lists reported edits with a note` and `missing baseline object falls back with a note`).
4. **`/diff` and `/fork` while models are working.** Both read the saved copy of the thread, not the live room, so they answer immediately instead of waiting for the turn (Task 6 and Task 8 use `store.room(...)`; Task 8 test `fork reads the saved copy`).
5. **Forking from an earlier message after `/compact`.** A summary that covers messages past the fork point must not carry over, or the fork's models would "remember" messages it doesn't have (Task 8 test `a summary past the fork point is dropped`).

---

## File map

| File | Change |
|---|---|
| `src/commands.ts` (new) | Parse composer text into a command or a message. |
| `src/exportThread.ts` (new) | Build Markdown/JSON exports and file names. |
| `src/diffGroups.ts` (new) | Group a thread diff by agent for the panel. |
| `src/DiffPanel.tsx` (new) | Replaces `ChangesPanel` in chats. |
| `src/ChatPane.tsx` | Use the parser; pins strip; `/diff`, `/fork`, `/export`; fork icon on messages. |
| `src/App.tsx` | Open a forked thread as a new pane in the same workspace. |
| `src/backend.ts` | New calls, Tauri and preview versions. |
| `src/types.ts` | `pins`, `changes`, `baseline` on `RoomSnapshot`; `ThreadDiff`. |
| `src/styles.css` | Pins strip, diff panel, fork icon. |
| `crates/apex-core/src/room.rs` | Pins, change records, baseline field, `RoomSnapshot::fork`. |
| `crates/apex-core/src/view.rs` | `pinned_section`. |
| `crates/apex-core/src/lib.rs` | Re-export `ChangeRecord`. |
| `src-tauri/src/changes.rs` (new) | Git snapshot, patch splitting, thread diff. |
| `src-tauri/src/export.rs` (new) | Safe file name and unique path in Downloads. |
| `src-tauri/src/lib.rs` | `room_pin`, `room_unpin`, `room_diff`, `room_fork`, `export_thread`; baseline capture; record changes in checkpoints. |
| `tests/*.test.mjs`, `crates/apex-core/tests/{room,wire_format}.rs` | Tests below. |
| `README.md` | Document the commands. |

---

### Task 1: Command parser

**Files:**
- Create: `src/commands.ts`, `tests/commands.test.mjs`
- Modify: `src/ChatPane.tsx:620-650` (dispatch and `send`), `src/ChatPane.tsx:1150` (composer hint)

**Interfaces:**
- Produces: `parseComposer(body: string): Parsed`, `postable(message: string): string`, types `Command`, `Parsed`. Later tasks add `case`s to the `switch` in `send`.

- [ ] **Step 1: Write the failing tests** in `tests/commands.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComposer, postable } from '../src/commands.ts';

test('known commands parse with their arguments', () => {
  assert.deepEqual(parseComposer('/clear'), { command: { name: 'clear' } });
  assert.deepEqual(parseComposer('/compact'), { command: { name: 'compact' } });
  assert.deepEqual(parseComposer('/pin  we are on Tauri 2 '), { command: { name: 'pin', fact: 'we are on Tauri 2' } });
  assert.deepEqual(parseComposer('/pin'), { command: { name: 'pin', fact: '' } });
  assert.deepEqual(parseComposer('/fork Try SQLite'), { command: { name: 'fork', title: 'Try SQLite' } });
  assert.deepEqual(parseComposer('/fork'), { command: { name: 'fork', title: '' } });
  assert.deepEqual(parseComposer('/export'), { command: { name: 'export', format: 'markdown' } });
  assert.deepEqual(parseComposer('/export json'), { command: { name: 'export', format: 'json' } });
  assert.deepEqual(parseComposer('/diff'), { command: { name: 'diff' } });
  assert.deepEqual(parseComposer('/DIFF'), { command: { name: 'diff' } });
});

test('multiline pins keep their lines', () => {
  assert.deepEqual(parseComposer('/pin line one\nline two'), { command: { name: 'pin', fact: 'line one\nline two' } });
});

test('unknown commands and bad arguments are flagged, not sent', () => {
  assert.deepEqual(parseComposer('/foo bar'), { command: { name: 'unknown', typed: '/foo' } });
  assert.deepEqual(parseComposer('/clear now'), { command: { name: 'unknown', typed: '/clear now' } });
  assert.deepEqual(parseComposer('/export pdf'), { command: { name: 'unknown', typed: '/export pdf' } });
});

test('paths and slashes inside words are plain text', () => {
  assert.deepEqual(parseComposer('/Users/me/file.txt is broken'), { text: '/Users/me/file.txt is broken' });
  assert.deepEqual(parseComposer('see src/App.tsx'), { text: 'see src/App.tsx' });
  assert.deepEqual(parseComposer('hello'), { text: 'hello' });
});

test('a doubled slash escapes and is sent with one slash', () => {
  assert.deepEqual(parseComposer('//compact'), { text: '//compact' });
  assert.equal(postable('//compact'), '/compact');
  assert.equal(postable('@jigga //compact'), '@jigga //compact');
  assert.equal(postable('plain'), 'plain');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/commands.ts'`.

- [ ] **Step 3: Implement** `src/commands.ts`

```ts
/** A slash command typed in the composer. Commands never reach the models. */
export type Command =
  | { name: "clear" }
  | { name: "compact" }
  | { name: "pin"; fact: string }
  | { name: "fork"; title: string }
  | { name: "export"; format: "markdown" | "json" }
  | { name: "diff" }
  | { name: "unknown"; typed: string };

/** Composer text is either a command to run or a message to send. */
export type Parsed = { command: Command } | { text: string };

/** Decide what `body` (already trimmed) is. A command is `/word` at the very
 *  start, followed by whitespace or nothing, so paths like `/Users/me` stay
 *  messages. Text that starts with `//` is a message; `postable` drops one slash. */
export function parseComposer(body: string): Parsed {
  if (body.startsWith("//")) return { text: body };
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return { text: body };
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? "").trim();
  switch (name) {
    case "clear":
    case "compact":
    case "diff":
      return arg ? { command: { name: "unknown", typed: body } } : { command: { name } as Command };
    case "pin":
      return { command: { name: "pin", fact: arg } };
    case "fork":
      return { command: { name: "fork", title: arg } };
    case "export":
      if (arg === "") return { command: { name: "export", format: "markdown" } };
      if (arg.toLowerCase() === "json") return { command: { name: "export", format: "json" } };
      return { command: { name: "unknown", typed: body } };
    default:
      return { command: { name: "unknown", typed: `/${match[1]}` } };
  }
}

/** The text to post for a message that may have been escaped with `//`. */
export function postable(message: string): string {
  return message.startsWith("//") ? message.slice(1) : message;
}
```

`/foo bar` reports `/foo`. A known command with a bad argument reports the whole text, so the warning shows what was wrong.

- [ ] **Step 4: Wire it into `ChatPane.tsx`**

In `dispatch.current`, send escaped messages with one slash:

```ts
      else await backend.roomPost(pane.id, postable(message));
```

Replace the two `/clear` and `/compact` lines in `send` with:

```ts
    const parsed = parseComposer(body);
    if ("command" in parsed) return runCommand(parsed.command);
```

and add, above `send`:

```ts
  /** Commands run locally and never reach the models. */
  const runCommand = (command: Command) => {
    switch (command.name) {
      case "clear":
        if (busy || turnQueue.active) return notify("Wait for the models to finish before clearing the chat.");
        return clearChat();
      case "compact":
        return compactChat();
      case "unknown":
        return notify(`${command.typed} isn't a command. Start with // to send it as a message.`, "error");
      default:
        // Added by later tasks.
        return notify(`${command.name} isn't available yet.`, "error");
    }
  };
```

The text stays in the composer for `unknown`, because `setText("")` only runs inside the handlers. Update the hint at line 1150 to: `"@name to mention · @all for everyone · / for commands: compact, clear, pin, diff, fork, export"`.

- [ ] **Step 5: Run checks**

Run: `npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts tests/commands.test.mjs src/ChatPane.tsx
git commit -m "Parse slash commands and warn on unknown ones"
```

---

### Task 2: Pins in the room

**Files:**
- Modify: `crates/apex-core/src/room.rs` (struct `Room`, `RoomSnapshot`, `snapshot`, `restore`, `new`, `request_for`), `crates/apex-core/src/view.rs`
- Test: `crates/apex-core/tests/room.rs`, `crates/apex-core/tests/wire_format.rs`

**Interfaces:**
- Produces: `Room::pins(&self) -> &[String]`, `Room::pin(&mut self, fact: &str) -> Result<(), String>`, `Room::unpin(&mut self, index: usize) -> Result<(), String>`, `RoomSnapshot.pins: Vec<String>`, `view::pinned_section(pins: &[String]) -> String`, `MAX_PIN_CHARS: usize = 500`.

- [ ] **Step 1: Write the failing tests** (append to `crates/apex-core/tests/room.rs`)

```rust
#[test]
fn pins_reach_every_model_and_survive_clear_and_compact() {
    let a = bot("a", &["one", "two", "three"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    room.pin("We are on Tauri 2").unwrap();
    say(&mut room, "hi");
    assert!(a.requests()[0].system.contains("- We are on Tauri 2"));

    let writer = ScriptedParticipant::new("a", &["summary"]);
    compact(&mut room, &writer).0.unwrap();
    say(&mut room, "again");
    assert!(a.requests().last().unwrap().system.contains("- We are on Tauri 2"));

    room.clear();
    say(&mut room, "fresh");
    assert!(a.requests().last().unwrap().system.contains("- We are on Tauri 2"));
    assert_eq!(room.snapshot().pins, vec!["We are on Tauri 2".to_string()]);
}

#[test]
fn pins_reject_empty_duplicate_and_oversized_facts_and_unpin_by_index() {
    let mut room = room(&[], TurnPolicy::Mention, 0);
    assert!(room.pin("   ").is_err());
    room.pin("first").unwrap();
    room.pin("second").unwrap();
    assert!(room.pin(" first ").is_err());
    assert!(room.pin(&"x".repeat(501)).is_err());
    room.unpin(0).unwrap();
    assert_eq!(room.pins(), ["second".to_string()]);
    assert!(room.unpin(5).is_err());
}

#[test]
fn no_pins_leave_the_system_prompt_unchanged() {
    let a = bot("a", &["ok"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    say(&mut room, "hi");
    assert!(!a.requests()[0].system.contains("pinned"));
}
```

In `wire_format.rs`, add:

```rust
#[test]
fn old_snapshots_without_pins_still_load() {
    let old = json!({ "participants": [], "transcript": [], "options": { "policy": "mention", "max_bot_hops": 3 } });
    let snapshot: apex_core::RoomSnapshot = serde_json::from_value(old).unwrap();
    assert!(snapshot.pins.is_empty());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p apex-core`
Expected: compile errors, `no method named pin` and `no field pins`.

- [ ] **Step 3: Implement**

In `view.rs`, after `system_prompt`:

```rust
/// The longest fact `/pin` accepts. Pins are sent on every turn.
pub const MAX_PIN_CHARS: usize = 500;

/// Facts the person pinned, for the end of every system prompt. Empty when
/// nothing is pinned.
pub fn pinned_section(pins: &[String]) -> String {
    if pins.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nThe human pinned these facts for this chat. Treat them as standing instructions:\n");
    for pin in pins {
        out.push_str(&format!("- {pin}\n"));
    }
    out
}
```

In `room.rs`: add `pins: Vec<String>` to `Room`; add `#[serde(default)] pub pins: Vec<String>,` to `RoomSnapshot`; copy it in `snapshot()` and `restore()`; `Vec::new()` in `new()`. Do **not** touch it in `clear()`. In `request_for`:

```rust
            system: system_prompt(participant.config(), &configs) + &pinned_section(&self.pins),
```

Methods next to `clear`:

```rust
    /// Facts every model is given on every turn. They live outside the
    /// transcript, so `/clear` and `/compact` keep them.
    pub fn pins(&self) -> &[String] {
        &self.pins
    }

    pub fn pin(&mut self, fact: &str) -> Result<(), String> {
        let fact = fact.trim();
        if fact.is_empty() {
            return Err("type the fact after /pin".into());
        }
        if fact.chars().count() > MAX_PIN_CHARS {
            return Err(format!("pins can be at most {MAX_PIN_CHARS} characters"));
        }
        if self.pins.iter().any(|p| p == fact) {
            return Err("that is already pinned".into());
        }
        self.pins.push(fact.to_string());
        Ok(())
    }

    pub fn unpin(&mut self, index: usize) -> Result<(), String> {
        if index >= self.pins.len() {
            return Err("that pin is gone".into());
        }
        self.pins.remove(index);
        Ok(())
    }
```

Import `pinned_section` and `MAX_PIN_CHARS` from `crate::view` in `room.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --workspace`
Expected: all pass, including `system_prompt_names_the_room_and_the_rules`.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-core
git commit -m "Keep pinned facts in every model's system prompt"
```

---

### Task 3: Pins in the app

**Files:**
- Modify: `src-tauri/src/lib.rs` (new commands + `generate_handler!`), `src/backend.ts`, `src/types.ts`, `src/ChatPane.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `Room::pin`, `Room::unpin`, `Room::pins` (Task 2), `runCommand` (Task 1).
- Produces: `backend.roomPin(id: string, fact: string): Promise<string[]>`, `backend.roomUnpin(id: string, index: number): Promise<string[]>`, `RoomSnapshot.pins?: string[]`.

- [ ] **Step 1: Tauri commands** in `src-tauri/src/lib.rs` after `room_clear`:

```rust
/// Pin a fact for every model in this chat. Returns the pins now in place.
/// While models are working this waits for the room, so the pin applies
/// from the next turn.
#[tauri::command]
async fn room_pin(state: State<'_, AppState>, store: State<'_, Store>, id: String, fact: String) -> Result<Vec<String>, String> {
    let pins = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        room.pin(&fact)?;
        room.pins().to_vec()
    };
    save_room(&state, &store, &id).await?;
    Ok(pins)
}

#[tauri::command]
async fn room_unpin(state: State<'_, AppState>, store: State<'_, Store>, id: String, index: usize) -> Result<Vec<String>, String> {
    let pins = {
        let room = state.room(&id)?;
        let mut room = room.lock().await;
        room.unpin(index)?;
        room.pins().to_vec()
    };
    save_room(&state, &store, &id).await?;
    Ok(pins)
}
```

Register both in `generate_handler!`. `tokio::sync::Mutex` hands out the lock in request order, so a pin sent during a turn lands before any message queued after it.

- [ ] **Step 2: Backend interface** in `src/backend.ts`

```ts
  /** Pin a fact for every model in the chat. Resolves with all pins. */
  roomPin(id: string, fact: string): Promise<string[]>;
  roomUnpin(id: string, index: number): Promise<string[]>;
```

Tauri: `roomPin: (id, fact) => invoke("room_pin", { id, fact })`, `roomUnpin: (id, index) => invoke("room_unpin", { id, index })`.

Preview (same rules as Rust):

```ts
    roomPin: async (id, fact) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      const pins: string[] = (room.pins ??= []);
      const trimmed = fact.trim();
      if (!trimmed) throw new Error("type the fact after /pin");
      if (trimmed.length > 500) throw new Error("pins can be at most 500 characters");
      if (pins.includes(trimmed)) throw new Error("that is already pinned");
      pins.push(trimmed);
      saveRoom(id);
      return [...pins];
    },
    roomUnpin: async (id, index) => {
      const room = rooms.get(id);
      if (!room?.pins?.[index]) throw new Error("that pin is gone");
      room.pins.splice(index, 1);
      saveRoom(id);
      return [...room.pins];
    },
```

Add `pins: room.pins ?? []` to the preview `roomCreate` return, and keep `room.pins` in `roomClear`.

- [ ] **Step 3: Types** in `src/types.ts`, inside `RoomSnapshot`:

```ts
  /** Facts every model sees on every turn; kept by /clear and /compact. */
  pins?: string[];
```

- [ ] **Step 4: ChatPane**

State: `const [pins, setPins] = useState<string[]>([]);`. Where the snapshot is restored (near line 498), add `setPins(saved.pins ?? []);`.

In `runCommand`:

```ts
      case "pin":
        if (!command.fact) return notify("Type the fact after /pin, for example: /pin we're on Tauri 2, don't suggest Electron");
        setText("");
        return void backend.roomPin(pane.id, command.fact)
          .then((next) => { setPins(next); notify(busy ? "Pinned. It applies from the next turn." : "Pinned for every model in this chat."); })
          .catch((error) => { setText(`/pin ${command.fact}`); notify(`Could not pin: ${String(error)}`, "error"); });
```

Strip, rendered directly above the message list (and only when `pins.length > 0`):

```tsx
        {pins.length > 0 && <div className="pins" aria-label="Pinned for every model">
          <span className="pins-label">Pinned</span>
          {pins.map((pin, index) => <div className="pin" key={pin}>
            <span className="pin-text" title={pin}>{pin}</span>
            <button className="icon small" aria-label={`Unpin ${pin}`} onClick={() =>
              backend.roomUnpin(pane.id, index).then(setPins).catch((error) => notify(`Could not unpin: ${String(error)}`, "error"))}>×</button>
          </div>)}
        </div>}
```

- [ ] **Step 5: Styles** in `src/styles.css`. Use the same neutral background and thin border as `.quote-preview`; no colored bar.

```css
.pins { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--panel-subtle, transparent); font-size: 12px; }
.pins-label { color: var(--muted); margin-right: 2px; }
.pin { display: inline-flex; align-items: center; gap: 4px; max-width: 360px; padding: 2px 4px 2px 8px; border: 1px solid var(--border); border-radius: 6px; }
.pin-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Check the variable names against the top of `styles.css` and use whatever `.quote-preview` uses.

- [ ] **Step 6: Run checks**

Run: `cargo test --workspace && npm test && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 7: Preview check.** At `http://localhost:1431/`: `/pin we're on Tauri 2` shows the strip; reload keeps it; `/clear` keeps it; × removes it; `/pin` alone shows the hint; a 600-character pin shows the error and keeps the text.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src/backend.ts src/types.ts src/ChatPane.tsx src/styles.css
git commit -m "Add /pin with a pinned-facts strip"
```

---

### Task 4: /export

**Files:**
- Create: `src/exportThread.ts`, `tests/export.test.mjs`, `src-tauri/src/export.rs`
- Modify: `src-tauri/src/lib.rs`, `src/backend.ts`, `src/ChatPane.tsx`

**Interfaces:**
- Consumes: `RoomSnapshot` fields incl. `pins` (Task 3).
- Produces: `exportMarkdown(t: ThreadExport, at: Date): string`, `exportJson(t: ThreadExport, at: Date): string`, `exportFileName(title: string, format: "markdown" | "json", at: Date): string`, `backend.exportThread(fileName: string, contents: string): Promise<string | null>` (the saved path, or `null` in the preview, which downloads instead).

Two facts the export can't change: messages store no time, so the export has a date but no per-message timestamps, and tool calls aren't saved in the transcript, so they can't be included. Both are noted in the README; adding them is a separate change.

- [ ] **Step 1: Failing TS tests** in `tests/export.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMarkdown, exportJson, exportFileName } from '../src/exportThread.ts';

const at = new Date('2026-10-03T15:00:00Z');
const thread = {
  title: 'Slash commands',
  participants: [{ id: 'jigga', display_name: 'Jigga', backend: { kind: 'scripted', lines: [] }, persona: '', access: 'read', effort: null }],
  transcript: [
    { seq: 0, speaker: { kind: 'human' }, text: 'Plan /pin' },
    { seq: 1, speaker: { kind: 'bot', id: 'jigga' }, text: '**Plan**\n\n- one' },
    { seq: 2, speaker: { kind: 'bot', id: 'gone' }, text: 'left the room' },
  ],
  pins: ['we are on Tauri 2'],
  compaction: { summary: 'secret summary', upto: 1 },
};

test('markdown has a title, pins and every message under its speaker', () => {
  const md = exportMarkdown(thread, at);
  assert.ok(md.startsWith('# Slash commands\n'));
  assert.ok(md.includes('Exported from Apex Deck on 2026-10-03'));
  assert.ok(md.includes('## Pinned\n\n- we are on Tauri 2'));
  assert.ok(md.includes('### Human\n\nPlan /pin'));
  assert.ok(md.includes('### Jigga\n\n**Plan**\n\n- one'));
  assert.ok(md.includes('### gone\n\nleft the room'));
});

test('markdown leaves out the compaction summary', () => {
  assert.ok(!exportMarkdown(thread, at).includes('secret summary'));
});

test('json keeps everything needed to re-import', () => {
  const data = JSON.parse(exportJson(thread, at));
  assert.equal(data.format, 'apex-deck-thread');
  assert.equal(data.version, 1);
  assert.equal(data.exported_at, '2026-10-03T15:00:00.000Z');
  assert.deepEqual(data.transcript, thread.transcript);
  assert.deepEqual(data.compaction, thread.compaction);
  assert.deepEqual(data.pins, thread.pins);
});

test('file names are safe and dated', () => {
  assert.equal(exportFileName('Slash commands', 'markdown', at), 'Slash commands 2026-10-03.md');
  assert.equal(exportFileName('a/b:c?', 'json', at), 'a-b-c- 2026-10-03.json');
  assert.equal(exportFileName('   ', 'markdown', at), 'Thread 2026-10-03.md');
});
```

Check the `Speaker` JSON shape in `src/types.ts` before running and adjust the fixture to match it exactly.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/exportThread.ts`

```ts
import type { Compaction, Message, ParticipantConfig } from "./types";

/** What an export needs from a thread. */
export interface ThreadExport {
  title: string;
  participants: ParticipantConfig[];
  transcript: Message[];
  pins: string[];
  compaction: Compaction | null;
}

const day = (at: Date) => at.toISOString().slice(0, 10);

function speakerName(message: Message, participants: ParticipantConfig[]): string {
  if (message.speaker.kind === "human") return "Human";
  const id = message.speaker.id;
  return participants.find((p) => p.id === id)?.display_name ?? id;
}

/** A readable copy of the thread. The summary the models see after /compact
 *  is left out; every message is still there. */
export function exportMarkdown(t: ThreadExport, at: Date): string {
  const who = t.participants.map((p) => `${p.display_name} (@${p.id})`).join(", ") || "none";
  const parts = [`# ${t.title.trim() || "Thread"}`, `Exported from Apex Deck on ${day(at)}. Participants: ${who}.`];
  if (t.pins.length > 0) parts.push(`## Pinned\n\n${t.pins.map((p) => `- ${p}`).join("\n")}`);
  parts.push("---");
  for (const message of t.transcript) parts.push(`### ${speakerName(message, t.participants)}\n\n${message.text}`);
  return parts.join("\n\n") + "\n";
}

/** The raw thread, for a later re-import. */
export function exportJson(t: ThreadExport, at: Date): string {
  return JSON.stringify({ format: "apex-deck-thread", version: 1, exported_at: at.toISOString(), ...t }, null, 2) + "\n";
}

export function exportFileName(title: string, format: "markdown" | "json", at: Date): string {
  const safe = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80) || "Thread";
  return `${safe} ${day(at)}.${format === "json" ? "json" : "md"}`;
}
```

Adjust `message.speaker.kind`/`.id` to the real `Speaker` type.

- [ ] **Step 4: Failing Rust tests** in `src-tauri/src/export.rs`

```rust
//! Where `/export` writes: the Downloads folder, never over an existing file.

use std::path::{Path, PathBuf};

/// Keep only a plain file name. The UI already makes one; this guards the
/// command against anything that could leave the folder.
pub fn safe_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', '\0']) {
        return Err("that is not a usable file name".into());
    }
    Ok(name.to_string())
}

/// `dir/name`, or `dir/name (2).ext` and so on if that file exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, format!(".{ext}")),
        None => (name, String::new()),
    };
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_could_leave_the_folder_are_refused() {
        assert!(safe_file_name("../x.md").is_err());
        assert!(safe_file_name("a/b.md").is_err());
        assert!(safe_file_name(".hidden").is_err());
        assert!(safe_file_name("  ").is_err());
        assert_eq!(safe_file_name(" Thread 2026-10-03.md ").unwrap(), "Thread 2026-10-03.md");
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("apex-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.md"), "a").unwrap();
        std::fs::write(dir.join("t (2).md"), "b").unwrap();
        assert_eq!(unique_path(&dir, "t.md"), dir.join("t (3).md"));
        assert_eq!(unique_path(&dir, "new.md"), dir.join("new.md"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
```

Run `cargo test -p apex-deck export` (check the crate name in `src-tauri/Cargo.toml`). It fails until `mod export;` is added to `lib.rs`; add it, then it passes.

- [ ] **Step 5: Command** in `lib.rs`

```rust
/// Save an exported thread in the Downloads folder. Returns where it went.
#[tauri::command]
fn export_thread(app: AppHandle, file_name: String, contents: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| format!("Could not find the Downloads folder: {e}"))?;
    let path = export::unique_path(&dir, &export::safe_file_name(&file_name)?);
    std::fs::write(&path, contents).map_err(|e| format!("Could not save the export: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}
```

Register it in `generate_handler!`.

- [ ] **Step 6: Backend + ChatPane**

`backend.ts` interface: `/** Save an export. Returns its path, or null when the browser downloaded it. */ exportThread(fileName: string, contents: string): Promise<string | null>;`. Tauri: `invoke("export_thread", { fileName, contents })`. Preview:

```ts
    exportThread: async (fileName, contents) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(link.href);
      return null;
    },
```

ChatPane `runCommand`. ChatPane already holds participants, pins and the compaction. Read the transcript from the `entries` state's message entries:

```ts
      case "export": {
        setText("");
        const at = new Date();
        const thread: ThreadExport = { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries) };
        const contents = command.format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
        return void backend.exportThread(exportFileName(pane.title, command.format, at), contents)
          .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
          .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
      }
```

Write `messagesOf` and `compactionOf` next to the entry types (around `ChatPane.tsx:52`) by filtering `entries` for message entries and the latest `summary` entry. If `entries` can lag behind the saved transcript, add `roomSnapshot(id)` to the backend instead and use that. Decide by reading how `entries` is built from `message_added`.

- [ ] **Step 7: Checks.** Run `cargo test --workspace && npm test && npx tsc --noEmit && npm run build`. In the preview, `/export` and `/export json` download the files. Open both and check them.

- [ ] **Step 8: Commit**

```bash
git add src/exportThread.ts tests/export.test.mjs src-tauri/src/export.rs src-tauri/src/lib.rs src/backend.ts src/ChatPane.tsx
git commit -m "Add /export to Markdown or JSON"
```

---

### Task 5: Record who changed which file

**Files:**
- Modify: `crates/apex-core/src/room.rs` (round loop near line 495, `clear`, snapshot), `crates/apex-core/src/lib.rs`, `src-tauri/src/lib.rs` (`room_post` checkpoint), `src/types.ts`
- Test: `crates/apex-core/tests/room.rs`, `crates/apex-core/tests/wire_format.rs`

**Interfaces:**
- Produces: `pub struct ChangeRecord { by: ParticipantId, path: String, added: usize, removed: usize, seq: usize }` (exported from `apex_core`), `RoomSnapshot.changes: Vec<ChangeRecord>`, `RoomSnapshot.baseline: Option<String>`, `Room::baseline(&self) -> Option<&str>`, `Room::set_baseline(&mut self, tree: String)`.

`seq` is the transcript length when the round started, so the reply that made the change sits at index `seq` or later. `baseline` is an opaque marker that the bridge sets (a git tree id). apex-core only stores it, and `clear()` resets it so `/diff` restarts with the thread.

- [ ] **Step 1: Failing tests** (append to `crates/apex-core/tests/room.rs`)

```rust
/// Edits `path` on every turn, then says "edited".
struct Editor { config: ParticipantConfig, path: &'static str }

#[async_trait::async_trait]
impl Participant for Editor {
    fn config(&self) -> &ParticipantConfig { &self.config }
    async fn respond(&self, _: TurnRequest, _: DeltaSink<'_>) -> Result<Reply, ParticipantError> { Ok(Reply::text("edited")) }
    async fn respond_with_approvals(&self, _: TurnRequest, on_progress: ProgressSink<'_>, _: &dyn Approver) -> Result<Reply, ParticipantError> {
        on_progress(Progress::Change(&FileChange::new(self.path, "-a\n+b\n")));
        Ok(Reply::text("edited"))
    }
}

fn editor(id: &str, path: &'static str) -> Arc<dyn Participant> {
    let config = ScriptedParticipant::new(id, &[]).config().clone();
    Arc::new(Editor { config, path })
}

#[test]
fn the_room_remembers_who_changed_which_file_until_cleared() {
    let mut room = Room::new(vec![editor("a", "x.rs"), editor("b", "y.rs")], RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: 0 });
    say(&mut room, "go");
    let changes = room.snapshot().changes;
    assert_eq!(changes.len(), 2);
    assert!(changes.iter().any(|c| c.by.as_str() == "a" && c.path == "x.rs" && c.added == 1 && c.removed == 1 && c.seq == 1));
    assert!(changes.iter().any(|c| c.by.as_str() == "b" && c.path == "y.rs"));

    room.set_baseline("tree123".into());
    assert_eq!(room.baseline(), Some("tree123"));
    room.clear();
    assert!(room.snapshot().changes.is_empty());
    assert_eq!(room.baseline(), None);
}
```

Use the existing approval-test participant (`tests/room.rs:~495`) as the model, and match its imports (`async_trait`, `Participant` trait method names). In `wire_format.rs`:

```rust
#[test]
fn change_records_shape() {
    let record = apex_core::ChangeRecord { by: ParticipantId::new("a"), path: "x.rs".into(), added: 1, removed: 2, seq: 3 };
    assert_eq!(to_value(&record).unwrap(), json!({ "by": "a", "path": "x.rs", "added": 1, "removed": 2, "seq": 3 }));
}
```

Extend `old_snapshots_without_pins_still_load` to also assert `snapshot.changes.is_empty()` and `snapshot.baseline.is_none()`.

- [ ] **Step 2: Run to verify failure:** `cargo test -p apex-core`. Expected: compile errors.

- [ ] **Step 3: Implement** in `room.rs`

```rust
/// A file a participant changed, kept with the chat so `/diff` can say who
/// changed what.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub by: ParticipantId,
    pub path: String,
    pub added: usize,
    pub removed: usize,
    /// The transcript length when the round that made it began.
    pub seq: usize,
}
```

Add `changes: Vec<ChangeRecord>` and `baseline: Option<String>` to `Room`. Add `#[serde(default)] pub changes: Vec<ChangeRecord>` and `#[serde(default)] pub baseline: Option<String>` (doc: "Where the folder stood when the chat began, as the app recorded it. Opaque to the room.") to `RoomSnapshot`. Wire both through `snapshot`/`restore`/`new`. In `clear()` add `self.changes.clear(); self.baseline = None;`. Add:

```rust
    pub fn baseline(&self) -> Option<&str> {
        self.baseline.as_deref()
    }

    pub fn set_baseline(&mut self, tree: String) {
        self.baseline = Some(tree);
    }
```

In the round loop (near line 495), collect changes during the parallel turns and keep them after:

```rust
            let made: std::sync::Mutex<Vec<ChangeRecord>> = Default::default();
            let made_ref = &made;
            let seq = self.transcript.len();
            let desk: &ApprovalDesk = &self.desk;
            let stop = &self.stop;
            let outcomes = join_all(jobs.into_iter().map(|(id, participant, request)| async move {
                let progress = |update: Progress<'_>| {
                    if let Progress::Change(change) = &update {
                        made_ref.lock().unwrap().push(ChangeRecord {
                            by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq,
                        });
                    }
                    on_event(progress_event(&id, update));
                };
                let approver = RoomApprover { desk, id: &id, on_event };
                let outcome = Self::interruptible(participant.as_ref(), request, stop.clone(), &progress, &approver).await;
                (id, outcome)
            }))
            .await;
            // Edits happened even if the person stopped the turn.
            self.changes.extend(made.into_inner().unwrap());
```

Re-export `ChangeRecord` in `crates/apex-core/src/lib.rs`.

- [ ] **Step 4: Checkpoint changes in the bridge.** In `room_post` (`src-tauri/src/lib.rs`), extend the `on_event` closure so a crash or a mid-turn `/diff` still sees edits:

```rust
        if let RoomEvent::Changed { id: by, change } = &event {
            let mut saved = checkpoint.lock().unwrap();
            let seq = saved.snapshot.transcript.len();
            saved.snapshot.changes.push(apex_core::ChangeRecord { by: by.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq });
            let _ = store.save_room(&id, &saved);
        }
```

At the end of `room_post`, `saved.snapshot = room.snapshot()` replaces this with the room's own record, so nothing is counted twice.

- [ ] **Step 5: Types.** In `src/types.ts`, add `ChangeRecord` and `changes?: ChangeRecord[]; baseline?: string | null;` on `RoomSnapshot`.

- [ ] **Step 6: Checks:** `cargo test --workspace && npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add crates/apex-core src-tauri/src/lib.rs src/types.ts
git commit -m "Remember which participant changed which file"
```

---

### Task 6: Git starting point and thread diff

**Files:**
- Create: `src-tauri/src/changes.rs`
- Modify: `src-tauri/src/lib.rs` (`mod changes;`, baseline capture in `room_post`, `room_diff`)

**Interfaces:**
- Consumes: `ChangeRecord`, `Room::baseline/set_baseline` (Task 5), `agents::login_path()`, `FileChange::new` (to count lines).
- Produces: `changes::snapshot(cwd: &Path) -> Result<String, String>`, `changes::split_patch(patch: &str) -> Vec<(String, String)>`, `changes::thread_diff(cwd: &Path, baseline: Option<&str>, records: &[ChangeRecord]) -> ThreadDiff`, and the serialized

```rust
#[derive(Debug, Serialize, PartialEq)]
pub struct ThreadDiff { pub files: Vec<DiffFile>, pub note: Option<String> }
#[derive(Debug, Serialize, PartialEq)]
pub struct DiffFile { pub path: String, pub added: usize, pub removed: usize, pub patch: String, pub by: Vec<ParticipantId> }
```

How it works: the starting point is the whole working tree (tracked + untracked, respecting `.gitignore`) written as a git tree object. It uses a temporary copy of the index (`GIT_INDEX_FILE`), so `git status`, the staging area, branches and stash never change. `/diff` takes a second snapshot and runs `git diff <start> <now>`. Tree objects aren't referenced by any branch, so `git gc` can delete them after its prune window (two weeks by default). When that happens, `/diff` says so and falls back to reported edits.

- [ ] **Step 1: Failing tests** in `src-tauri/src/changes.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{ChangeRecord, ParticipantId};
    use std::process::Command;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-diff-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"]] {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["add", "-A"]).status().unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["commit", "-qm", "init"]).status().unwrap();
        dir
    }

    fn record(by: &str, path: &str) -> ChangeRecord {
        ChangeRecord { by: ParticipantId::new(by), path: path.into(), added: 1, removed: 0, seq: 1 }
    }

    #[test]
    fn diff_since_start_includes_new_files_attributes_them_and_leaves_git_alone() {
        let dir = repo();
        std::fs::write(dir.join("staged.txt"), "s\n").unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["add", "staged.txt"]).status().unwrap();
        let status_before = Command::new("git").arg("-C").arg(&dir).args(["status", "--porcelain"]).output().unwrap().stdout;

        let start = snapshot(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new file.txt"), "hi\n").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/out"), "ignored\n").unwrap();

        let diff = thread_diff(&dir, Some(&start), &[record("jigga", "a.txt")]);
        assert_eq!(diff.note, None);
        let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "new file.txt"]);
        assert_eq!(diff.files[0].by, vec![ParticipantId::new("jigga")]);
        assert_eq!((diff.files[0].added, diff.files[0].removed), (1, 1));
        assert!(diff.files[1].by.is_empty());

        // The person's staging area and status are untouched (apart from the files we wrote).
        std::fs::remove_file(dir.join("new file.txt")).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let status_after = Command::new("git").arg("-C").arg(&dir).args(["status", "--porcelain"]).output().unwrap().stdout;
        assert_eq!(String::from_utf8_lossy(&status_before), String::from_utf8_lossy(&status_after).replace("?? target/\n", ""));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_repository_lists_reported_edits_with_a_note() {
        let dir = std::env::temp_dir().join(format!("apex-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(snapshot(&dir).is_err());
        let diff = thread_diff(&dir, None, &[record("null", "x.rs"), record("jigga", "x.rs")]);
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].by, vec![ParticipantId::new("null"), ParticipantId::new("jigga")]);
        assert_eq!(diff.files[0].patch, "");
        assert!(diff.note.unwrap().contains("isn't a git repository"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_baseline_object_falls_back_with_a_note() {
        let dir = repo();
        let diff = thread_diff(&dir, Some("0123456789012345678901234567890123456789"), &[record("a", "a.txt")]);
        assert_eq!(diff.files.len(), 1);
        assert!(diff.note.unwrap().contains("starting snapshot is gone"));
        let diff = thread_diff(&dir, None, &[]);
        assert!(diff.note.unwrap().contains("next message"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn split_patch_names_files_by_their_new_path_and_old_path_when_deleted() {
        let patch = "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n\
diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
        let files = split_patch(patch);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "x.rs");
        assert!(files[0].1.ends_with("+b\n"));
        assert_eq!(files[1].0, "gone.rs");
        assert_eq!(split_patch(""), vec![]);
    }
}
```

- [ ] **Step 2: Run to verify failure:** `cargo test -p <tauri crate> changes`. Expected: compile errors.

- [ ] **Step 3: Implement** the top of `src-tauri/src/changes.rs`

```rust
//! What changed in a chat's folder since the chat began, read with git.
//! The starting point is a snapshot of the working tree written as a git
//! tree through a private copy of the index, so the person's staging area,
//! branches and stash never change.

use std::path::{Path, PathBuf};
use std::process::Command;

use apex_core::{ChangeRecord, FileChange, ParticipantId};
use serde::Serialize;

// (ThreadDiff and DiffFile as in Interfaces above)

fn git(cwd: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(["-c", "core.quotePath=false"]).args(args);
    if let Some(path) = crate::agents::login_path() { command.env("PATH", path); }
    if let Some(index) = index { command.env("GIT_INDEX_FILE", index); }
    let out = command.output().map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Write the whole working tree (tracked and untracked, minus ignored files)
/// as a git tree and return its id.
pub fn snapshot(cwd: &Path) -> Result<String, String> {
    let real = cwd.join(git(cwd, None, &["rev-parse", "--git-path", "index"])?.trim());
    let temp: PathBuf = std::env::temp_dir().join(format!("apex-deck-index-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    // Starting from the real index means only changed files are re-read.
    if real.exists() {
        std::fs::copy(&real, &temp).map_err(|e| format!("could not copy the git index: {e}"))?;
    }
    let result = git(cwd, Some(&temp), &["add", "-A", "--", ":/"])
        .and_then(|_| git(cwd, Some(&temp), &["write-tree"]));
    let _ = std::fs::remove_file(&temp);
    result.map(|tree| tree.trim().to_string())
}

/// Split `git diff` output into one patch per file, named by its new path,
/// or by its old path when the file was deleted.
pub fn split_patch(patch: &str) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    for line in patch.lines() {
        if let Some(header) = line.strip_prefix("diff --git ") {
            let path = header.split_once(" b/").map_or(header, |(_, b)| b);
            files.push((path.to_string(), String::new()));
        }
        if let Some((path, body)) = files.last_mut() {
            if let Some(new_path) = line.strip_prefix("+++ b/") { *path = new_path.to_string(); }
            body.push_str(line);
            body.push('\n');
        }
    }
    files
}

/// Everyone who reported changing `path`, in the order they first did.
fn who_changed(path: &str, records: &[ChangeRecord]) -> Vec<ParticipantId> {
    let mut by: Vec<ParticipantId> = Vec::new();
    for r in records.iter().filter(|r| r.path == path) {
        if !by.contains(&r.by) { by.push(r.by.clone()); }
    }
    by
}

/// The models' own reports, one entry per file, when git can't help.
fn reported(records: &[ChangeRecord], note: &str) -> ThreadDiff {
    let mut files: Vec<DiffFile> = Vec::new();
    for r in records {
        match files.iter_mut().find(|f| f.path == r.path) {
            Some(f) => { f.added += r.added; f.removed += r.removed; if !f.by.contains(&r.by) { f.by.push(r.by.clone()); } }
            None => files.push(DiffFile { path: r.path.clone(), added: r.added, removed: r.removed, patch: String::new(), by: vec![r.by.clone()] }),
        }
    }
    ThreadDiff { files, note: Some(note.to_string()) }
}

pub fn thread_diff(cwd: &Path, baseline: Option<&str>, records: &[ChangeRecord]) -> ThreadDiff {
    if git(cwd, None, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return reported(records, "This folder isn't a git repository, so this lists only the edits the models reported. Files changed by commands aren't included.");
    }
    let Some(start) = baseline else {
        return reported(records, "This thread starts tracking the folder with your next message. Until then, this lists only the edits the models reported.");
    };
    if git(cwd, None, &["cat-file", "-e", &format!("{start}^{{tree}}")]).is_err() {
        return reported(records, "The starting snapshot is gone (git cleaned it up), so this lists only the edits the models reported.");
    }
    let patch = match snapshot(cwd).and_then(|now| git(cwd, None, &["diff", "--no-color", "--no-ext-diff", "--no-renames", "--relative", start, &now])) {
        Ok(patch) => patch,
        Err(error) => return reported(records, &format!("git could not compare the folder ({error}), so this lists only the edits the models reported.")),
    };
    let files = split_patch(&patch).into_iter().map(|(path, patch)| {
        let counted = FileChange::new(path.clone(), patch.clone());
        DiffFile { by: who_changed(&path, records), added: counted.added, removed: counted.removed, path, patch }
    }).collect();
    ThreadDiff { files, note: None }
}
```

Confirm `FileChange` is re-exported from `apex_core`. If it isn't, import it from `apex_core::approval`.

- [ ] **Step 4: Run tests:** `cargo test --workspace`. Expected: pass.

- [ ] **Step 5: Capture the starting point** in `room_post`, right after `let mut room = room.lock().await;` and before `checkpoint` is built:

```rust
    if room.baseline().is_none() {
        if let Some(cwd) = state.room_context(&id)?.cwd {
            // Not a git folder, or git missing: /diff falls back to reported edits.
            if let Ok(Ok(tree)) = tokio::task::spawn_blocking(move || changes::snapshot(&cwd)).await {
                room.set_baseline(tree);
            }
        }
    }
```

- [ ] **Step 6: Command**

```rust
/// What changed in the folder since this thread started, and who changed it.
/// Reads the saved copy, so it answers while models are still working.
#[tauri::command]
async fn room_diff(state: State<'_, AppState>, store: State<'_, Store>, id: String) -> Result<changes::ThreadDiff, String> {
    let cwd = state.room_context(&id)?.cwd.ok_or("this thread has no workspace folder")?;
    let snapshot = store.room(&id)?.ok_or("this thread has not been saved yet")?.snapshot;
    tokio::task::spawn_blocking(move || changes::thread_diff(&cwd, snapshot.baseline.as_deref(), &snapshot.changes))
        .await
        .map_err(|e| e.to_string())
}
```

Register `room_diff`.

- [ ] **Step 7: Checks:** `cargo test --workspace`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/changes.rs src-tauri/src/lib.rs
git commit -m "Diff a thread's folder against a git snapshot taken at its start"
```

---

### Task 7: /diff panel

**Files:**
- Create: `src/diffGroups.ts`, `tests/diff-groups.test.mjs`, `src/DiffPanel.tsx`
- Modify: `src/types.ts`, `src/backend.ts`, `src/ChatPane.tsx` (Changes button near line 835, panel near line 1116, `runCommand`), `src/Approvals.tsx` (remove `ChangesPanel`/`MadeChange` once unused), `src/styles.css`

**Interfaces:**
- Consumes: `room_diff` (Task 6), `Diff` from `src/Approvals.tsx` (renders one patch).
- Produces: `groupDiff(files: DiffFile[], order: string[]): DiffGroup[]` where `DiffGroup = { by: string | null; files: DiffFile[] }`; `backend.roomDiff(id: string): Promise<ThreadDiff>`.

- [ ] **Step 1: Failing tests** in `tests/diff-groups.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDiff } from '../src/diffGroups.ts';

const f = (path, by) => ({ path, added: 1, removed: 0, patch: '', by });

test('files group under each agent in room order, shared files under both', () => {
  const groups = groupDiff([f('a.rs', ['null']), f('b.rs', ['jigga', 'null']), f('c.rs', [])], ['jigga', 'null']);
  assert.deepEqual(groups.map((g) => [g.by, g.files.map((x) => x.path)]), [
    ['jigga', ['b.rs']],
    ['null', ['a.rs', 'b.rs']],
    [null, ['c.rs']],
  ]);
});

test('agents no longer in the room still get a group, after current ones', () => {
  const groups = groupDiff([f('a.rs', ['gone']), f('b.rs', ['jigga'])], ['jigga']);
  assert.deepEqual(groups.map((g) => g.by), ['jigga', 'gone']);
});

test('no files, no groups', () => {
  assert.deepEqual(groupDiff([], ['jigga']), []);
});
```

- [ ] **Step 2: Run, expect FAIL** (`npm test`).

- [ ] **Step 3: Implement** `src/diffGroups.ts`

```ts
import type { DiffFile } from "./types";

/** Files under the agent that changed them. `by: null` holds files no model
 *  reported: the person, a shell command or another app changed them. */
export interface DiffGroup { by: string | null; files: DiffFile[] }

export function groupDiff(files: DiffFile[], order: string[]): DiffGroup[] {
  const ids = [...order, ...files.flatMap((f) => f.by).filter((id, i, all) => !order.includes(id) && all.indexOf(id) === i)];
  const groups: DiffGroup[] = ids.map((by) => ({ by, files: files.filter((f) => f.by.includes(by)) }));
  groups.push({ by: null, files: files.filter((f) => f.by.length === 0) });
  return groups.filter((g) => g.files.length > 0);
}
```

Add `ThreadDiff`/`DiffFile` to `src/types.ts`, mirroring the Rust structs (`by: string[]`, `note: string | null`).

- [ ] **Step 4: Backend.** Interface: `/** What changed in the folder since the thread started, by agent. */ roomDiff(id: string): Promise<ThreadDiff>;`. Tauri: `invoke("room_diff", { id })`. Preview canned data, so the panel shows a shared file, an unattributed file and a patch:

```ts
    roomDiff: async (id) => {
      const room = rooms.get(id);
      const [first, second] = room?.participants ?? [];
      const patch = "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-const title = \"Deck\";\n+const title = \"Apex Deck\";\n export default App;\n";
      return {
        note: "Preview: these changes are made up. The desktop app reads them from git.",
        files: [
          { path: "src/App.tsx", added: 1, removed: 1, patch, by: first ? [first.id] : [] },
          { path: "README.md", added: 3, removed: 0, patch: "+## Commands\n+\n+/pin, /diff, /fork, /export\n", by: [first, second].filter(Boolean).map((p) => p.id) },
          { path: "package-lock.json", added: 12, removed: 4, patch: "", by: [] },
        ],
      };
    },
```

- [ ] **Step 5: `src/DiffPanel.tsx`**, replacing `ChangesPanel` in the chat. Keep the same `aside.changes` frame and close button so layout and styles carry over.

```tsx
import { useState } from "react";
import { Diff } from "./Approvals";
import { groupDiff } from "./diffGroups";
import type { ThreadDiff } from "./types";

interface Props {
  diff: ThreadDiff | null;
  loading: boolean;
  order: string[];
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/** Everything that changed in the folder since this thread started, under
 *  the agent that changed it. */
export function DiffPanel({ diff, loading, order, nameOf, colorOf, onReveal, onRefresh, onClose }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const files = diff?.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <aside className="changes" aria-label="Changes since this thread started">
      <header className="changes-head">
        <strong>Since this thread started</strong>
        <span className="muted">{loading ? "Reading…" : `${files.length} files · +${added} −${removed}`}</span>
        <button className="ghost small" onClick={onRefresh} disabled={loading}>Refresh</button>
        <button className="icon small" aria-label="Close changes" onClick={onClose}>×</button>
      </header>
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
                {open === key && <Diff text={file.patch} />}
              </div>
            );
          })}
        </section>
      ))}
    </aside>
  );
}
```

`Diff` already renders "The tool did not say what changed in this file." for an empty patch. Pass it a short `diff-none` message for files that only come from reports if that wording reads wrong here.

- [ ] **Step 6: ChatPane wiring**
- State: `const [diff, setDiff] = useState<ThreadDiff | null>(null); const [diffLoading, setDiffLoading] = useState(false);`
- `const loadDiff = () => { setDiffLoading(true); backend.roomDiff(pane.id).then(setDiff).catch((error) => notify(`Could not read changes: ${String(error)}`, "error")).finally(() => setDiffLoading(false)); };`
- The Changes button and `/diff` both do `setShowChanges(true); loadDiff();` (`/diff` also clears the text).
- In the `idle` event handler: `if (showChangesRef.current) loadDiff();`. Use a ref so the event closure sees the current value.
- Button count: distinct paths in the restored `saved.changes` plus live `changed` events. Keep the existing `changes` state, fed from both. No git runs until the panel opens.
- Render `<DiffPanel diff={diff} loading={diffLoading} order={participants.map((p) => p.id)} … />` where `ChangesPanel` was. Delete `ChangesPanel` and `MadeChange` from `Approvals.tsx` if nothing else uses them.

- [ ] **Step 7: Styles** for `.diff-group h4`, `.diff-file-row`, `.changes-note`, matching the existing `.changes` panel.

- [ ] **Step 8: Checks:** `npm test && npx tsc --noEmit && npm run build`. In the preview, `/diff` opens the panel with three groups, a patch expands, and Refresh works.

- [ ] **Step 9: Commit**

```bash
git add src/diffGroups.ts tests/diff-groups.test.mjs src/DiffPanel.tsx src/types.ts src/backend.ts src/ChatPane.tsx src/Approvals.tsx src/styles.css
git commit -m "Add /diff: folder changes since the thread started, by agent"
```

---

### Task 8: /fork

**Files:**
- Modify: `crates/apex-core/src/room.rs` (`impl RoomSnapshot`), `src-tauri/src/lib.rs`, `src/backend.ts`, `src/App.tsx:224-235,486`, `src/ChatPane.tsx` (Props, `runCommand`, message actions near line 1058), `src/styles.css`
- Test: `crates/apex-core/tests/room.rs`, `src-tauri/src/storage.rs` tests or a new test in `lib.rs`

**Interfaces:**
- Consumes: `pins`, `changes`, `baseline` on `RoomSnapshot` (Tasks 2, 5).
- Produces: `RoomSnapshot::fork(&self, upto: usize) -> RoomSnapshot`; `room_fork(source, target, upto: Option<usize>)`; `backend.roomFork(source: string, target: string, upto: number | null): Promise<void>`; ChatPane prop `onFork: (title: string, upto: number | null) => Promise<string>` (resolves with the new title).

- [ ] **Step 1: Failing tests** (append to `crates/apex-core/tests/room.rs`)

```rust
#[test]
fn forking_at_the_end_copies_everything_the_models_need() {
    let a = bot("a", &["one", "two"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    room.pin("keep me").unwrap();
    say(&mut room, "hi");
    let writer = ScriptedParticipant::new("a", &["summary"]);
    compact(&mut room, &writer).0.unwrap();
    room.set_baseline("tree".into());
    let snapshot = room.snapshot();

    let fork = snapshot.fork(snapshot.transcript.len());
    assert_eq!(fork.transcript, snapshot.transcript);
    assert_eq!(fork.pins, vec!["keep me".to_string()]);
    assert_eq!(fork.compaction, snapshot.compaction);
    assert_eq!(fork.baseline.as_deref(), Some("tree"));
    assert_eq!(fork.last_targets, snapshot.last_targets);
}

#[test]
fn a_summary_past_the_fork_point_is_dropped() {
    let a = bot("a", &["one", "two"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    say(&mut room, "first");
    say(&mut room, "second");
    let writer = ScriptedParticipant::new("a", &["summary"]);
    compact(&mut room, &writer).0.unwrap(); // covers all 4 messages
    let fork = room.snapshot().fork(2);
    assert_eq!(fork.transcript.len(), 2);
    assert_eq!(fork.compaction, None);
    assert!(fork.last_targets.is_empty());
    assert!(fork.cursors.values().all(|&c| c <= 2));
}

#[test]
fn edits_made_after_the_fork_point_are_left_out() {
    let mut room = Room::new(vec![editor("a", "x.rs")], RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: 0 });
    say(&mut room, "one"); // change seq 1, reply at index 1
    say(&mut room, "two"); // change seq 3, reply at index 3
    let snapshot = room.snapshot();
    assert_eq!(snapshot.fork(2).changes.len(), 1);
    assert_eq!(snapshot.fork(1).changes.len(), 0);
    assert_eq!(snapshot.fork(99).transcript.len(), 4);
}
```

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement** in `room.rs`

```rust
impl RoomSnapshot {
    /// This chat as it stood after its first `upto` messages, for `/fork`.
    /// Participants, settings, pins and the folder's starting point carry
    /// over. A summary carries over only if it covers nothing past `upto`,
    /// and edits made in later rounds are left out.
    pub fn fork(&self, upto: usize) -> RoomSnapshot {
        let upto = upto.min(self.transcript.len());
        let whole = upto == self.transcript.len();
        RoomSnapshot {
            participants: self.participants.clone(),
            transcript: self.transcript[..upto].to_vec(),
            options: self.options,
            cursors: self.cursors.iter().map(|(id, &seen)| (id.clone(), seen.min(upto))).collect(),
            last_targets: if whole { self.last_targets.clone() } else { Vec::new() },
            compaction: self.compaction.clone().filter(|c| c.upto <= upto),
            pins: self.pins.clone(),
            changes: self.changes.iter().filter(|c| c.seq < upto).cloned().collect(),
            baseline: self.baseline.clone(),
        }
    }
}
```

- [ ] **Step 4: Run** `cargo test -p apex-core`. Expected: pass.

- [ ] **Step 5: Tauri command**

```rust
/// Copy chat `source` into a new chat `target`, up to message `upto` (all of
/// it when `None`). Reads the saved copy, so it works while models reply.
#[tauri::command]
async fn room_fork(state: State<'_, AppState>, store: State<'_, Store>, source: String, target: String, upto: Option<usize>) -> Result<(), String> {
    if store.room(&target)?.is_some() {
        return Err("a thread with that id already exists".into());
    }
    let cwd = state.room_context(&source)?.cwd.map(|p| p.to_string_lossy().into_owned());
    let snapshot = store.room(&source)?.ok_or("send a message before forking this thread")?.snapshot;
    let upto = upto.unwrap_or(snapshot.transcript.len());
    store.save_room(&target, &SavedRoom { cwd, snapshot: snapshot.fork(upto) })
}
```

Register it. Because `room_create` restores saved data first, opening a pane with the `target` id loads the fork.

Add the test named in Review Focus 4 to the `storage.rs` tests module. It saves a room, appends a message to the saved copy only, forks via `snapshot.fork`, and asserts the fork has the saved message. That shows forking needs no live room lock:

```rust
    #[tokio::test]
    async fn fork_reads_the_saved_copy() {
        let root = temp();
        let store = Store::new(root.clone());
        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("saved", &|_| {}).await;
        store.save_room("src", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        let saved = store.room("src").unwrap().unwrap();
        store.save_room("dst", &SavedRoom { cwd: saved.cwd.clone(), snapshot: saved.snapshot.fork(usize::MAX) }).unwrap();
        assert_eq!(store.room("dst").unwrap().unwrap().snapshot.transcript[0].text, "saved");
        std::fs::remove_dir_all(root).unwrap();
    }
```

- [ ] **Step 6: Backend.** Interface `roomFork(source: string, target: string, upto: number | null): Promise<void>`. Tauri: `invoke("room_fork", { source, target, upto })`. Preview: copy the `localStorage` entry `apex-deck.demo.room.${source}` into `…${target}`, with `transcript` sliced to `upto`, `compaction` dropped if `compaction.upto > upto`, `last: []` when truncated, and `seq` set to the new length.

- [ ] **Step 7: App.** Next to `addPane`:

```ts
  /** Copy a thread into a new one next to it, in the same workspace. */
  const forkThread = async (source: Pane, title: string, upto: number | null) => {
    const id = newId("pane");
    await backend.roomFork(source.id, id, upto);
    setPanes((list) => [...list, { id, workspaceId: source.workspaceId, kind: "chat", title }]);
    setFocusedPane(id);
    setSection("threads");
    setMaximized(null);
    return title;
  };
```

Pass `onFork={(title, upto) => forkThread(pane, title, upto)}` to `<ChatPane>` at line 486, and make `onFork` optional in `Props` for profile mode.

- [ ] **Step 8: ChatPane.** `runCommand`:

```ts
      case "fork": {
        setText("");
        return void forkAt(command.title || `${pane.title} (fork)`, null);
      }
```

with

```ts
  const forkAt = (title: string, upto: number | null) =>
    onFork?.(title, upto)
      .then((name) => notify(`Forked into “${name}”. Both threads work in the same folder, so file edits in one show up in the other.`))
      .catch((error) => notify(`Could not fork: ${String(error)}`, "error"));
```

Message action: next to the reply button (the `setReply({…})` handler near line 1058), add a fork button on **every** message, human or bot, shown on hover/focus like the reply arrow, with no visible label:

```tsx
<button className="icon small message-action" aria-label="Fork from here" title="Fork from here"
  onClick={() => forkAt(`${pane.title} (fork)`, entry.message.seq + 1)}>
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3h0a3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/></svg>
</button>
```

Match the reply arrow's existing class names and placement exactly. Read them at line ~1050 first.

- [ ] **Step 9: Checks:** `cargo test --workspace && npm test && npx tsc --noEmit && npm run build`. In the preview: `/fork Try SQLite` opens a new thread with the same messages, participants and pins; forking from the second message gives two messages; the original is unchanged; restarting the preview keeps both.

- [ ] **Step 10: Commit**

```bash
git add crates/apex-core src-tauri/src src/backend.ts src/App.tsx src/ChatPane.tsx src/styles.css
git commit -m "Add /fork and fork-from-here on messages"
```

---

### Task 9: Docs and end-to-end verification

**Files:**
- Modify: `README.md`, `docs/identicon-battery-verification.md` → add a sibling `docs/thread-commands-verification.md`

- [ ] **Step 1: README.** Under "Using Apex Deck", add a Commands list:
  - `/compact`, `/clear` (existing text).
  - `/pin <fact>`: every model sees it on every turn; kept by `/compact` and `/clear`; remove with × in the strip.
  - `/diff`: what changed in the workspace folder since the thread started, by agent. Needs git for full diffs; otherwise lists edits the models reported.
  - `/fork [name]`: copy the thread; the fork icon on a message forks from that point. Both threads share the folder.
  - `/export`, `/export json`: saved to Downloads. No per-message times or tool calls (not stored).
  - Start a message with `//` to send a literal `/`.

- [ ] **Step 2: Full checks.** `cargo test --workspace`, `npm test`, `npx tsc --noEmit`, `npm run build`. Record the counts.

- [ ] **Step 3: Desktop dev build** (production app stays running). In a scratch git repo workspace with one Claude Code agent and one Codex agent:
  1. `/pin always answer in one sentence`, ask both something, and confirm both comply. `/compact`, ask again, and confirm they still comply.
  2. Have Claude edit `a.txt` and Codex create `b.txt`; also `touch c.txt` yourself. `/diff` should show `a.txt` under Claude, `b.txt` under Codex and `c.txt` under "Not reported by a model". Run `git status` and confirm nothing is staged that wasn't before.
  3. `/diff` in a non-git folder shows the note.
  4. `/fork`, then send a message in the fork; the original is unchanged. Restart the dev build; both threads are there.
  5. `/export` and `/export json`; Finder reveals each file in Downloads.
  6. `/foo` warns; `//foo` is sent as `/foo`.

- [ ] **Step 4: Write `docs/thread-commands-verification.md`** listing what was checked in the preview versus the desktop app, with anything not verified marked as such.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/thread-commands-verification.md
git commit -m "Document /pin, /diff, /fork and /export"
```

Stop here and report. Don't push or merge.
