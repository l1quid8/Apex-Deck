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

## Other CLI backends on macOS

Gemini, Grok, Muse, and saved custom CLI profiles use a separate per-turn home, work
folder, temporary directory and XDG configuration directories. The child gets a
fresh environment, not the host's MCP secrets, endpoint overrides or daemon
socket variables. The native macOS sandbox applies to the process and its
children. It denies host configuration file contents, host Unix sockets,
loopback services, arbitrary writes and Keychain access. Standard web egress on
ports 80/443 remains available for model APIs; this is not a domain allowlist.
System runtime directories and the exact selected executable remain readable.
A custom executable is trusted operator-supplied code, not an untrusted upload.
Do not embed private MCP credentials or endpoints in its code/arguments.

- **Grok:** only its model `auth.json` is copied into the private home. A
  requirements file denies all MCP servers; imported Claude/Cursor MCP config,
  managed MCP gateways, shared leaders and subagents are disabled. Built-in
  tools are withheld with `--tools ""`.
- **Gemini:** uses the standalone Google `gemini` CLI, never an existing
  Antigravity service. Only Google model sign-in files are copied. Private
  system settings supply an empty core tool list, a nonmatching MCP allowlist
  and disabled extensions. See [Google's configuration reference](https://geminicli.com/docs/reference/configuration/).
  The standalone CLI must be installed and signed in; an `agy` install alone
  does not make Gemini available in the gateway catalog.
- **Custom CLI:** saved profiles appear as `cli/<profile-id>` when the key has
  CLI scope. Commands cannot inherit the host's login files or API-key
  environment. Self-contained commands and runtimes installed under the
  permitted system/Homebrew runtime directories work; user-home npm/Python
  dependency trees are not automatically granted access. A wrapper requiring
  unavailable dependencies or host configuration fails closed. Local model
  servers should be configured as API profiles instead of bypassing the
  sandbox's loopback restriction.

These additional paths are withheld on non-macOS hosts until an equivalent
process boundary exists. Missing executables, unavailable sandbox facilities,
authentication failures and unsupported runtime layouts fail the request and
refund its turn reservation. They never trigger an unrestricted retry.

## Muse subscription authentication

On macOS, Muse is available through the same private process boundary. The
trusted daemon uses the macOS credential helper to resolve only the
`ai.meta.dev.credentials` / `meta` Keychain item, with a ten-second timeout.
Only its OAuth subscription access token and selected model-login metadata are
staged in a private 0600 auth file; API-key and MCP credential slots are omitted.
The request's private 0700 directory is removed when the participant is dropped.
Host credentials and settings are not rewritten, and the sandboxed child still
cannot query Keychain. Unsupported auth schemas and credential failures fail
closed without an unrestricted retry.

Muse plugins are disabled. Its safe directory walker may open the selected
executable's ancestor directories and the literal `/Library` and
`/Library/Application Support` directories. These are directory-only grants,
not permission to read files or subtrees beneath them. User MCP configuration,
private credential files, host sockets and loopback connections remain blocked.
An old `allow_mcp` key cannot change this policy.

## Verification and limits

Regression tests exercise a real gateway listener with a legacy-format key:
normal custom CLI replies return HTTP 200, while attempted reads of a private
MCP canary return `PRIVATE_MCP_UNAVAILABLE` with no secret content. Separate
kernel-enforced tests verify absolute file reads and connections to host TCP
and Unix-socket canaries fail. A Gemini fixture checks native CLI selection and
private settings. A live Grok completion through the HTTP listener with a legacy key returned HTTP 200 and `GATEWAY_OK 42`. The Gemini fixture does
not prove an authenticated Google completion. A real Muse Spark 1.3 completion
through the HTTP listener with an old `allow_mcp: true` key returned HTTP 200
and `GATEWAY_MUSE_OK 42`; a private-tool inventory prompt returned
`PRIVATE_MCP_UNAVAILABLE`. Independent kernel tests verify that the Muse
directory grants still deny private file contents and direct Keychain queries.
Opt-in live tests are marked ignored so ordinary tests never consume subscription
turns.

## Desktop settings

Settings → Model gateway is available on the local owner's desktop only. The daemon also enforces local-socket authority for status, provider configuration checks, listener changes, and key management; paired devices and WebSocket-token clients cannot administer the gateway.

Enable or disable the listener, copy its URL, create family-scoped keys with request/spend limits, and revoke keys from the panel. Secrets are displayed only when created and are not saved by the renderer. Keys remain valid until revoked; expiry is not supported. Disabling the listener preserves keys and closes accepted HTTP connections. Disable before changing the listen address or port.

Listener settings are stored privately in `gateway-settings.json` and restored by `serve`. A failed restored listener leaves the local daemon available and reports an error in Settings so the owner can repair it. Explicit `--gateway-port` arguments override saved settings for that launch. The listener uses HTTP: keep loopback by default, or use a private address with an encrypted tunnel/HTTPS proxy for other devices.

Provider readiness reports installed/configured status, not a successful authentication or completion. Private MCP isolation applies to every gateway key, including legacy `allow_mcp` keys.
