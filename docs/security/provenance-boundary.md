# Protected assistant provenance — gated macOS candidate

Status: implemented for review, **not production accepted**. Phase 4 is blocked.
The existing Agents tab and Full access execution rules are unchanged.

## Guarantee and threat boundary

An unrestricted worker running as the desktop user's UID must not manufacture
an authoritative assistant submission or approval through the local socket,
`apex-daemon --stdio --attach`, another daemon, or edits to user-owned JSON.
A same-UID socket connection still has access to ordinary authorized tools;
it is no longer evidence that a human submitted or approved assistant work.

The guarantee is **submission through pinned Apex UI code**, not proof that a
physical human typed or understood it. Root access, a compromised kernel,
compromise of the pinned code itself, and automation controlling the trusted UI
are outside this boundary. Full access remains unrestricted project files,
processes and network access subject to the existing access/privacy rules. It
is not authority to impersonate UI submissions or create standing approvals.

This candidate is macOS-only. Remote ordinary coding-room traffic keeps its
existing SSH route; remote assistant authority is refused. This is not a
security upgrade for an existing Linux/remote daemon.

## Components

`crates/apex-provenance` is a small root LaunchDaemon with a fixed Unix socket.
It has no command execution or arbitrary-path file API. Its operations are:

- `issue`: accept an exact UI command and return an Ed25519 submission receipt.
- `claim`: consume that receipt once, durably, before execution.
- `finish`: record the trusted daemon's succeeded/rejected outcome; rejection
  reasons are bounded, and an established outcome cannot be rewritten.
- `read`/`write`: read and compare-and-swap a fixed set of authority documents.

The root-owned directory is
`/Library/Application Support/Apex Deck Provenance`.
It contains the key pair, immutable build pins, durable journal and protected
copy of the signed app. The socket is `/var/run/dev.apexdeck.provenance.sock`.
There are no key/service-path environment overrides and no user-mode fallback.

The kernel supplies a socket audit token, including process-generation identity.
Security.framework validates that dynamic code against the exact installed
CDHash. The UI additionally has identifier `dev.apexdeck.app`. The signing
identity alone is insufficient: a Full access worker might have access to the
same user's Developer ID key, but cannot replace the root-owned CDHash pin.
The daemon has its own exact build pin and cannot issue UI receipts.

Both callers must have hardened runtime, acceptable entitlements, valid sealed
resources and root-owned, non-writable code paths. The installer recursively
removes writable ACLs, rejects bundle symlinks escaping the protected tree and
pins the copied artifacts after validating them. It refuses an existing
installation rather than resetting keys or overwriting records.

## Client and host admission

`desktop/provenance.mjs` sends protected intents from the authenticated Deck
window to the broker and verifies the signed response against the protected
public key. It compares UID, canonical host data directory and exact command
content before wrapping it as `provenance_execute`.

Delivery IDs for strict DTOs are signed **top-level** metadata, not extra fields
in command arguments. The host strips this metadata only while parsing the
already-bound command. Original request IDs remain bound for submissions and
personal decisions; task actions bind task ID and revision.

`Host::call_with_client_capability` is the common socket/CLI host gate. Plain
protected commands are rejected. An attested command requires a valid root
signature and a fresh signed nonce acknowledgement of durable consumption.
A fake socket, editable daemon token or copied JSON flag cannot provide that.
The caller never chooses a verification key or disables checking through an
argument, environment variable or CLI option. Relevant direct service methods
are crate-private. Paired devices cannot forward a wrapper to bypass scope.

Protected calls cover assistant submissions/actions, personal submissions and
decisions, standing permissions/configuration/machine grants, explicit memory
mutations, room authorization/configuration, and assistant-owned room
continuation. Project-note mutations are reserved to the UI pending the narrow
context-derived worker bridge in Phase 4. Normal coding/file/process tools are
not added to this protected intent surface.

Receipt keys deduplicate exact retries and reject changed content under the
same submission identity. Consumption is recorded before execution. After a
crash or lost response, consumption is **not** proof of successful execution:
the outcome is uncertain until a protected result is available. A retry cannot
repeat the write. Stale typed approvals return a rejection and record it.

## Direct writes and restart

Admission alone was insufficient. The old personal runtime reread human and
decision events, queued tasks, schedules and approval hashes from editable
`personal-assistants.json`. Room restoration also reused editable remembered
permissions, participants, options, cwd and fallback mount history.

Production storage now routes these exact ledger names through the broker:

- `assistant-conversations-v1.json`
- `assistant-tasks-v1.json`
- `personal-assistants.json`
- `personal-machine.json`
- `room-authority-v1.json`

Authority is scoped by kernel UID, canonical data directory and ledger name.
Writes require the pinned daemon and a current broker revision. Personal
state, task recovery and conversation lookup consequently use protected
originals rather than a worker's disk edits, including after restart.

Room transcripts remain ordinary project data. Their permission-bearing
fields, including mount lineage, are restored from the protected room manifest.
An editable snapshot cannot manufacture an Always allow rule, substitute
participants/cwd or inject an outside fallback mount. Deletion revokes the
manifest. The existing daemon DataLock provides one host per data directory;
the broker also rejects stale writes from another process.

Broker transactions are serialized and acknowledged only after file and parent
directory fsync. The response envelope is size-checked before committing.
Individual IPC frames are bounded independently from the larger durable
journal; a full journal rejects a transaction rather than evicting provenance.

## Executable hardening

Before signing, Electron packaging disables RunAsNode, NODE_OPTIONS and the
Node inspector, and enables embedded ASAR integrity and ASAR-only loading.
These fuses matter because JS startup validation runs too late to stop a
preloaded script. See the [Electron fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses).
The installer reads all fuse wires from the copied signed framework and checks
ASAR integrity metadata. Packaged UI DevTools are disabled and the menu item is
removed. Development builds retain their existing debugging controls.

Packaged startup refuses code-loading/debug environment and command-line
overrides. An absolute `APEX_DECK_DATA_DIR` is allowed for isolated QA: it selects
data, not executable code, and its canonical path is bound into each receipt.
`APEX_DAEMON_BIN`, a development renderer URL and smoke-code overrides remain
forbidden for the trusted packaged issuer.

## Legacy data and activation gate

**No existing app, LaunchAgent, conversation, assistant, memory or task was
installed over, moved, deleted or automatically certified.** The old user files
remain at their original paths. Production broker storage deliberately does
not ingest them as authority. A broker-unavailable host fails closed.

A migration remains an explicit rollout prerequisite, not an administrator
copy of unsigned JSON into the journal:

1. Snapshot and hash original files, retaining paths and read-only provenance.
2. Preview identities, memories, tasks, schedules and approvals to the user.
3. Preserve historical content as legacy/unverified records.
4. Require a fresh UI-confirmed import bound to exact source hashes.
5. Keep queued work interrupted/proposed, schedules paused and remembered
   approvals ungranted until separately reauthorized. Never restart work from
   an old `Approved` flag or label imported facts as newly user-confirmed.
6. Verify restoration and deduplication before changing which store the UI uses.

That import UI/command is **not implemented** in this candidate. Do not activate
this candidate on the user's normal data directory or distribute it as a
replacement app until migration and native acceptance pass. New installations
and isolated QA can exercise the protected path without blessing legacy data.

## Test seams and remaining acceptance

Host unit tests use isolated local storage; downstream behavior tests explicitly
assume verified UI admission. Daemon dependency tests use a `test-support`
constructor restricted to dedicated temporary directories and a process-local
registry. It is called only by test construction. Default production
construction remains broker-only even when the feature is compiled; there is
no environment/CLI/RPC path to register a fixture. The production-compiled
forged-storage integration test deliberately does not register one.

These tests do not substitute for installed OS verification. Before Phase 4:

- Verify signed UI and daemon success through the root broker in isolated data.
- Attempt the same intent from shell, raw socket, stdio attach and an alternative
  daemon; observe denied issuance and no protected state change.
- Tamper user JSON, restart, and confirm protected originals/approval states win.
- Crash between claim/dispatch/outcome, then verify uncertain status and no
  repeated effects; test concurrent compare-and-swap and rejected approvals.
- Inspect installed signatures, all fuse slices, keys, ACLs, nested resources and
  symlink containment; reject developer/ad-hoc or modified/copied mutable code.
- Verify Full access edits, builds, Git, network and subprocesses in that signed
  installation. Verify ordinary remote coding compatibility separately.
- Finish reviewed legacy migration and rerun native CLI integration acceptance.

Administrator authentication is required for the LaunchDaemon installation.
This session's `sudo -n true` returned `sudo: a password is required`.
The installer has been prepared and syntax-checked but has not been run.

Phase 4 must derive its original request from protected storage and recorded
intent. Record existence in the old JSON is never evidence of human origin.
