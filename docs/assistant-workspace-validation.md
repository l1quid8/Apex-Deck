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

## Remaining phase gates

1. Phase 1 foundation passed as described above.
2. Discover and select all durable assistants with owner-bound async operations and phone compatibility.
3. Add versioned project notes, bounded authorized context and separate reviewed scratch promotion.
4. Connect proposed personal handoffs to the existing coding executor with immutable ownership and receipts.
5. Verify independent controls, retries and restart reconciliation.
6. Build the approved main-pane assistant interface and durable avatar flow.
7. Integrate the separately reviewed Dashboard prerequisite and global Tasks aggregation.
8. Prove two assistants across three projects, then perform the agreed development-window smoke test.

The Dashboard prerequisite review found that externally opening a closed/archived saved chat can immediately trigger orphan cleanup. It must be fixed and covered before that patch is integrated. Its existing passing tests did not cover that case.
