# Task G2a report: Legacy ledger import (host snapshot, preview, UI-confirmed apply)

Status: DONE_WITH_CONCERNS (concerns are listed at the end)

## Commits (branch docs/assistant-workspace-plan)
- d97736e test: keep the local protected-ledger fixture apart from legacy user JSON
- dae739a feat(host): snapshot, preview and UI-confirmed apply for legacy ledgers
- 200a19e feat(desktop): attest legacy import apply and type the import client

## What I implemented

### Prerequisite: the test seam now separates protected documents from legacy files (d97736e)
Under `cfg(test)` and the isolated `test-support` seam, `authority_file` used to store each protected
document at the user-owned path itself. That made "the legacy original" and "the protected ledger" the
same file in tests: you couldn't snapshot an original, apply, and then check that the original was
unchanged. Production keeps the two apart (the broker vs the user file), so the fixture now does too. It
stores the protected copy at `<path>.protected-fixture` (`authority_file::fixture_path`, also exposed as
`apex_host::test_support::protected_fixture_path`). I updated the existing tests that read or wrote
ledger files directly to use the fixture path: project_memory, project_memory_service, assistant_tasks,
assistant_conversation, command and host. Production code paths are unchanged.

### Host (dae739a)
New module `crates/apex-host/src/legacy_import.rs` and three commands:

- `legacy_import_preview {}`: unprotected and read-only for every protected ledger.
  - It copies each legacy source into `<data>/legacy-import/<YYYYMMDD-HHMMSS>/`. The sources are tasks,
    conversations, personal, machine, and every saved-room file that has no protected manifest yet.
  - It reads with `symlink_metadata`, so a link is reported, not followed. It writes `manifest.json`
    (ledger, source path, snapshot file, size, sha256) and sets the copies and the manifest to 0400.
  - The snapshot folder is renamed into place only once it is complete. A previous snapshot whose files
    and hashes match exactly, and whose copies still hash correctly, is reused (`reused: true`).
  - The response gives each ledger's state: ready, imported, conflict, missing, unreadable, unavailable
    or notSupported. It also gives sha256, counts, per-record rows (id, kind, title capped at 120
    characters, original status, import status, reason), and problems (what is not imported and why).
- `legacy_import_apply {snapshot, sources:{ledger: sha256}}`: protected.
  - It is listed in `Command::requires_provenance`, so a plain or unattested call gets the standard
    rejection from `call_with_client_capability`.
  - It validates the snapshot id (timestamp format only), then re-hashes the snapshot copies and refuses
    if they differ from the manifest or from the bound sha. It refuses any ledger other than tasks,
    conversations and rooms.
  - It checks for a different-content conflict and parses every source before writing anything.
  - It then imports tasks, conversations and rooms. Each is one compare-and-swap through the owning
    store's lock: `AssistantTasks::import_legacy`, `ConversationStore::import_legacy` and
    `Store::import_legacy_room_authorities`.
  - Each written ledger is read back through `authority_file::read`, and the legacy marker and counts
    are checked against what was imported.
  - The result is `{snapshot, complete, ledgers:[{ledger, state: imported|alreadyImported|failed|notAttempted, imported, skipped, verified, importedAtMs, error}]}`.
    If one ledger fails, the ledgers after it are reported as `notAttempted`.
  - The import identity is (data dir, ledger). The ledger records `legacyImport {sourceSha256,
    importedAtMs, snapshot, imported, skipped}`. An exact retry returns that original record and writes
    nothing; different content is refused with "already imported from different legacy content".
- `legacy_import_history {snapshot, requestId}`: unprotected and read-only. It returns the full
  original conversation record from the re-hashed snapshot, with `verified: false` and a label.

Legacy marker: every imported task, conversation record and room manifest carries
`legacy: {sourceSha256, importedAtMs, originalId?, originalStatus?, verified: false}`. Room manifests
keep the marker across later `save_room` calls.

How each record is mapped on import:
- **Tasks**
  - Ids are prefixed `legacy-` so they never collide with protected `task-N` ids.
  - A queued task with no attempts becomes `proposed`. A queued task with attempts, or a running,
    applying or needs_you task, becomes `interrupted`, and any open attempt is closed.
  - `leaseHeld` is set to false, because it would otherwise restore a checkout hold at startup.
  - `pendingApprovals` and `pendingQuestions` are emptied, and `unknownCostAccepted` is set to false.
  - `lineage` is dropped, because it authorizes project-memory promotion.
  - Requests and handoffs are imported, remapped to the new ids, unless their id is already taken.
  - Execution bindings are NOT restored. They are listed as problems, the thread opens as an ordinary
    chat, and the assistant never continues it.
  - Nothing is dispatched: `redispatch_recovered_queued` only picks up queued tasks.
- **Conversations**
  - New non-executable status `ConversationStatus::Legacy`.
  - Each record keeps an envelope: id, owner, destination, a request-text excerpt and a response
    excerpt (2000 characters each), `taskId` when that legacy task was imported, and the marker.
  - Threads, profiles and evidence are dropped.
  - `assistant_message` refuses to rerun a legacy request id, with an explicit message.
- **Rooms**
  - A manifest is created from the room file's cwd, participants, options, plan and mounts.
  - `allowed` is left empty.
  - Only the mount chain that walks back from the room's cwd (`own_lineage`) is kept. Earlier or
    broken mounts are dropped, since those are what the missing-folder fallback picks from.
  - A room that already has a manifest is skipped.
- **Size**: every protected write is refused if it would exceed `MAX_BYTES - 64 KiB`. Broker limits
  are unchanged.
- **Personal assistants and machine grants**: snapshotted, shown as `notSupported`, and refused by
  apply (see concerns).

Registration:
- **Broker**: `legacy_import_apply` is added to `apex_provenance::protected()`. Its replay key is the
  UI delivery id (`provenanceRequestId`), like room actions. No trust check or limit changed.
- **Daemon**: all three commands are `Need::Never` for paired devices (`authority.rs`, plus table
  entries). Capability `assistant_legacy_import_v1` is advertised next to the other assistant
  capabilities, so an older UI never calls these commands.
- **Docs**: `docs/security/provenance-boundary.md` "Legacy data" section updated. It said the import
  command was not implemented.

Nothing runs at startup; the only entry points are the three commands.

### Desktop plumbing (200a19e)
- `desktop/provenance.mjs`: `legacy_import_apply` is added to `protectedCommands`, so it is attested
  and gets a random `provenanceRequestId`. Preview and history stay unattested.
- `src/legacyImport.ts`: typed client for G2b, following the `projectMemory.ts` pattern.
  - `createLegacyImportClient({route})` exposes `unavailable()`, `preview()`,
    `apply(preview, ledgers?)` and `history(snapshot, requestId)`.
  - It is gated on the capability, and the shapes are checked.
  - `apply` sends only ready, importable ledgers, with exactly the hashes the preview showed.
  - `history` rejects a result that is not marked unverified.
  - No UI was built.

## Tests and results

New tests:
- `crates/apex-host/tests/legacy_import.rs` (7 tests, isolated test-support seam). They cover:
  - snapshot copies, hashes and read-only modes, with originals byte-identical and the snapshot reused
    on a rerun;
  - preview status mapping (queued→proposed, running→interrupted, done kept), room permission and mount
    reasons, missing personal files, and no protected write by preview;
  - after apply and a restart (which runs the startup redispatch): every task carries a legacy marker,
    the queued task is still `proposed` with no attempts, the running task is `interrupted`, the lease
    and approval flags are false, and the request receipt says `legacy`;
  - `Store::room` restores the legacy room with empty `allowed` and only its own mount;
  - history returns the full unverified text;
  - a tampered snapshot is refused with nothing written;
  - an unshown hash, an empty source list and a path-traversal snapshot id are all refused;
  - an exact retry returns `alreadyImported` with the same counts and byte-identical protected ledgers;
  - changed content is shown as `conflict` and its apply is refused;
  - a synthetic conversations source over 16 MiB (20 × 1 MiB) imports, the written ledger is under
    16 MiB, and history still returns the full 1 MiB text.
- `legacy_import.rs` unit tests (5):
  - a plain `host.call(legacy_import_apply)` without a receipt is refused with "protected provenance
    receipt", and no protected ledger is written;
  - only apply requires provenance;
  - snapshot-id validation and timestamp formatting;
  - title and excerpt caps at character boundaries;
  - mount lineage.
- apex-provenance: `legacy_import_apply_is_issued_only_for_trusted_ui_and_bound_to_a_delivery_id`.
- JS: `tests/legacy-import.test.mjs` (4 tests) and one new test in `tests/desktop-provenance.test.mjs`.
- `command.rs` `names_lists_every_command` updated to 162; the daemon authority table has entries for
  the 3 new commands.

Full runs (after the final change):
- `cargo test` (repo root, default members): all ok, 0 failed. Highlights: apex-host lib 549 passed,
  apex-host tests/legacy_import 7, apex-host tests/host 19, apex-daemon 144 plus integration suites,
  apex-provenance 26.
- `cargo test -p apex-daemon`: all ok.
- `cargo test -p apex-host-production-check` (run on its own): 3 passed.
- `npm test`: 2091 pass, 0 fail.
- `npx tsc --noEmit`: clean.
- No compiler warnings in the build output.

## TDD evidence
- **RED (host integration)**: `cargo test -p apex-host --test legacy_import`, before any implementation
  → `0 passed; 7 failed`. Every test panicked with
  `preview: "unknown variant \`legacy_import_preview\`, expected one of ..."`. This was expected: the
  commands did not exist yet.
- **GREEN**: the same command → `7 passed; 0 failed`. One intermediate failure was a test casing slip
  ("confirm" vs "Confirm" in a reason string); I fixed it in the test.
- **RED (broker)**: `cargo test -p apex-provenance legacy_import` →
  `Err("Command cannot acquire submission authority")`. Expected, because the verb was not yet in
  `protected()`. **GREEN**: 26 passed.
- **RED (JS)**: `node --experimental-strip-types --test tests/legacy-import.test.mjs tests/desktop-provenance.test.mjs`
  → the `desktop-provenance` assertion failed (`protectedCommands.has('legacy_import_apply')` was false)
  and `legacy-import.test.mjs` failed (module missing). **GREEN**: 9 pass.
- Not RED-first: the 5 unit tests inside `legacy_import.rs`, the daemon authority table rows and the
  `names()` count were written together with the implementation.

## Files changed
- crates/apex-host/src/authority_file.rs, test_support.rs (fixture path)
- crates/apex-host/src/legacy_import.rs (new), lib.rs, command.rs
- crates/apex-host/src/assistant_tasks.rs, assistant_conversation.rs, storage.rs, assistant_service.rs
- crates/apex-host/src/project_memory.rs, project_memory_service.rs, host.rs (tests only: fixture path)
- crates/apex-host/tests/legacy_import.rs (new)
- crates/apex-provenance/src/lib.rs
- crates/apex-daemon/src/authority.rs, protocol.rs
- desktop/provenance.mjs, src/legacyImport.ts (new)
- tests/desktop-provenance.test.mjs, tests/legacy-import.test.mjs (new)
- docs/security/provenance-boundary.md

## Self-review findings (fixed before reporting)
- Removed a dead match arm and an unused helper left over from drafting `legacy_import.rs`.
- Imported tasks originally kept `lineage`. I dropped it, because `project_memory_stage` and
  `project_memory_promote` treat lineage as delegation authority.
- I set `leaseHeld` to false on imported tasks. Otherwise `Host::try_new` would restore a checkout
  hold for them.

## Concerns
1. **Personal assistants and machine grants are not imported.** They are snapshotted and shown as
   `notSupported`, and apply refuses them. The brief's mapping for them is conditional ("if personal
   files exist"), and the reference machine has none. The `PersonalDocument` model (events, decisions,
   schedules, rules, machine links) needs its own reviewed safety mapping. Please decide whether that is
   a follow-up task.
2. **The installed root broker must be updated.** I added `legacy_import_apply` to the broker's
   `protected()` allowlist, which is how every protected verb is registered. Until the pinned root
   broker is reinstalled, issuance of this verb fails closed. No trust check or limit changed, but this
   is a broker code change; the brief's "no change to broker trust checks" may want a second look.
3. **The test seam changed.** The fixture now stores protected documents at `<path>.protected-fixture`,
   and that touched several existing tests (listed above). It is test-only, but it is a behavior change
   to the seam G1b introduced.
4. **Partial failures return Ok.** A failure after some ledgers were written returns `complete: false`
   with per-ledger states, so the broker records the outcome as succeeded. Validation failures (hash
   mismatch, conflict, unreadable source, unattested call) return Err before any write.
5. **New strings the UI doesn't know yet.** The new `legacy` conversation status reaches the UI through
   the request receipt in `assistant_tasks_list`. `ApexAgentTasks.tsx` types the receipt status as
   pending|completed|interrupted, so G2b should handle `legacy`. Room manifests carry the marker, but
   `room_state` does not expose it yet; I avoided adding a broker read to every `room_state` call.
6. **Rooms are identified by a digest.** The rooms ledger's import identity is a digest over room files
   that have no protected manifest. Because already-restored rooms are excluded, live chats do not
   change it. A new manifest-less room appearing after an import would show as `conflict`.
