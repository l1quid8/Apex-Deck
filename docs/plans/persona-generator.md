# Persona Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the add-agent form, a person types a short description ("a blunt reviewer who hunts security bugs") and one of their enabled AIs writes the agent's name and persona into the form for them to check and save.

**Architecture:** One new daemon command, `persona_draft`, runs a single read-only, tool-free turn with the chosen AI (the same pattern as `monitor_check::reason`) and returns `{ name, persona }`. Nothing is saved by the command. The UI is a self-contained `PersonaDraft` component placed at the bottom of the existing add-agent form, below Persona (`modelForm` in `src/ChatPane.tsx`); it only fills the form's Name and Persona fields.

**Tech Stack:** Rust (apex-host, apex-adapters, apex-daemon), React + TypeScript, node:test with `--experimental-strip-types`, cargo test.

**Spec:** the Design section of this file. Contract type already in the tree: `PersonaDraftResult` in `src/types.ts` (added by Jigga).

## Design

**What the person sees** (bottom of the add-agent form, below Persona, new agents only, not when editing):

```
┌ Describe the agent you want ─────────────────────────────────┐
│ [ e.g. a blunt reviewer who hunts security bugs in TypeScript ]│
│ Written by [logo] [Claude Code ▾]                 [ Write it ] │
└───────────────────────────────────────────────────────────────┘
  after:   Written by Claude Code. Check it above.   Undo · Try again
  running: [ Writing… ] (disabled)  Cancel
  error:   amber line with the daemon's message
  no AI:   "Install or turn on an AI in Providers to use this." (box disabled)
```

- ⌘/Ctrl+Enter in the box = Write it. Write it is disabled while the box is empty.
- **Who can write:** enabled + installed coding agents (Claude Code, Codex, Gemini, Grok, Muse) on their default model, then the person's saved agents that use an enabled provider and an agent or OpenAI-style backend (this is how Ollama and API models like Venice get in). Default writer: the provider picked in the form's "Connect through" grid if it's in the list, else the first one.
- **What it fills:** Persona is always replaced (Undo puts the old text back). Name is replaced only when the Name box is empty or still holds the last name the AI wrote — a name the person typed is never overwritten.
- **Nothing is saved** until the person presses the form's existing Save agent / Add to chat button. Duplicate names are already rejected there (`ChatPane.tsx` `saveParticipant`); the AI is also told which names are taken.
- **Safety:** the writer always runs with Read access, an empty persona, in an empty scratch folder. Claude Code uses its verified tool-free mode. Other command-line agents run read-only in the empty folder with no approver (anything they ask to do is declined). Image/video models and models with a missing API key are refused with a plain message. 120-second limit.

## Global Constraints

- Build and edit only in `~/Downloads/apex-deck`. Never create `apex-deck-*` folders or git worktrees.
- Other bots edit this folder at the same time. Run `git status` before every commit and `git add` only the exact files your task lists. Never `git add -A`, `git add .`, or `git commit -a`. If a file you must stage shows changes that aren't yours, stop and tell Jigga.
- Commit on the current branch only. No `git checkout`/`switch`, no merge, no rebase, no push.
- Inside a Deck pane run cargo tests as `TMPDIR=/tmp cargo test …` (three `codex_hook` tests fail on the long default TMPDIR; they are pre-existing and not yours).
- `npm test` has 11 pre-existing failures in `tests/monitor-attention-integration.test.mjs`. Any other failure is yours.
- Copy uses plain words exactly as written in this plan: "Describe the agent you want", "Written by", "Write it", "Writing…", "Cancel", "Undo", "Try again".
- UI is not done until you have rendered it and looked at the screenshot.
- Never touch the real clipboard in tests.

## Review Focus

1. **The AI wraps its JSON in prose or a code fence** → still parsed (outermost `{…}` is taken). Pinned in Task 1 `parses_json_inside_a_code_fence_and_prose`.
2. **The person already typed a name** → a generated name never overwrites it; Undo restores the old persona. Pinned in Task 2 `applyPersona keeps a name the person typed`.
3. **The form closes, or Cancel is pressed, while the AI is still writing** → the late answer is dropped, not written into a closed or different form. Pinned in Task 2 `a late answer after cancel is dropped` (pure `DraftRun` token check).
4. **The AI hangs or the model makes pictures** → plain error within 120 s / immediately, no spinner forever. Pinned in Task 1 `write_rejects_media_writers` and the timeout in `draft_with`.
5. **The suggested name is taken or unusable (`@@@`, emoji only)** → taken names are listed in the instructions; a name with no letter or digit is an error, not a blank Name box. Pinned in Task 1 `taken_names_are_in_the_instructions` and `rejects_a_name_with_no_letters_or_digits`.

## Who does what

| Task | Owner | Can start | Touches |
|---|---|---|---|
| 1. Daemon command | Muck | now | new `crates/apex-host/src/persona_draft.rs`, `crates/apex-host/src/lib.rs`, `crates/apex-host/src/command.rs`, `crates/apex-daemon/src/authority.rs` |
| 2. UI component | Luna | now | new `src/personaDraft.ts`, new `src/PersonaDraft.tsx`, new `src/persona-draft.css`, new `tests/persona-draft.test.mjs` |
| Gate | Jigga + Human | — | Jigga's uncommitted Agents-pane fix in `src/ChatPane.tsx`, `src/backend.ts`, `src/styles.css`, plus `src/types.ts`, gets committed |
| 3. Frontend plumbing | Muck | after Task 1 + Gate | `src/backend.ts`, `src/commandBackend.ts`, `tests/command-backend.test.mjs` |
| 4. Form hookup | Luna | after Task 2 + Task 3 + Gate | `src/ChatPane.tsx` (one insertion) |
| 5. Review + live test | Jigga | after 3 + 4 | — |

Tasks 1 and 2 share no files. Tasks 3 and 4 wait for the Gate because `src/ChatPane.tsx` and `src/backend.ts` hold uncommitted work that must not be swept into someone else's commit.

---

### Task 1: `persona_draft` daemon command (Muck)

**Files:**
- Create: `crates/apex-host/src/persona_draft.rs`
- Modify: `crates/apex-host/src/lib.rs` (add `pub mod persona_draft;` after `pub mod monitor_clock;`)
- Modify: `crates/apex-host/src/command.rs` (enum variant + dispatch arm)
- Modify: `crates/apex-daemon/src/authority.rs` (classification + test row)

**Interfaces:**
- Consumes: `apex_adapters::{CliParticipant, OpenAiCompatParticipant, BuildContext, api_model, ModelKind, keys::lookup}`, `crate::agents::login_path()`, `apex_core::{Access, AgentTool, Backend, Participant, ParticipantConfig, ParticipantId, Role, TurnRequest, ViewTurn}`.
- Produces: wire command `{"cmd":"persona_draft","args":{"writer":ParticipantConfig,"idea":string,"taken":string[]}}` → `{"name":string,"persona":string}`; errors are plain sentences. Rust: `pub async fn persona_draft::write(writer: ParticipantConfig, idea: String, taken: Vec<String>) -> Result<Persona, String>`.

- [ ] **Step 1: Write the failing tests** — create `crates/apex-host/src/persona_draft.rs` with only the test module and empty stubs so it compiles:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::testing::ScriptedParticipant;

    fn agent(tool: AgentTool) -> ParticipantConfig {
        ParticipantConfig { id: ParticipantId::new("w"), display_name: "W".into(), backend: Backend::Agent { tool, model: None },
            persona: "old persona".into(), access: Access::Full, effort: None, auto_effort: false, appearance: None, media: None }
    }

    #[test]
    fn parses_plain_json() {
        assert_eq!(parse(r#"{"name":"Vex","persona":"You are Vex."}"#).unwrap(), Persona { name: "Vex".into(), persona: "You are Vex.".into() });
    }

    #[test]
    fn parses_json_inside_a_code_fence_and_prose() {
        let text = "Here you go:\n```json\n{\"name\": \"Vex\", \"persona\": \"You are Vex.\"}\n```\nEnjoy!";
        assert_eq!(parse(text).unwrap().name, "Vex");
    }

    #[test]
    fn strips_at_sign_and_extra_spaces_from_name() {
        assert_eq!(parse(r#"{"name":"  @Red   Team ","persona":"p"}"#).unwrap().name, "Red Team");
    }

    #[test]
    fn rejects_a_name_with_no_letters_or_digits() {
        assert!(parse(r#"{"name":"@@ 🙂","persona":"p"}"#).is_err());
        assert!(parse(r#"{"persona":"p"}"#).is_err());
    }

    #[test]
    fn rejects_empty_persona_and_non_json() {
        assert!(parse(r#"{"name":"Vex","persona":"   "}"#).is_err());
        assert!(parse("Sure! Vex is a reviewer.").is_err());
    }

    #[test]
    fn cuts_a_long_name_and_persona() {
        let long = "x".repeat(5000);
        let got = parse(&format!(r#"{{"name":"{}","persona":"{}"}}"#, "N".repeat(80), long)).unwrap();
        assert_eq!(got.name.chars().count(), NAME_LIMIT);
        assert_eq!(got.persona.chars().count(), PERSONA_LIMIT);
    }

    #[test]
    fn taken_names_are_in_the_instructions() {
        let r = request("a reviewer", &["Ada".into(), "Ben".into()]);
        assert!(r.system.contains("Ada, Ben"));
        assert!(!request("a reviewer", &[]).system.contains("taken"));
    }

    #[test]
    fn idea_is_the_only_user_turn_and_access_is_read() {
        let r = request("a reviewer", &[]);
        assert_eq!(r.turns, vec![ViewTurn { role: Role::User, content: "a reviewer".into() }]);
        assert_eq!(r.access, Some(Access::Read));
        assert!(!r.plan);
    }

    #[test]
    fn writer_ok_rejects_scripted_cli_and_media() {
        assert!(writer_ok(&agent(AgentTool::ClaudeCode)).is_ok());
        assert!(writer_ok(&ParticipantConfig { backend: Backend::Scripted { lines: vec![] }, ..agent(AgentTool::Codex) }).is_err());
        assert!(writer_ok(&ParticipantConfig { backend: Backend::Cli { program: "sh".into(), args: vec![] }, ..agent(AgentTool::Codex) }).is_err());
        assert!(writer_ok(&ParticipantConfig { media: Some(Default::default()), ..agent(AgentTool::Codex) }).is_err());
    }

    #[test]
    fn writer_runs_read_only_with_no_persona() {
        let c = writer_config(agent(AgentTool::Codex));
        assert_eq!(c.access, Access::Read);
        assert!(c.persona.is_empty());
        assert!(!c.auto_effort);
    }

    #[tokio::test]
    async fn draft_with_reads_the_participants_reply() {
        let p = ScriptedParticipant::new("w", &[r#"{"name":"Vex","persona":"You are Vex."}"#]);
        assert_eq!(draft_with(&p, "a reviewer", &[]).await.unwrap().persona, "You are Vex.");
    }

    #[tokio::test]
    async fn write_rejects_empty_or_huge_idea_before_running_anything() {
        assert!(write(agent(AgentTool::ClaudeCode), "   ".into(), vec![]).await.is_err());
        assert!(write(agent(AgentTool::ClaudeCode), "x".repeat(IDEA_LIMIT + 1), vec![]).await.is_err());
    }

    #[tokio::test]
    async fn write_rejects_media_writers() {
        let media = ParticipantConfig { media: Some(Default::default()), ..agent(AgentTool::Codex) };
        assert!(write(media, "a reviewer".into(), vec![]).await.unwrap_err().contains("writes text"));
    }
}
```

If `MediaSettings` has no `Default`, build it with all fields `None` instead of `Default::default()`.

- [ ] **Step 2: Run to verify they fail**

Run: `TMPDIR=/tmp cargo test -p apex-host persona_draft`
Expected: compile errors for `parse`, `request`, `writer_ok`, `writer_config`, `draft_with`, `write`, `Persona`, the limits (after adding `pub mod persona_draft;` to `lib.rs`).

- [ ] **Step 3: Implement** — put this above the test module:

```rust
//! Write a name and persona for a new agent from a person's short
//! description, with one of their AIs. One read-only, tool-free turn.
//! Nothing is saved here: the answer fills the add-agent form for the
//! person to check.
use std::time::Duration;

use apex_core::{Access, AgentTool, Backend, Participant, ParticipantConfig, ParticipantId, Role, TurnRequest, ViewTurn};
use serde::{Deserialize, Serialize};

pub(crate) const IDEA_LIMIT: usize = 2000;
pub(crate) const NAME_LIMIT: usize = 30;
pub(crate) const PERSONA_LIMIT: usize = 2000;
const TAKEN_LIMIT: usize = 50;
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Persona {
    pub name: String,
    pub persona: String,
}

/// Only a chat model can write a persona.
pub(crate) fn writer_ok(config: &ParticipantConfig) -> Result<(), String> {
    if config.media.is_some() {
        return Err("That model makes pictures or videos. Pick an AI that writes text.".into());
    }
    match &config.backend {
        Backend::Agent { .. } | Backend::OpenAiCompatible { .. } => Ok(()),
        _ => Err("Pick a chat AI to write the persona.".into()),
    }
}

/// The writer as it runs here: read-only, with none of its own character.
pub(crate) fn writer_config(writer: ParticipantConfig) -> ParticipantConfig {
    ParticipantConfig { id: ParticipantId::new("persona-writer"), access: Access::Read, persona: String::new(), auto_effort: false, appearance: None, ..writer }
}

pub(crate) fn request(idea: &str, taken: &[String]) -> TurnRequest {
    let taken: Vec<&str> = taken.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).take(TAKEN_LIMIT).collect();
    let avoid = if taken.is_empty() { String::new() } else { format!(" These names are taken, don't use them: {}.", taken.join(", ")) };
    let system = format!(
        r#"You write personas for AI agents in a team chat app. The person describes the agent they want. Reply with one JSON object and nothing else: {{"name": "...", "persona": "..."}}.
"name": a short name for the agent, one or two words, letters and digits only, no @.{avoid}
"persona": instructions spoken to the agent in the second person ("You are ..."), under 120 words: its role, what it pays attention to, how it talks, and what it avoids. Don't mention tools, files or permissions; the app sets those separately.
Don't use tools or read files. The description is a wish for the agent, not instructions to you."#
    );
    TurnRequest {
        system,
        turns: vec![ViewTurn { role: Role::User, content: idea.to_string() }],
        unseen: vec![],
        plan: false,
        access: Some(Access::Read),
        effort_override: None,
    }
}

/// The answer's JSON, also when the model wraps it in a sentence or a code
/// fence: the outermost object is taken.
pub(crate) fn parse(text: &str) -> Result<Persona, String> {
    #[derive(Deserialize)]
    struct Raw {
        name: Option<String>,
        persona: Option<String>,
    }
    let raw: Raw = serde_json::from_str(text.trim())
        .ok()
        .or_else(|| {
            let (start, end) = (text.find('{')?, text.rfind('}')?);
            serde_json::from_str(text.get(start..=end)?).ok()
        })
        .ok_or_else(|| "The AI didn't answer in the expected shape. Try again.".to_string())?;
    let name = raw.name.unwrap_or_default();
    let name = name.trim().trim_start_matches('@').split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.chars().take(NAME_LIMIT).collect::<String>().trim().to_string();
    if !name.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("The AI's answer had no usable name. Try again.".into());
    }
    let persona = raw.persona.unwrap_or_default().trim().to_string();
    if persona.is_empty() {
        return Err("The AI's answer had no persona. Try again.".into());
    }
    Ok(Persona { name, persona: persona.chars().take(PERSONA_LIMIT).collect() })
}

pub(crate) async fn draft_with(participant: &dyn Participant, idea: &str, taken: &[String]) -> Result<Persona, String> {
    let reply = tokio::time::timeout(TIMEOUT, participant.respond(request(idea, taken), &|_| {}))
        .await
        .map_err(|_| "The AI took too long to answer. Try again.".to_string())?
        .map_err(|error| error.to_string())?;
    parse(&reply.text)
}

/// Have `writer` write a name and persona from `idea`. `taken` are names
/// already in use, so the AI picks another.
pub async fn write(writer: ParticipantConfig, idea: String, taken: Vec<String>) -> Result<Persona, String> {
    let idea = idea.trim();
    if idea.is_empty() {
        return Err("Describe the agent you want first.".into());
    }
    if idea.chars().count() > IDEA_LIMIT {
        return Err(format!("Keep the description under {IDEA_LIMIT} characters."));
    }
    writer_ok(&writer)?;
    if let Backend::OpenAiCompatible { base_url, model, api_key_env } = &writer.backend {
        if let Some(name) = api_key_env {
            if apex_adapters::keys::lookup(name).is_none() {
                return Err("That AI's API key is missing on this machine.".into());
            }
        }
        if apex_adapters::api_model(base_url, api_key_env.as_deref(), model).await.is_some_and(|m| m.kind != apex_adapters::ModelKind::Text) {
            return Err("That model makes pictures or videos. Pick an AI that writes text.".into());
        }
    }
    let config = writer_config(writer);
    let participant: Box<dyn Participant> = match &config.backend {
        Backend::Agent { tool, .. } => {
            let tool = *tool;
            let scratch = std::env::temp_dir().join("apex-deck-persona-draft");
            std::fs::create_dir_all(&scratch).map_err(|e| format!("Could not make a scratch folder: {e}"))?;
            let context = apex_adapters::BuildContext { cwd: Some(scratch.clone()), path: crate::agents::login_path(), temp: Some(scratch), ..Default::default() };
            let cli = apex_adapters::CliParticipant::new(config).with_context(&context);
            // Claude Code has a verified tool-free mode; the other agents run read-only in an empty folder.
            Box::new(if tool == AgentTool::ClaudeCode { cli.with_tools_disabled() } else { cli })
        }
        _ => Box::new(apex_adapters::OpenAiCompatParticipant::new(config)),
    };
    draft_with(participant.as_ref(), idea, &taken).await
}
```

- [ ] **Step 4: Wire the command.** In `crates/apex-host/src/command.rs` add next to `GenerateImage { … }` in the enum:

```rust
    /// One of the person's AIs writes a name and persona for a new agent. Nothing is saved.
    PersonaDraft { writer: ParticipantConfig, idea: String, #[serde(default)] taken: Vec<String> },
```

and next to the `GenerateImage { … } =>` dispatch arm:

```rust
            PersonaDraft { writer, idea, taken } => reply(crate::persona_draft::write(writer, idea, taken).await?),
```

In `crates/apex-daemon/src/authority.rs`, next to `RoomCreate { .. } => full(Global),`:

```rust
        // Runs a model on the person's account, outside any thread.
        PersonaDraft { .. } => full(Global),
```

and in the test table next to the `room_create` row:

```rust
            ("persona_draft", Some((Full, "global")), json!({ "writer": { "id": "w", "display_name": "W", "backend": { "kind": "scripted", "lines": [] } }, "idea": "x" })),
```

- [ ] **Step 5: Run tests**

Run: `TMPDIR=/tmp cargo test -p apex-host persona_draft && TMPDIR=/tmp cargo test -p apex-daemon authority && cargo check --workspace --all-targets`
Expected: all pass, check clean.

- [ ] **Step 6: Live smoke test with the real Claude Code** (costs one small Claude turn). Add this ignored test to the module and run it once:

```rust
    #[tokio::test]
    #[ignore = "runs the real Claude Code"]
    async fn live_claude_writes_a_persona() {
        let got = write(agent(AgentTool::ClaudeCode), "a blunt reviewer who hunts security bugs".into(), vec!["Ada".into()]).await.unwrap();
        eprintln!("{got:?}");
        assert!(!got.persona.is_empty());
    }
```

Run: `TMPDIR=/tmp cargo test -p apex-host live_claude_writes_a_persona -- --ignored --nocapture`
Expected: PASS and a printed name + persona. Paste the printed result in your report.

- [ ] **Step 7: Commit**

```bash
git status --short
git add crates/apex-host/src/persona_draft.rs crates/apex-host/src/lib.rs crates/apex-host/src/command.rs crates/apex-daemon/src/authority.rs
git commit -m "feat(host): persona_draft writes a new agent's name and persona with one read-only turn"
```

---

### Task 2: `PersonaDraft` component and helpers (Luna)

**Files:**
- Create: `src/personaDraft.ts` (pure helpers, node-testable — value imports need the `.ts` extension, types use `import type`)
- Create: `src/PersonaDraft.tsx`
- Create: `src/persona-draft.css` (imported by `PersonaDraft.tsx`; do not edit `src/styles.css`)
- Test: `tests/persona-draft.test.mjs`

**Interfaces:**
- Consumes: `PersonaDraftResult`, `ParticipantConfig`, `AgentTool` from `src/types.ts`; `providerEnabled`, `providerForConfig` from `src/providers.ts`; `ProviderLogo` from `src/providerLogos.tsx` (prop `preset`, `label`).
- Produces (Task 4 relies on these exact names):
  - `export interface PersonaWriter { key: string; label: string; logo: string; config: ParticipantConfig }`
  - `export interface WriterPreset { key: string; label: string; tool: AgentTool; installed: boolean }`
  - `export function personaWriters(presets: WriterPreset[], profiles: ParticipantConfig[], disabled: readonly string[]): PersonaWriter[]`
  - `export function defaultWriter(writers: PersonaWriter[], preset: string): string` (returns a writer `key`, `""` when none)
  - `export function applyPersona(form: { name: string; persona: string }, result: PersonaDraftResult, lastName: string | null): { name: string; persona: string }`
  - `export class DraftRun { start(): number; cancel(): void; current(token: number): boolean }`
  - `export function PersonaDraft(props: { writers: PersonaWriter[]; preset: string; taken: string[]; form: { name: string; persona: string }; onApply: (next: { name: string; persona: string }) => void; write: (writer: ParticipantConfig, idea: string, taken: string[]) => Promise<PersonaDraftResult> }): JSX.Element`

- [ ] **Step 1: Write the failing tests** — `tests/persona-draft.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { personaWriters, defaultWriter, applyPersona, DraftRun } from '../src/personaDraft.ts';

const presets = [
  { key: 'claude_code', label: 'Claude Code', tool: 'claude_code', installed: true },
  { key: 'codex', label: 'Codex', tool: 'codex', installed: true },
  { key: 'gemini', label: 'Gemini CLI', tool: 'gemini', installed: false },
];
const saved = (id, backend, extra = {}) => ({ id, display_name: id, backend, persona: 'mine', access: 'full', effort: null, ...extra });

test('writers are installed, enabled agents, then saved chat agents', () => {
  const profiles = [
    saved('venice', { kind: 'open_ai_compatible', base_url: 'https://api.venice.ai/api/v1', model: 'llama', api_key_env: 'VENICE_API_KEY' }),
    saved('pics', { kind: 'open_ai_compatible', base_url: 'https://api.venice.ai/api/v1', model: 'flux', api_key_env: 'VENICE_API_KEY' }, { media: {} }),
    saved('script', { kind: 'scripted', lines: [] }),
    saved('cmd', { kind: 'cli', program: 'sh', args: [] }),
  ];
  const writers = personaWriters(presets, profiles, ['codex']);
  assert.deepEqual(writers.map((w) => w.key), ['agent:claude_code', 'saved:venice']);
  assert.deepEqual(writers[0].config.backend, { kind: 'agent', tool: 'claude_code', model: null });
  assert.equal(writers[1].logo, 'api');
});

test('writers never carry their own persona or more than read access', () => {
  const writers = personaWriters(presets, [saved('opus', { kind: 'agent', tool: 'claude_code', model: 'opus' })], []);
  for (const w of writers) {
    assert.equal(w.config.persona, '');
    assert.equal(w.config.access, 'read');
  }
});

test('a disabled provider hides saved agents that use it', () => {
  const writers = personaWriters(presets, [saved('opus', { kind: 'agent', tool: 'claude_code', model: 'opus' })], ['claude']);
  assert.deepEqual(writers.map((w) => w.key), ['agent:codex']);
});

test('default writer follows the form, else the first', () => {
  const writers = personaWriters(presets, [], []);
  assert.equal(defaultWriter(writers, 'codex'), 'agent:codex');
  assert.equal(defaultWriter(writers, 'ollama'), 'agent:claude_code');
  assert.equal(defaultWriter([], 'codex'), '');
});

test('applyPersona fills an empty name and replaces the persona', () => {
  assert.deepEqual(applyPersona({ name: '', persona: 'old' }, { name: 'Vex', persona: 'You are Vex.' }, null), { name: 'Vex', persona: 'You are Vex.' });
});

test('applyPersona keeps a name the person typed', () => {
  assert.deepEqual(applyPersona({ name: 'Mine', persona: '' }, { name: 'Vex', persona: 'p' }, null), { name: 'Mine', persona: 'p' });
});

test('applyPersona replaces a name the AI wrote last time', () => {
  assert.deepEqual(applyPersona({ name: 'Vex', persona: 'p' }, { name: 'Nova', persona: 'q' }, 'Vex'), { name: 'Nova', persona: 'q' });
});

test('a late answer after cancel is dropped', () => {
  const run = new DraftRun();
  const first = run.start();
  run.cancel();
  assert.equal(run.current(first), false);
  const second = run.start();
  assert.equal(run.current(second), true);
  assert.equal(run.current(first), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test tests/persona-draft.test.mjs`
Expected: FAIL, cannot find `src/personaDraft.ts`.

- [ ] **Step 3: Implement `src/personaDraft.ts`**

```ts
// Who can write a new agent's persona, and how the answer fills the form.
import type { AgentTool, ParticipantConfig, PersonaDraftResult } from "./types";
import { providerEnabled, providerForConfig } from "./providers.ts";

export interface WriterPreset { key: string; label: string; tool: AgentTool; installed: boolean }
export interface PersonaWriter { key: string; label: string; logo: string; config: ParticipantConfig }

/** The writer runs read-only with none of its own character (the daemon enforces this too). */
function asWriter(config: ParticipantConfig): ParticipantConfig {
  return { ...config, persona: "", access: "read", auto_effort: false };
}

/** Installed, enabled coding agents on their default model, then saved chat agents whose provider is enabled. */
export function personaWriters(presets: WriterPreset[], profiles: ParticipantConfig[], disabled: readonly string[]): PersonaWriter[] {
  const agents = presets
    .filter((p) => p.installed && providerEnabled(p.key, disabled))
    .map((p) => ({
      key: `agent:${p.tool}`,
      label: p.label,
      logo: p.key,
      config: asWriter({ id: `writer-${p.tool}`, display_name: p.label, backend: { kind: "agent", tool: p.tool, model: null }, persona: "", access: "read", effort: null }),
    }));
  const savedAgents = profiles
    .filter((p) => (p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible") && !p.media && providerEnabled(providerForConfig(p), disabled))
    .map((p) => ({ key: `saved:${p.id}`, label: `${p.display_name} (saved)`, logo: providerForConfig(p), config: asWriter(p) }));
  return [...agents, ...savedAgents];
}

/** The form's chosen provider when it can write, else the first writer. */
export function defaultWriter(writers: PersonaWriter[], preset: string): string {
  return writers.find((w) => w.key === `agent:${preset}`)?.key ?? writers[0]?.key ?? "";
}

/** The persona is always replaced; the name only when empty or still the AI's last one. */
export function applyPersona(form: { name: string; persona: string }, result: PersonaDraftResult, lastName: string | null): { name: string; persona: string } {
  const keepName = form.name.trim() !== "" && form.name !== lastName;
  return { name: keepName ? form.name : result.name, persona: result.persona };
}

/** Each Write it gets a token; Cancel or a newer run makes older answers stale. */
export class DraftRun {
  private latest = 0;
  start(): number { return ++this.latest; }
  cancel(): void { this.latest++; }
  current(token: number): boolean { return token === this.latest; }
}
```

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test tests/persona-draft.test.mjs`
Expected: 8/8 PASS.

- [ ] **Step 5: Implement `src/PersonaDraft.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { ParticipantConfig, PersonaDraftResult } from "./types";
import { ProviderLogo } from "./providerLogos";
import { applyPersona, defaultWriter, DraftRun, type PersonaWriter } from "./personaDraft";
import "./persona-draft.css";

type Form = { name: string; persona: string };

export function PersonaDraft({ writers, preset, taken, form, onApply, write }: {
  writers: PersonaWriter[];
  preset: string;
  taken: string[];
  form: Form;
  onApply: (next: Form) => void;
  write: (writer: ParticipantConfig, idea: string, taken: string[]) => Promise<PersonaDraftResult>;
}) {
  const [idea, setIdea] = useState("");
  const [writerKey, setWriterKey] = useState(() => defaultWriter(writers, preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ by: string; before: Form; name: string } | null>(null);
  const run = useRef(new DraftRun());
  // A late answer must never land in a closed form.
  useEffect(() => () => run.current.cancel(), []);
  useEffect(() => { if (!writers.some((w) => w.key === writerKey)) setWriterKey(defaultWriter(writers, preset)); }, [writers, preset, writerKey]);

  const writer = writers.find((w) => w.key === writerKey);
  const go = async () => {
    if (!writer || !idea.trim() || busy) return;
    const token = run.current.start();
    setBusy(true); setError("");
    try {
      const result = await write(writer.config, idea.trim(), taken);
      if (!run.current.current(token)) return;
      onApply(applyPersona(form, result, done?.name ?? null));
      setDone({ by: writer.label, before: form, name: result.name });
    } catch (e) {
      if (run.current.current(token)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run.current.current(token)) setBusy(false);
    }
  };
  const cancel = () => { run.current.cancel(); setBusy(false); };
  const undo = () => { if (done) { onApply(done.before); setDone(null); } };

  if (writers.length === 0) {
    return <div className="persona-draft wide off"><span className="field-title">Describe the agent you want</span>
      <p className="hint">Install or turn on an AI in Providers to use this.</p></div>;
  }
  return (
    <div className="persona-draft wide">
      <label className="field-title" htmlFor="persona-idea">Describe the agent you want</label>
      <textarea id="persona-idea" value={idea} rows={2} disabled={busy}
        placeholder="e.g. a blunt reviewer who hunts security bugs in TypeScript"
        onChange={(e) => setIdea(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); } }} />
      <div className="persona-draft-row">
        <span className="persona-draft-by">Written by</span>
        {writer && <ProviderLogo preset={writer.logo} label={`${writer.label} logo`} />}
        <select aria-label="Written by" value={writerKey} disabled={busy} onChange={(e) => setWriterKey(e.target.value)}>
          {writers.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        {busy && <button type="button" className="link" onClick={cancel}>Cancel</button>}
        <button type="button" className="persona-draft-go" disabled={busy || !idea.trim()} onClick={() => void go()}>{busy ? "Writing…" : "Write it"}</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {done && !busy && !error && <p className="persona-draft-done">Written by {done.by}. Check it above.
        <button type="button" className="link" onClick={undo}>Undo</button> · <button type="button" className="link" onClick={() => void go()}>Try again</button></p>}
    </div>
  );
}
```

Check `ProviderLogo`'s real prop names in `src/providerLogos.tsx` before using it, and whether the form already has a `.link` button style (`grep -n "\.link\b" src/styles.css`); if not, define `.persona-draft .link` in the new CSS.

- [ ] **Step 6: Implement `src/persona-draft.css`** — match the form's existing tokens (`--panel`, `--accent`, `--border`/`--line`, `--muted`; check which exist with `grep -n "^\s*--" src/styles.css | head -40`). Shape: a quiet inset box (1px border, 10px radius, 10–12px padding, 8px gap), textarea full width, one row with the label, a 20px logo, the select, and the Write it button pushed right (`margin-left: auto`) using the accent color. `.off` dims the box. No new colors outside the existing variables.

- [ ] **Step 7: Render and look.** Make a standalone harness (outside the repo, e.g. `/tmp/persona-draft-shot/`) that renders `PersonaDraft` with the real `styles.css` + `persona-draft.css` inside a `.add-form`-styled container at 560px and 320px wide, in four states: idle, writing, done (with Undo · Try again), error, plus the no-writers state. Screenshot with headless Chrome and look at every state. Fix anything that wraps badly, overflows, or doesn't match the form around it. Put the screenshot path in your report.

- [ ] **Step 8: Type check and commit**

Run: `npx tsc --noEmit && node --experimental-strip-types --test tests/persona-draft.test.mjs`
Expected: clean, 8/8.

```bash
git status --short
git add src/personaDraft.ts src/PersonaDraft.tsx src/persona-draft.css tests/persona-draft.test.mjs
git commit -m "feat(ui): PersonaDraft box writes a new agent's name and persona with one of your AIs"
```

---

### Gate: commit Jigga's pending work (Jigga, needs the Human's go)

Jigga commits the uncommitted Agents-pane fix and merge repair (`src/ChatPane.tsx`, `src/backend.ts`, `src/styles.css`) plus the `PersonaDraftResult` type in `src/types.ts`, staging only those files. Jigga posts the commit hash in the chat. Tasks 3 and 4 do not start before that message.

---

### Task 3: Frontend plumbing (Muck, after Task 1 and the Gate)

**Files:**
- Modify: `src/backend.ts` (interface method + browser stand-in)
- Modify: `src/commandBackend.ts`
- Test: `tests/command-backend.test.mjs`

**Interfaces:**
- Consumes: wire command `persona_draft` from Task 1; `PersonaDraftResult` from `src/types.ts`.
- Produces: `Backend.personaDraft(writer: ParticipantConfig, idea: string, taken: string[]): Promise<PersonaDraftResult>`.

- [ ] **Step 1: Failing test** — add to the `COMMANDS` table in `tests/command-backend.test.mjs`:

```js
  ['personaDraft', [participant, 'a reviewer', ['Ada']], 'persona_draft', { writer: participant, idea: 'a reviewer', taken: ['Ada'] }],
```

Run: `node --experimental-strip-types --test tests/command-backend.test.mjs`
Expected: FAIL, `personaDraft` is not a function.

- [ ] **Step 2: Implement.** In the `Backend` interface in `src/backend.ts`, after `agentModels(…)`:

```ts
  /** Have `writer` write a name and persona for a new agent from `idea`. `taken` are names already in use. Nothing is saved. */
  personaDraft(writer: ParticipantConfig, idea: string, taken: string[]): Promise<PersonaDraftResult>;
```

(add `PersonaDraftResult` to the existing `import type { … } from "./types"`). In the browser stand-in, after `agentModels: async () => [],`:

```ts
    personaDraft: async (_writer, idea) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { name: "Sketch", persona: `You are Sketch, a stand-in written by the browser demo for: ${idea.trim().slice(0, 80)}` };
    },
```

In `src/commandBackend.ts`, after `agentModels`:

```ts
    personaDraft: (writer, idea, taken) => call<PersonaDraftResult>("persona_draft", { writer, idea, taken }),
```

Then run `npx tsc --noEmit`; if any other object implements `Backend` (the compiler will name it), give it the same method, forwarding to its inner backend where it wraps one.

- [ ] **Step 3: Run tests**

Run: `npx tsc --noEmit && node --experimental-strip-types --test tests/command-backend.test.mjs`
Expected: clean, all pass.

- [ ] **Step 4: Commit** — `src/backend.ts` is Jigga's committed file by now; check `git diff src/backend.ts` shows only your lines before staging.

```bash
git status --short
git diff src/backend.ts
git add src/backend.ts src/commandBackend.ts tests/command-backend.test.mjs
git commit -m "feat(backend): personaDraft calls persona_draft"
```

---

### Task 4: Put the box in the add-agent form (Luna, after Tasks 2, 3 and the Gate)

**Files:**
- Modify: `src/ChatPane.tsx` (import + one insertion in `modelForm`, directly below the Persona label)

**Interfaces:**
- Consumes: everything Task 2 produces; `backend.personaDraft` from Task 3; existing `PRESETS`, `installed(p)`, `profiles`, `participants`, `disabledProviders`, `draft`, `setDraft`, `editing` in `ChatPane`.

- [ ] **Step 1: Insert** — add the import next to the `AgentPicker` import:

```tsx
import { PersonaDraft } from "./PersonaDraft";
import { personaWriters } from "./personaDraft";
```

and inside `modelForm`, directly below the Persona `<label className="wide">…</label>` and above `{formError && …}`:

```tsx
          {!editing && <PersonaDraft
            writers={personaWriters(
              PRESETS.flatMap((p) => p.agent ? [{ key: p.key, label: p.label.replace(/ \(.*\)$/, ""), tool: p.agent.tool, installed: installed(p) }] : []),
              profiles, disabledProviders)}
            preset={draft.preset}
            taken={[...new Set([...profiles, ...participants].map((p) => p.display_name))]}
            form={{ name: draft.name, persona: draft.persona }}
            onApply={(next) => setDraft((d) => ({ ...d, name: next.name, persona: next.persona }))}
            write={(writer, idea, taken) => backend.personaDraft(writer, idea, taken)}
          />}
```

If `installed` or `setDraft` have different names at that point in the file, use the real ones (`installed` is defined at `ChatPane.tsx:561`).

- [ ] **Step 2: Type check and tests**

Run: `npx tsc --noEmit && npm test`
Expected: clean; only the 11 known `monitor-attention-integration` failures.

- [ ] **Step 3: Render the real form and look.** With the browser stand-in (`npm run dev` at `:5391`, headless Chrome): Agents tab → + New agent, type an idea, press Write it, wait for the stand-in's answer. Screenshot idle, writing, and done. Check: the box sits below Persona inside the form, the Name and Persona boxes fill, Undo puts them back, the Agents pane still doesn't page-scroll. Repeat in a chat's + Add model form. Put screenshot paths in your report.

- [ ] **Step 4: Commit** — check `git diff src/ChatPane.tsx` shows only your lines.

```bash
git status --short
git diff src/ChatPane.tsx
git add src/ChatPane.tsx
git commit -m "feat(ui): describe-it box in the add-agent form"
```

---

### Task 5: Review and live test (Jigga)

- [ ] Review the four commits against this plan and the Review Focus list.
- [ ] `TMPDIR=/tmp cargo test -p apex-host persona_draft`, `npx tsc --noEmit`, `npm test`.
- [ ] `npm run desktop:dev` with its own `APEX_DECK_DATA_DIR` (never the installed app's data): write a persona with Claude Code, one other installed agent, and a saved API agent; try Cancel mid-run and Undo.
- [ ] Report to the Human with screenshots; no push or merge without their go.

## Later (not in this plan)

- Rewriting an existing agent's persona from the edit form.
- Suggesting effort/access along with the persona.
- The phone app.
