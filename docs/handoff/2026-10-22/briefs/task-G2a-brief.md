# Task G2a: Legacy ledger import — host snapshot, preview and UI-confirmed apply

## Why

Read `docs/security/provenance-boundary.md` in full first (especially "Direct writes and
restart" and "Legacy data and activation gate"). Production now reads these ledgers only
through the root broker (`crates/apex-host/src/authority_file.rs` → `apex_provenance::io::document`):

- `assistant-conversations-v1.json`, `assistant-tasks-v1.json` (data dir root)
- `personal-assistants.json`, `personal-machine.json`, `room-authority-v1.json` (Store root, `saved-chats-v1/`)

Users' pre-broker data still sits in the plain user-owned files at those same paths and is
deliberately ignored ("Legacy user JSON has not been certified"). The broker is now active
on real data directories, so those users see empty assistants/tasks/conversations and
every saved room fails restore with "This legacy room has no verified authority manifest."
The doc lists the required migration; this task implements its host half.

Real data shape on the reference machine (structure only): conversations
`{version, records:{<uuid>:{request,status,response,revision}}}` — 32 records, **23 MB**
total; tasks `{version,revision,nextTaskId,nextRunId,tasks{7},requests{3},executions{1},handoffs{}}`;
93 saved rooms under `saved-chats-v1/rooms/` with no manifests; no personal/machine files.
Broker limits (`crates/apex-provenance/src/lib.rs`): one frame/document `MAX_BYTES` = 16 MiB,
journal 128 MiB. The conversations file alone exceeds a single document.

## Required behavior (doc steps 1–6, made concrete)

1. **Snapshot.** Copy each legacy source that exists into
   `<data dir>/legacy-import/<YYYYMMDD-HHMMSS>/` (never move or modify originals), record
   path, size and sha256 in a `manifest.json` there, chmod files read-only. Reuse a prior
   snapshot whose hashes match instead of copying again.
2. **Preview** — a new *unprotected, read-only* host command (name e.g.
   `legacy_import_preview`) returning, per ledger: source path, sha256, record counts,
   and per-record summary rows (id, kind, short title/first line capped ~120 chars,
   original status, the status it WILL get on import, and why). Also report anything that
   cannot be imported and why. Preview performs no protected write.
3. **Preserve as legacy/unverified.** Imported records carry an explicit legacy marker
   (e.g. `legacy: {sourceSha256, importedAtMs}`) that every consumer can see; they are
   never presented as user-confirmed and never as newly verified facts.
4. **Apply** — a new *protected* command (e.g. `legacy_import_apply`) that goes through the
   existing UI-issued provenance path (`desktop/provenance.mjs` issue → `provenance_execute`
   → `Host::call_with_client_capability`). Plain/unattested calls must be rejected exactly
   like other protected commands. Arguments bind the exact source sha256 values shown in
   the preview; the host re-hashes the snapshot and refuses on any mismatch.
   Exact retry with the same hashes is idempotent (returns the original result, writes
   nothing new); changed content under the same import identity is rejected.
5. **Safety mapping on import:**
   - queued/running/approved work → interrupted or proposed; nothing is dispatched or
     resumed by the import; never restart work from an old `Approved` flag;
   - schedules paused; remembered approvals / Always-allow / standing grants /
     machine grants imported **ungranted** (kept visible as legacy for re-authorization);
   - room manifests: create `room-authority-v1.json` entries from each legacy room
     snapshot's cwd/participants/options/plan/mounts so rooms restore, but with
     remembered permissions (`allowed`) empty and any fallback mount outside the room's
     own lineage dropped — follow the manifest semantics already in `storage.rs`
     (`RoomAuthority`, `save_room_authority`);
   - imported facts (if personal files exist) are legacy, not user-confirmed.
6. **Size.** A protected document must stay under `MAX_BYTES`. Conversations: import each
   record's authority-relevant envelope (id, status mapped to a non-executable legacy
   state, timestamps, short text excerpt) into the protected conversations ledger, and
   keep full original transcripts readable as legacy history from the hashed snapshot
   (served by a read-only host command), labelled unverified. Do not raise broker limits.
7. **Verify before reporting success**: read every written protected document back, check
   counts/dedup against the preview, and return a result the UI can show. A failure midway
   leaves already-written documents consistent (each ledger write is a single CAS) and the
   result says exactly which ledgers were imported.
8. Does nothing automatically at startup. No import without the apply command.

## Tests (TDD — RED first)

Host tests in existing style using the test-support isolated storage seam:
- snapshot copies, hashes, read-only, originals byte-identical afterwards, reused on rerun;
- preview counts/status mapping for tasks (queued→interrupted/proposed), rooms (allowed emptied), conversations (excerpt + legacy marker), missing files;
- apply rejects an unattested/plain call; rejects hash mismatch (tamper snapshot after preview); exact retry is idempotent; written docs < 16 MiB with a synthetic >16 MiB conversations source;
- after apply, a legacy room restores via `Store::room` with empty `allowed`; a legacy queued task does not dispatch (`redispatch_recovered_queued` leaves it);
- imported records carry the legacy marker.
Run full `cargo test -p apex-host`, `cargo test -p apex-daemon`, and any JS tests you touch
(`desktop/provenance.mjs` client allowlist, if it enumerates protected commands).

## Constraints

- No env/CLI/RPC path that skips attestation; no change to broker trust checks or limits.
- Capability/advertisement: add the new commands beside existing assistant capabilities
  so an older UI does not call them.
- Commit host + desktop plumbing only (the UI dialog is G2b). Conventional messages.
