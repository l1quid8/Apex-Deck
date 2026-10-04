# `!server`: name a tool server in a message

Written 2026-10-03 by Jigga for Null to build on `feat/thread-commands`. Builds on `2026-10-03-mcp-safety.md` (listing, per-turn enforcement, approvals). Pinned rule still applies: servers off by default, trading and publishing tools ask even with Full access.

## What the human types

```
@null !x-mcp read WiseUp2RiseUp's last five posts
!hyper_mcp what's the Arcane Digital balance?      (goes to the last-addressed model)
@all !x-mcp !hyper_mcp compare notes
```

- `@` picks **who** answers (unchanged). `!` picks **which tool servers that turn loads**. The model still decides which tools to call.
- A `!name` loads that server **for the turn this message starts, and only that turn**. The next message without `!` loads nothing again (unless the thread sidebar has the server switched on, MCP plan commit 3).
- This is how off-by-default stays usable: you don't have to open the sidebar to use a server once.

## Parsing rules

- `!` counts only at the start of the text or after whitespace, followed by a name (`[A-Za-z0-9._-]+`). So `wow!`, `!=`, `![img](…)` and `!!` are not server requests.
- Ignored inside inline code and fenced code blocks (same rule should apply to `@` mentions; add the same test there).
- Matching is case-insensitive and ignores `-`, `_`, `.` and spaces on both sides, so `!hyper_mcp`, `!hypermcp` and `!Hyper-MCP` all match Claude's `Hyper MCP`, and `!computeruse` matches `computer-use`.
- Names are matched **per target agent**, against that agent's own server list. Claude calls it `Hyper MCP`, Codex calls it `hyperliquid`; each is matched separately.
- `\!name` is literal text.
- The `!name` text stays in the message the model sees, and Deck adds one line to that turn's prompt: `The human asked you to use these tool servers: x-mcp.`

## When a name doesn't match

- **No target agent has it:** the composer doesn't send. It underlines the name and shows `No tool server called "x-mpc" for Null`. The human fixes it or escapes it with `\!`. A typo must never silently run the turn without the tool, or with a different one.
- **Some targets have it, some don't** (`@all !x-mcp`): send. Agents without it run normally, and their turn gets the prompt line `x-mcp isn't available to you in Deck`.
- **Server list can't be fetched** (MCP plan rule 2, fail closed): the composer says `Couldn't list Null's tool servers` and doesn't send a message containing `!`.

## Safety (nothing here bypasses the MCP plan)

- `!` only adds servers to the turn's enabled set: `turn servers = thread servers ∪ !servers`. Enforcement is the MCP plan's per-turn mechanism (Claude `--disallowedTools mcp__<other>` + `ask` rules; Codex `-c mcp_servers.<other>.enabled=false`).
- **Until approval cards exist (MCP plan commit 4), `!` servers are read-only.** Tools whose names hit the MCP plan's rule 4 list (`order`, `trade`, `cancel`, `post`, `publish`, `send`, `delete`, `leverage`, …) are removed for the turn, not allowed (rule 5). This turns the human's "don't trigger any write tools" from a request to the model into something Deck enforces.
  - Claude: tool names come from the init event cache, so this is `--disallowedTools mcp__<server>__<tool>` per matching tool.
  - Codex: needs the tool names per server. **Check X4** (before building): does `codex mcp` or the app server expose a server's tool list? If not, use `enabled_tools` per server with an allowlist built from the first turn's tool list, or keep the whole server off until approvals land.
- After commit 4, those tools stop being removed and instead ask every time, with no "Always allow".
- Queued messages keep their own `!` set. Steering a running turn with a `!` message doesn't add servers mid-turn; the composer says `!x-mcp applies from Null's next turn`.

## UI

- Typing `!` opens the composer menu (`src/composerMenu.ts`, same trigger pattern as `@`): server names for the target agent(s), each with its agent badge and status (`connected`, `needs login`). Selecting one inserts `!name `.
- In sent messages, `!name` renders as a small chip, like mentions (`RichText.tsx`).
- While a turn runs, the participant chip shows the loaded servers on hover: `Null · x-mcp, hyperliquid`.
- Hint text in the composer menu footer: `@ who answers · ! which tools`.

## Data

- `Message` gets `#[serde(default)] servers: Vec<String>`: the resolved server names, per target, stored so retry, `/fork` and `/export` reproduce the same turn. Export lists names only.

## Code

- `crates/apex-core/src/server_request.rs`: `parse_server_requests(text) -> Vec<String>` (raw names) and `resolve(names, known: &[String]) -> Resolved { matched, unknown }`. Pure, no I/O. Mirrors `mention.rs`.
- Frontend `src/serverRequests.ts`: the same parse for the menu and the unknown-name check. The Rust side is authoritative on send.
- Turn builder (`src-tauri/src/lib.rs`, the per-turn launch path from per-participant turns stage 1) passes the resolved set to the MCP enforcement arguments.

## Commits (tests pass after each)

Depends on MCP plan commits 2 (listing) and 3 (per-turn enforcement). Do those first; they're needed anyway.

1. **Parser:** `server_request.rs` + tests (start/whitespace rule, code spans, `wow!`, `![img]`, `\!`, normalisation, per-agent matching, duplicates). No behaviour change.
2. **Turn wiring:** resolve on send, store `servers` on the message, union with thread servers, read-only removal of rule-4 tools, the prompt line. Tests for the argument sets per CLI and for fail-closed paths.
3. **Composer:** `!` menu, unknown-name block, chips, hover list, browser-preview mock backend.
4. **After MCP approvals:** swap "removed" for "always asks" on rule-4 tools.

## Done when (desktop app, real CLIs)

- `@null !x-mcp read my posts` works; the next message without `!` has no x-mcp tools (ask Null to list its MCP tools: none).
- `!hyper_mcp balance` on Claude: read tools work, `place_order` isn't in the tool list.
- `!x-mpc` (typo) doesn't send.
- `wow! that's great` sends normally with no server loaded.

## Human decisions (2026-10-03)

1. Yes: a turn without `!` should load no tool servers.
2. No: do not implement the proposed temporary removal of write/trading/publishing tools. Keep the approval requirement for trading/publishing from the pinned MCP plan; implement approval support before exposing these tools through `!` rather than adding a temporary read-only phase.
3. Finish the earlier per-participant turns plan first, in FIFO order. MCP listing/switching and `!` remain later work.

These decisions supersede the temporary read-only staging described above. They do not authorize calling MCP/plugin write tools during development or testing.
