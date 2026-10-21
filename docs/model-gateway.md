# Model gateway privacy

Gateway keys grant model access only. Personal MCP servers, including `hl_mcp`
and `x_mcp`, are never shared, even by an old key whose stored `allow_mcp` field
is true. `keys issue --allow-mcp` is rejected. Normal local Deck conversations
keep their existing configuration.

Claude gateway turns use strict MCP configuration and no tools. Codex gateway
turns disable plugins, apps, shell execution, and every configured MCP server
with per-process overrides. Before sending a prompt, Deck verifies the running
Codex server exposes no MCP tools or resources. Inventory failures refuse the
request; they do not fall back to an unrestricted CLI.

Gemini, Grok, Muse, and arbitrary custom CLI wrappers are currently omitted from
`/v1/models` and return HTTP 409 if requested directly: their MCP isolation has
not been verified. API providers and scripted fixtures do not inherit local MCP
configuration. These restrictions apply to HTTP gateway clients, not local bots.

