# Remote access milestone 3: QR pairing and connection modes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: draft, revised after Null's review (2026-10-07). Not built. Builds on milestone 2
(`feat/device-authority`, a91fa40), which must merge first.

**Goal:** A user taps **Pair phone** on the Mac (or runs `apex-daemon pair`
on a VPS), scans the QR in Apex Deck on the iPhone, checks that both screens
show the same code, approves, and the phone then reaches that machine from
anywhere over iroh, in Automatic or Direct only, with the route shown.

**Architecture:** The daemon's existing iroh endpoint gains a second ALPN,
`apex-deck/pair/1`, that accepts unknown endpoints only while an invitation
is live and runs a challenge/HMAC exchange bound to both authenticated
endpoint IDs and the TLS session. Approval goes through the local socket
(desktop Settings or the `pair` CLI) and adds the phone through the registry's
atomic `Devices::approve_pairing` (milestone 2's registry plus revisions). On the iPhone, the spike's C bridge becomes a production
Capacitor plugin (`ApexRemote`) that owns the Keychain key and the
connections, and exposes each connection to the web UI as a `Link` for the
existing `DaemonClient`.

**Tech Stack:** Rust (iroh 1.3.0, `hmac` + `sha2`, `qrcode`), Swift
(Capacitor 8 plugin, Keychain, AVFoundation scanner), TypeScript/React
(desktop Settings, phone app).

**Spec:** `docs/built-in-remote-access-plan.md` (sections "QR pairing",
"Connection modes and route selection", "Direct only identity and
addresses", milestone 3). Also `docs/iroh-mobile-spike.md` and
`docs/superpowers/plans/2026-10-07-device-authority.md`.

## Global Constraints

- iroh **1.3.0** on daemon and phone, same as the deployed relay.
- Production relay is only `https://relay.apex-terminal.xyz/`; no n0 relays or discovery in any non-dev build.
- `PortmapperConfig::Disabled` on every endpoint, phone and host, every build.
- Invitation secret: 256 random bits. Invitation lifetime: **5 minutes**. One phone per invitation.
- Pairing ALPN `apex-deck/pair/1`; session ALPN stays `apex-deck/1`.
- No daemon commands on a pairing connection.
- Approval is always required on the host, even for a valid proof.
- Secrets (invitation secret, phone key) never reach localStorage, logs, analytics, JavaScript (phone key) or the relay in readable form.
- Pairing commands and events are **local-only** (`Trust::Local`); a phone can't start, see or approve pairing.
- `~/Downloads/apex-deck` is the only build folder; build on a branch from `main` after milestone 2 merges.
- No TestFlight upload of an iroh-linked build until the export-compliance answer is settled (Task 9).

## Review Focus

1. **Two phones scan the same QR at once** → exactly one reaches the approval screen; the other is told "This code was already used." (Task 2 test `second_claim_is_refused`.)
2. **The QR expires while the user is looking at the code** → approving after expiry fails with "This pairing code expired. Start again." and no device is added. (Task 2 test `approve_after_expiry_adds_nothing`.)
3. **The phone was revoked on this machine before and pairs again** → the approval screen says so, and approving restores it; without approval it stays blocked. (Task 2 test `revoked_phone_needs_explicit_approval`.)
4. **Direct only with no reachable address** (home Mac, no forwarded port) → the phone shows "Direct connection blocked" with the port-forwarding hint and never touches the relay; it does not loop retrying every second. (Task 7 test + hardware check.)
5. **The phone loses access while the app is open** (revoked, or close code `NOT_PAIRED`) → the machine shows "Access removed — pair again on this machine" and stops retrying. (Task 7 test `revoked_close_stops_retrying`.)
6. **Approve races disconnect, cancel, expiry, revoke or restore** → approve returns `Ok` exactly when the device was committed to `devices.json`, and nothing is added otherwise. The phone *usually* gets `ok` too, but not always: if it drops right after the commit, it's paired without knowing it (the accepted window in step 6). An approval for an old claim never lands on a newer one, and never restores a phone whose registry entry changed after the claim, even when the change leaves the tombstone looking the same. (Task 2 race tests, Task 3 `approve_after_phone_left_adds_nothing`.)
7. **A different machine answers for the QR's host ID** → the phone stops before sending its proof. (Task 3 + Task 6 `wrong_host_key_is_rejected`.)

---

## What exists today

- `crates/apex-daemon/src/remote.rs`: endpoint bound with our relay only, port mapper off, one ALPN `apex-deck/1`, key in `<data>/iroh-key`, UDP port kept in `remote.json`. `serve()` closes unknown IDs with `close::NOT_PAIRED` and revoked ones with `close::REVOKED`.
- `devices.rs`: `Devices::add(id, label, tier, threads, restore)`, tombstones, broadcast of revokes. `devices_*` commands are local-only (`protocol.rs:325`).
- `serve --remote` exists behind the `remote` cargo feature (off by default). The desktop sidecar runs `serve --exit-on-stdin-close` (`desktop/sidecar.mjs:18`) with no `--remote`.
- Desktop **Settings → Paired devices** (`src/PairedDevicesSettings.tsx`) lists, retiers and revokes; nothing adds.
- Phone: machines are `DirectMachine { id, name, kind, url, token }` in localStorage (`src/phoneRules.ts:14`); each opens a `DaemonClient` over `webSocketConnect` (`src/phoneBackend.ts`). `DaemonClient` takes any `Connect` returning a `Link`.
- Phone iroh: spike only. `crates/iroh-mobile` is a JSON-over-C bridge with one global lock and echo pings; `iphone/IrohSpike` is a local Swift package wired in only by `scripts/iroh-mobile-local-wiring.sh`, which rejects Release builds. `iroh::Connection::export_keying_material` is available in 1.3.0 (`endpoint/connection.rs:1115`), so we can bind the proof to the TLS session.

## Design

### Pairing protocol (`apex-deck/pair/1`)

One bidirectional stream of newline-delimited JSON, at most 4 KiB per line, 30-second deadline for the initial exchange only: from connect until the host has verified the proof and replied `claimed` (step 4). After that the deadline is lifted and the claimed connection may wait for the human's Approve/Deny until the invitation expires (at most 5 minutes from `pair_start`); expiry, cancel or the phone disconnecting end that wait.

1. **Host → phone** `{"v":1,"challenge":<32 bytes b64url>,"host_name":"Tyler's Mac Studio"}`
2. **Phone → host** `{"invitation":<16 bytes b64url>,"label":"Tyler's iPhone","proof":<32 bytes b64url>}`
3. Host checks, in this order, each failure closing with a distinct close code:
   - invitation exists, not expired, not claimed → else `PAIR_UNKNOWN` / `PAIR_EXPIRED` / `PAIR_USED`
   - `proof == HMAC-SHA256(secret, transcript)`, constant-time → else `PAIR_BAD_PROOF`; 5 bad proofs cancel the invitation
   - On success the invitation becomes **claimed** by this phone ID (atomic; a second claim gets `PAIR_USED`). The claim gets a fresh random 16-byte `claim_id` and holds a handle to *this* connection, plus a snapshot of the phone's registry entry taken in one read under the registry lock: its **revision** and its tombstone (`previously_revoked_at`, or none). See "Device revisions" below.
4. **Host → phone** `{"claimed":true}`. The host does **not** send the code. Each side computes it on its own from its own transcript (phone: its key, `connection.remote_id()`, the challenge it received, its own EKM). The desktop shows phone label, code, tier and thread choice, and Approve/Deny; the phone shows its code. If anything in the two transcripts differs, the codes differ and the user denies.
5. On Approve (`pair_approve {invitation, claim_id}`), refusing with nothing added if any check fails. Under the pairing lock:
   - the invitation is still claimed, by **this** `claim_id` (else `PairError::StaleClaim`), and not expired or cancelled;
   - the claim's connection is still open (`connection.close_reason().is_none()`), else `PairError::PhoneLeft`;
   - then, still holding the pairing lock, one atomic registry call: `Devices::approve_pairing(phone_id, label, tier, threads, expect_revision)`. Inside the registry's own lock (the same one `revoke`, `add` and `set_*` take) it compares the phone's current revision with the claim's snapshot (else `PairError::Changed`: a revoke, restore or other change happened while the code was on screen; start again), then adds the device, lifting the tombstone only if the snapshot had one, bumps the revision and writes the file. Check and write can't be split by a revoke, because there is no moment between them when the registry lock is free;
   - mark the invitation consumed, release the pairing lock.

   Lock order is always pairing lock → registry lock. `Devices` never calls into `Invites`, so there's no cycle.

   **Host → phone** `{"ok":{"host_id":<daemon host_id>,"host_name":…,"tier":…,"threads":…}}`, close `BYE`. On Deny / expiry / cancel: `{"err":"…"}`, close `PAIR_DENIED` / `PAIR_EXPIRED`.
6. **Phone leaves before approval** (connection closes, or its 30 s initial-exchange deadline passes before it was claimed): the claim is dropped and the invitation is **burnt**, not reopened. `pair_wait` / `pair_approve` answer `PhoneLeft` ("The phone disconnected. Start again."). Expiry and cancel close the claimed connection with `PAIR_EXPIRED` / `PAIR_DENIED` at once, so a late Approve finds no open connection.

   One narrow window remains: the phone drops *after* `approve_pairing` commits but before it reads `ok`. Then the device is paired but the phone doesn't know it; it shows "Pairing didn't finish" and the device appears in Paired devices, where the user can revoke it. We accept that rather than undoing an add.

```
transcript = "apex-deck pair v1\0"
          || invitation_id (16) || challenge (32)
          || host_endpoint_id (32, from our own key)
          || phone_endpoint_id (32, from connection.remote_id())
          || ekm (32, export_keying_material(label="EXPORTER-apex-deck-pair-v1", context=""))
proof = HMAC-SHA256(secret, transcript)
code  = (first 4 bytes of HMAC-SHA256(secret, "apex-deck pair code v1\0" || transcript) as big-endian u32) mod 1_000_000, as "NNN NNN"
```

Both IDs come from what iroh authenticated, never from a message. The phone computes the same transcript from `connection.remote_id()` and its own key. iroh already refuses a TLS peer whose key doesn't match the dialed ID; the phone also checks `remote_id() == QR host` itself and closes before reading the challenge if not, so a wrong host key never gets a proof. The EKM differs per TLS session, so a proof captured from one connection fails on any other.

**Device revisions.** `Registry` gains `revisions: BTreeMap<endpoint_id, u64>` (persisted, `#[serde(default)]` so milestone 2 files still load). Every change to an ID's entry bumps it: add, restore, revoke, tier and thread changes; `seen` does not. Entries are never removed, so an ID's revision only grows, including across revoke → restore → revoke. Comparing revisions rather than tombstones closes the case Null found: a revoke then restore (or restore then revoke in the same millisecond) can leave the tombstone looking exactly as it did, but the revision has moved. `Devices::snapshot(id) -> (revision, Option<revoked_at>)` reads both under one lock. This is a small change to milestone 2's `devices.rs` and lands in Task 2.

**Revoked phones.** A tombstoned ID can still claim an invitation. The approval screen says "This phone was removed on <date>. Approving lets it back in." Approval of *that* claim is the explicit local action milestone 2 requires, so it passes `restore=true`, and only when the claim's snapshot showed the tombstone (the user saw the warning). A revoke or restore that lands after the claim, at any point up to the registry write, makes the approval fail with `Changed`; it is never silently undone.

**Pairing ALPN gate.** `remote::accept` routes by ALPN. On `apex-deck/pair/1` with no live invitation, close `PAIR_UNKNOWN` at once, before reading anything. At most 4 pairing connections are open at a time; extras are closed.

### QR / pairing link

`apexdeck://pair?p=<base64url(JSON)>`, JSON:

```json
{"v":1,"host":"<endpoint id hex>","name":"Tyler's Mac Studio","relay":"https://relay.apex-terminal.xyz/",
 "addrs":["192.168.50.14:41641","203.0.113.7:41641"],"inv":"<b64url 16>","secret":"<b64url 32>","exp":1791400000}
```

The phone rejects `v != 1`, any `relay` other than ours, an expired `exp` (allowing 2 minutes of clock skew), and a malformed `host`. `addrs` are hints: LAN addresses from `endpoint.addr()`, plus any advertised addresses (below). The QR renders as SVG on the desktop and as Unicode blocks in the terminal; the link text is also shown with a Copy button for the paste fallback.

### Advertised addresses (Direct only for home Macs)

`remote.json` gains `"advertise": ["myhome.ddns.net:41641"]`, set by `apex-daemon remote advertise <host:port>…` / `--clear`, or the desktop **Remote access** section. It goes into the QR and into the `hello` reply for device connections (`"addrs"`), so the phone refreshes its saved hints on every Automatic connect. The phone resolves hostnames itself before each dial (DDNS IPs change) and dials the pinned endpoint ID, so an address never establishes trust. Private (RFC 1918 / link-local / ULA) addresses are tried only while the phone is on Wi-Fi.

### Device `hello`

For `Trust::Device`, `hello`'s ok also carries `"access":{"tier":…,"threads":…}` and `"addrs":[…]`. The phone uses `access` to hide **New thread**, terminals and file actions below Full. That is a display courtesy only; the host still enforces everything (milestone 2).

### iPhone plugin `ApexRemote` (replaces the spike)

Rust (`crates/iroh-mobile`, renamed module `apex_remote`), Swift (`iphone/ApexRemote`, a normal local package always linked):

- **One endpoint per mode**, built from the Keychain key: Automatic = our relay only; Direct only = `RelayMode::Disabled`. Port mapper off on both. Switching mode closes every connection, rebinds with the same key and lets `DaemonClient` reconnect.
- **Handles, not a global lock.** Each connection or pairing attempt has a `u64` handle that is never reused. Calls are async on the Rust runtime and never hold a lock across an await.
- **Handle first, then work.** `connect` and `pair` allocate the handle synchronously and return it **at once**, before any dialing; progress arrives as events. So JS can `close(handle)` / `pairCancel(handle)` while the dial is still in flight, and that aborts the task's `CancellationToken` and returns within 1 s.
- **Calls** (Capacitor → native): `identity() → {endpointId}`, `setMode({mode})`, `pair({link}) → {handle}`, `pairCancel({handle})`, `connect({hostEndpointId, addrs}) → {handle}`, `send({handle, line})`, `close({handle})`, `shutdown()`.
- **Events** (native → JS): `opened {handle}`, `line {handle, line}`, `route {handle, route: "direct"|"relayed"|"connecting"}`, `closed {handle, code, reason}`; for pairing `pairCode {handle, code}` (computed by the phone, see protocol step 4) and `pairDone {handle, hostId, tier, threads, …}` / `closed`.
- **Bounded queues.** Each handle has a bounded outbound queue (256 lines or 16 MiB) and a bounded inbound event queue (1024 events or 32 MiB). One line may be up to 8 MiB, the daemon's `DEVICE_MAX_FRAME`, checked by a test. Handle numbers come from one process-wide counter and are never reused, even across shutdown and restart. `send` on a full outbound queue rejects ("busy"). A full inbound queue closes that connection locally with `OVERFLOW` rather than dropping lines; `DaemonClient` reconnects and replays from its last sequence (milestone 2 bookkeeping).
- **Teardown.** `close(handle)` marks the handle dead synchronously in Rust; every callback first checks the dead flag under that handle's own small lock, and a dead handle emits exactly one final `closed` and nothing after. Swift drops any event for a handle not in its live table; `irohLink.ts` ignores unknown handles too. `shutdown()` (plugin `deinit`, WebView reload, mode switch) cancels all handles, awaits their tasks, and only then unregisters the C callback, so no event can arrive on a freed callback context.
- **Key**: 32 bytes generated natively, Keychain `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, service `dev.apexdeck.remote.identity` (not the spike's). Passed to Rust as raw bytes, zeroized after the endpoint is built. Never sent to JS.
- **No force casts.** Malformed native output rejects the call with a message.
- **Release builds link it.** The spike guard and local wiring script are removed. The xcframework stays out of git. `scripts/build-iroh-mobile.sh` writes a stamp next to it: a SHA-256 over `crates/iroh-mobile`, `crates/apex-pairing`, `Cargo.lock`, the Rust toolchain version and the script itself. `npm run iphone:sync` and an Xcode pre-build phase rebuild when the xcframework is **missing or its stamp doesn't match**, and fail with "Install Rust (rustup) to build the iPhone app" when cargo isn't there. An outdated xcframework can't be linked silently.

### Phone machines

```ts
type Machine = DirectMachine | PairedMachine;
interface PairedMachine {
  id: string;            // daemon host_id from pairing
  name: string;
  kind: MachineKind;
  transport: "iroh";
  hostEndpointId: string;
  addrs: string[];       // hints, refreshed from hello
  pairedAt: number;
}
```

`loadMachines` keeps reading old entries as `DirectMachine` (no `transport` field). Connection mode (`"automatic" | "direct"`) is one phone-wide setting in localStorage, applied through `ApexRemote.setMode`.

**Screens**
- **Add machine** sheet: **Scan QR code** (primary) and **Paste pairing link**; the old address/token form moves under **Enter address manually**.
- **Pairing**: camera scanner → "Connecting to Tyler's Mac Studio…" → code in large digits, "Check that your computer shows the same code, then approve it there." → success, or the error by close code: expired, already used, denied, "Your phone isn't approved on the Apex Deck relay yet — show this ID to the beta operator: <ID> [Copy]" when the relay refuses and no direct address worked.
- **Machine row**: `Direct` / `Relayed` pill while connected.
- **Settings → Remote access**: this phone's endpoint ID with Copy (for the beta allowlist); **Advanced → Connection**: Automatic (default) / Direct only with the spec's explanation text verbatim.
- **Machine edit**: name, and for paired machines an **Extra address** field (`host:port`) for Direct only; no token field.

**Status lines** (`phoneRules.ts`): close `REVOKED`/`NOT_PAIRED` → `failed`, "Access removed — pair again on this machine"; Direct only with every address timing out → `reconnecting` with "Direct connection blocked. A home computer needs a forwarded UDP port (Settings → Remote access on the computer shows which)."; Automatic with relay refused → "Relay unavailable".

### Desktop

- **Settings → Remote access** (new section above Paired devices): switch **Allow paired phones to connect from anywhere** (persists in app settings; the sidecar adds `--remote` when on and restarts), the endpoint ID, UDP port, and the advertised-address field.
- **Paired devices → Pair phone** opens a sheet: QR + Copy link + 5:00 countdown; tier picker (default **Chat and approvals**) and threads (All / pick). When a phone claims: label, code, revoked-before warning if any, **Approve** / **Deny**. Closing the sheet cancels the invitation.
- Desktop package builds the daemon with `--features remote` (`package.json` desktop scripts).

### Headless (`apex-daemon pair`)

`apex-daemon pair [--tier read_only|chat|full] [--threads all|ID,ID]` talks to the running daemon over the local socket (like `devices`): `pair_start`, prints the QR and link, `pair_wait` until claimed/expired, prints label + code (+ revoked warning), asks `Approve? [y/N]`, then `pair_approve` or `pair_cancel`. Ctrl-C cancels. Refuses with a clear message if the daemon isn't running with `--remote`.

### New local-only daemon commands

| Command | Args | Answer |
| --- | --- | --- |
| `pair_start` | `{tier, threads}` | `{invitation, link, expires_at}` |
| `pair_wait` | `{invitation}` | when claimed: `{claim_id, phone_id, label, code, previously_revoked_at}`; or err expired/cancelled/phone_left. Long-poll, ends at expiry. |
| `pair_approve` | `{invitation, claim_id}` | `{device}`; err stale_claim / phone_left / changed / expired / cancelled |
| `pair_cancel` | `{invitation}` | `null` |
| `remote_info` | `{}` | `{enabled, endpoint_id, port, advertise}` |
| `remote_advertise` | `{addrs}` | `{advertise}` |

They go in the same local-only branch as `devices_*` (`protocol.rs:325`). The desktop uses `pair_wait` too, so there are no new events to classify.

---

## Tasks

### Task 1: Pairing crypto and link format (daemon, pure)

**Files:** Create a small workspace crate `crates/apex-pairing` (`src/lib.rs`, `src/proof.rs`, `src/link.rs`; deps `hmac`, `sha2`, `base64`, `serde`) so the daemon and the iPhone bridge share one implementation; add it to the root `Cargo.toml` members and as an optional dependency of `apex-daemon` under the `remote` feature.

**Interfaces — Produces:**
- `pub struct Transcript<'a> { invitation: &'a [u8;16], challenge: &'a [u8;32], host: &'a [u8;32], phone: &'a [u8;32], ekm: &'a [u8;32] }`
- `pub fn proof(secret: &[u8;32], t: &Transcript) -> [u8;32]`
- `pub fn verify(secret: &[u8;32], t: &Transcript, proof: &[u8]) -> bool` (constant time via `hmac::Mac::verify_slice`)
- `pub fn code(secret: &[u8;32], t: &Transcript) -> String` → `"NNN NNN"`
- `pub struct Invite { v, host, name, relay, addrs: Vec<String>, inv: [u8;16], secret: [u8;32], exp: u64 }` with `to_link() -> String` and `parse_link(&str, now_s: u64) -> Result<Invite, String>`

- [ ] Write failing tests: a proof verifies; changing any one transcript field (each of the five) makes `verify` false; `code` is 7 chars `\d{3} \d{3}` and changes when the phone ID changes; a known-answer vector (fixed secret/transcript → fixed hex proof **and** code, computed once and pasted, so the phone side can share it); `parse_link` rejects `v=2`, another relay, expired `exp`, bad base64, wrong-length `host`; round-trip `to_link`/`parse_link`.
- [ ] Run `cargo test -p apex-pairing` → fails to compile.
- [ ] Implement.
- [ ] Run again → pass. Commit `feat: pairing proof, code and link format`.

### Task 2: Invitations (daemon state, no network)

**Files:** Create `crates/apex-daemon/src/pairing/invites.rs`. Modify `crates/apex-daemon/src/devices.rs` (revisions, `snapshot`, `approve_pairing`).

**Files (cont.):** `crates/apex-daemon/src/pairing.rs` re-exports `apex_pairing`.

**Interfaces — Consumes:** Task 1 types; `Devices::list`, `Devices::revoke` (milestone 2). **Produces:**
- `Devices::revision(id) -> u64` (0 if never seen), `Devices::snapshot(id) -> (u64, Option<u64>)`, and `Devices::approve_pairing(id, label, tier, threads, expect_revision) -> Result<Device, ApproveError>` where `ApproveError::{Changed, Registry(String)}`; compare-and-add in one `change` closure. `add`, `revoke`, `set_tier` and `set_threads` bump the revision.
- `pub struct Invites` (in `Daemon`, `Arc<Invites>`), `Invites::start(tier, threads, now) -> Invite` (secret from `rand::rngs::OsRng`)
- `claim(inv_id, phone_id, label, proof_ok: bool, conn: ClaimConn, now) -> Result<Claim, PairError>` where `PairError::{Unknown, Expired, Used, BadProof, Cancelled, StaleClaim, PhoneLeft, Changed}` maps to close codes / error replies. `ClaimConn` is a trait (`is_open()`, `close(code)`) so tests use a fake and Task 3 wraps `iroh::Connection`.
- `phone_left(inv_id, claim_id)` (called by Task 3 when the connection ends) burns the invitation.
- `wait(inv_id) -> Result<Claim, PairError>` (async; resolves on claim, expiry, cancel or phone left)
- `approve(inv_id, claim_id, &Devices, now) -> Result<Device, PairError>`, running the step-5 checks under the pairing lock and the registry compare-and-add via `approve_pairing`; `deny`/`cancel(inv_id)` close the claimed connection
- `Claim { claim_id, phone_id, label, code, revision: u64, previously_revoked_at: Option<u64> }`
- in-memory only; a daemon restart drops all invitations.

- [ ] Write failing tests:
  - `second_claim_is_refused` — two claims on one invitation: first Ok, second `Used`.
  - `approve_after_expiry_adds_nothing` — claim at t, approve at t+5min+1s → `Expired`, `devices.list()` unchanged.
  - `revoked_phone_needs_explicit_approval` — revoke ID, claim shows `previously_revoked_at`, `get(id)` still None until approve, then Some.
  - `five_bad_proofs_cancel` — 5 `proof_ok=false` claims → 6th good one gets `Cancelled`.
  - `consumed_invite_cannot_be_reused` — approve, then claim again → `Used`.
  - `cancel_wakes_waiter` — `wait` returns `Cancelled` after `cancel`.
  - `approve_after_phone_left_adds_nothing` — fake conn closed (or `phone_left` called) → approve gets `PhoneLeft`, no device, invitation burnt (a new claim gets `Used`).
  - `approve_after_cancel_adds_nothing` and `approve_after_deny_adds_nothing`.
  - `stale_claim_id_refused` — approve with a wrong / earlier `claim_id` → `StaleClaim`, no device.
  - `revoke_after_claim_blocks_approve` — claim (no tombstone), then `devices.revoke(id)`, approve → `Changed`, tombstone intact.
  - `stale_approval_never_restores` — claim while tombstoned, phone leaves, a later claim by the same phone on a *new* invitation; approving the old `(inv, claim_id)` → error, still tombstoned.
  - `revision_survives_identical_tombstone` — claim while tombstoned (snapshot revision r), then `add(restore)` and `revoke` again with the clock frozen (a `#[cfg(test)]` override for `now_ms` in `devices.rs`) so the new `revoked_at` equals the old one; the tombstone is byte-identical, approve → `Changed`, still tombstoned. Same with no tombstone: claim, then `add` + `revoke` + `add(restore)` + `revoke` → `Changed`.
  - `revisions_persist` — bump, reopen `Devices` from disk, revision unchanged; a milestone-2 `devices.json` with no `revisions` loads with all revisions 0.
  - Races (each run 200× on a multi-thread runtime with a barrier):
    - approve vs `cancel`, approve vs expiry, approve vs `phone_left`. Invariant: approve returned `Ok` ⇔ the device is in `devices.json`, and when it's `Ok` the fake conn was open when the pairing-lock checks ran. It does **not** assert the phone received `ok`; the fake conn may close right after the commit (step 6's accepted window), and one run in the batch forces that order to prove approval still commits.
    - approve vs `Devices::revoke(id)` on an un-tombstoned claim. Invariant: after both finish the ID is always tombstoned and not in `devices`; approve is `Ok` only if its write landed before the revoke's (revision after approve < final revision), else `Changed`.
    - approve vs a CLI restore of the tombstoned phone (`apex-daemon devices add <id> --restore`, which takes the registry lock and bumps the revision). Invariant: exactly one of them succeeds, the device appears once, the other gets `Changed` / "already paired".
    - approve vs revoke → restore run back-to-back on another task. Invariant: approve is `Ok` only if it committed before the revoke; never `Ok` after the restore.
- [ ] Run → fail. Implement. Run → pass. Commit `feat: daemon pairing invitations with single use and expiry`.

### Task 3: Pairing over iroh (daemon)

**Files:** Modify `crates/apex-daemon/src/remote.rs` (ALPN routing, `pair_serve`, close codes `PAIR_UNKNOWN=10, PAIR_EXPIRED=11, PAIR_USED=12, PAIR_BAD_PROOF=13, PAIR_DENIED=14`), `bind()` alpns gets `PAIR_ALPN`.

**Interfaces — Consumes:** Tasks 1–2. **Produces:** `pub const PAIR_ALPN: &[u8] = b"apex-deck/pair/1";` `pub async fn pair_serve(daemon, connection)`; a test helper `pub async fn pair_dial(key, server_addr, invite) -> Result<Value, (u32, String)>` in `#[cfg(test)]` that plays the phone side using Task 1.

- [ ] Write failing loopback tests (relay `None`, like the existing `remote.rs` tests):
  - happy path: start invite, dial, approve from another task → phone gets `ok`, then `apex-deck/1` with the same key is served.
  - no live invitation → closed `PAIR_UNKNOWN` before any frame.
  - wrong secret → `PAIR_BAD_PROOF`.
  - proof replayed on a new connection (capture the proof bytes, send them on a second connection) → `PAIR_BAD_PROOF`.
  - proof computed for a different phone ID, sent by another key → `PAIR_BAD_PROOF`.
  - `wrong_host_key_is_rejected` — invite carries host key A's ID, a daemon with key B listens at the address: the dial fails or the phone-side check closes it, the daemon receives no proof frame, and nothing is claimed.
  - `approve_after_phone_left_adds_nothing` — phone closes after `claimed`; `pair_approve` → `PhoneLeft`, no device.
  - expiry while claimed → phone's connection gets `PAIR_EXPIRED` immediately; a later approve adds nothing.
  - phone's code (computed by the test helper from its own transcript) equals `Claim.code`.
  - a session command (`hello`) on the pairing stream → closed, nothing run.
  - deny → phone gets err + `PAIR_DENIED`, no device.
  - fifth concurrent pairing connection is closed.
- [ ] Run → fail. Implement. Run `cargo test -p apex-daemon --features remote` → all pass (old tests too). Commit `feat: daemon pairs phones over iroh with a bound challenge proof`.

### Task 4: Local commands, `hello` access, advertised addresses, `pair` CLI

**Files:** Modify `protocol.rs` (local-only branch, `hello` device extras), `remote.rs` (`advertise` in `remote.json`, `start` returns it), `cli.rs`; create `crates/apex-daemon/src/pair_cli.rs` (shares `through_daemon` with `devices_cli.rs` — move it to a small `local_call.rs`); `Cargo.toml` (`qrcode` with only the unicode renderer).

**Interfaces — Produces:** the six commands in the table above; `hello` ok for `Trust::Device` adds `access` and `addrs`.

- [ ] Failing tests: each new command refused from `Trust::Device` and `Trust::Token`; `hello` from a device carries its current tier/threads and the advertised addresses; `remote_advertise` rejects `nonsense`, accepts `host:port` and `[v6]:port`, survives restart; `pair_cli::parse` cases; a CLI run against a live test daemon where a scripted phone claims and `y` approves.
- [ ] Run → fail. Implement. Run → pass. Commit `feat: apex-daemon pair, local pairing commands and advertised addresses`.

### Task 5: Desktop — Remote access switch and Pair phone sheet

**Files:** Modify `desktop/sidecar.mjs` (`serveArgs(dataDir, { remote })`), `desktop/main.mjs` (setting + restart), `package.json` desktop scripts (`--features remote`); create `src/pairing.ts` (API + countdown/status text rules), `src/PairPhoneSheet.tsx`, `src/RemoteAccessSettings.tsx`; modify `src/SettingsPage.tsx`, `src/PairedDevicesSettings.tsx`; tests `tests/pairing.test.mjs`, `tests/sidecar.test.mjs` (extend if it exists).

- [ ] Failing tests: `serveArgs(dir, {remote:true})` contains `--remote`; `pairing.ts` countdown text (`4:59`, `0:00` → "Expired"); revoked-before warning text; approve disabled until claimed; closing calls `pair_cancel`.
- [ ] Implement. `npm test` and `npx tsc --noEmit` pass.
- [ ] Check it in a running app with its **own** data folder (`APEX_DECK_DATA_DIR=$(mktemp -d) npm run desktop:dev`), never the installed Deck's: QR appears, countdown runs, Cancel cancels. Screenshot for the reviewer.
- [ ] Commit `feat: desktop pairs phones from Settings with a QR and approval`.

### Task 6: iPhone `ApexRemote` plugin (production bridge)

**Files:** Rewrite `crates/iroh-mobile/src/lib.rs` (handles, async, events via a registered C callback, zeroized key); move `iphone/IrohSpike` → `iphone/ApexRemote` (Swift plugin, Keychain, no `as!`); modify `iphone/App/App.xcodeproj` to link it in all configurations; delete `scripts/iroh-mobile-local-wiring.sh` and the spike screen gate; `scripts/build-iroh-mobile.sh`, `package.json` `iphone:sync`. Depends on `crates/apex-pairing` from Task 1 for the transcript, proof and link parser.

- [ ] Failing Rust tests (host-side, loopback):
  - two concurrent connections on two handles;
  - `connect` returns a handle before the dial finishes; `close(handle)` during a 20 s connect returns within 1 s, and the handle gets exactly one `closed` and no later `opened`/`line`;
  - `pairCancel(handle)` mid-pair, same guarantee;
  - after `close`, a line the host sends late is never delivered;
  - inbound queue overflow closes with `OVERFLOW`; full outbound queue makes `send` reject;
  - `shutdown()` returns only after all tasks end; no callback fires after it (counter in the test callback);
  - 100 open/close cycles leave 0 live handles and 0 running tasks;
  - `wrong_host_key_is_rejected` from the bridge side (no proof sent);
  - the bridge's own `pairCode` equals the daemon's `Claim.code` in loopback;
  - a Direct only endpoint given an address with a relay hint dials only the IP; a remote close code reaches the `closed` event; the Task 1 known-answer vector (proof and code) matches.
- [ ] Build-script stamp: touching a file in `crates/iroh-mobile` makes `npm run iphone:sync` rebuild; an unchanged tree doesn't.
- [ ] Implement. `cargo test -p iroh-mobile` passes; `scripts/build-iroh-mobile.sh` builds device + arm64 Simulator.
- [ ] Unsigned iPhone **Release** build passes from a fresh clone with no xcframework, and again after changing a bridge source file (`xcodebuild … -configuration Release CODE_SIGNING_ALLOWED=NO`).
- [ ] Commit `feat: iPhone ApexRemote plugin replaces the iroh spike bridge`.

### Task 7: Phone app — pairing, paired machines, modes, route, statuses

**Files:** Create `src/daemon/irohLink.ts` (`irohConnect(machine, plugin): Connect`), `src/phone/PairSheet.tsx`, `src/phone/RemoteSettings.tsx`; modify `src/phoneRules.ts` (types, `loadMachines`, status lines, `canSeeNewThread(access)`), `src/phoneBackend.ts` (pick link by `transport`), `src/phone/PhoneApp.tsx`, `iphone/App/App/Info.plist` (`NSCameraUsageDescription`: "Scan the pairing code shown on your computer.", URL scheme `apexdeck`); add a scanner plugin (`@capacitor-mlkit/barcode-scanning` or AVFoundation inside `ApexRemote`; pick the one with no Google Play services dependency on iOS); tests `tests/phone-pairing.test.mjs`, `tests/iroh-link.test.mjs`.

- [ ] Failing tests with a fake plugin:
  - `irohConnect` resolves a `Link` that round-trips lines; `closed` after open calls `onClose`.
  - `revoked_close_stops_retrying` — close code 2 → `DaemonClient` status `failed`, "Access removed — pair again on this machine", no retry timer.
  - Direct only, connect timeout → "Direct connection blocked…" line, backoff continues at the normal schedule (not faster).
  - `loadMachines` reads an old `DirectMachine` list unchanged and a mixed list.
  - pairing link from the camera and from paste go through the same parser; a link with another relay is refused with "This code isn't from Apex Deck."
  - `canSeeNewThread({tier:"chat"})` false, `full` true.
  - `hello.addrs` replaces the saved hints.
  - pairing screen shows the code from the plugin's `pairCode` event; a `closed` arriving for an old pairing handle doesn't touch the current attempt.
- [ ] Implement. `npm test`, `npx tsc --noEmit` pass. Phone build (`node scripts/build-phone.mjs`) and Simulator build pass.
- [ ] Commit `feat: phone pairs by QR and connects to paired machines over iroh`.

### Task 8: Hardware acceptance (needs the human's phone)

- [x] Installed Mac remains reachable after ⌘Q: human confirmed the phone connected on cellular and opened a thread (2026-10-07). Human-reported result; not independently observed.
- [x] Apex-Terminal paired with `apex-daemon pair --tier full` + `y`; phone shows Connected (2026-10-07). Human-reported; network (Wi-Fi vs cellular) not stated.
- [x] Chat sent from the phone, reply received (2026-10-07). Human-reported; which machine and network not stated.

No code; record results in `docs/iroh-mobile-spike.md` → rename to `docs/remote-access-acceptance.md`.

- [ ] Phone's new production endpoint ID added to the relay allowlist (the spike ID is a different Keychain item); old spike ID removed.
- [ ] Pair the home Mac on Wi-Fi; pair Apex-Terminal over cellular through the relay (`apex-daemon pair` over SSH).
- [ ] Each failure from the spec on real hardware: expired QR, second phone (or Simulator) scanning the same QR, Deny, a QR with the relay edited → refused on the phone.
- [x] Cellular: Mac and VPS in Automatic both show Connected · Direct; chat sent to each, replies received (2026-10-07). Human-reported; not independently observed.
- [ ] Direct only: VPS with its port open → Direct; home Mac without a forwarded port → "Direct connection blocked".
- [ ] Packet capture on the relay during a Direct only session with a forced Wi-Fi→cellular switch: no packets from the phone's session socket reach the relay.
- [ ] Router check: no UPnP/NAT-PMP mappings from the Mac or phone in the router's table.
- [ ] Revoke from the desktop while the phone is open → "Access removed" within 2 s.

### Task 9: Export compliance before any TestFlight build (human decision)

The production phone build now links iroh (QUIC/TLS 1.3 via rustls). `Info.plist` currently says `ITSAppUsesNonExemptEncryption = NO`. Before the next TestFlight upload the human answers App Store Connect's encryption questions for this build and we set the key to match. I won't change it or upload until that's decided. This blocks shipping, not building.

---

## Out of scope (milestone 4+)

Recovery kit and replacement-phone bootstrap; mutation dedup and jittered foreground reconnect; Mac daemon key in Keychain (still a release blocker from milestone 2); push notifications; public relay access policy; a persistent background daemon when the desktop window is closed (the switch in Task 5 only covers while Deck is running).

## Decisions (settled 2026-10-07)

The human accepted the recommended answer on all six.

1. **Re-pairing a revoked phone** clears its tombstone on explicit approval of that exact claim (shown with a warning), and only if the phone's registry revision hasn't moved since the claim. No separate `devices add --restore` step.
2. **Phone leaving burns the invitation** instead of reopening it for another scan. The cost is pressing Pair phone again.
3. **One phone key for all machines** (one relay allowlist entry per phone), not one per machine.
4. **Code length: 6 digits** (about 20 bits). It's a "same phone?" check on top of the 256-bit secret, not the security boundary.
5. **Rust is required to build the iPhone app** once iroh is linked in Release; the stamp check rebuilds outdated artifacts as well as missing ones. Publishing a prebuilt xcframework is deferred until outside contributors build the app.
6. **Pairing through the relay needs the phone on the beta allowlist first**; pairing on the same Wi-Fi doesn't. Accepted beta friction until milestone 5's access policy.

Still open: the App Store encryption answer (Task 9) before any TestFlight upload.

Estimate: 1.5–2 weeks for one engineer, most of it Tasks 6–7.
