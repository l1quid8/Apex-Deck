# ApexAgent implementation validation, October 9, 2026

The implementation is on local branch `feat/apexagent-delegation-20261009` in
the managed `apexagent-delegation` checkout. The
original Downloads checkout was preserved: all 912 files in snapshot
`7c96f613ad394ffcc5dd5c833010d83408c05323` still match its contents. Both earlier
code copies have backup refs under `refs/apex-backups/delegation-20261009-*`.
Nothing has been pushed, installed, or merged into the original checkout.

Local implementation commits:

- `9f3d797`: durable host delegation, process ownership and Git integration.
- `92152af`: shared desktop/phone controls, recovery and behavioral fixtures.

Ten GPT Luna helpers contributed in batches of three, respecting the runtime's
four-agent limit including the controller. The controller integrated shared
interfaces, inspected changes, ran fresh checks, and requested independent
reviews. Reviews covered human request authority, ordinary worker permissions,
durable process ownership, checkout reservations, task recovery, desktop and
phone ownership filtering, and Git integration.

## Fresh checks

| Check | Result |
| --- | --- |
| JavaScript suite | 1,015 passed |
| TypeScript and production build | Passed; existing large-bundle warning remains |
| Rust workspace with remote support | 771 passed; one live-provider test intentionally ignored |
| Fresh daemon end-to-end tests | 14 passed |
| Native desktop smoke | Passed, including restored worker startup and shutdown |
| Native widget smoke | 12 steps passed |
| Native multi-host smoke | Passed |

Commands are listed in [the workflow guide](apexagent-delegation.md).
The saved check logs are `/tmp/apexagent-final-{js,rust,build,e2e}.log`,
`/tmp/apexagent-desktop-smoke-final10.log`,
`/tmp/apexagent-widget-smoke-final.log`, and
`/tmp/apexagent-multihost-final.log`. Native widget screenshots are under
`/tmp/apex-widget-screenshots`; multi-host evidence is under
`.superpowers/smoke/multi-host` in the implementation checkout.
The multi-host fixture uses two real local daemons and an SSH executable shim.
It verifies renderer and connection isolation, restart recovery, draft
preservation, remote uploads, and saved-session behavior; it does not establish
deployment on a real VPS.

The native widget check exercises setup/profile choice, editing the assigned
profile without losing responsibility, sources or history, immediate answers,
clarification task cards, attention badges, and usable request controls in
regular and narrow windows. The general smoke now creates its large profile
library through the actual Agents editor and uses a dedicated test project
instead of snapshotting the shared `/tmp` directory.

## Delegation acceptance evidence

The daemon fixtures use deterministic local reasoning and CLI stand-ins,
temporary Git repositories, and two independent clients. They cover:

- A human request starts exactly one linked execution thread. Closing its pane
  leaves the worker running. Ready retains the checkout reservation; stale
  acceptance fails, fresh verified acceptance releases the waiting writer.
- A restart preserves completed task receipts; replay does not dispatch again.
  Proactive proposals remain unstarted until approved.
- Two isolated workers run in distinct worktrees. Their actual approval
  requests appear on task records and require a human decision.
- Sequential acceptance preserves the primary staging index, an intervening
  human edit, and the earlier accepted task. Checks and outputs remain visible.
- Archiving removes the owned worktree and build folders, retains task records
  and immutable result refs, and prevents an archived task from resuming.

Rust regressions additionally cover descendant cancellation and timeout,
restart process recovery, interrupted integration, later human edits during
recovery, replacing symlinks without writing through them, snapshot reachability
after Git garbage collection, malformed or linked recovery registries,
concurrent registry creation, and read chats continuing during acceptance.

## Validation limits

This is a local implementation, not a shipped release. A physical iPhone and
paid-provider execution have not been exercised. The current Codex adapter has
no verified isolated startup mechanism and therefore shows Needs you; it
continues to support in-place execution. macOS checks passed; Linux CI is
configured with remote support but was not run locally. Windows process-tree
recovery is explicitly unsupported.

The two-client fixtures establish daemon/protocol behavior, not physical phone
interaction. The plan's physical-device and real-provider release acceptance
checks remain outstanding before release.
