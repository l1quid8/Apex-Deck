# Protected assistant provenance — gated macOS candidate

Status: implemented for review, **not production accepted**. Phase 4 is blocked.
The existing Agents tab and Full access execution rules are unchanged.
Current integration and outstanding UI work are tracked in
[the gate handoff](../handoff/2026-10-22/INTEGRATION.md); the earlier
[candidate validation](provenance-validation.md) is historical evidence.

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
mutations, room authorization/configuration, assistant-owned room
continuation, and the confirmed legacy ledger import. Project-note mutations are reserved to the UI pending the narrow
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
manifest. Before opening authority, the pinned daemon obtains signed broker
acknowledgements for its canonical primary and saved-chat folders, then takes
exclusive nonblocking kernel locks on stable root-owned inodes under
`ROOT/host-locks/`. The host retains read-only, close-on-exec descriptors for its
lifetime. Both scopes must succeed before either live guard is published;
contention is a fatal construction error before ledger reads or worker recovery.
After ownership succeeds, failure to open any initial protected ledger also
aborts construction; a partially authoritative host never uses empty task state
alongside live saved-room authority.
The editable daemon `owner.lock` remains an ordinary startup convenience and
provides no adversarial singleton guarantee.

Each protected document, claim and outcome call canonicalizes its final folder
and retains a strong reference from a private weak guard registry throughout
IO. A missing or untrusted broker leaves the host without authority; later RPCs
never acquire ownership, so broker recovery requires a host restart. Symlink
retargeting into an unowned folder refuses authority. Broker restart cannot
release a living host's kernel locks when the stable files are preserved, while
host death does. Root-administrator replacement or reset of those files is a
separate maintenance operation outside the same-UID threat boundary. The broker also
rejects stale writes from another process.

Lock filenames bind kernel UID and canonical folder by SHA256. The broker
creates empty root-owned mode 0444 files once, durably, under a mode 0755
root-owned directory; it never replaces existing inodes. Existing scopes remain
usable at the 4,096-file capacity; new scopes fail closed. These bookkeeping
files persist after isolated QA. A same-UID process can contend for the readable
locks as denial of service, which grants no authority and is outside the
authenticity guarantee, as are stopping or killing the host.

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
ASAR integrity metadata. The audio-input entitlement preserves the existing voice capability under
hardened runtime ([Apple documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)).
Packaged UI DevTools are disabled and the menu item is
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

The host import and initial preview/confirmation UI exist; G2b's remaining
refresh, record-marker and read-only history work is still pending review.
`legacy_import_preview`
(read-only) copies each legacy file into `<data>/legacy-import/<YYYYMMDD-HHMMSS>/`
with a `manifest.json` of paths, sizes and sha256, makes the copies read-only and
reuses a matching earlier snapshot. `legacy_import_apply` is a protected UI intent
(the broker's `protected()` list includes it, so an installed broker must be
updated before it can issue one). It binds the exact previewed hashes, re-hashes
the snapshot, and writes each ledger in one compare-and-swap with a `legacy`
marker (`verified: false`) on every record. Queued tasks become proposals,
in-progress tasks are interrupted, approvals, leases, delegation lineage and
assistant thread claims are dropped, room manifests get empty remembered
permissions, Full/Edits bot access resets to Ask, custom command bots stay
inactive in the snapshot until added again through the UI, and only the mount
chain leading to the room's folder is retained. Imported
conversations keep only capped excerpts in a non-executable `legacy` state. The
full transcript is served read-only from the snapshot by `legacy_import_history`.
A task, conversation or personal-assistant ledger imports one legacy source:
an exact retry writes nothing, and different content is refused. Rooms deduplicate
by room ID so a later import can restore additional rooms without replacing an
existing protected manifest. Personal assistants preserve identities, memories,
correction/forget chains and historical messages as legacy/unverified records.
Every action class requires at least Ask; machine links and remembered automatic
approvals are ungranted, pending work needs a fresh decision, schedules wait for
confirmation and old process fingerprints cannot become recovery instructions.
Machine grants are previewed but never imported. See
[the host completion notes](../handoff/2026-10-22/CONTINUATION.md) for the reviewed
mapping. Do not activate
this candidate on the user's normal data directory or distribute it as a
replacement app until migration and native acceptance pass. New installations
and isolated QA can exercise the protected path without blessing legacy data.

## Test seams and remaining acceptance

Host unit tests use isolated local storage; downstream behavior tests explicitly
assume verified UI admission. Daemon dependency tests use a `test-support`
constructor restricted to dedicated temporary directories and a process-local
registry. It is called only by test construction. Default production
construction remains broker-only even when the feature is compiled; there is
no environment/CLI/RPC path to register a fixture.

Integration suites get the seam without a manual flag: `apex-host` and
`apex-daemon` enable `test-support` through a dev-dependency on themselves, so
`cargo test -p apex-host` and `cargo test -p apex-daemon` need no argument. That
feature is compiled only into test builds, and compiling it opts nothing in.

The daemon's integration tests spawn a separate test-only binary,
`apex-daemon-fixture` (`required-features = ["test-support"]`). Its own `main`
marks the process as verified-UI-assuming and then runs the normal daemon
command line; the isolated host is still limited to a dedicated directory under
the temporary directory. The shipped `apex-daemon` binary never makes that
call, so `Daemon::start` is broker-only in every build of it, including
`cargo test --release`. The fixture binary is never installed or packaged, and
`scripts/package-mac.mjs` runs the plain release builds of `apex-daemon` and
`apex-provenance` itself before packaging, so a stale or test-built
`target/release` binary is never copied.

`npm run test:e2e` also builds that explicitly named fixture binary and runs
the JavaScript E2E clients against dedicated temporary stores. The runner
overrides `APEX_DAEMON_BIN` for those tests only; it never changes production
admission or installs the fixture. These checks exercise real transport,
storage and worker behavior under simulated verified admission. Their results
do not replace the signed installed UI, broker and negative-client checks.

Because those dev-dependencies compile every `apex-host` and `apex-daemon` test
target with `test-support`, the forged-storage integration tests live in the
separate crate `apex-host-production-check`, which depends on `apex-host`
without the feature and never registers a fixture. Run it on its own
(`cargo test -p apex-host-production-check`); one of its tests asserts the
feature is off, so combining it with the other crates in one `cargo test`
invocation (feature unification) fails loudly instead of passing vacuously.

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
The historical candidate was installed and later rolled back; the existing
broker and protected copy are not acceptance of this integration source. The
current gate build has not been installed or re-pinned. Follow the
[install checkpoint](../handoff/2026-10-22/INSTALL-CHECKPOINT.md), retaining all
protected records as well as the original user files.

Phase 4 must derive its original request from protected storage and recorded
intent. Record existence in the old JSON is never evidence of human origin.

## Acceptance harness and checklist mapping

`scripts/acceptance-provenance.sh` runs the checklist above against whatever is
installed, as the normal user, with no sudo. It starts its own daemons on a
fresh `mktemp -d` folder under `/tmp`, stops them before exit, deletes the
folder (unless `--keep`), and never stops, replaces or reloads the user's app,
daemon, broker or LaunchAgent. It prints one `PASS`/`FAIL`/`SKIP` line per check
and writes a JSON evidence file whose path it prints (default under
`target/acceptance-provenance/`). It exits non-zero when any check fails.

The evidence file stamps the source it was produced from — `source.commit`,
`source.branch`, `source.dirty` with `source.uncommittedFiles`, and the harness's
own `source.harnessSha256` — so a run is never mistaken for a claim about a
commit it did not come from. Read `dirty` first: a dirty run describes a working
folder.

The tamper check also rejects `protected ledgers unavailable` in either startup
log, after stopping that isolated daemon. An empty fallback response cannot count
as protected storage winning. `tests/provenance-acceptance.test.mjs` executes the
actual shell check with isolated daemon effects: each unavailable startup must
fail even when its response exactly matches the empty protected state. Changed
state and a rewritten planted file must fail too.

Three consecutive runs on 2026-10-23 (04:22Z, 04:28Z and a `--keep` run) all
produced the same result: **23 PASS, 1 FAIL, 8 SKIP of 32 checks** against the
parked protected copy (daemon `6eedd8545bc0`) and the rolled-back `/Applications`
build (daemon `8e2116f9c224-dirty`). Evidence for the 04:28Z run:
`target/acceptance-provenance/evidence-20261023T042821Z.json` (not committed:
`target/` is ignored, and the file names the host and user). The stdio and
tamper checks were then strengthened (see the mapping table) and the same counts
reproduced at 04:34Z and after the commit that carries them.

The single failure is real and is the defect G4 exists for:
`launchagent.daemon-path` reports that the user's LaunchAgent runs
`/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon`, not the
protected daemon, because the rolled-back app was launched after the trusted
install and rewrote the agent. It will stay red until the gate build is
installed, so it is the harness's pre-install baseline rather than a regression.
It is reported only; the harness changes nothing. On a clean exit no
`/tmp/apex-acceptance.*` folder remains and `system/dev.apexdeck.provenance`
still reports `active count = 1`.

| Checklist item | Evidence |
| --- | --- |
| Signed UI and daemon succeed through the root broker in isolated data | `positive.trusted-daemon`, `positive.protected-read` (protected daemon `serve --data-dir <tmp>` logs no `protected ledgers unavailable` and answers a protected ledger read). Source: `apex-provenance::tests::claim_is_durable_and_cannot_be_replayed_after_reload`, `exact_retry_is_idempotent_but_changed_request_is_rejected`, `apex-provenance::tests::native_audit_token_rejects_an_unpinned_same_user_process` |
| The same intent from shell, raw socket, stdio attach and an alternative daemon is refused, with no protected state change | `negative.raw-socket-issue`, `negative.stdio-protected-command` (a real `apex-daemon --stdio --attach --data-dir <tmp>` session relaying to the running protected daemon, not a second socket exchange; `--attach` fails rather than starting a second host, so a reply proves the transport), `negative.copied-daemon`, `negative.copied-daemon-serves`, `negative.installed-daemon*`. Source: `untrusted_process_cannot_issue_even_with_full_filesystem_access`, `unknown_and_nested_commands_never_gain_authority`, `copied_receipt_cannot_cross_user_project_or_data_directory`, `apex-host::command::tests::provenance_unverified_command_is_refused_before_any_mutation`, `apex-daemon::authority::tests::every_command_for_every_tier_and_scope` (`provenance_execute` is `Need::Never` for paired devices) |
| Tampered user JSON, restart, protected originals and approval states win | `tamper.forged-user-json` (a *valid* forged `assistant-tasks-v1.json` — revision 9, task `forged-acceptance` — planted, daemon started, stopped and started again; both starts must answer the protected ledger exactly, field for field, and the planted file must be untouched). The fixture is `crates/apex-host/tests/fixtures/forged-assistant-tasks-v1.json` and `assistant_tasks::tests::acceptance_tamper_fixture_is_a_valid_forged_ledger` parses it with the real document type and serves it through `AssistantTasks::open`, so "ignored" cannot mean "unparseable". Source: `protected_ledgers_reject_untrusted_writers_and_stale_versions`, `protected_personal_approval_survives_reload_without_trusting_user_json` |
| Crash between claim/dispatch/outcome leaves an uncertain status and no repeated effects; concurrent compare-and-swap; rejected approvals | `a_crash_between_claim_and_outcome_leaves_one_claim_and_no_replay` and `two_writers_from_the_same_read_commit_once_and_the_second_is_refused` (added here; they were the only gaps), plus `stale_approval_rejection_is_durable_and_cannot_be_rewritten`, `archived_submission_finish_is_reported_not_silently_dropped`, `expired_unclaimed_receipt_fails_closed_and_can_be_reissued`, and at the worker level `personal_worker::tests::attempted_non_idempotent_op_becomes_uncertain_and_asks` |
| Installed signatures, every fuse slice, keys, ACLs, nested resources, symlink containment; developer/ad-hoc or copied mutable code refused | `static.signature.*`, `static.signature.app-deep`, `static.hardened-runtime.*`, `static.entitlements.*`, `static.fuses` (protected copy), `static.fuses.installed` (`/Applications`; every slice scanned for the Electron wire), `static.ownership`, `static.symlinks`, `static.keys-and-acls` (root-only, no ACL, modes), `negative.copied-daemon` (same bytes from a user-owned path are refused) |
| The root broker is a running system LaunchDaemon with its socket, and the daemon agent starts from the protected copy rather than a mutable one | `static.broker-job`, `static.broker-socket`, `launchagent.daemon-path` — the first two PASS; the third is the harness's one **FAIL** until the gate build is installed (see above) |
| Installed CDHashes match the broker's pins | `static.cdhash-pins` — **SKIP**: `config.json` is root-only by design and this harness never uses sudo. The pin is still enforced on every connection, which `positive.*` and `negative.*` exercise |
| Full access edits, builds, Git, network and subprocesses in the signed installation; ordinary remote coding compatibility | **SKIP** (`skip.full-access`, `skip.remote-coding`): both need the signed UI window and a paired device. Covered by the final smoke test, never faked here |
| UI-issued intents and approvals, including the legacy import preview and confirmation | **SKIP** (`skip.ui-issued`, `skip.installed-import`): a protected write needs a receipt only the pinned UI can obtain, so it cannot be driven from a shell (`positive.protected-write`) |
| Reviewed legacy migration and native CLI integration acceptance | **SKIP** (`skip.native-cli`): the migration review landed with G2a; `npm run test:e2e` is rerun at the install checkpoint |

Delivery of the harness was checked against the parked protected copy only. The
`/Applications` build installed at the time predates the broker entirely (its
daemon contains no `dev.apexdeck.provenance` string), so the
`negative.installed-daemon` checks SKIP with that reason and re-run after the
gate build is installed.
