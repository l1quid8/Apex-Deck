# Pomerado wiring: website integrations as MCP servers

Pomerado (https://github.com/Pomerado/pomerado) turns websites into
deterministic MCP integrations. It builds each one by working through the site
in a Chromium browser, and its tools return structured text.

**Pomerado is not computer use.** It only drives websites. It cannot start
programs or control Mac apps. Desktop control is a separate design:
`docs/superpowers/plans/2026-10-31-unified-computer-use.md`.

## Wiring on this Mac

Everything below lives in user config, not in this repository.

- **Runtime:** Pomerado needs Node `>=24.21.0 <25`. Node 24 is keg-only, so the
  config uses `/opt/homebrew/opt/node@24/bin/node`, with Pomerado installed by
  `npm install -g --prefix /opt/homebrew/opt/node@24 pomerado`.
- **Mint server:** `pomerado` in `~/.claude.json` and `~/.codex/config.toml` runs
  `/bin/zsh ~/pomerado-integrations/.deck-support/mint-with-deck-keychain.zsh`.
  That launcher reads the Deck-saved `OPENAI_API_KEY` from the Keychain and keeps
  it in memory. No config file holds the key.
- **Why a launcher:** Deck versions without the fix below expand `${OPENAI_API_KEY}`
  from the process environment only. The launcher also serves Claude Code and
  Codex, which cannot read Deck's saved keys.
- **Minted integrations:** `pomerado-mcp mint --root ~/pomerado-integrations`
  saves each one under that folder. Each runs as its own MCP server through its
  `mcp.mjs` launcher, with no key and no model calls. `example_reader` is wired
  this way as the working example.

## Changes in this repository

- **Saved keys reach MCP servers.** `Pool::servers` in
  `crates/apex-adapters/src/api_tools/mcp_client.rs` expands `${NAME}` with
  `keys::lookup`: saved key first, then environment, the same as HTTP backends.
  A server receives only the names its own config asks for.
- **Approvals.** `mint`, `provide_input` and `cancel_job` show an approval card;
  `get_job` runs without one. Covered by
  `pomerado_tools_gate_minting_and_input_but_release_job_reads` in
  `crates/apex-adapters/src/mcp.rs`.
- **Preview.** The demo backend in `src/backend.ts` lists `pomerado` and
  `example_reader`.

## Verified behavior

- API bots: `example_reader` returned its page data, and a fresh mint was polled
  with `get_job` to `completed` / `build: published`, in the running app and
  through `Turn` + `mcp_call`.
- Codex: a real session called `example_reader`, and a job was polled to
  completion.
- Claude Code: `claude mcp list` shows both servers connected.
- Browser work: an integration opened a site, clicked Next and read page 2.

A mint takes about 2 to 3 minutes. Jobs live in the server process that started
them, so poll from the same connection. The `#[ignore]`d test
`live_api_bot_calls_example_reader_and_polls_a_real_job` repeats the API-bot check
on a machine with this wiring. It spends the API key, so run it by hand.
