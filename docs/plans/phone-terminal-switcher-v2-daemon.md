# Phone terminal switcher v2: daemon implementation plan

## Goal and boundaries

Let the phone list Apex Deck terminals on a paired machine, choose one, and join it with recent output followed by live output. A phone can also start a terminal through the existing `pty_spawn` command. The inventory includes PTYs created by Apex Deck on desktop or phone; it does not include Terminal.app, iTerm, or other processes that Apex Deck did not start.

V1 of this implementation keeps terminal list and output access at **Full access**, matching the current policy for every PTY command and output event. This avoids broadening access to secrets in terminal output and does not require a new per-device subscription model. Keep input, resize, spawn, and kill Full-only. Revisit scoped ReadOnly viewing separately if product requirements call for it.

## API shapes

Add commands to `apex_host::Command` (JSON names shown). `PtySpawn` today takes `id`, optional `agent`, optional `cwd`, `cols`, and `rows`; its `id` is the pane ID supplied by the UI. List/attach should use that same ID namespace:

```json
{ "cmd": "pty_list", "args": {} }
{ "cmd": "pty_attach", "args": { "id": "pane-id", "after": null } }
```

`pty_list` returns summaries, for example (field names are proposed, not current wire fields):

```json
[{"id":"pane-id","name":"shell 01","cwd":"/work/apex-deck","source":"desktop","state":"running","exitCode":null,"lastActivity":1720000000000}]
```

`pty_attach` returns a snapshot and a **per-terminal output cursor**:

```json
{"id":"pane-id","output":"...bounded recent UTF-8 output...","cursor":42,"state":"running","exitCode":null}
```

The cursor is a monotonically increasing output sequence for that PTY; the event bus's existing `seq` is global and is not a substitute. The existing daemon protocol captures `Host::events().last_seq()` after `Host::call` and holds a command reply until all earlier global events have been delivered. That gives a useful reply/event barrier, but does not create an atomic per-PTY snapshot by itself. Implement one explicit contract: register the live listener first, buffer that PTY's sequenced chunks, then apply the snapshot and only buffered chunks with a per-PTY sequence greater than its cursor. Test output racing the snapshot. Existing `pty-data` payloads currently contain only `{id,data}`; adding sequence is a wire change, so update desktop and phone consumers together or introduce a separate sequenced attach stream. Do not describe a separate `after` argument as subscription state: the host has no attach/subscription command today.

Terminal metadata should include ID, display name, cwd/project path, lifecycle state (`running` or `exited`), optional exit code, last activity, and output cursor. Current IDs are caller-supplied pane IDs; define collision/replacement behavior before calling them stable across clients. `PtyManager` receives no caller/device identity, and `Host::pty_spawn` receives only `id`, optional agent, cwd, and size. Therefore `source: desktop|phone` cannot currently be inferred. Either omit source in v1, or explicitly plumb trusted origin/device metadata from the daemon request context through `Host::pty_spawn` to the manager; do not infer it from `agent` or cwd. Since the current manager removes sessions at exit, retain exited metadata and the bounded tail long enough for the switcher to show completed terminals and re-run/close actions; set an explicit retention policy.

Output history is a per-session byte-bounded ring (initial limit: 256 KiB, configurable constant). Store output as bytes or safe UTF-8 chunks while preserving current decoding behavior; clarify that this is raw terminal output, not a rendered terminal screen. ANSI escapes and partial screen updates are expected. Do not hold the manager lock while emitting host events or serializing large snapshots.

## Implementation sequence

1. **Session model and history** — extend `PtyManager` sessions with metadata, lifecycle, per-terminal output cursor, and bounded scrollback. Record each decoded chunk before invoking the existing event sink. Retain a short-lived exited record instead of dropping all state on child exit. Add manager operations to list and atomically snapshot history/cursor/state. Decide whether replacing an existing pane ID (the current `spawn` behavior kills/replaces it) preserves or discards its old record.
2. **Host commands and event contract** — implement `Host::pty_list` and `Host::pty_attach`; add command variants, JSON dispatch, reply serialization, and cursor-bearing output delivery. `Host::call` returns JSON values for the daemon's generic command reply. Ensure attach snapshot plus live events obey the ordering contract above. Keep `pty_spawn/write/resize/kill` behavior and existing event consumers intact or migrate them together.
3. **Authorization** — classify `PtyList` and `PtyAttach` as `full(Global)` in `authority.rs`; keep PTY control commands and `PtyData`/`PtyExit` at `full(Global)`. `Scope::Global` means the device must be allowed every thread (in addition to Full tier); test both a limited-thread Full device and ReadOnly/Chat devices are refused, and an all-thread Full device is allowed. Event authorization is global too, so do not lower event authorization to ReadOnly.
4. **Protocol and clients** — verify daemon protocol command replies preserve attach ordering, and update capability advertisement if commands are explicitly enumerated. Add remote command/event mapping in `src/commandBackend.ts` and backend types in `src/backend.ts`. Implement the phone terminal list/attach flow and reconnect handling in the phone Code UI; show Full-access denial using existing access messaging. `src/eventHub.ts` currently routes `pty-data` to registered PTYs, so extend that subscription path or add a terminal-session consumer without breaking pane terminals.
5. **Switcher actions** — use existing spawn/write/resize/kill commands for new shell, input, resizing, and end. Rename and copy-last-output may be client-side only initially; if rename must persist across clients, add a dedicated metadata update command and authorize it Full-only.

## Likely files

- `crates/apex-host/src/pty.rs` — metadata, bounded history, cursor, lifecycle retention, atomic snapshot.
- `crates/apex-host/src/host.rs` — list/attach host methods and output recording.
- `crates/apex-host/src/command.rs` — command variants and dispatch.
- `crates/apex-host/src/events.rs` — output cursor/event payload if the existing event is extended.
- `crates/apex-daemon/src/authority.rs` — Full-only policy and tier/scope tests.
- `crates/apex-daemon/src/protocol.rs` — reply/event ordering and remote protocol coverage; capability list if applicable.
- `src/commandBackend.ts`, `src/backend.ts`, `src/eventHub.ts` — remote transport, typed API, live output routing.
- Phone Code/terminal components under `src/phone/` — inventory, terminal switcher, attach state and controls.
- `crates/apex-host/tests/host.rs` and `crates/apex-daemon/tests/` — command/history, attach ordering, and remote permission coverage.

## Acceptance criteria

- `pty_list` returns only Apex Deck-managed terminals, with stable IDs and accurate cwd/source/state/activity; it does not claim to discover unrelated Mac terminal apps.
- All PTYs started through Apex Deck appear. Source labels are accurate only if origin/device identity has been explicitly plumbed from the request; otherwise omit source labels in v1.
- Every output chunk increments that terminal's cursor and enters its bounded history. History never exceeds its byte limit, and truncation leaves valid UTF-8 output.
- Attaching to a running terminal returns recent output and a cursor, then receives all later output exactly once, including output produced while the attach request is in flight.
- Exited terminals expose their exit code and retained recent output for the documented retention period; expired entries disappear from the list.
- Full-tier devices allowed every thread can list, attach, and receive terminal output. ReadOnly, Chat, and Full devices with thread-limited scope cannot use list/attach or receive global PTY output. Existing write/resize/spawn/kill remain Full plus all-thread scope.
- Existing desktop terminal panes continue receiving their output and existing commands keep their wire shape.
- The phone switcher can list, select, and reattach to an Apex Deck PTY; its display states distinguish running, waiting/idle where detectable, failed exit, and exited. Search covers summary metadata and available recent output.
- The API documents that history is raw PTY output, not a faithful screen snapshot.

## Rough size and unresolved product details

Daemon and protocol work is **medium** if Full-only access is accepted. Client transport plus the phone UI is additional medium work. ReadOnly viewing with per-terminal grants, discovery of terminals owned by other Mac apps, faithful screen restoration, and persistent cross-client renaming are explicitly out of this plan.

Before implementation, choose the exited-session retention duration and whether list metadata should expose full cwd paths or only project/display names. Also decide whether v1 omits source labels or adds trusted request-origin plumbing. Keep the initial implementation Full-tier plus all-thread scope regardless; changing that policy requires a separate explicit security decision.

## Implemented v1 decisions

- Exited sessions and their output tail are retained for five minutes after exit.
- The list exposes the final cwd folder name as `project`; it does not expose the full path.
- Source labels are omitted because trusted desktop-versus-phone origin is not currently available in the daemon request context.
- `pty-data` now includes a per-terminal `cursor`. Clients subscribe first, fetch `pty_attach`, discard buffered chunks at or below the snapshot cursor, then append later chunks.
- The phone Code tab lists, selects, attaches to, and sends input to Apex Deck PTYs. It reports the existing Full-access requirement when list/attach is refused.
