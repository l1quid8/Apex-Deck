# iPhone connection and command review

Reviewed source: `253da444e2a619f4cf88bda06861558f00d34fd2`.
Scope: phone room loading/sending, pairing authority, daemon dispatch,
provenance admission, attachments, connection status and related tests.
This is a focused review, not an exhaustive audit of every Apex Deck subsystem.
No application code, installed bundle, pairing record or protected ledger was changed.

## Findings

### P1: Paired phones have no route through protected command admission

Locations: `crates/apex-host/src/command.rs:219,251-272`,
`crates/apex-daemon/src/authority.rs:56`,
`crates/apex-daemon/src/protocol.rs:541-557,687-691`, `src/phoneBackend.ts:39-55`.

An authenticated Full phone passes device authorization for `room_create`,
but dispatch then reaches the host's receipt gate. Creation, configuration,
approvals and answers require protected receipts. The phone's command backend
sends plain commands; only the installed desktop UI can issue receipts, and
`provenance_execute` is explicitly forbidden to paired devices. Granting Full
access or reconnecting does not resolve this. The error in IMG_4122/IMG_4123 is
the exact rejection string at command.rs:272. Matching build IDs alone will
not resolve the missing admission path in the reviewed source.

Repair: design a broker-backed admission path for authenticated phone intents,
binding device identity, current tier/thread scope, exact command and replay
identity. Keep assistant-owned authority separate from ordinary coding access.
Device grants must meet the provenance threat model before becoming evidence
of a human submission: the current registry is user-owned `devices.json`, and
device management accepts ordinary local-socket callers. Simply trusting the
daemon/device flag or removing `RoomCreate` from `requires_provenance` would
weaken the existing boundary. Add production-gate phone tests for creation,
reopening, approvals, revocation and narrowed scope.

### P1: Reading an existing phone thread first requires global Full creation access

Locations: `src/roomRecovery.ts:4-10`, `src/phone/PhoneApp.tsx:899-904`,
`crates/apex-daemon/src/authority.rs:72,125`.

`loadRoomState` always calls `roomCreate` before `roomState`. Thus even an
already-open room that permits a scoped read cannot be viewed by a ReadOnly,
Chat or thread-limited Full device: `RoomCreate` requires global Full access.
On the current protected host, even unrestricted Full devices hit finding 1
before the read. This also explains why the error may appear on opening a
thread, before pressing Send.

Reproduced with a backend whose `roomState` succeeds and whose `roomCreate`
rejects: `loadRoomState` rejects and never calls `roomState` (read count: zero).

Repair: distinguish reading/attaching to an existing thread from creating one.
Use the permitted state read for an already-open room; specify restoration of
saved but unopened rooms separately, because `Host::room_state` currently needs
a live handle. Preserve unsupported-helper fallback without treating permission,
provenance or network failures as a reason to create a room. Cover all device
tiers and scopes, including read access to a room already open on the desktop.

### P2: A 6 MiB attachment exceeds the phone wire limit and closes its connection

Locations: `src/phone/PhoneApp.tsx:1166-1176`, `src/daemon/transport.ts:43`,
`src/daemon/irohLink.ts:61-64`, `crates/iroh-mobile/src/lib.rs:48,367-371`,
`crates/apex-daemon/src/protocol.rs:41`.

The picker reads files without a transport-size check. The transport base64
encodes all bytes in one JSON line. The native phone bridge allows at most
8 MiB per line, whereas the host permits attachments up to 20 MiB.
A 6 MiB file already needs 8 MiB for base64 alone, plus JSON overhead.
The bridge rejects that send; `irohConnect` catches the rejection by closing
the entire link. Retrying the same attachment repeats the failure, potentially
followed by the misleading asleep message in finding 4.

Reproduced using the real `daemonTransport` serializer: 6,291,456 input bytes
produce an 8,388,702-byte request for `existing-room/photo.heic`, beyond the
8,388,608-byte frame limit. This is independent of provenance admission.

Repair: validate the encoded request size against a negotiated transport limit
before sending and report the rejection while preserving the draft/link. If
20 MiB phone attachments are required, implement bounded chunked transfer.
Test exact-limit and over-limit payloads, multibyte filenames, and draft/link
preservation after a rejected upload. Raising every connection's frame bound
without accounting for base64 and queued memory is insufficient.

### P2: Disconnection is presented as confirmed Mac sleep

Locations: `src/phoneRules.ts:142-151`,
`src/phone/PhoneApp.tsx:2605-2608`, `src/phone/threadListRules.ts:85`.

Every offline Mac is called asleep; there is no sleep signal in `LinkView`.
Network failure, daemon shutdown and upload-triggered disconnection can all
produce the screenshot's “is asleep” / “Paused until … wakes” wording.
The rules tests currently assert this assumption as expected behavior.

Repair: report “can't be reached” / reconnection until a verified sleep signal
is available. Preserve retry and the unsent draft. Update both the thread
banner and machine-list heading plus their tests.

## Screenshot interpretation

- The screenshot identifies Mac build `3288e52e6f38` and iPhone build
  `e4a7b5fd791c`. Both resolve to different commits in this repository.
  This is a separate compatibility warning; it does not issue a receipt.
- The receipt error is a server-side command rejection. Re-pairing or repeatedly
  tapping Retry cannot add the missing protected admission path.
- The asleep message establishes only loss of connection, not the Mac's actual
  power state. The Mac daemon was running during this review; that observation
  does not establish its state at screenshot time.
- Ordinary coding `RoomPost`/`RoomPostTo`/`RoomTurn` commands are not universally
  receipt-gated; assistant-owned execution continuations are. Restoring an
  allowed existing room read can therefore recover some ordinary chat use,
  while creation and protected actions still require finding 1 to be resolved.

## Verification

- `npx tsc --noEmit`: passed.
- `cargo test -p apex-host-production-check` (run separately): 3 passed,
  including a check that `test-support` is disabled.
- Focused phone, iroh and desktop-provenance Node tests: 57 passed.
- Minimal runtime reproductions confirmed the skipped permitted read,
  oversize serialized attachment and unverified sleep wording.
- The daemon protocol/remote test hosts explicitly assume verified UI and
  isolated host dispatch bypasses production receipt admission. Passing those
  tests cannot establish production phone compatibility.
- `npm test`: 2,522 passed, 3 skipped, 0 failed (2,525 total).
  Full output: `/tmp/apex-null-review-tests.log`.

No physical-iPhone or TestFlight validation was performed. No application fix
has been implemented or deployed in this review.
