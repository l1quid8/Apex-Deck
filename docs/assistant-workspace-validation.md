# Assistant workspace implementation and validation

Implementation branch: `docs/assistant-workspace-plan`.

This is an implementation record for the [approved plan](superpowers/plans/2026-10-22-assistant-workspace.md), not a release or installation record. The existing production Agents screen remains the reusable-worker manager. The approved main-pane assistant UI is still a later phase.

## Source and preservation boundary

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

## Remaining phase gates

1. Phase 1 foundation passed as described above.
2. Phase 2 passed: discovery, owner-bound operations, phone compatibility and per-assistant session drafts.
3. Add versioned project notes, bounded authorized context and separate reviewed scratch promotion.
4. Connect proposed personal handoffs to the existing coding executor with immutable ownership and receipts.
5. Verify independent controls, retries and restart reconciliation.
6. Build the approved main-pane assistant interface and durable avatar flow.
7. Integrate the separately reviewed Dashboard prerequisite and global Tasks aggregation.
8. Prove two assistants across three projects, then perform the agreed development-window smoke test.

The Dashboard prerequisite review found that externally opening a closed/archived saved chat can immediately trigger orphan cleanup. It must be fixed and covered before that patch is integrated. Its existing passing tests did not cover that case.
