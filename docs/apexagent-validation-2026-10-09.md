# ApexAgent implementation validation, October 9, 2026

The implementation was built on branch `feat/apexagent-delegation-20261009` in
the managed `apexagent-delegation` checkout, then integrated into `main` in the
original Downloads checkout. Before integration, all 912 files matched snapshot
`7c96f613ad394ffcc5dd5c833010d83408c05323`. Both earlier code copies have backup
refs under `refs/apex-backups/delegation-20261009-*`. The signed native app is now
installed at `/Applications/Apex Deck.app`; installation evidence is below.

Local implementation commits:

- `9f3d797`: durable host delegation, process ownership and Git integration.
- `92152af`: shared desktop/phone controls, recovery and behavioral fixtures.
- `26a6f2c`: workflow documentation and implementation validation.

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

This is a locally installed development build, not a formal release. A physical iPhone and
paid-provider execution have not been exercised. The current Codex adapter has
no verified isolated startup mechanism and therefore shows Needs you; it
continues to support in-place execution. macOS checks passed; Linux CI is
configured with remote support but was not run locally. Windows process-tree
recovery is explicitly unsupported.

The two-client fixtures establish daemon/protocol behavior, not physical phone
interaction. The plan's physical-device and real-provider release acceptance
checks remain outstanding before release.

## Native installation

The native app was packaged from `main` at `26a6f2c`. Fresh checks in that
checkout passed: 1,015 JavaScript tests, 771 Rust tests with remote support
(one live-provider test intentionally ignored), TypeScript and the production
build. The optimized daemon build and Developer ID packaging succeeded.

The packaged app passed the full native desktop smoke, including browser
recovery, persisted storage, restored worker startup, and daemon shutdown. After
installation, the actual `/Applications/Apex Deck.app` passed all 12 widget
checks using isolated test data. Its signature passed deep, strict verification,
and its bundled `app.asar` and daemon hashes match the tested package:

| Artifact | SHA-256 |
| --- | --- |
| `Contents/Resources/app.asar` | `1a2f5a876dbc3563ceb6173ddcd2efb3d5c2feeae8a3e252e210fd4070d3ca7a` |
| `Contents/Resources/bin/apex-daemon` | `fcb6bebc56b44b52090c9a3218fe7566b0a39967966fafbfc564af274f4e3972` |

The production LaunchAgent was stopped gracefully and refreshed with the new
bundled daemon. A fresh handshake advertised `monitor_profile_update`,
`assistant_delegation`, and `assistant_isolation`, with remote access running.
Host identity, pairing keys, paired devices and remote configuration retained
their hashes. The saved session still contains three workspaces, nine panes and
seven profiles. The normal native app reopened successfully; its saved
conversation, task request controls, and editable profile dropdown were
inspected without dispatching new provider work or changing the profile.

The former app, LaunchAgent plist, daemon data and desktop data are backed up in
`~/Library/Application Support/Apex Deck/build-backups/20261009-115214-apexagent`.
The per-boot daemon token rotated normally. Session content was preserved;
its `savedBy` client marker changed after reconnecting.

Installation logs are `/tmp/apexagent-main-{js,rust,build}.log`,
`/tmp/apexagent-native-{release,package,packaged-smoke,installed-widget}.log`.
The application version remains `0.5.1`; the hashes above identify this build.
