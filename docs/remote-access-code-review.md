# Built-in remote access: implementation map

Reviewed current source on October 7, 2026. This is a code inspection and proposed change map; no implementation or network testing was performed. This supersedes the relay-only direction in the earlier plan.

## Target behavior

Default **Automatic**: authenticate the paired host, try direct transport, and fall back to the Apex-Terminal relay after a bounded attempt. **Direct only**: never forward session traffic through a relay; explain public address, port forwarding and firewall requirements. Show **Direct** or **Relayed** separately from online/reconnecting status. A public VPS still needs a reachable listener and firewall permission; a public address alone does not guarantee access.

Two distinct implementation scopes: existing WebSockets can support public-address/LAN direct access plus an encrypted relay fallback. Automatic NAT hole punching additionally needs a peer networking transport on both ends; adding a relay to the existing WebSocket code does not provide hole punching. Choose that transport after an actual Capacitor/iPhone and Rust daemon compatibility experiment, rather than assuming iroh can be dropped into the browser WebSocket adapter.

## iPhone

| Current source | Required change |
|---|---|
| `src/phoneRules.ts`: `DirectMachine` has `id/name/kind/url/token`; serialized into the machine list | Version the pairing record: stable authenticated host public key, phone identity reference, endpoint candidates, relay locator and `automatic/direct-only` policy. Retain application host IDs such as `local` separately from cryptographic identity. Migrate legacy address/token records with an explicit re-pair flow. |
| `src/phone/PhoneApp.tsx:187,254`: machine records including token are in localStorage | Store private keys in iOS Keychain through a native bridge; keep only nonsecret metadata in localStorage. Add QR scanning, camera permission, expiring pairing validation and host confirmation. |
| `src/phone/PhoneApp.tsx:263`: calls `webSocketConnect(machine.url)` | Substitute a connection manager implementing the existing `Connect/Link` contract. Try direct candidates with timeout/cancellation, then relay when allowed; report the selected route and preserve per-machine isolation. Validate host identity before sending RPC commands. |
| `src/daemon/webSocketLink.ts` | Add bounded connection attempts, heartbeat/liveness handling and cleanup of timed-out sockets. Introduce an authenticated encrypted Link around either transport; forwarding plaintext JSON over a TLS relay would let the relay read it. Add a native transport bridge if the selected peer library requires one. |
| `src/phoneBackend.ts` | Authenticate with a phone-specific identity instead of the shared daemon token; pass expected host identity and route changes into the connection store. |
| `src/phone/PhoneApp.tsx:1934–2008` Machines UI | Make Scan QR the normal setup, preserve manual public-address configuration under Advanced, add policy control, route label, actionable failure messages, and distinguish local removal from confirmed host revocation. |
| `src/daemon/client.ts` | Reuse current reconnect, `boot_id/seq` replay and resync logic. Re-run route selection on reconnect/network changes and resume from the last acknowledged event. Add handshake deadlines and foreground/network hooks; iOS cannot be assumed to keep sockets alive while suspended. Do not automatically replay mutating commands with unknown outcomes. |

Current product constraint: `phoneRules.ts:newThreadGate` requires the Mac online to create a thread, and only one Mac is permitted. Networking alone will not make a VPS-only phone experience independent of a Mac. If that is a launch requirement, separately move or partition session/workspace ownership so the chosen VPS can own its thread list, and migrate existing saved sessions.

## Mac app

| Current source | Required change |
|---|---|
| `desktop/sidecar.mjs:18,49`; `desktop/main.mjs` daemon lifecycle | Add opt-in persistent remote service, a macOS launch agent and service installation/status controls. Today the spawned daemon uses `--exit-on-stdin-close` and ends when Deck quits. Continue attaching to the same daemon/data folder; avoid duplicate hosts. Sleeping or powered-off Macs remain unreachable. |
| `src/HostsSettings.tsx` | Add Remote Access settings for this Mac: enable/disable, pairing QR, paired phones, revoke phone, endpoint override, route policy and recovery. Preserve desktop SSH host management. |
| `desktop/preload.cjs`, `desktop/main.mjs`, backend command interfaces | Expose narrow local-only pairing/revocation/service APIs. Privileged management must not become available to every remote RPC client. Renderer receives public QR information, not long-lived host secrets. |
| `src/hostConnections.ts`, connection UI | Extend connection metadata with route and identity/authentication errors, independently of existing connection status. The Mac's local Unix-socket connection remains local; SSH to VPS can stay as implemented in `desktop/link.mjs`. |

The Mac app provides the setup UI; put the remote transport in the shared daemon so Linux VPS hosts get the same behavior without Electron.

## Shared Rust daemon

| Current source | Required change |
|---|---|
| `crates/apex-daemon/src/identity.rs` | Add persistent cryptographic host identity, protected key storage and a persisted paired-phone registry. Existing `host-id` is a random identifier, not an authentication key. |
| `serve.rs:75–77` | Separate local bootstrap token from durable phone credentials. Today `daemon-token` is regenerated at every daemon start, so pasted phone tokens stop working after restart. |
| `websocket.rs` | Add authenticated, encrypted remote sessions for direct and relay paths, both feeding the existing protocol stream interface. Keep local socket/SSH paths working. Direct public WebSocket access needs TLS provisioning or a reviewed encrypted transport that works with the iPhone client; current listener does not terminate TLS. |
| `protocol.rs:60,251` | Replace remote `Trust::Token` with authenticated device context and enforce permissions on the host for every RPC and event subscription. Current token authentication grants access to the command dispatcher; client-side write guards are not a security boundary. Keep trusted local access explicitly separate. |
| New pairing/device management module | Create short-lived single-use pairing offers; QR binds host public key, offer ID, rendezvous location and pairing proof. Use a reviewed authenticated key exchange, not a custom cipher. Persist a distinct phone public key/permissions; host approval prevents unsolicited enrollment. Never exchange a shared account-wide secret. |
| New remote connection module; `serve.rs`, `cli.rs` | Persist remote settings and establish an outbound authenticated relay registration. Add direct endpoint configuration, policy, heartbeat, reconnect with jitter, IPv4/IPv6 candidate handling and optional peer traversal. A relay connection is a live bidirectional tunnel, not an inbound connection to the home Mac. |
| Device registry and active sessions | Revocation removes authorization and immediately closes all sessions for that phone; check authorization on new connections and before further commands. Recovery: locally pair a replacement phone on the host, or use an offline recovery credential to authorize replacement; revoke the lost phone. Loss of the host key requires explicit re-pairing. |
| `protocol.rs:28,134` and attachment transport | Bound connections, in-flight commands, queue memory, pairing attempts and bandwidth. Current protocol permits 32 MiB frames and uses an unbounded reply channel; base64 attachments increase traffic. Add chunked transfer/backpressure before exposing the service publicly. |
| `packaging/systemd/apex-daemon@.service` | Load persisted remote settings and maintain Linux service uptime. Installation must explicitly explain any listener/firewall change; do not silently expose an insecure listener. |

## Separate Apex-Terminal backend

No relay implementation was found in the inspected transport paths. Add a separate service/deployment for TLS rendezvous and opaque encrypted stream forwarding, with authenticated host/device registration, expiring route tickets, heartbeats, bounded buffers, connection/byte quotas, rate limiting and metadata-only operational metrics. Reject anonymous unrestricted forwarding so it cannot become an open proxy. The relay never receives device private keys or plaintext RPC payloads.

If hole punching is selected, implement/use that transport's rendezvous/discovery and relay protocol; an arbitrary WebSocket relay is not automatically compatible. Specify whether Direct only permits introduction traffic or means no helper contact whatsoever. Default recommendation: permits discovery, prohibits session-data relay, and says so in the UI.

## Build order and acceptance

1. Prove authenticated transport between the actual iPhone build and Rust daemon, including cellular-to-home and cellular-to-VPS, before committing to a peer library.
2. Implement durable identity, QR pairing, secure storage, permissions, revocation and local recovery.
3. Implement direct transport and bounded reconnect; preserve existing event replay/resync.
4. Add the backend tunnel and Automatic fallback, route display and persistent Mac service.
5. Add traversal if the selected transport supports it; validate on restrictive networks, not just LAN.

Required end-to-end checks: direct VPS, home direct through configured router, forced relay, Direct only never relays payloads, mismatched host rejected, expired/reused QR rejected, revoked phone loses existing and new access, daemon restart retains pairing, Wi-Fi/cellular switch resumes correctly, missed events trigger resync, unknown-result writes are not duplicated, offline host preserves drafts, and overload remains bounded. Measure relay RSS/CPU and byte throughput using realistic concurrent sessions and attachments; previous 20–50 MB and under-1% CPU claims are not measurements of this code.
