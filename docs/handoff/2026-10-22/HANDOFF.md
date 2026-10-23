# Handoff — Named Assistant Workspace (apex-dot) + provenance gate

Written 2026-10-22 ~20:50 PDT at the end of a Claude Code session. Read this whole file before
touching the branch. Everything here was verified at the time of writing unless marked otherwise.

## 1. TL;DR

- **Installed app is ROLLED BACK** to this morning's pre-security build (daemon `8e2116f`,
  built 10:01). Threads are restored (26/26 chat panes load). The protected "provenance" build
  is parked, not deleted. See §2.
- **Plan progress:** Tasks 1–3 done (earlier). Tasks 4–8 **not started**. Task 4 is gated on a
  security gate that the plan names but never decomposed; this session decomposed it into
  G1, G1b, G1c, G2a, G2b, G4, G3 and finished **G1, G1b, G1c** (reviewed clean).
- **G2a (legacy import, host side)** is implemented and reviewed — **Needs fixes**. Its fix round 1
  was stopped mid-way and saved as WIP commit `b59ee3f` (compiles, unreviewed, incomplete). §4.
- **Branch:** `docs/assistant-workspace-plan` in worktree
  `/Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan`, HEAD `b59ee3f`
  (+ this handoff commit). Not pushed since `d802783`-era; local main merged in. Nothing merged to main.
- **Next action:** finish G2a fix round 1 (§5, step 1), then follow the order in §5.

## 2. Machine state (what is installed and running)

| Thing | State |
| --- | --- |
| `/Applications/Apex Deck.app` | **pre-security build**, 0.8.2, daemon `8e2116f9c224-dirty`, app.asar 2026-10-22 10:01. Reads plain JSON; no broker use. Running, daemon listening. |
| `/Applications/Apex Deck.app.provenance-20261022-204152` | The protected candidate build (daemon `6eedd85`, ships `apex-provenance`). Parked. |
| `/Applications/Apex Deck.app.replaced-20261022-180659` | Second copy of the 10:01 build (spare). |
| `/Applications/.Apex Deck.old-20261011-215416.app` | 0.6.1, old. |
| Root broker LaunchDaemon `dev.apexdeck.provenance` | **Still loaded and running** as root; socket `/var/run/dev.apexdeck.provenance.sock`. Harmless to the 10:01 build (it never connects). Re-pinned at 18:12 to the provenance build's CDHashes (UI `7911a74d…`, daemon `9a7405e0…`). |
| `/Library/Application Support/Apex Deck Provenance/` | Root-owned: keys, config (pins), **TrustedUI/Apex Deck.app** (protected copy of the provenance build), fresh empty journal. Backups: `…Provenance.backup-20261022-173203`, `-181158`, `-181240` (root-only; contents not inspected). |
| `~/Library/LaunchAgents/dev.apexdeck.daemon.plist` | Was removed before rollback; the 10:01 app currently runs its own daemon child. Earlier trusted-variant plist backup: `/private/tmp/claude-501/-Users-tylercaldwell-Downloads/8003b5a8-5e70-4309-a3d5-d57fa5d1bc7d/scratchpad/agent-plist-trusted-20261022-204152.bak` (tmp — may vanish). |
| `~/Library/Application Support/dev.apexdeck.app/worker-processes.parked-20261022-181512` | 77 **empty** worker-recovery registry dirs moved aside to stop a startup crash loop. Safe to leave; move back only if you know you need them. |
| Data | Plain legacy files intact: `assistant-conversations-v1.json` (23 MB, 32 records), `assistant-tasks-v1.json` (7 tasks), `saved-chats-v1/rooms/` (91 files; 25 rewritten by the provenance build after 17:15 but still contain cwd/participants, plus an extra `mounts` key the 10:01 build ignores). No `personal-assistants.json` / `personal-machine.json` exist on this Mac. |
| Dock | Points at `/Applications/Apex Deck.app` (now the 10:01 build, fine). |

**To go back to the provenance build later** (only after G2/G4 land and are installed): rebuild the
release from the branch, install, re-pin with `sudo /bin/bash scripts/repin-provenance.sh`, launch the
**TrustedUI** copy, run the legacy import. Do not simply swap the parked copy back — it has neither
G1 (startup crash fix) nor the import, so users will see empty data and possibly a crash loop.

### Why the provenance build failed today (keep — these are the gate's real-world findings)

1. **Stale pin after reinstall** → broker refuses daemon.
2. **Startup crash:** worker-recovery loop in `Host::new` did `host.store.room(&id)?`, and protected
   reads failing killed the daemon every 10 s (launchd loop). Fixed in G1 (`466dc8f`).
3. **Path-trust rule:** `crates/apex-provenance/native/peer.m` trusts a peer only if *every path
   component* of its executable is root-owned and not group/world-writable. `/Applications` is
   group-writable → the `/Applications` copy is **never** trusted, even with identical CDHashes. Only the
   `TrustedUI` copy works. Addressed by G4 (not yet implemented).
4. **LaunchAgent flip:** launching the `/Applications` copy rewrites the LaunchAgent to its own
   (untrusted) daemon (`desktop/launchAgent.mjs`). G4.
5. **Fresh authority is empty**, so legacy rooms fail with "no verified authority manifest" and
   assistants/tasks/conversations look empty until imported. G2.

## 3. Repository and branch

- Worktree: `/Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan`
- Branch: `docs/assistant-workspace-plan`. Main checkout: `/Users/tylercaldwell/Downloads/apex-deck` (on `main`, untouched).
- Rules: `AGENTS.md` (git status before changes; `npx tsc --noEmit` must pass; dev build only from the main
  checkout with `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`;
  release only in `/Users/tylercaldwell/Downloads/apex-deck/release`). Never bare `git stash` (shared stash).
- Plan: `docs/superpowers/plans/2026-10-22-assistant-workspace.md`; spec:
  `docs/superpowers/specs/2026-10-22-assistant-workspace-design.md`; security design:
  `docs/security/provenance-boundary.md` (binding for all gate work).

### Commits this session (oldest → newest, after `bd83da6`)

| Commit | What | Review |
| --- | --- | --- |
| `533b560` | Merge local `main` (7 commits incl. Dashboard/Tasks patch Task 7 needs) | baseline: tsc ok, npm 2085/2085 |
| `466dc8f` | **G1** host startup degrades (log + skip) when worker recovery can't verify room authority | clean |
| `d2d233e` `e805181` `58b3111` | **G1b** restore 25 integration tests via test-support seam; `Daemon::start` broker-only in all builds; test-only `apex-daemon-fixture` bin (`required-features = ["test-support"]`); `scripts/package-mac.mjs` now builds release binaries itself; new crate `crates/apex-host-production-check` (feature-off forged-storage tests); `default-members` excludes it | clean after 2 fix rounds |
| `fb8a276` | **G1c** `Store::save_room` writes room file first, manifest second, restores old file on manifest failure; un-ignored regression test; storage `temp()` race fix | clean |
| `d97736e` `dae739a` `200a19e` | **G2a** legacy import: snapshot (`<data>/legacy-import/<ts>/`, sha256 manifest, 0400), unprotected preview, protected `legacy_import_apply` (added to broker `protected()` allowlist — **installed broker must be replaced** for it to work), legacy markers, tasks→proposed/interrupted with `legacy-` ids, rooms→manifests with `allowed` emptied, conversations→non-executable `Legacy` envelopes + 2000-char excerpts, full text from snapshot | **Needs fixes** (§4) |
| `b59ee3f` | **WIP** G2a fix round 1: `crates/apex-host/src/legacy_personal.rs` (212 lines) + edits in personal*/storage/tasks/conversation. Compiles (`cargo check -p apex-host --tests`). Not wired into `legacy_import.rs` orchestrator. Tests not run. | unreviewed |

### Test commands (current, correct)

- `cargo test` at repo root — all default members (= `--workspace --exclude apex-host-production-check`).
- `cargo test -p apex-host-production-check` — **run alone** (multi-crate runs unify `test-support` on and its guard test fails by design).
- `npm test` (2091 passing at `200a19e`), `npx tsc --noEmit`.
- Known flaky under machine load: `voice::helper::tests::readiness_timeout_kills_the_helper` (100 ms timeout); occasional `gateway_admin` unit tests when other cargo jobs run.

## 4. G2a open findings (fix round 1 — what `b59ee3f` was doing)

Reviewer verdict on `fb8a276..200a19e`: core import sound (hash binding, CAS rollback, non-executable
legacy, ungranted permissions, size, idempotent retry; broker change is an allowlist entry only; fixture
path is test-only; partial-failure result is truthful; `legacy-` ids safer). **Blocking:**

1. **Personal assistants / machine grants.** Ruling: **import personal assistants now** — identities
   (name/look/profile), facts as legacy/unverified with correction/forget chains intact, rules and
   remembered approvals **ungranted** (visible for re-auth), pending approvals not granted, queued
   personal tasks proposed/interrupted, schedules paused, events kept as legacy history. Machine grants
   (`personal-machine.json`): preview a row per grant "not imported — re-approve on this machine"; never
   import as active. Preview must emit per-record rows for identities, memories, schedules, rules,
   approvals, grants. Same CAS/rollback/`legacy_import` mark/AlreadyImported/size-budget pattern.
   Tests with synthetic personal + machine files. → partially in `b59ee3f`.
2. **Rooms identity is a one-shot digest** (`legacy_import.rs` ~180-246, 391, 418; `storage.rs` ~270-276):
   leftover rooms after an import show a false `conflict` and are refused forever. Fix: dedupe per room id
   (room with a legacy-marked manifest = AlreadyImported; other manifest-less rooms importable later);
   test "import, add a new legacy room, second preview shows it importable, second apply imports only it".
   → **not started.**
3. Minors to include: attempt rooms even if tasks/conversations failed (`legacy_import.rs` ~506-520);
   count/report requests+handoffs skipped by id collision and remap `HandoffReceipt` payload ids
   (`assistant_tasks.rs` ~1324-1331); remove dead `let _ = path;` + zip in `tests/legacy_import.rs` ~357.

Then: scoped re-review of the fix diff (`200a19e..<new HEAD>`) against the brief
`docs/handoff/2026-10-22/briefs/task-G2a-brief.md` and the findings above.

## 5. Remaining work, in order

1. **Finish G2a fix round 1** (§4), review, mark done. Either continue `b59ee3f` or
   `git reset --soft HEAD~1` and redo — your call; it is unreviewed.
2. **G2b — import preview/confirm UI.** Brief: `docs/handoff/2026-10-22/briefs/task-G2b-brief.md`.
   Extra inputs from G2a: imported conversation status `legacy` is not yet typed in `src/ApexAgentTasks.tsx`;
   room manifests carry the legacy marker but `room_state` doesn't expose it; legacy task retry UI must show
   the legacy `owner.cwd`, not only the title.
3. **G4 — hand off to the TrustedUI copy.** Brief: `…/briefs/task-G4-brief.md`.
4. **G3 — acceptance harness + independent security review.** Brief: `…/briefs/task-G3-brief.md`.
   Then an opus-class security review of `crates/apex-provenance`, `Host::call_with_client_capability`,
   `desktop/provenance.mjs`, `legacy_import*`.
5. **Install checkpoint (needs the user):** release build in `/Users/tylercaldwell/Downloads/apex-deck/release`
   per AGENTS.md, install, `sudo /bin/bash scripts/repin-provenance.sh` (type `repin` exactly), launch
   TrustedUI copy, run `scripts/acceptance-provenance.sh` (from G3), run the import from the UI, verify
   threads/tasks/conversations. Only then is the gate passed and Task 4 unblocked.
6. **Plan Tasks 4 → 5 → 6 → 6A → 7 → 8** exactly as written in the plan file (strict order: shared files
   `assistant_tasks.rs`/`assistant_service.rs` for 4/5; `App.tsx`/RightPanel for 6/7; 6A extends 6's editor).
   Task 4 must read original requests from protected storage (broker path), never plain JSON.
7. Final whole-branch review (most capable model), then finishing (PR/merge only with the user's OK).

## 6. Decisions made on the user's behalf (rulings) — this session

Each: decision — why — cost if wrong. (Earlier Task 1–3 rulings are in `sdd-ledger.md` lines ~33-81.)

1. Merged local `main` into the branch first — Dashboard patch Task 7 depends on lives there — PR carries main's unrelated commits (skins, popouts, git-changes).
2. Decomposed the gate into G1/G1b/G1c/G2a/G2b/G3/G4 — plan named the gate, not its tasks — may omit an acceptance item; G3 brief copies the doc's checklist verbatim to prevent that.
3. Implement Tasks 4–8 in source after the gate, defer **installed** acceptance to one combined install — every install needs admin password + re-pin — an installed-only broker defect found late could force rework.
4. Stop points only: install/re-pin, Electron dev-window smoke test, push/merge.
5. Conversations imported as non-executable envelopes + excerpts; full text read-only from hashed snapshot — 23 MB > 16 MiB broker document cap, doc only requires legacy/unverified preservation — legacy transcript copies are not tamper-protected (hash recorded and shown).
6. Split G2 into host (G2a) and UI (G2b) — one review surface each — extra review round.
7. Added G4 (handoff to TrustedUI, never downgrade LaunchAgent) — observed Dock launch silently replaced the trusted daemon — extra relaunch hop.
8. Added G1b after finding 25 integration tests broken by the provenance commits (also failing with `--features test-support`) — cost: one more task.
9. Added G1c for the `save_room` ordering bug G1b exposed.
10. Kept `apex-host-production-check` in the workspace with `default-members` excluding it — single lockfile — `cargo test --workspace` alone still needs `--exclude` (documented in README).
11. Import personal assistants now rather than defer — later tasks build on personal records; spec requires preserving personal memories — larger G2a.
12. **Rolled the installed app back to the 10:01 pre-security build** so the user can work — the user asked for threads back immediately; the provenance path needs G2 + G4 + reinstall first — the security boundary is not active on this machine until the install checkpoint (§5.5).

## 7. Deferred minors (final review must triage)

- G1: no-saved-room test passed pre-fix; continue-path test doesn't assert no release/reserve; `Ok(None)`/no-cwd still abort startup per brief "unchanged".
- G1b: `default-members` must stay in sync with `members`; `desktop:package`/`desktop:dmg` build release binaries twice (harmless); flaky voice/gateway tests under load.
- G1c: ambiguous broker CAS (committed but error returned) makes `save_room` restore the old file under the new manifest (unsafe direction, narrow window); manifest-failure restore path untested (no broker fault seam); create/fork paths still manifest-first (orphan manifest possible).
- G2a: conversations imported before tasks lose `taskId` link permanently; conversation envelope budget fails the whole ledger above ~2000 records; legacy task `owner.cwd`/thread ids kept verbatim (UI must show cwd before retry).

## 8. How the work was run (if you continue the same way)

Subagent-driven development: one implementer per task, then an independent spec+quality review, then
fix rounds (max 5) with scoped re-reviews. Workspace (git-ignored):
`.superpowers/sdd/2026-10-22-assistant-workspace/` — `progress.md` (ledger; copy at
`docs/handoff/2026-10-22/sdd-ledger.md`), `task-*-brief.md`, `task-*-report.md`, `review-*.diff`,
and reusable `implementer-instructions.md`, `reviewer-instructions.md`, `re-review-instructions.md`.
Review packages were generated with the superpowers `review-package` script; any `git diff -U10 BASE..HEAD`
into a file works the same. Use the strongest model for security-touching reviews; reviews found real
defects in every gate task so far — do not skip them.
