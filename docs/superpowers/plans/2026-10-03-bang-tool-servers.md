# `!server`: name a tool server in a message

Written 2026-10-03 by Jigga for Null. **Active (rewritten 2026-10-03).** An earlier version was parked by mistake when the human chose servers-on-by-default; the human did want `!` with autocomplete. Servers stay on, so `!` no longer loads or unloads anything. It's a shortcut that names a server and tells the model to use it.

## What the human types

```
@null !x-mcp read WiseUp2RiseUp's last five posts
!hyper_mcp what's the Arcane Digital balance?      (goes to the last-addressed model)
@all !x-mcp !hyper_mcp compare notes
```

- `@` picks **who** answers (unchanged). `!` names **which tool server to use**. The model still decides which tools to call.
- Every server stays loaded on every turn (human decision 4). `!` doesn't change what's loaded.
- Deck adds one line to that turn's prompt: `The human asked you to use these tool servers: x-mcp.` The `!name` text also stays in the message.

## Autocomplete (the main deliverable)

- Typing `!` at the start of the text or after whitespace opens the composer menu (`src/composerMenu.ts`, same trigger and keyboard handling as `@`).
- The menu lists the servers of the target agent(s): the @mentioned ones, or the last-addressed one when there's no @mention. Each row shows the server name and the agent badge. Filter by typed prefix using the normalised match below.
- Selecting a row inserts `!name ` (the agent's own spelling, e.g. `!x-mcp`, `!Hyper MCP` → insert `!hyper-mcp`, i.e. lowercase with spaces as `-`).
- If the list hasn't loaded yet, the menu shows `Loading Null's tool servers…`; if it failed, `Couldn't list Null's tool servers`.
- Footer hint: `@ who answers · ! which tools`.
- In sent messages, `!name` renders as a small chip like mentions (`RichText.tsx`).

## Where the server list comes from

- **Codex:** `codex_policy` (`crates/apex-adapters/src/mcp.rs`) already reads the server inventory for approvals. Expose the same inventory (names only).
- **Claude:** server names from the init event (`mcp_servers`) of the agent's latest turn; cache per agent. Before any turn has run, launch nothing extra: show `Send a message to Claude once to load its tool servers` in the menu. (If Claude has a cheap list command that matches what Deck loads, use it instead; check first.)
- New Tauri command `list_tool_servers(agent_id) -> Vec<String>`, cached per agent, refreshed after each turn. Browser-preview mock returns a fixed list (`x-mcp`, `hyperliquid`, `computer-use`).
- Never read config files or tokens (MCP plan rule).

## Parsing rules

- `!` counts only at the start of the text or after whitespace, followed by a name (`[A-Za-z0-9._-]+`). `wow!`, `!=`, `![img](…)` and `!!` are not server requests.
- Ignored inside inline code and fenced code blocks.
- Matching is case-insensitive and ignores `-`, `_`, `.` and spaces, so `!hyper_mcp`, `!hypermcp` and `!Hyper-MCP` all match `Hyper MCP`, and `!computeruse` matches `computer-use`.
- Matched per target agent against that agent's own list (Claude `Hyper MCP`, Codex `hyperliquid`).
- `\!name` is literal text.

## When a name doesn't match

- **No target agent has it** (`!x-mpc`): the composer doesn't send, underlines the name and shows `No tool server called "x-mpc" for Null`. Escape with `\!`.
- **Some targets have it** (`@all !x-mcp`): send; agents without it get the prompt line `x-mcp isn't available to you in Deck`.
- **List unavailable:** send anyway (servers are on, nothing is loaded by `!`), no underline, and the prompt line still names the server. Don't block the human on a listing failure.

## Safety

- Nothing changes: `!` doesn't load, enable or allow anything. Trading/publishing tools still go through the approval cards on `feat/mcp-tool-approvals`, every call, even at Full access.
- During development and testing, don't call MCP/plugin write tools (human instruction).

## Code

- `crates/apex-core/src/server_request.rs`: `parse_server_requests(text) -> Vec<String>` and `resolve(names, known) -> Resolved { matched, unknown }`. Pure. Mirrors `mention.rs`.
- `src/serverRequests.ts`: same parse for the menu and the unknown-name check. Rust is authoritative on send.
- Turn builder in `src-tauri/src/lib.rs` adds the prompt line.

## Commits (tests pass after each)

1. **Parser** (`server_request.rs`, `serverRequests.ts`) + tests: start/whitespace rule, code spans, `wow!`, `![img]`, `\!`, normalisation, duplicates.
2. **Server list:** `list_tool_servers` for Codex and Claude, cache, mock backend.
3. **Composer:** `!` menu with autocomplete, unknown-name block, chips, footer hint. Tests in the style of `tests/composer-menu.test.mjs`.
4. **Turn wiring:** prompt line, `Message.servers` (`#[serde(default)]`) so retry, `/fork` and `/export` keep it.

Commits 1 and 3 can ship first with the mock list if 2 needs more digging, so the human sees autocomplete in the browser preview quickly.

## Done when (desktop app, real CLIs)

- Typing `@null !x` shows `x-mcp` (and other `x…` servers); Enter inserts `!x-mcp `.
- `@null !x-mcp read my posts` works and the prompt line names x-mcp.
- `!x-mpc` (typo) doesn't send and is underlined.
- `wow! that's great` sends normally with no menu and no chip.

## Human decisions (2026-10-03)

1. ~~A turn without `!` loads no servers.~~ Superseded by 4.
2. No temporary read-only filter; trading/publishing tools ask via approval cards.
3. Finish per-participant turns first (done).
4. Servers stay **on** by default.
5. `!` autocomplete is wanted ("That's what I asked!"). Not parked.
