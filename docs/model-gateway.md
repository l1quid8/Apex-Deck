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

Gemini, Grok, and saved custom CLI profiles use a separate per-turn home, work
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

These three additional paths are withheld on non-macOS hosts until an equivalent
process boundary exists. Missing executables, unavailable sandbox facilities,
authentication failures and unsupported runtime layouts fail the request and
refund its turn reservation. They never trigger an unrestricted retry.

## Muse remains withheld

Muse is omitted from `/v1/models` and direct requests return HTTP 409. Its
current macOS subscription login uses Keychain: a normal session starts, but
the isolated session fails with Keychain OSStatus -50. Broad Keychain or
preferences-service exceptions would expose more than the model credential and
are deliberately absent. A future trusted host helper must supply only Muse's
model authentication through a supported isolated authentication interface
before this backend can be enabled. An old `allow_mcp` key cannot bypass this.

## Verification and limits

Regression tests exercise a real gateway listener with a legacy-format key:
normal custom CLI replies return HTTP 200, while attempted reads of a private
MCP canary return `PRIVATE_MCP_UNAVAILABLE` with no secret content. Separate
kernel-enforced tests verify absolute file reads and connections to host TCP
and Unix-socket canaries fail. A Gemini fixture checks native CLI selection and
private settings. A live Grok completion through the HTTP listener with a legacy key returned HTTP 200 and `GATEWAY_OK 42`. The Gemini fixture does
not prove an authenticated Google completion, and Muse's live completion is
currently blocked as described above. Opt-in live tests are marked ignored so
ordinary tests never consume subscription turns.
