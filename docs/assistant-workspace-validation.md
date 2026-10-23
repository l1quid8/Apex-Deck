# Assistant workspace implementation and validation

Implementation branch: `feat/null-assistant-completion` in `/Users/tylercaldwell/Downloads/apex-deck-worktrees/null-assistant-integration`.

Validated feature source: `696f112475eaf90bac8270c9575cee161b65df7b`, based on `29f8b30`. This records implementation and fixture validation of the [approved plan](superpowers/plans/2026-10-22-assistant-workspace.md). Nothing was merged to main, installed, re-pinned, packaged or shipped in this continuation.

## Current implementation

- Your team uses durable host-qualified assistants. Conversation, Projects, Activity, Memory and Settings occupy the main canvas; existing human sessions remain mounted and the global sidebar keeps its state. Late saves/uploads/creation outcomes retain their original owner and cannot close another assistant's draft.
- Creation and Settings share supported Provider/Model/Reasoning controls, Full access, pixel identity and optional generated avatars. Creation visibly exposes its initial allowed project folder; choosing Full access or assigning a project never silently creates a folder grant. Existing reusable Agents profiles and legacy metadata remain intact. `src/AgentsSection.tsx` is byte-identical to baseline `29f8b30`.
- Personal plans create durable project proposals with original verified human-event provenance and immutable assistant/project lineage. Explicit approval uses the existing isolated/read-only worker executor, destination eligibility, checkout protection and limits. Imported Human labels do not establish authority. Worker endpoint privacy is checked again on approval, dispatch and continuation.
- Task controls retain durable intent, attempts, receipts and uncertain outcomes. Cancelled work can explicitly Retry into a new attempt; duplicate delivery/reconnect cannot duplicate an operation or result. Completed attempts return once to their recorded assistant, even after message history pruning.
- Avatar generation persists dispatch intent, costs and owner-bound jobs before a provider call. Preview requires explicit Apply, then Create/Save. Cancellation/reset preserve the prior saved appearance; creation spend remains attributed even when a pixel avatar is chosen. Assets normalize to hashed 512×512 PNG, survive restart and authenticated second-client reads, and fall back to the saved pixel pattern offline. Cancelled or late results cannot select another editor's image.
- Global Tasks collects every current personal/project store, including unassigned legacy tasks and retained offline snapshots. Keys use authoritative host/project identity even when both hosts call themselves `local`. Filters, collapsed groups and task details remain global across page navigation and popouts. Backend calls verify the captured authenticated host before invocation and after replies.

## Fresh integrated verification — 2026-10-23

These are parent-executed results, not only implementation-agent reports. JavaScript passed on `887087e`; its files are unchanged by the final Rust-only startup fix. TypeScript, Rust, production admission and E2E were rerun after that fix.

| Check | Result | Evidence |
| --- | --- | --- |
| `npx tsc --noEmit` | Passed | `/tmp/null-assistant-final-tsc.log` |
| `npm test` | 2,229 passed; no failures/skips | `/tmp/null-assistant-final-npm.log` |
| `TMPDIR=/tmp cargo test -p apex-host -p apex-provenance -p apex-daemon -- --test-threads=2` | 834 passed; no failures; 5 existing ignored | `/tmp/null-assistant-final-rust.log` |
| Feature-off production storage/admission checks | 3 passed; no failures/skips | `/tmp/null-assistant-final-production.log` |
| All JavaScript E2E files against explicit `apex-daemon-fixture` | 22 passed; no failures/skips | `/tmp/null-assistant-final-e2e.log` |
| Independent whole-branch source review | No remaining Important/Critical findings; 49 focused checks passed | `/tmp/null-assistant-final-review.md` |
| `git diff --check`; unchanged production Agents component | Passed | Parent read-back |

The E2E scenarios exercise two hosts with the same local assistant ID, three canonical disposable project roots, real deterministic registered workers, private/project memory separation, reviewed scratch promotion and deduplication, stale edits, independent pause/cancel/retry, pending proposals, restart/reconnect and once-only results. A deterministic image adapter exercises actual generation/status/asset/configuration/create RPCs without credentials or billing, including creation cost transfer and cancellation/reset. The adapter is registered only by the explicitly named temporary-directory fixture binary; compiling test support never enables it in the regular daemon. This is not signed installed-app admission evidence.

The first combined host run exposed an outdated exhaustive command-count assertion after combining the two RPC additions. The assertion now explicitly covers the five avatar commands and the delegation command; the complete rerun above passed. Review also reproduced and fixed forbidden endpoint dispatch, canonical folder alias mismatches, cancelled Retry, creation cost attribution, initial folder selection, exact project navigation and late-save draft loss.

The separate feature-off target caught a degraded-startup regression: recovered-task result reconciliation attempted a protected read after ownership admission had failed. Startup now skips only that reconciliation/dispatch when protected ledgers are unavailable, retaining existing process cleanup and fail-closed writes. Independent review approved the narrow guard; the existing unsigned-forgery startup regression now passes in the separate three-test target.

## Supported boundaries and remaining native gate

- Delegation is validated on the assistant's owning host. Cross-owning-host project dispatch remains unavailable without authenticated remote authority. Clients can still connect to multiple owning hosts independently.
- Shared worker prompts deliberately omit assistant-private facts; they carry scoped project/monitor evidence and the assignment. No memory text grants authority.
- Personal Pause prevents new starts. Active work is paused individually with the task control. Adapters without checkpoints stop safely into Interrupted and require explicit Retry; there is no transparent checkpoint-resume claim. This follows Task 5's explicit contract where the design prose differed.
- Production image generation reuses the existing Venice adapter and configured credentials. Local cancellation prevents application of a result but cannot cancel a charge already dispatched to a provider. No paid image call was made here.
- CLI installation and cached model metadata are checked and labeled; current CLI sign-in cannot be independently verified by the available discovery API. API-provider missing credentials and unavailable catalogues block the runtime form with a concrete reason.
- Browser controls reuse actual availability and the existing Open browser/Take over action; browser operations retain their existing Send-class approval policy. No unenforced browser-only permission was invented.
- No installed or native-window smoke was performed. The observed running processes remained `/Applications/Apex Deck.app/Contents/MacOS/Apex Deck` and its bundled daemon; no development session was launched. A fresh `sudo -n true` still returned `sudo: a password is required`.

The administrator checkpoint in [UPGRADE-PROCEDURE.md](handoff/2026-10-22/UPGRADE-PROCEDURE.md) and signed native acceptance remain open. Its existing `8f67474` security candidate predates this feature source. Passing fixture admission does not close that gate or authorize merging/shipping Tasks 4–8.

After that checkpoint, perform one native smoke in the existing authorized window: create/rename two assistants with explicit project folders and supported saved runtime settings; keep Tasks open while navigating assistants, Projects, Memory, Settings and Agents; approve work in three disposable projects, pause one owner, inspect scoped memory/review and reconnect/restart. Compare durable IDs, pending approvals, attempts, results and pixel/generated asset references before/after. The deterministic image lifecycle is already automated; do not trigger a paid provider call just to repeat it.

## Earlier foundation checkpoints

The phase-local records below describe earlier source checkpoints. Their deferred UI/avatar statements were true at those phases and are superseded by the current implementation and evidence above.

### Earlier source and preservation boundary

- Work happens in `/Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan`.
- The publication branch initially predated 58 committed application changes. Merge `5959ee1` reconciles the committed application baseline `4d40cc0` without copying the shared checkout's uncommitted Dashboard/Tasks patch.
- No production data, memory records, installed application, running daemon, or shared checkout was modified by these implementation checks. Tests use temporary stores and fixture providers.
- The production `src/AgentsSection.tsx` matches baseline `4d40cc0`; the preview's simplified worker screen is not being substituted.

## Phase 1: identity and configuration

Status: verified foundation, backend commit `f41befd`. Independent Task 1 review found no remaining blocker in the supported contract.

Implemented frontend contracts qualify assistant IDs by their durable host and project IDs by host, workspace and canonical project path. Pixel appearance reuses the production identicon algorithm, preserves saved color/shape/seed and retains the pixel fallback for future image assets. The versioned settings mutation is registered with the disconnected-host guard, so it cannot queue a stale save during reconnect.

Host configuration uses a revision-checked transaction; stale or invalid submissions change none of the saved fields. It preserves private facts, correction/deletion chains, pending task approvals and hashes, and legacy metadata. Later UI work will consume this contract; these source changes do not yet expose a new creation/settings screen.

Current checks:

| Check | Result | Scope |
| --- | --- | --- |
| New identity, appearance and existing identicon cases | 15 passed | Pure identity and pixel fallback behavior, including Windows host paths |
| Identity, identicon and host-backend checks | 28 passed | Includes disconnected versioned saves; the new regression failed before the guard was added |
| `npx tsc --noEmit` | Passed | Reconciled branch with frontend contracts and host guard |
| `npm test` | 1,995 passed | Reconciled JavaScript branch; backend verification is separate below |
| `cargo test -p apex-host personal` | 67 passed | Includes final configuration, preservation, model-discovery and access-policy regressions |
| Host command tests | 12 passed | New RPC parsing and command discovery |
| Daemon authority tests | 5 passed | Configuration requires Full/global device authority |
| Daemon hello test | 1 passed | Advertises `assistant_workspace_v4` |
| Independent Task 1 review and diff check | Passed | Reviewed final code and read back exact Rust results |

An initial full test attempt encountered concurrent Electron dependency extraction errors. Serial dependency setup resolved those failures before the passing rerun. Detailed baseline and review records are retained in this plan's ignored `.superpowers/sdd/2026-10-22-assistant-workspace/` workspace; raw setup/test logs are in `/tmp/apex-assistant-baseline/`.

### Supported boundaries

- Remote project assignments remain unavailable until the project host can authenticate and validate authority. No grant is inferred.
- Runtime profile changes require an offered model catalogue; unavailable discovery blocks that change while settings-only saves preserve the saved profile.
- New generated-image attachment remains unavailable until Phase 6A. Existing image references and pixel fallback are preserved.
- Until scoped delegation exists, any Off assignment blocks generic personal tools on that host; Ask assignments require approval for those tools. These broad restrictions avoid pretending that a command cannot reach another project merely because it starts in a different folder.

## Phase 2: discovery, ownership and draft continuity

Status: verified at `9d276ac`, including draft retention `4b3652a`, collection `eb4c5ce`, and negotiated capabilities `fe2aa21`/`4e30dee`.

- Discovery collects every supported local/remote assistant without creating one. Durable authenticated host identity stays separate from transport aliases; offline records retain freshness and valid session selection survives refresh.
- Sends, reactions, approvals, memory changes, runtime settings and attachments capture their original assistant and route. Revision and generation checks reject stale list/write outcomes. An assistant's versioned settings keep the editor's submitted revision rather than silently upgrading it.
- Background bridges visit all linked assistants. Ownership is rechecked before each claim, execution, result and multi-step machine link, so a reconnect cannot deliver Alpha's output or grant to Beta merely because their local IDs match.
- Push payloads include the durable host. Exact notifications wait for the right assistant, including offline/newly created identities; older list results cannot erase that target. Pending identities present an attributed read-only lane. Legacy hostless notifications never guess by repeated local ID.
- Assistant-specific session drafts preserve text, quotes, task destination, attachment metadata and transcript position across switches. Pending uploads and late send outcomes remain in the original draft. These drafts are client-memory state, not a new lasting memory system or restart-persistence promise.
- Old hosts retain safe legacy operations. Versioned configuration is sent only when the current handshake advertises `assistant_workspace_v4`; capability checks issue no mutation probe.

Independent review reproduced and resolved two wrong-owner mutation paths (bridge result delivery and machine linking), route-rebinding/stale-list defects, exact-notification discovery races, and the removed-host synchronous capability contract. The final review found no unaddressed blocker in this phase.

| Final gate | Result | Evidence |
| --- | --- | --- |
| `npm test` | 2,027 passed; zero failures/skips | `/tmp/apex-assistant-phase2-full.log`, 55.13 s |
| `npx tsc --noEmit` | Passed | Parent-executed on clean `9d276ac` |
| `cargo test -p apex-host personal_worker::push::tests` | 1 passed | `/tmp/apex-assistant-phase2-push.log`; fixture payload, no live APNs request |
| Independent combined phase-2 checks | 105 passed | `/tmp/apex-assistant-baseline/task2-final-review.log` |
| `git diff --check` | Passed | Clean source at the final gate |
| Production Agents screen | Unchanged | Exact comparison with `4d40cc0` |

An earlier full-suite attempt ran while draft regressions were deliberately RED: 2,012/2,014 passed with those two expected failures. A separate overlapping full attempt was canceled; neither is presented as a passing gate. The parent-owned final 2,027-test run above supersedes both. No development app launch, native UI smoke, production-data migration, installation, merge to main or release was performed.

## Phase 3: scoped project memory and inspectable reads

Status: verified implementation and independent source review; source checkpoint only, not an installation.

- `assistant_project_memory_v1` negotiates the new notebook operations. Each read/write revalidates the durable assistant host, exact assigned project, canonical workspace/folder and current grant. Current support requires the assistant and project to share one authenticated host; remote authority is still unavailable.
- Shared notes live in `project-memory-v1.json`. Private facts remain in the original personal document. Direct human edits carry null author and no invented worker source. The Memory panel separates private facts from selected-project notes and shows IDs, versions, timestamps, provenance and fresh-read time. Existing monitor decisions/preferences are read-only sources, never copied into writable notes.
- Edits require the inspected note version. Atomic transactions reject stale concurrent writes. Forget clears words across the complete correction chain and retained scratch copies; already-issued task results/snapshots are historical evidence and are not represented as erased.
- Durable scratch freezes an exact excerpt of the current completed worker result with assistant/project/task/attempt/run identity. `capturedTaskRevision` remains fixed; explicit re-review may advance `expectedTaskRevision` before first promotion without changing source ID, bytes or expiry. Source deduplication and delivery-ID bindings are separate, so a new request ID cannot save a second copy. Accepting work and saving memory remain separate actions.
- Assistant lineage is additive/omitted on legacy tasks; legacy owner keys and hashes remain unchanged. Legacy/unassigned tasks cannot manufacture assistant authorship. Actual personal-to-project lineage creation and worker context injection belong to Phase 4; this phase does not claim that existing production workers use the new notebook or that a promotion button has been added to task review.
- Retrieval excludes other assistants, unrelated projects, whole conversations, expired and forgotten notes. Private facts additionally require an allowed target provider; local evidence assembly performs no model/network call. The eventual sender must independently enforce provider/host policy before sending. Quoted JSON evidence cannot grant permissions; the existing gateway test verifies malicious memory cannot bypass Ask or Project tools Off.
- The full serialized context, including assignment, JSON escaping and provenance, obeys the total character budget. Per-scope quotas are ceilings. Optional notes are dropped to fit; an assignment that cannot fit with its provenance fails explicitly.
- Project limits: 500 active notes, 5000 retained notes, 2000 Unicode characters per note, 1000 current scratch records, 5000 retained scratch records and 10000 delivery IDs. Scratch expires after 24 hours. Capacity errors preserve dedup/tombstone metadata; future maintenance is not silently invented here.
- Private-memory mutations accept optional expected assistant revisions. New clients send a captured revision; old hosts omit the unsupported field and keep their legacy operation. Assistant/project switches cannot retarget an in-flight request, editor draft, correction or late receipt. Offline mutations are refused without reconnect replay.

Independent review identified two production issues, both fixed with failing regressions before the fixes: serialized-budget overflow and scratch stranded by a later task-acceptance revision. Source review found no remaining Important/Critical finding. Earlier harness failures and an outdated command-count expectation were repaired and are not presented as feature regressions.

| Final gate | Result | Evidence |
| --- | --- | --- |
| `npm test` | 2,045 passed; zero failures/skips | `/tmp/apex-phase3-js-final.log` |
| `npx tsc --noEmit` | Passed | Parent-executed final check |
| `cargo test -p apex-host` | 539 unit + 19 integration passed; 4 explicitly ignored | `/tmp/apex-phase3-host-final.log`; ignored live provider/simulator/trash checks were not run |
| `cargo test -p apex-daemon` | 144 unit + 25 integration passed; 1 explicitly ignored live model-turn test | `/tmp/apex-phase3-daemon-final.log` |
| Independent focused frontend review | 24 passed | Reviewer-executed actual client/component tests |
| Production Agents screen | Exact match to `4d40cc0` | Parent byte comparison |

No installed app, live daemon, production data, main checkout or development window was changed. The phase-6 main-pane redesign remains pending; these Memory controls are added to the existing panel component.

## Remaining phase gates

1. Phase 1 foundation passed as described above.
2. Phase 2 passed: discovery, owner-bound operations, phone compatibility and per-assistant session drafts.
3. Phase 3 passed for the supported same-host notebook contract; production delegation injection follows in Phase 4.
4. Connect proposed personal handoffs to the existing coding executor with immutable ownership and receipts.
5. Verify independent controls, retries and restart reconciliation.
6. Build the approved main-pane assistant interface and durable avatar flow.
7. Integrate the separately reviewed Dashboard prerequisite and global Tasks aggregation.
8. Prove two assistants across three projects, then perform the agreed development-window smoke test.

The Dashboard prerequisite review found that externally opening a closed/archived saved chat can immediately trigger orphan cleanup. It must be fixed and covered before that patch is integrated. Its existing passing tests did not cover that case.
