# Remote access milestone 2: device authority

Status: built on `feat/device-authority` (2026-10-07); real check 9 passed
over relay.apex-terminal.xyz. iroh sits behind the daemon's `remote` cargo
feature, off by default. Implements
milestone 2 of `docs/built-in-remote-access-plan.md`. QR pairing is
milestone 3 and builds on this.

## Goal
The daemon knows which phones may connect from outside, what each may do,
and can revoke one instantly and permanently. A phone is identified only by
its iroh endpoint ID, never by the shared LAN token.

## What exists today
- `protocol.rs:60` `Trust` has two cases: `Local` (stdio, local socket) and
  `Token` (WebSocket with the shared `daemon-token`). Both reach every
  command in `apex_host::Command` (about 70) and every event.
- No device list, no per-command check, no iroh endpoint in the daemon. The
  spike listener lives in `crates/iroh-spike`, outside the daemon.

## Design

### Device registry
- `devices.json` in the data folder, owner-only, written atomically with
  `files::write_private`. That helper (`files.rs:9`) syncs the temp file
  but not the folder, so a crash right after the rename can lose it. Fix
  the helper: after `rename`, open the parent folder and `sync_all()` it.
  Every caller (including `daemon-token`) gets the fix; add a test that the
  helper still leaves no temp file behind on error.
- `{ version: 1, devices: [{ endpointId, label, tier, threads, addedAt,
  lastSeen }], revoked: [{ endpointId, revokedAt }] }`.
- `threads` is `"all"` or a list of thread (room) IDs. New devices default
  to `"all"` until milestone 3's pairing screen lets the user pick.
- A revoked ID stays in `revoked` (tombstone). Adding it again needs an
  explicit local action; a stale pairing can never restore it.
- Loaded once at start into `Daemon`, guarded by a mutex; every change is
  written before it takes effect.

### Trust
- Add `Trust::Device(EndpointId)`. `Local` and `Token` behave exactly as
  today, so the desktop and LAN phones are unaffected.
- A `Device` connection is accepted only if its iroh-authenticated ID is in
  `devices` and not in `revoked`. The `hello` token is ignored for it.

### Permission check
- `fn allowed(tier, &Command) -> Result<(), String>` in a new
  `crates/apex-daemon/src/authority.rs`, called before `run()` for `Device`
  connections only.
- **The match has no wildcard arm.** A new `Command` variant fails to
  compile until someone classifies it.
- Re-check the registry on every command (cheap lookup), not just at
  connect, so a tier change applies to the next command.
- After the tier check, a command that names a thread (`room_*`,
  `save_attachment`, `artifacts_load` and anything else carrying a room ID)
  is refused unless that thread is in the device's `threads`. Commands that
  could name a thread are part of the same exhaustive match, so each one
  states how its thread ID is found.
- Tiers (from the plan):
  - **Read-only:** `session_load`, `room_state`, `room_diff`,
    `artifacts_load`, `agents_detect`, `agent_models`.
  - **Chat + approvals (default):** read-only plus `room_post`,
    `room_post_to`, `room_targets`, `room_turn`, `room_stop`,
    `room_decide`, `room_answer`, `room_set_plan`, `save_attachment`.
    Be plain about what this means: posting to a thread wakes its bots,
    and those bots run with that thread's existing folder and permission
    mode. So Chat can cause code to run on the host, limited to threads
    the user already set up and allowed. The pairing and Settings screens
    must say so.
  - **Full:** adds `pty_*`, `folder_list`, `workspace_read`, `room_create`,
    `room_update_participant`, `room_import`, `room_delete`,
    `session_save`, `settings_save`, file reads/exports.
  - **Never remote, any tier:** `decision_key_save`, `mod_*`,
    `open_target`, `quit_*`, `env_present`, `data_folder`,
    `api_models` (fetches arbitrary URLs), and all device management.
- **Thread-limited devices get no global commands, at any tier.** Each
  command in the match is classified as `Thread(id)`, `GlobalRead`
  (`agents_detect`, `agent_models`, filtered `session_load`) or `Global`.
  A device whose `threads` isn't `"all"` is refused every `Global`
  command even on Full: `pty_*` (a shell isn't tied to a thread),
  `folder_list`, `workspace_read`, file reads/exports, `room_create`,
  `room_import`, `room_delete` of a thread outside its list,
  `session_save` (it rewrites the whole session, other threads included)
  and `settings_save`. So a limited Full device can do Full actions only
  inside its own threads, such as `room_update_participant` on them.
  Anything that can't be tied to one allowed thread is denied.
- `room_decide`/`room_answer` must name an outstanding request; stale or
  already-answered IDs fail (existing host behavior, add a test).

### Snapshots and event filtering
- Snapshots: `session_load` and `room_state` return only threads in the
  device's `threads`; a `"all"` device sees everything. Thread lists,
  unread counts and anything else that would reveal another thread's name
  or content are filtered the same way.
- Events: every event name is classified like commands, as `Thread(id)`,
  `GlobalRead` or `Global`, exhaustively, so a new event fails the build
  until it's classified. Delivery needs **both** the tier rule and the
  scope rule:
  - Tier: Read-only and Chat get room events and approval requests; PTY
    output and settings events need Full.
  - Scope: a `Thread(id)` event goes only to devices whose `threads`
    include that ID. A `Global` event (`pty_*` output/exit, settings
    changes, workspace/folder changes, session-wide saves) goes only to
    devices whose `threads` is `"all"`, at any tier, so a thread-limited
    Full device never gets PTY or settings events. `GlobalRead` events
    (agent detection, model lists) go to any device whose tier allows them.
  - An event that names several threads (e.g. a session-wide update) is
    `Global`, or is split per thread before filtering; it is never sent
    whole to a limited device.
- The check runs per event at delivery time in `protocol::serve`, for both
  replayed and live events, against the registry as it is right then. It
  is never decided once at subscribe time, so a tier or thread change
  applies to the very next event.
- A filtered event still advances `written` (`protocol.rs:112`). Replies
  wait for `reply.after <= written` (`protocol.rs:164`, `179`), so if
  skipped events didn't advance it, the phone's command replies would
  stall until an allowed event happened to arrive. The `hello` reply's
  `last_seq` likewise counts filtered events, so resume works as today.

### Revocation
- `Daemon` keeps a `broadcast` channel of revoked IDs. Each `Device` session
  listens and closes immediately when its ID is revoked, dropping its event
  subscription. Work the phone already started keeps running and is
  reported as such.
- "Immediately" includes waits: the revoke signal is raced (`select!`)
  against the `hello` wait, every frame read, and every write. A phone
  that stops reading (so the write blocks on a full stream) or never sends
  `hello` is still cut off. The QUIC connection is closed with a reason
  code, not just the stream.
- Revocation is written to disk before the broadcast, so it survives a
  crash or restart.
- **The broadcast is only a fast path; the saved registry is the
  authority.** A session also checks the registry (not just the channel)
  before every command, before every event it sends, and after `hello`.
  If its broadcast receiver reports `Lagged` or `Closed`, it re-reads the
  registry at once and closes if its ID is revoked. A missed message
  can therefore delay the cut-off by at most one frame, never let a
  revoked phone keep working.
- **Revoke during connection setup:** the accept path subscribes to the
  revoke channel *before* its registry check, then checks again after the
  handshake and `hello`. A revoke that lands anywhere in that window is
  caught by one of the two.

### Management (local only)
- New commands `devices_list`, `devices_set_tier`, `devices_revoke`,
  accepted only from `Trust::Local`. `Token` and `Device` get "not allowed
  from a remote connection". A phone can never raise its own tier or touch
  another device.
- CLI: `apex-daemon devices list | revoke <id> | tier <id> <tier>`, plus a
  temporary `devices add <id> --label --tier` so milestone 2 can be tested
  before QR pairing replaces it in milestone 3.
- Desktop: **Settings → Paired devices**: label, added, last seen, tier
  dropdown, Revoke (with confirm). Empty state says pairing arrives later.

### Daemon iroh endpoint (behind a flag)
- `apex-daemon serve --remote` starts an iroh endpoint next to the existing
  listeners. Off by default.
- Secret key in `iroh-key`, owner-only (0600), in the data folder, for
  this milestone only. Production on the Mac moves it to Keychain as the
  remote-access plan says; that is a release blocker, tracked with the
  signing work. Linux VPS keeps the 0600 file. Relay: only `https://relay.apex-terminal.xyz/`. Port mapper
  off. Stable UDP port from `--remote-port` (default chosen at first start,
  then saved).
- ALPN `apex-deck/1`; one bidirectional QUIC stream carries the existing
  newline-JSON protocol via `protocol::serve(daemon, Trust::Device(id), ..)`.
  Lower the frame cap for `Device` to 8 MiB (plan asks for an explicit
  attachment limit instead of 32 MiB).
- Unknown or revoked IDs: close the connection with a reason code before
  reading any frame.

## Tests (exit criteria)
1. Table test: every `Command` variant × every tier → expected allow/deny.
   Generated from the enum so a missed variant fails.
2. Device management commands refused from `Token` and `Device`.
3. Unknown endpoint ID refused at connect; revoked ID refused at connect.
4. Revoking a connected device closes its session within 1 s and stops
   its events, including (a) a device that never sent `hello`, and (b) a
   device that stopped reading so the daemon's write is blocked.
4a. Thread scope: a device limited to thread A is refused commands on
   thread B, never sees B in `session_load`/`room_state`, and gets no B
   events live or on replay.
4b. A device whose events are mostly filtered still gets every command
   reply promptly (sequence bookkeeping).
4c. Narrowing a device's tier or threads mid-session filters the next
   live event.
4d. `write_private` syncs the parent folder (checked with a test hook or
   by inspecting the call order).
4e. A thread-limited Full device is refused `pty_spawn`, `folder_list`,
   `workspace_read`, `session_save`, `settings_save` and `room_create`,
   but allowed `room_update_participant` on its own thread.
4e2. A thread-limited Full device receives no `Global` events (PTY output
   from a terminal another client opened, a settings change), both live
   and on replay after reconnect, while an `"all"` Full device gets them.
   Table test: every event variant × tier × scope (`"all"` vs limited).
4f. Revocation with a lagged receiver (test hook forces `Lagged`) and a
   revoke injected between the registry check and `hello` both close the
   session; the device never gets a command reply after the revoke.
5. Revocation and tier changes survive a daemon restart.
6. A tier change applies to the next command without reconnecting.
7. Event filter applies to replayed events after reconnect.
8. Existing `Local`/`Token` tests pass unchanged.
9. Real check: the spike client with an added device key reaches the Mac
   daemon over the relay, runs `room_state`, is refused `pty_spawn` on
   Chat tier, then is cut off by `apex-daemon devices revoke`.

## Decided (Null review, 2026-10-07)
1. **Thread creation stays in Full.** `room_create` and
   `room_update_participant` can start a bot with any permission mode in
   any folder. Chat-tier phones can't start new threads; this is a visible
   change for phones that do so today, so the phone hides New thread on
   Chat tier instead of showing an error.
2. **Thread scoping is enforced now**, in commands, snapshots and events
   (see above), not deferred.
3. **Daemon key:** 0600 file for this milestone; Keychain on the Mac before
   release.

## Where it was built
Branched from `main` in `~/Downloads/apex-deck` once the auto-thinking work
finished.
