# SDD ledger — plan: docs/superpowers/plans/2026-10-22-assistant-workspace.md

Implementation baseline: b06ce17, clean docs/assistant-workspace-plan linked worktree.
User authorized implementation on this branch; preserve production Agents tab and verify phases before advancing.

## Preflight dependency scan
| Tasks | Contract/file | Finding/ruling |
|---|---|---|
| 1 / 2 | Personal record, refs, profile, projects | Task1 types and host gate precede discovery migration. Exclusive ownership of personalAssistant.ts. |
| 1 / 3 | personal_settings.rs, revisions, project refs | Task3 extends versioned writes; legacy RPC stays unchanged. |
| 1 / 4 | projects, profile access, command schemas | Explicit binding/grant validation precedes handoff. Full access cannot create grants. |
| 1 / 6 / 6A | look seed/kind/image, profile, workspace configure | Task1 adds fields only; generated assets must be owner-checked in 6A, not arbitrary look.image input. |
| 2 / 6 | lanes, selection, drafts | Immutable host+assistant ref is the only routing key. UI must consume ref-aware collection. |
| 3 / 4 | bounded context, project sources | Scratch promotion and task completion remain separate. No private note sharing by default. |
| 4 / 5 / 7 / 8 | lineage, ledger, exact-owner actions | Preserve legacy TaskOwner/keys/hashes; serialize schema edits and prove stale/retry behavior. |
| 6 / 7 | App.tsx, RightPanel | Main-pane route preserves mounted sessions/global panel; one editor at a time. |
| 6 / 6A | editor/creation transaction | Explicit Apply then Save/Create; candidate never changes current avatar alone. |
| prerequisite / 7 | dirty Dashboard patch | Shared checkout has uncommitted changes. Read-only review now; do not copy/cherry-pick unfinished files. Integrate only reviewed committed patch when available. |

## Per-task internal consistency
| Task | Result |
|---|---|
| 1 | Additive settings and expectedRevision agree. Missing model metadata must force null effort, not fabricate support. Remote project bindings need actual authenticated authority; reject unverified assignment. |
| 2 | Includes local/remote capable hosts, offline retention, captured refs and phone compatibility. |
| 3 | Independent note store, explicit lifecycle and stable scratch-source dedup agree. |
| 4 | Proposed handoff and human provenance agree; no synthetic human message. |
| 5 | Desired state is distinct from adapter acknowledgment; no fake transparent resume. |
| 6 | Existing Agents tab unchanged; work brief via Conversation; main pane only. |
| 6A | Generated avatar is separate from text model and requires explicit billing action, owner-bound durable assets. |
| 7 | Must follow independent Dashboard prerequisite review; never replace regular panel ownership. |
| 8 | Automated fixtures differ from observed dev smoke; no installation implied. |

Ruling: Use already-existing linked worktree and requested branch rather than create/switch another branch — user explicitly selected docs/assistant-workspace-plan and shared checkout is dirty — no change to primary checkout.
Ruling: Plan global statement that publication does not include implementation applied to its prior publication; current explicit request authorizes implementation, not release/install/merge.
Ruling: Preserve dirty Dashboard work in place and defer its integration until reviewed committed source exists — copying other unfinished work violates plan — later sidebar phase can be blocked by dependency, never claimed complete.

## Active work
- Baseline JS setup/typecheck/full test: baseline_review.
- Task1 Rust implementation/tests: identity_backend.
- Task1 frontend contracts/tests: identity_frontend.
- Deepgeek asked in group chat for read-only Task1 correctness review; no response yet.
- Null owns integration and independent verification. No phases marked complete.

## Baseline reconciliation
- Frontend Task1 commits e89adb5, f531bdb: pure identity/appearance contracts. 15 focused tests and tsc passed, awaiting full Task1 review.
- Baseline dependency install had concurrent Electron lazy-extract errors; serial install repaired it. Rerun 1846/1846 JS tests passed, including new identity tests.
- Backend RED tests 3/3 failed as expected: unknown personal_workspace_configure. Log /tmp/apex-personal-workspace-red.log.
- Paused backend writer; merge 5959ee1 brought exact committed shared HEAD 4d40cc0 into docs branch. Uncommitted Dashboard/ApprovalCard changes untouched.
- Dashboard review found closed/archived External Pane action can be killed by orphan cleanup. Must fix/test before integrating prerequisite.
- Task1 is not complete. No phase advanced.

Task1 integration: disconnected-host regression failed before implementation and passed after registering personal_workspace_configure as mutation. Focused identity/appearance/host-backend tests 28/28, tsc exit 0, diff check clean. No phase advanced.

## Task1 review rulings
- Fixed local route alias versus durable host identity, proposed/current privacy checks before model discovery, invalid avatar color rejection, seed migration on explicit v4 save, and composed access policies.
- Ruling: until Task4 provides explicitly scoped execution, any Off binding for a host refuses generic personal tools on that host, without relying on argv/cwd to prove disjoint effects. Existing broad folder grants plus opaque commands/Git object reads cannot prove project separation. Cost: conservative refusal of otherwise unrelated host tools; expose concrete reason and never imply full project-scoped execution exists in Phase1.
- Ruling: reuse credential store valid_name contract (mixed/lowercase allowed), not a new uppercase-only policy. No credential values inspected.
- Ruling: remote project bindings are explicitly unavailable until authenticated owning-host authority exists; unverifiable model catalogs cannot accept runtime updates, while settings-only saves preserve old profiles. No new image assets can attach before6A.

Task 1: complete — f41befd backend, e89adb5/f531bdb frontend, c6eada3 disconnected guard. Final personal67, command12, authority5, hello1 passed. Root read results independently, tsc+28 focused JS passed. Independent reviewer no remaining blocker. Explicit supported-boundary restrictions recorded. Task2 may begin.

Task2 root integration: fe2aa21 exposes negotiated capability via Backend/Transport and pre-send v4 guard. Two RED tests confirmed missing methods;130 checks+tsc passed. Reviewer found removed-host proxy returned rejected Promise for synchronous supports; root regression RED then fixed,144 checks+tsc passed. Task2 collection implementation remains underway.

Task 2: complete — eb4c5ce collection,9d276ac notification authority,4b3652a drafts,fe2aa21/4e30dee capabilities. Root final clean-source npm2027/2027,tsc,diff,Agents comparison passed; Rustpush1/1 passed. Independent reviewer105/105 and APPROVE at9d276ac. No Task3 code started. Published source/docs checkpoint next.

## Task 3 review resolutions
- Verified Deepgeek B1/B2: no scratch store exists; TaskOwner lacks assistant identity.
- Task 3: Ruling: add immutable durable scratch snapshots and bring forward optional AssistantTask.lineage, preserving TaskOwner/legacy serialization and hashes — one run may supply several reviewed notes, so runId alone cannot deduplicate distinct scratch observations — cost: one additive schema and an extra human-only staging operation.
- Task 3: Ruling: manual notebook saves use author:null and no task source, promotions derive author from verified lineage — avoids manufacturing a model author for a human edit — cost: selected-assistant context and actual author are different concepts.
- Task 3: Ruling: live assignment/grant validation remains same-host-only until remote authenticated authority exists; endpoint privacy plus explicit provider allowlist/saved provider gates private sharing — cost: remote notebook coordination unavailable in this phase.
- Task 3: Ruling: explicit bounded quotas and 24h scratch expiry retain tombstone/dedup metadata rather than pruning it automatically — cost: a full historical store needs future reviewed maintenance.
- Task 3: required edit versions; full correction-chain text erasure shared with personal memory; quoted context and no capability changes; separate promotion source/delivery indexes.
- RED evidence: frontend project-memory7/7 expected failures; store11/11 expected failures followed by cap/wire-shape3 failures; host project RPC2 failures unknown variants after fixture repairs. Private revision regression was introduced alongside implementation and subsequently verified (not claimed preimplementation RED).
- Initial host harness failures (wrong Arc receiver, colliding fixture directory, unsupported scripted profile, wrong private-store path) corrected; none counted as production behavior evidence.

Task 3 review fix: serialized-context hard cap reproduced RED with 2000-character assignment containing JSON quotes; per-scope quotas alone were insufficient. Optional notes are now removed until full quoted JSON/provenance fits; an unfit assignment returns a concrete error, never silent truncation.

Task 3: Ruling: before first promotion, explicit host-validated re-review may advance scratch expectedTaskRevision while capturedTaskRevision/source bytes/id/expiry remain immutable — task acceptance otherwise strands a staged note forever — cost: two revision concepts, now named and tested. After promotion, receipt/source revision stays immutable; a different revision requires inspecting the existing receipt.
Task 3: Ruling: provider-denied private sharing omits only assistant facts during local evidence assembly; authorized selected-project/monitor evidence remains inspectable — this helper sends nothing; Task4 sender must separately refuse any disallowed provider call — cost: caller must not equate assembly success with permission to send. Spec wording clarified.

Task 3: Ruling: delegation context lives in project_memory_service.rs rather than changing the tool-free personal prompt — actual worker injection belongs to Task4, and the main-pane container to Task6 — cost: until those phases, the new context builder and reviewed-promotion RPCs are available/tested but not advertised as live delegated-worker behavior.
Task 3 final gate: root npm2045/2045; tsc exit0; full apex-host539 unit+19integration (4ignored); full apex-daemon144unit+25integration (1ignored); total727 Rust passes. git diff check and exact Agents byte comparison passed. Independent review has no unresolved Important/Critical finding. No app/service installation, production-data change or main integration. Source checkpoint commit/push next.

Task 3: complete — d802783, parent-owned npm2045, tsc, host558 and daemon169 passes,5 explicit ignored checks; independent review clear. Pushed origin/docs/assistant-workspace-plan and remote SHA read back equal. Same-host notebook and prepared context/promotion contract only; Task4 actual handoff/worker injection and later phases remain pending.

## Session 2026-10-22 evening — resume for full implementation (user asked: "finish the complete implementation")
State at resume: HEAD bd83da6 (24 commits ahead of origin/main base; provenance candidate 4a36d74..bd83da6 landed after Task 3, outside SDD tasks). Installed app re-pinned 18:12; trusted daemon running from TrustedUI copy on the user's normal data dir with EMPTY protected ledgers (legacy JSON untouched).

### Pre-flight scan (Tasks 4–8 + gate)
| Pair / task | Produces → consumes | Finding |
| --- | --- | --- |
| Gate → Task 4 | protected original request/human-event provenance → delegation bridge derives request from protected storage | Task 4 cannot rely on unprotected conversation records; must read via authority_file/broker path |
| T4 ↔ T5 | AssistantTask.lineage, delegation receipts (assistant_tasks.rs, assistant_service.rs) → pause/cancel/retry per owner | same files; strict order T4 then T5 |
| T4 ↔ T7 | lineage + namespaced IDs → dedupe in global feed | T7 must dedupe by lineage, consistent with T4 schema |
| T4/T5 ↔ T8 | E2E asserts T4/T5 behavior | fine, T8 last |
| T6 ↔ T6A | creation/Settings editor (T6) → avatar generation section (T6A) | T6 leaves Avatar section extensible; T6A adds Generate. Order T6 then T6A |
| T6 ↔ T7 | App.tsx/RightPanel global ownership | both touch App.tsx; strict order |
| T7 ↔ main Dashboard patch | RightDashboard/dashboardNavigation/composerStatus | patch is on local main (385e7ed etc.), not on this branch → must merge main first |
| T1–3 → T6 | AssistantRef collection, runtime profile RPCs, project memory RPCs | consumed as-is |
| T4 self | tests reference cargo filters assistant_delegation/assistant_conversation | new module must expose test names matching filter |
| T5 self | "No test may assert transparent resume for an adapter that cannot checkpoint" | consistent with spec Pause definition |
| T6 self | "Retire widget/floating/mini only after routing migration" | consistent |
| T6A self | stub image adapters only; no live billing | consistent with spec |
| T7 self | files modify RightDashboard "after the separate Dashboard patch lands" | satisfied by G0 merge |
| T8 self | smoke test "in the existing Electron development window" | AGENTS.md: dev build only from /Users/tylercaldwell/Downloads/apex-deck; needs user present |
| Spec vs provenance doc | spec predates broker; doc forbids activating candidate on normal data dir before migration | already violated today to restore the app; G2 import addresses it |

- Ruling: merge local main (7 commits, clean merge-tree) into this branch before any task as G0 — spec delivery order step 1 says integrate the Dashboard patch first and it now lives on main — cost if wrong: branch carries main's unrelated commits (skins, popouts, git-changes) into the eventual PR.
- Ruling: define gate work as tasks G1 (daemon startup must degrade, never crash, on refused/missing protected reads — found live today: worker-recovery loop `host.store.room(&id)?` in host.rs killed startup), G2 (legacy import per provenance-boundary.md steps 1–6), G3 (automated adversarial acceptance harness + scripted installed checks + independent security review). — the plan names the gate but not its tasks — cost: my decomposition may omit an acceptance item the doc lists; G3 brief copies the doc's list verbatim to prevent that.
- Ruling: implement Tasks 4–8 in source after G1–G3 land, but defer INSTALLED native acceptance to one combined install/re-pin at the end — every install needs the user's admin password and a re-pin; installing between tasks would cost repeated user interrupts — cost if wrong: an installed-only broker defect found late could force rework in Tasks 4–8. Task 4 still reads authority only through the broker path, so the security property does not depend on install timing.
- Ruling: stop points are only (a) installing/re-pinning (admin password, outside worktree), (b) the Electron dev-window smoke test (AGENTS.md checkout + user observation), (c) push/merge. Everything else proceeds without check-ins.
G0: merged main 533b560; baseline tsc exit0, npm exit0 (ℹ tests 2085 ℹ pass 2085 ℹ fail 0 )
- Ruling (G2): conversation transcripts are imported as non-executable legacy envelopes + excerpts in the protected ledger, full text served read-only from the hashed snapshot labelled unverified — reference data is 23 MB vs broker 16 MiB per-document cap, and doc step 3 only requires preserving history as legacy/unverified, not certifying it — cost if wrong: full legacy transcripts are not protected against later tampering of the snapshot copy (mitigated: hash recorded at import and shown).
- Ruling (G2): split into G2a (host snapshot/preview/apply + desktop plumbing) and G2b (UI preview/confirm dialog) — one reviewable surface each — cost: an extra review round.
- Ruling (G4 added): packaged app launched from /Applications hands off to the TrustedUI copy and never downgrades the LaunchAgent — observed tonight: a Dock launch replaced the trusted daemon with an untrusted one and hid all protected data — cost if wrong: an extra relaunch hop on every /Applications launch. Gate order: G1 → G2a → G2b → G4 → G3 (G3 runs the harness last so it sees G1/G4 behavior in source; installed acceptance still deferred).
Baseline defect: at 533b560 (pre-G1) apex-host --test host 16/19 fail and apex-daemon --test attach 2/7 fail with 'A protected provenance receipt from the installed Apex UI is required' (also with --features test-support). Broken by provenance commits, not G1. Ruling: add task G1b to restore those integration tests via the existing test-support attestation seam without adding production bypasses — cost: one more task before G2.
G1: ⚠️ req3 resolved by controller: AssistantTasks::unavailable is an empty Document; redispatch_recovered_queued (assistant_service.rs) has no store/room/authority_file call. 
G1: minor (deferred): no-saved-room test passed pre-fix (guards Ok(None) only); continue-path test does not assert no release/reserve; Ok(None)/no-cwd paths still abort per brief "unchanged".
G1: complete (commits 533b560..466dc8f, review clean)
G1b: dispatched (base 466dc8f)
G1b: implementer DONE_WITH_CONCERNS d2d233e (host 18 pass/1 ignored, attach 7, lifeline/shutdown/stdio/websocket restored). Found production bug: Store::save_room writes room-authority before room file → failed room write leaves authority cwd moved; test a_replace_that_cannot_be_saved_leaves_the_thread_open_and_saved_where_it_was ignored pending fix. Review dispatched (opus) with named risk: package-mac copies target/release/apex-daemon without building.
G1b review (opus): Needs fixes — Important: (1) feature-compiled Daemon::start not broker-only; TMPDIR-controlled guard; package-mac copies unbuilt target/release binary; (2) no feature-off test target, stale doc line 260. Fix round 1 sent to original implementer (fixture bin + packager guard + doc).
G1b: minor (deferred): intermittent gateway_admin / voice::helper unit-test failures under concurrent cargo jobs (pre-existing).
- Ruling: add task G1c — fix Store::save_room ordering (authority manifest written before room file; failed room write leaves cwd moved) and un-ignore a_replace_that_cannot_be_saved_leaves_the_thread_open_and_saved_where_it_was — real production regression from provenance commits — cost: one small task.
G1b: fix round 1/5 implemented e805181 (fixture bin apex-daemon-fixture, Daemon::start broker-only, package-mac builds release binaries itself, new crate apex-host-production-check feature-off test; npm 2086 pass). Scoped re-review dispatched (opus) incl. named risk: production-check test fails under cargo test --workspace.
G1b: minor (deferred): voice::helper readiness_timeout_kills_the_helper (100ms timeout) flaky under machine load (load ~9), also at baseline.
G1b: fix round 1/5 (2 addressed, 1 new open — cargo test --workspace / bare cargo test fail via production-check feature unification; commits d2d233e..e805181)
- Ruling: keep apex-host-production-check in workspace; add default-members + README/alias for exclude pair — single lockfile beats excluded-package handling — cost: `cargo test --workspace` alone still needs the --exclude, documented.
G1b: fix round 2/5 (1 addressed, 0 open; commits e805181..58b3111)
G1b: minor (deferred): default-members must be kept in sync with members (README equivalence claim); package.json desktop:package/dmg build release binaries twice (harmless).
G1b: complete (commits 466dc8f..58b3111, review clean)
G1c: dispatched (base 58b3111)
G1c: implementer DONE_WITH_CONCERNS fb8a276 (room-file-first + restore on manifest failure; un-ignored regression; temp() race fix). Review dispatched.
G1c: minor (deferred, final review to triage): ambiguous broker CAS (committed but error returned) → save_room restores old room file under new manifest (unsafe direction, narrow window); manifest-failure restore path untested (no broker fault seam); create/fork paths still manifest-first (orphan manifest possible, cannot move existing room).
G1c: complete (commits 58b3111..fb8a276, review clean)
G2a: dispatched (base fb8a276, opus)
G2a: implementer DONE_WITH_CONCERNS d97736e,dae739a,200a19e (npm 2091, cargo all pass). Concerns: personal/machine not imported; broker protected() list gained legacy_import_apply (needs broker reinstall); fixture seam path .protected-fixture; partial failure returns Ok complete:false; G2b needs legacy status typing + room_state marker. Review dispatched (opus).
G2a review (opus): Needs fixes — Important: personal/machine not previewed per record nor imported; rooms digest one-shot → false conflict for leftover rooms. Concerns b–e judged acceptable (broker change = allowlist entry only; fixture path test-only; partial failure truthful + idempotent retry; legacy- ids/no lineage safer).
- Ruling: import personal assistants now (facts legacy, rules/approvals ungranted, tasks proposed/interrupted, schedules paused); machine grants previewed not imported — later tasks build on personal records and spec requires preserving personal memories — cost: larger G2a.
G2a: minor (deferred): conversations imported before tasks lose taskId link permanently; conversation envelope budget fails whole ledger above ~2000 records; legacy task owner.cwd/threadIds kept verbatim → G2b/retry UI must show cwd.
G2a: fix round 1 sent.
