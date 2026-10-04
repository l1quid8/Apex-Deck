# `/mcp`: servers on by default, approval for money and publishing

Written 2026-10-03 by Jigga for Null to build on `feat/thread-commands`, after the per-participant turns work. Human decision (2026-10-03, supersedes the earlier off-by-default rule): **servers stay on by default.** Trading and publishing tools always ask, even with Full access.

## Why it matters now

Every agent Deck starts today loads every MCP server its CLI knows about. Nothing in `presets.rs` mentions MCP.

- Codex (`codex mcp list --json`, checked 2026-10-03): 11 servers, including `hyperliquid`, `robinhood-trading`, `x-mcp`, `x-publisher_mcp`, `x-nitter_mcp`, plus plugin servers (`computer-use`, `cua_repl`, `node_repl`, …).
- Claude Code (init event, checked 2026-10-03): the claude.ai connectors `Hyper MCP`, `Robinhood Agentic`, `Google Drive`, `Instacart`, `Claude Docs`, plus plugin servers.
- With Full access (`danger-full-access` / `bypassPermissions`) these tools run without asking.
- **Read access doesn't protect against this either.** Read mode only removes file and shell tools (`--disallowedTools Edit,Write,NotebookEdit,Bash`; Codex `--sandbox read-only`). A read-only agent can still call `place_order` today, because the sandbox only limits local files and commands, not remote MCP calls.

## What I checked (2026-10-03, Claude Code 2.1.288, codex-cli 0.160.0)

| Question | Result |
|---|---|
| Does `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` also drop claude.ai connectors? | **Yes.** The init event lists no MCP servers or tools at all; connectors and plugin servers are all gone. This answers the open question from the open-work doc. |
| Can one Claude server be switched off by name? | **Yes.** `--disallowedTools mcp__claude_ai_Hyper_MCP,mcp__claude_ai_Robinhood_Agentic` removed exactly those two servers' tools and kept the rest. |
| Do `ask` rules still apply under `bypassPermissions`? | **Yes.** `--permission-mode bypassPermissions --settings '{"permissions":{"ask":["mcp__…__search_products"]}}'` denied the call in `-p` mode (`permission_denials` lists it). With the stdio prompt tool it should reach Deck as a `can_use_tool` request instead; see check C1. |
| Does Codex support per-tool approval for MCP? | The binary contains `default_tools_approval_mode`, `approval_mode`, `enabled_tools`, `disabled_tools` and the app-server request `mcpServer/elicitation/request`. Exact values and behaviour are not yet confirmed; see check X1–X3. |
| Can Deck list servers without reading config files? | Codex: `codex mcp list --json` (fields `name`, `enabled`, `auth_status`, `transport`, …). Claude: `claude mcp list` is text only and slow (it health-checks every server). |

## Rules

1. **On by default.** A new thread loads every server the agent's CLI has enabled. The human can switch servers off per agent, per thread.
2. **Fail closed.** If Deck can't tell which servers exist (listing fails or times out), the agent runs with **no** MCP servers. It never falls back to "everything".
3. **Read tools run without asking; risky tools ask.** Tools matching rule 4 ask before every call, at every access level, Full included. Other tools run normally. (Changed from "every tool asks" because servers are now on by default; asking on every read would make them unusable.)
4. **Some tools can never be trusted.** If a tool name contains `order`, `trade`, `buy`, `sell`, `swap`, `transfer`, `withdraw`, `deposit`, `leverage`, `cancel`, `post`, `tweet`, `publish`, `send`, `reply`, `delete` or `exercise`, it asks every time and the "Always allow" option isn't shown. Better to over-match: a read tool that matches by accident just asks.
5. **If a CLI can't ask, the tool is removed rather than allowed.** For example, if Codex `exec` can't prompt for MCP calls, the gated tools are disabled for that turn and the agent is told they're unavailable.
6. **Deck never reads secrets.** It doesn't open `~/.codex/config.toml`, `~/.claude.json`, `.mcp.json` or any token store, and it doesn't pass server definitions through. From the CLI listings it keeps only the server name, enabled flag and status. It drops `transport`, which can contain env names, URLs and headers.

## Enforcement per CLI

### Claude Code (`presets.rs`, `claude_session.rs`)

- **No servers enabled** (the default): `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. This is verified to remove everything, so Deck doesn't need to know the server names.
- **Some servers enabled:**
  - Don't use strict mode. Claude can't be handed a connector's definition, and Deck mustn't copy server definitions anyway.
  - Add `--disallowedTools mcp__<name>` for every **other** known server.
  - Add `--settings '{"permissions":{"ask":["mcp__<enabled>"]}}'`, with `allow` entries for trusted tools.
  - Always run these turns through the two-way session (`--input-format stream-json --permission-prompt-tool stdio`), even with Full access. Keep `--permission-mode` as it is for the access level (`bypassPermissions` for Full), so files and commands behave exactly as they do now.
- "Known servers" comes from the last init event Deck saw for that agent (`mcp_servers[].name` and the `mcp__*` tool prefixes), cached per tool. Rule 2 applies: if no list is cached, a turn that should have servers enabled runs strict and empty, and Deck shows "Couldn't list MCP servers".
- Gap: a server added after the cache was filled wouldn't be in the disallow list. Fix: when the init event shows a server that isn't enabled and isn't in the disallow list, Deck stops the turn before the first tool call, refreshes the cache and restarts the turn. This only happens when at least one server is enabled.

### Codex (`presets.rs`, `codex_server.rs`)

- Run `codex mcp list --json` before each turn. It's fast; cache it for 60 s. Parse only `name` and `enabled`.
- For every server that isn't enabled for this thread: `-c mcp_servers.<name>.enabled=false`. Quote the name as a TOML key if it isn't a bare key.
- If the listing fails: don't start the turn. Post "Couldn't list Codex MCP servers, so this turn didn't run." `--ignore-user-config` would also drop the user's model and profile settings, so it isn't a fallback.
- **Servers enabled:** run the turn through the app server (the path Ask already uses) at every access level. Keep the same sandbox mapping. Set `-c mcp_servers.<name>.default_tools_approval_mode="<ask value>"` per enabled server, with the auto value for trusted tools. MCP approval requests become Deck approvals (see below).
- If X2 shows the app server can't ask for MCP calls under `approvalPolicy: "never"`: run gated servers with `disabled_tools` for every tool that isn't trusted. Rule 5 applies.

### Gemini

Out of scope. Gemini agents always get no MCP servers (check G1 for the flag). The sidebar shows "MCP not supported for Gemini yet".

## Approvals

- `crates/apex-core/src/approval.rs`: add `ActionKind::Tool`. The title is `"<Server>: <tool>"` and the detail is the arguments as pretty-printed JSON, shown verbatim and never summarised.
- The approval card for a tool shows the server, tool and arguments. It has Approve and Reject, plus "Always allow in this thread" when rule 4 allows it.
- A trusted tool is saved on the thread (see Data) and takes effect from that agent's next turn.
- Targeted Stop (`reject_for`, stage 1 of per-participant turns) already rejects a stopped agent's pending tool approvals. Keep it that way.
- An unanswered approval never times out to Approve.

## Data

On `SavedRoom` (`src-tauri/src/storage.rs`), per participant, with defaults so old rooms load as "everything the CLI enables":

```rust
#[serde(default)]
pub mcp: HashMap<ParticipantId, McpChoice>,

#[derive(Default, Serialize, Deserialize)]
pub struct McpChoice { pub disabled: Vec<String> }
```

- `/fork` copies the MCP choice. `/export` lists the enabled server names only.
- Cached server lists live in memory only.

## UI: MCP section in the thread sidebar (`ThreadDetails.tsx`)

- One collapsible "MCP" section with a row per agent: `Null · Codex — 0 of 11 on`.
- Expanding a row lists the servers by name and status (connected / needs auth / disabled in CLI), each with a switch. Servers the CLI itself has disabled are shown greyed out and can't be switched on here.
- Trusted tools are listed under their server with a remove button.
- `/mcp` in the composer opens this section. It doesn't post anything, which is consistent with the slash-command rule ("creates something or takes text you'd type anyway"): `/mcp` is the only way to reach a setting that has no other shortcut. If you'd rather not bend that rule, drop the slash command and keep the section. **Human to decide.**
- A participant chip shows a small plug icon when that agent has any server on.

## Checks to run before building (no code)

- **C1** Claude: `bypassPermissions` + `--permission-prompt-tool stdio` + an `ask` rule. Does the call arrive as `can_use_tool` and run after allow? Test with `Instacart search_products` or a Google Drive read, never a trading tool.
- **C2** Claude: does `--settings` JSON on the command line merge with the user's settings, or replace their `permissions`? Merging is fine either way, but confirm user `deny` rules still apply.
- **X1** Codex: valid values for `default_tools_approval_mode` / `approval_mode` (likely `auto` / `prompt` / `approve`). Check `codex` docs or `-c` with `--strict-config`.
- **X2** Codex app server: which request carries an MCP approval (`mcpServer/elicitation/request` or `item/tool/requestApproval`), its params, and whether it is sent under `approvalPolicy: "never"`.
- **X3** Codex `exec`: what happens to a `prompt` tool with no one to ask (declined, or run anyway?). If it runs anyway, rule 5 applies, and this is the reason the app server is required.
- **G1** Gemini: `--allowed-mcp-server-names` with a name that matches no server, to switch MCP off.

Test only against Instacart search, Google Drive reads or other harmless tools. If a trading or publishing tool has to be tested, **reject** the approval; never approve it.

## Commits

Each commit leaves all tests passing.

1. **Off for everyone** (the urgent part, small): Claude always strict and empty; Codex disables every listed server and refuses the turn if listing fails; Gemini off. No UI. Preset tests updated (`presets.rs` command-line tests). This alone closes the Full-access trading risk.
2. **Listing:** `mcp_servers(tool)` Tauri command (Codex JSON plus the Claude init-event cache), names and status only, with a unit test that `transport` is dropped.
3. **Per-thread choice + enforcement:** the `McpChoice` storage, the enabled/disallow/ask arguments, the Codex app-server routing, and the init-event check for unknown servers. Tests for each argument combination and for the fail-closed paths.
4. **Tool approvals:** `ActionKind::Tool`, the Claude `can_use_tool` and Codex MCP request mapping, trusted tools and the rule 4 name filter. Tests for the filter and for "never trusted" names.
5. **Sidebar section, `/mcp`, chip icon,** plus the browser-preview mock backend.

## Done when (desktop app, real CLIs)

- In a new thread, a Full-access Codex agent and a Full-access Claude agent each report no MCP tools when asked to list them.
- After switching on Instacart for the Claude agent only, it can search but gets an approval card first. "Always allow" works and survives an app restart. Codex still has no MCP tools.
- After switching on `hyperliquid` for the Codex agent and asking for a tiny order, an approval card appears with the full arguments and no "Always allow". **Reject** leaves no order (check `get_open_orders`).
- Stopping that agent while the card is open rejects the card.

## Order relative to other work

Per-participant turns stages 2–5 come first, as planned. Commit 1 here could be done first if the Human wants it now: it touches only `presets.rs` and its tests, and doesn't conflict with the turn-scheduling files.

## Implementation checkpoint — Null, 2026-10-03

Urgent stage 1 implemented, uncommitted. Existing scheduling work is preserved.

- Claude: strict empty MCP configuration at every access level.
- Gemini: `--allowed-mcp-server-names __apex_deck_no_mcp_servers__`; flag confirmed against official CLI source. Gemini is not installed here, so live verification is pending.
- Codex: discovery has a 10-second timeout, runs in the turn's workspace/PATH, and fails closed without printing discovery output. Both app-server and exec receive the same disable arguments.
- Ruling: this also touches `cli.rs` and adapter integration tests because app-server bypasses presets. Presets-only enforcement would miss the normal Codex turn path.
- Ruling: turn-local `features.plugins=false` and `features.apps=false` are required before discovery and launch. Plugin-derived servers do not necessarily have transport definitions; setting an enabled override for them creates an invalid configuration. Disabling those features first leaves seven configured servers in this environment, and a fresh CLI read-back with their overrides confirmed all seven disabled. This also disables plugin-provided capabilities for these turns until selective MCP support is implemented.
- Ruling: Codex's override parser does not support TOML quoted keys. Use bare alphanumeric, underscore and hyphen names; refuse a turn for any other name rather than risk addressing the wrong server.
- Desktop real-agent verification remains pending; the running production app has not been restarted.
- Next: per-participant turns stage 2, then stages 3–5; MCP stages 2–5 follow those. `/mcp` UI choice remains unresolved and is not part of urgent stage 1.

Validation: 182 Rust tests passed serially; 78 frontend tests passed; frontend build passed (existing chunk-size warning). `git diff --check` passed.

## User override: installed integrations enabled

The human explicitly requested restoring installed MCPs and plugins for Deck launches. Removed the temporary MCP-off discovery and launch overrides for Codex, Claude, and Gemini. This restores each CLI's configured integrations; it does not force-enable integrations disabled in the CLI library. During this task, do not invoke MCP/plugin write tools. Per-thread MCP controls and mandatory trading/publishing approval remain future work, not enforced by this launch change. No commit, push, merge, or production restart is authorized.

## Approval implementation checkpoint — Null, 2026-10-03

Human's next step implemented on `feat/mcp-tool-approvals`, committed in `8011fee`. Integrations remain on by default. Scope is risky-tool approvals; sidebar switches and `!` syntax are not part of this step.

- Claude uses a two-way stream at every access level, with `permissions.ask: ["mcp__*"]`. The host releases ordinary reads and presents risky names on the existing approval card. User deny settings remain ahead of ask rules.
- Codex inventories server tools through `mcpServerStatus/list` before starting the model, including plugin and app identities. Only approval overrides are retained; transport definitions, config files and tokens are not read. All catalog tools prompt at the CLI boundary; Deck releases ordinary reads and asks for risky names.
- Codex non-Ask access uses granular policy with MCP elicitation enabled and local sandbox escalation disabled. Live probe showed `approvalPolicy: never` bypasses MCP prompting even with explicit `prompt`, so it cannot enforce this feature.
- Codex MCP approvals arrive as `mcpServer/elicitation/request`, with `_meta.codex_approval_kind=mcp_tool_call` and `tool_params`. They bind to the exact pending call and arguments; unrelated or ambiguous requests decline. Responses contain no persistent/session trust option.
- `ActionKind::Tool` uses the existing Approve/Reject card, with full JSON arguments. Targeted Stop retains the existing approval-desk rejection and participant-idle card cleanup.
- Fail closed: Codex refuses a turn if app-server setup or tool discovery fails. An unreachable/auth-failing server's incomplete catalog currently refuses the whole Codex turn. No unprotected exec fallback.
- Ruling: flattened Codex approval-key overrides preserve transport settings. App tool policies use a tools table with literal qualified names (for example `github.fetch_pr_patch`), since dotted override keys would address a different tool. Names in override path segments containing dots are refused rather than misaddressed.
- Live harmless tests: Claude Full `can_use_tool` rejection; Claude synthetic deny settings still remove the test tool; Codex Full local read approval rejection, including overriding a previous `approve` default; Codex GitHub `fetch_pr_patch` read approval rejection; Codex plugin-scoped approval rejection before execution. Claude local `search_products` returned `LOCAL_TEST_OK` after one approval and asked again on the second call, which was rejected. No trading/publishing tools ran.

Verification: 195 Rust tests passed serially; 82 frontend tests passed; frontend build passed with the existing chunk-size warning. Self-review performed; the fresh-review agent could not start because the collaboration runtime could not load this thread. Live desktop-card testing remains pending. Nothing committed, pushed, merged, or restarted.
