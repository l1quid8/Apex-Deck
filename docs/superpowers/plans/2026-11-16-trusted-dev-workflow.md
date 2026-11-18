# Trusted Dev Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Matching signed dev UI/daemon on real threads, without installers,
with reversible production switching.

**Architecture:** User-side Node snapshot builder and launcher; explicit
administrator Python transaction switches exact trust pins and user services.
Existing provenance broker and production payload remain intact.

**Tech Stack:** Node, Electron Builder, Python standard library, codesign, launchd.

**Spec:** `docs/superpowers/specs/2026-11-16-trusted-dev-design.md`

## Global Constraints

- Preserve all unrelated checkout edits; work on `feat/trusted-dev-workflow`.
- No production DMG/pkg builds; development builds start in the project root.
- No authority resets or bypasses; no keys/journal rollback.
- Activation uses macOS administrator authorization after a reviewable build.

## Review Focus

- Signature/source drift between copying and activation must fail closed.
- Failed broker/service start must restore production or retain recovery state.
- Concurrent/foreign owners must never be terminated or overwritten.
- Repeated dev builds must not accumulate bundles or change active resources.
- Unexpected upgrades/pin changes must never restore stale production config.

## Task 1: Trust transaction

Files: `scripts/trusted-dev.py`, `tests/trusted-dev.test.mjs`.

- [x] Write failing temporary-directory Python tests for preserved keys/journal,
  exact config restoration, failed activation rollback, drift and repeated stop.
- [x] Implement fixed-path root transaction, validation, state, lock, service
  lifecycle and read-only status. External commands use argv and clean env.
- [x] Run tests; confirm failures are fixed and authority bytes untouched.

## Task 2: Snapshot builder and commands

Files: `scripts/trusted-dev.mjs`, `package.json`, same test file.

- [x] Write failing tests for deterministic build plans, source identity, no
  DMG/pkg output, clean runtime env and CLI routing.
- [x] Implement incremental debug compilation, signed immutable app snapshot,
  manifest and bounded staging. Add build/start/stop/status npm commands.
- [x] Test source drift, failed builds, and activation command generation.

## Task 3: Documentation and installed acceptance

Files: `docs/trusted-development.md`.

- [x] Document start/rebuild/stop/recovery, real-data effects and helper limit.
- [x] Run focused tests, existing related tests, `npx tsc --noEmit`, diff check.
- [x] Build a real signed snapshot, verify signatures/manifests and source stamp.
- [x] Independent branch review, fix material findings, rerun relevant checks.
- [ ] Activate only through explicit admin authorization; verify protected chat
  reads/submission and restoration when authorization is available.

## Execution ledger

- Initial TypeScript baseline passed. Shared checkout has unrelated dirty work.
- User approved signed snapshots instead of Vite hot reload.
- Native execution: this is one coordinated service transaction; preserve the
  user-approved outcome and settle routine implementation details in this chat.
- Reviewed by independent design and code reviewers. Fixed recovery owner
  selection, persistent service disable, API activity checks, stale atomic
  temporary writes, received assistant events, and degraded-host recovery.
- First real build exposed duplicate production/dev resource destinations from
  Electron Builder config inheritance. Materialized the config instead; the
  next real signed app/daemon passed strict anchored verification and embedded
  matching UI/daemon stamp `4d69083a0af4-dev-19fb44446086`.
- Final recovery-only adjustment triggered a fresh snapshot build, which passed
  strict UI/daemon anchored verification. No root changes were made.
  Live activation awaits user Terminal sudo authorization
  and completion of three existing production agent jobs.
- 53 focused/related packaging tests passed; TypeScript and diff check passed.
- Ruling: uninspectable legacy histories or degraded protected state require
  explicit interactive `idle` confirmation; known busy work always refuses.
  Activity inspection is not an atomic gate against new phone/CLI submissions.
- First user activation was correctly left in production, but rejected idle
  Claude sessions as busy merely because they remained daemon children. Traced
  the two registered groups to idle threads and persistent MCP servers. Added
  exact kernel birth/UID/PGID/room checks and a fresh thread-idle recheck. Known
  idle owned CLI groups may stop with the service; unknown/active groups refuse.
- Eleven focused tests cover this guard, including provider CLIs, persistent
  servers, PID reuse, escaping groups, and work starting during inspection.
- Second user activation exposed that root IPC clients are intentionally
  rejected by the daemon's same-effective-UID socket policy. Routed every
  administrator-helper RPC through a synchronous owner-UID scope with `finally`
  restoration. Added credential/error-path regressions; 56 focused/related tests
  pass. Independent review found no issue in the credential fix.
- Real read-only administrator verification succeeded against the installed
  daemon: IPC ran as UID 501 and root UID 0 was restored afterward. No trust
  pins/services changed. A GUI-launched diagnostic could not read Downloads due
  to macOS privacy controls; its temporary copy worked and was removed. Actual
  activation remains a Terminal operation, not a GUI diagnostic.
- Third user attempt exposed asynchronous broker bootout: launchd rejected
  bootstrap with EINPROGRESS before the old job disappeared. Added a wait for
  both job removal and PID exit. A real disposable system LaunchDaemon passed
  three rapid start/unload cycles and was removed.
- Real dev activation then succeeded, including protected store reads and the
  expected dev stamp. Signed UI acceptance exposed a backlog: native sampling
  showed most broker CPU in SecStaticCodeCheckValidity on the roughly 200 MB
  full-debug daemon. Closed the test UI and restored production successfully.
- Ruling: trusted snapshots use opt-level 1, no debug info, stripped symbols,
  incremental compilation and a dedicated target/trusted-dev cache. Ordinary
  debug builds remain untouched. Broker readiness now requires a fresh complete
  read-only response rather than connect/cached host reads alone.
- The optimized binary is 46 MB, but actual UI startup still overwhelmed the
  broker's listen backlog. The current development checkout's existing
  block_in_place protected IO permits concurrent requests; it was preserved.
  Added a client-side per-process broker stream lease in
  crates/apex-provenance/src/io.rs, covering the full request/response without
  caching, bypassing checks, or replaying uncertain mutations. Real Unix-socket
  concurrency tests pass. Full provenance library suite: 124 passed, 2 ignored;
  focused/related JavaScript suite: 61 passed. Independent review found no
  recursive acquisition or authority regression.
- Recovery was also blocked by a completed zombie child. Process inspection
  now excludes only kernel ps Z states; living unknown workers still refuse.
  Production was restored using the guarded helper. The queued-client build
  still needs fresh UI/thread and protected-submission acceptance.

- Fresh queued-client UI acceptance loaded the real Building Procedure thread
  and its transcript/agent controls without a build-mismatch banner. Creating
  an empty talk-only chat remained on Starting and did not produce a confirmed
  new chat; acceptance remains incomplete. No message was sent to any agent.
- Closed the dev UI. Normal stop reached its activity guard but could not
  inspect assistant/catalog activity and refused noninteractive recovery.
  Do not describe the workflow as ready until protected write and restore
  acceptance pass. Fresh TypeScript/diff checks and all 61 JS tests pass.

- Final guarded normal stop succeeded after the transient worker exited:
  production trust/service restored; status reports production PID 50641,
  no dev PID, protectedRead ok. Opened the protected production app and
  verified Building Procedure with its real transcript and one agent.
- The delayed empty chat eventually reached the catalog after broker reload
  (chat-df353af6-8f9d-4757-aad5-fdfaea7ebb08). Production UI confirmed it had
  one idle agent and zero messages; moved only that test chat to recoverable
  Trash (count 4 -> 5). No agent message was sent. Production remains open.
- Remaining acceptance gap: sustained dev responsiveness under real catalog
  load, and a prompt protected submission. Bootstrap/service ordering and
  guarded production restoration are proven; end-to-end workflow is not yet
  declared ready. An idle-confirmation question became unnecessary because
  the normal guard eventually inspected activity and completed itself.
