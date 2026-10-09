# Apex Deck and ApexAgent code review

Reviewed October 9, 2026, against the current working tree based on commit `30935aa`, including the uncommitted ApexAgent, widget, monitor, and adapter changes. This is a review, not a fix pass; application source was left unchanged.

## Assessment

ApexAgent has a useful product direction: a persistent project observer that remembers human direction, tracks unresolved decisions, and gives reasons for raising them. The durable ledger, selected sources, citation validation, and protection against stale project ownership are strong foundations. Keeping findings open until the human settles them is a sensible trust boundary.

I would hold broader unattended CLI monitoring and scoped remote access until the first two findings are fixed. The implementation currently grants more capability than its read-only monitoring contract promises, and restricted devices can read monitoring data outside their allowed threads.

The repository is more carefully engineered than its early status might suggest. Rust core/adapter/host/transport separation is useful, and there is substantial testing of cancellation, persistence, pairing, approval correlation, and UI state rules. The principal weakness is that related guarantees are enforced in different places: tool access versus editor ownership; subprocess cancellation versus lifetime; desktop recovery versus phone recovery; monitor durability versus workspace removal. The bugs below occur where those implementations meet.

## Findings

### 1. [P1] Restricted devices can read monitoring data from unrelated projects

[authority.rs:55](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-daemon/src/authority.rs:55) classifies both `MonitorList` and `MonitorGet` as `GlobalRead`. That classification bypasses a device's selected-thread restriction. [host.rs:891](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/host.rs:891) returns complete durable monitors, including human responsibilities and decisions, selected thread identifiers, messages, and evidence excerpts. [protocol.rs:217](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-daemon/src/protocol.rs:217) filters session responses, but does not filter monitor responses.

**Verified:** a synthetic read-only device restricted to `allowed-thread` was denied `room_state(secret-thread)` yet received the secret project's monitor through both monitor commands, using the freshly rebuilt daemon and host libraries.

**Fix:** require unrestricted access for these reads until an explicit monitor scope and source-aware response filter exist. A monitor can combine file evidence and several threads, so merely matching one allowed thread is insufficient.

### 2. [P1] CLI-backed ApexAgent checks can approve mutating MCP tools

[monitor_check.rs:194](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/monitor_check.rs:194) uses `Access::Read` for CLI checks and relies on the default rejecting approver. However, [claude_session.rs:284](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-adapters/src/claude_session.rs:284) automatically approves MCP tools whose names miss the substring blacklist in [mcp.rs:5](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-adapters/src/mcp.rs:5), bypassing that approver. Names such as `create_file`, `update_document`, and `execute` are not blocked.

**Verified:** a freshly compiled fake Claude requested `mcp__probe__create_file` while read-only with `NoApprover`; Deck returned `behavior: allow` and the complete arguments. The probe tested the permission response without performing a real mutation.

**Fix:** give monitoring a tool-free execution mode enforced at the adapter boundary. Until then, use the tool-free HTTP text path for monitoring. An empty working directory and a read-only prompt do not contain connected external tools.

### 3. [P1] Cancellation leaves descendant processes running

[cli.rs:124](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-adapters/src/cli.rs:124) applies `kill_on_drop(true)` to the immediate process without owning or terminating its descendants. Stop drops the response future, and the editor guard is released when the turn ends.

**Verified:** a local shell fixture launched a child that wrote a marker after 800 ms. Its parent timed out at 100 ms; the descendant still wrote afterward. No project files were involved.

**Impact:** a command can keep changing files after Stop or timeout, including alongside the next participant granted editing access.

**Fix:** terminate and reap the owned process tree before releasing the editing reservation. Cover ordinary completion cleanup, Stop, inactivity timeout, and monitor timeout.

### 4. [P1] Removing a watched project freezes the other projects' monitoring UI

[monitorAttention.ts:88](/Users/tylercaldwell/Downloads/apex-deck/src/monitorAttention.ts:88) rejects an entire host snapshot if any monitor belongs to a removed, moved, or otherwise unlisted workspace. The host returns every durable monitor, and workspace removal does not remove those records.

**Verified:** a valid remaining project's blocker plus a removed project's monitor yielded zero attention entries from an empty state. With existing state, subsequent findings and resolutions stop updating. The condition persists across restart.

**Fix:** exclude records that no longer belong to current workspaces before reconciliation, while still rejecting conflicting ownership for current records. Define what happens to background monitoring when a project is removed or moved; hidden monitors currently remain eligible for checks.

### 5. [P1] Retry can create overlapping connections and strand commands

[client.ts:155](/Users/tylercaldwell/Downloads/apex-deck/src/daemon/client.ts:155) checks `this.link` to determine whether connection work is in progress. [client.ts:183](/Users/tylercaldwell/Downloads/apex-deck/src/daemon/client.ts:183) does not assign that link until the asynchronous dial finishes. Two Retry actions during a slow connection can therefore dial concurrently.

**Verified:** a fake-link reproduction established two connections. The older attempt replaced a newer welcomed link; replies on the newer link were ignored, its outstanding command remained unresolved, and its connection was left open.

**Fix:** track the pending dial and a connection generation. Close superseded completions and prevent their success or failure from changing current state.

### 6. [P1] Phone snapshot loading can lose blocking approvals and new messages

[PhoneApp.tsx:554](/Users/tylercaldwell/Downloads/apex-deck/src/phone/PhoneApp.tsx:554) installs the fetched room snapshot wholesale. Events arriving during that fetch are immediately applied to the current room at lines 575 onward; they are discarded against a null room or overwritten by the older snapshot.

**Verified:** running the actual extracted loading effect, emitting an approval while the request was pending, and then resolving the earlier snapshot left the approval list empty.

**Fix:** use the existing desktop `createRoomRecovery` buffering and `recovery_seq` boundary on the phone, for all room events rather than only roster changes.

### 7. [P2] Accepting a Claude plan bypasses the editing reservation

[concurrent.rs:331](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-core/src/concurrent.rs:331) reserves the editor only for a request initially allowed to write. Plan requests start with read access and acquire no reservation. [claude_session.rs:125](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-adapters/src/claude_session.rs:125) later restores writable permissions when the human accepts `ExitPlanMode`.

**Verified:** one synthetic participant held the editor while planning Claude received `bypassPermissions`; no editor transition occurred.

**Fix:** acquire the reservation before restoring writable permissions, or finish planning and schedule a separate writable turn.

### 8. [P2] Time passing alone cannot trigger a new monitoring assessment

[monitor_check.rs:243](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/monitor_check.rs:243) skips model assessment whenever the evidence fingerprint is unchanged, except for initial assignment, redirection, and explicit Check now. Fingerprints intentionally exclude observation time. The model's adaptive next-check deadline therefore does not cause another assessment if the sources stay unchanged.

**Failure case:** a responsibility has an agreed deadline, and the first check occurs before it. When the deadline passes without file or thread changes, the scheduled check skips assessment rather than detecting that the deadline has been missed. Subsequent quiet checks repeat this indefinitely.

**Verified:** a fresh-source host and local HTTP model completed an initial assessment, then a second due check with unchanged sources. There were two recorded checks but only one model call; the second replaced the requested wake reason with `No evidence changed`.

**Fix:** represent agreed deadlines and time-driven wake reasons explicitly, and evaluate them independently of content changes. Preserve content-based suppression for ordinary quiet checks.

### 9. [P2] Monitor message identifiers repeat after daemon restart

[monitor.rs:306](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/monitor.rs:306) allocates message IDs from a process-local atomic counter initialized to one, without seeding from persisted messages. [ApexAgent.tsx:284](/Users/tylercaldwell/Downloads/apex-deck/src/ApexAgent.tsx:284) uses those IDs as React keys.

**Verified:** a fresh-source host harness saved an initial message, restarted in a separate process, and appended another. The persisted IDs were `["message-1", "message-1"]`.

**Fix:** use durable per-conversation allocation or random identifiers. Cover restart followed by both human and assistant messages, including after transcript trimming.

### 10. [P2] Image and video charges are omitted from saved usage totals

[room.rs:746](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-core/src/room.rs:746) records usage only when input or output token counts exist. Media replies can report `cost_micros` without either token count.

**Verified:** a fake participant returned a successful $1 cost-only reply; `room.usage()` remained empty.

**Fix:** record a reply when any usage field exists, including cost, and apply the same condition to compaction accounting.

### 11. [P2] Connected phones do not receive desktop session edits

[PhoneApp.tsx:370](/Users/tylercaldwell/Downloads/apex-deck/src/phone/PhoneApp.tsx:370) loads the session on connection changes. PhoneApp has no `onSessionChanged` subscription, despite the backend exposing that event.

**Failure case:** create, rename, archive, or remove chats/projects on desktop while the phone stays connected. Its list remains stale until reconnect or a phone-originated session update.

**Fix:** subscribe to session changes and reconcile them with local edits through one shared session controller.

### 12. [P2] Editing sources while Save is pending silently loses newer selections

[ApexAgent.tsx:189](/Users/tylercaldwell/Downloads/apex-deck/src/ApexAgent.tsx:189) unconditionally clears dirty source state and installs the saved selections when the response arrives. The selection controls remain enabled during the save.

**Verified:** remove source A, Save, then remove B before the reply. The response restores B and clears the dirty flag.

**Fix:** compare the source edit generation captured at Save against the current generation, preserving later edits, or disable source selection while saving.

### 13. [P2] The advertised DDNS setup does not work in the mobile bridge

[iroh-mobile/lib.rs:422](/Users/tylercaldwell/Downloads/apex-deck/crates/iroh-mobile/src/lib.rs:422) accepts IP socket addresses or relay URLs without resolving hostname hints. The daemon accepts DDNS names, and Settings suggests `myhome.ddns.net:41641`.

**Verified:** the current `target()` implementation rejected that suggested value in both Automatic and DirectOnly modes as an unsupported relay, before relay fallback.

**Fix:** resolve hostname address hints before constructing endpoint addresses, preserving relay fallback if DNS fails in Automatic mode.

### 14. [P2] In-process stdio hosts can copy private secrets into readable snapshots

[checkpoints.rs:203](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/checkpoints.rs:203) force-adds ignored files, including `.env`, into the snapshot store. Store directories use ordinary creation permissions. The `serve` entry point protects its data directory with mode 0700, but [stdio.rs:30](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-daemon/src/stdio.rs:30) and direct `Host::new` do not impose that protection.

**Verified:** under umask 022, a synthetic `.env` with mode 0600 was copied into a snapshot under directories with mode 0755, with its blob readable at mode 0444.

**Impact condition:** other OS users can traverse the parent of an in-process stdio host's data directory, such as a custom shared server path. The daemon's normal `serve` path is protected.

**Fix:** enforce a private data/snapshot directory consistently at every entry point. Consider an explicit policy for snapshotting credential files.

### 15. [P2] Mod process timeouts do not cover stdin delivery

[mods.rs:125](/Users/tylercaldwell/Downloads/apex-deck/crates/apex-host/src/mods.rs:125) awaits stdin delivery before starting the timeout or draining output. A child that does not read stdin, or fills stdout before reading, can block indefinitely.

**Verified:** `/bin/sleep 5` with 1 MiB stdin and `timeoutMs:100` remained blocked until the reproduction's outer 500 ms deadline fired.

**Fix:** start the deadline at spawn and concurrently drive stdin, stdout, stderr, and child exit.

### 16. [P3] Desktop frame size validation misses the terminating chunk

[lines.mjs:27](/Users/tylercaldwell/Downloads/apex-deck/desktop/lines.mjs:27) finishes a line without checking the size of its final segment plus buffered content.

**Verified:** exactly `MAX_LINE` bytes followed by `B\n` delivered a 33,554,433-byte line without rejection. Existing tests only reject overflow before a newline.

**Fix:** enforce the limit on complete lines before concatenation and delivery.

## Architecture and product recommendations

1. **Centralize effective capabilities.** Make observation-only execution, tool permissions, process ownership, and editing ownership explicit runtime contracts. A prompt, model profile, and reservation should agree throughout a turn, including transitions out of Plan mode.
2. **Share lifecycle controllers between desktop and phone.** The desktop already has recovery machinery that the phone bypasses. Extract the room snapshot/event boundary, session synchronization, and connection-attempt ownership into shared controllers; test those integrations with pending requests and late events.
3. **Give monitors a complete project lifecycle.** Removal, relocation, profile changes, and disabling background work should have explicit persisted behavior. One stale monitor should never prevent current monitors from appearing.
4. **Keep ApexAgent's observations honest.** Source IDs, versions, and verbatim quotes establish traceability, not whether an entire claim is true. The current collector reads selected text, saved transcript tails, and git metadata; it does not independently rerun tests or verify completion. Present inferred conclusions accordingly, show coverage gaps, and reserve Done for explicit human decisions or agreed verifiable criteria.
5. **Favor lifecycle integration tests over more helper assertions.** The existing pure-model tests are useful but miss several reproduced component and protocol races. Add the cases above at their actual controller/adapter boundaries.
6. **Expand CI to the shipped feature set.** The daemon workflow currently tests and builds without `--features remote`, excluding pairing/iroh from the normal Linux artifact and CI paths. Include remote-enabled tests, the independent mobile Rust crate, frontend typechecking/build, and a small deterministic Electron smoke path.

The large coordination components deserve attention: `ChatPane.tsx` is about 3,084 lines, `PhoneApp.tsx` about 2,270, and `App.tsx` about 1,695. Extract lifecycle responsibilities around the demonstrated bugs rather than splitting files solely to reduce their size. The main production JavaScript chunk is approximately 804 kB minified; lazy-loading expensive views is a lower-priority performance improvement after correctness work.

## Validation and scope

- JavaScript suite: **970 passed, zero failures**.
- TypeScript and Vite production build: **passed**, with a bundle-size warning.
- Freshly rebuilt Rust workspace with `apex-daemon/remote`: **688 passed, zero failures, one ignored**.
- Real-daemon frontend integration suite against the fresh binary: **12 passed, zero failures**.
- Independent mobile Rust bridge, built in a fresh target directory: **18 passed, zero failures**.
- Clef feed suite: **10 passed**; targeted desktop/PDF/signing suites: **58 passed**. Targeted frontend runs were also successful and overlap the main JavaScript suite.
- Additional reproductions used fake providers, temporary stores, synthetic secrets, local shell children, and local HTTP/protocol fixtures. No paid model requests, live external messages, or real project mutations were performed.

Existing Rust build artifacts disagreed with the current source in a restart probe. Workspace crate artifacts were rebuilt before recording the final Rust results and repeat probes; earlier cached counts were discarded.

Coverage spans core room orchestration, provider adapters, host persistence/checkpoints/terminals/mods, monitoring and evidence collection, daemon authority/transports/pairing, Electron IPC/browser/SSH and packaging, React desktop/widget/attention/routing, phone state/recovery, the Swift/Rust bridge, Clef feed, tests, plans, and CI. The `ios/` app is an explicitly simulated design prototype and was assessed as such. Generated assets and release binaries were not treated as source review targets.

This was a source and automated review. It does not establish live provider compatibility, physical iPhone behavior, actual relay/remote host connectivity, installed-app behavior, or full visual/accessibility correctness. Physical-device and Electron smoke validation remain separate from the passing suites above.

## Follow-up: other local worktrees and the profile picker

After the user supplied Claude's assessment, I inspected the other local checkouts on October 9. The review findings above describe the `main` working tree, not every version available elsewhere on the Mac.

- `/private/tmp/apex-agent-review-fixes` is a clean worktree on `feat/apex-agent`, at `97c5e50` (`Fix ApexAgent monitoring permissions and durable state`). Its source implements targeted fixes for findings 1, 2, and 9: unrestricted monitor reads, a tools-disabled Claude monitoring path, and durable message allocation. That branch restricts monitoring profiles to HTTP text APIs and Claude with tools disabled. Its complete integration into current `main` has not been tested in this review.
- Current `main` also contains adapter/event/client edits absent from that branch. The shared `App.tsx` contents match between these two working trees, but the runtime files differ. Reconciliation should preserve the latest main changes and bring over reviewed fixes individually, with tests for their combined behavior.
- `feat/glass-themes-v4` is an ancestor of `main`, two commits behind it, and its worktree has no uncommitted changes. It does not contain unique branch work to recover.
- [sidecar.mjs:92](/Users/tylercaldwell/Downloads/apex-deck/desktop/sidecar.mjs:92) reuses any daemon answering on the data-folder socket without checking feature compatibility. Different development builds using the default folder can therefore attach to the same daemon. Use separate `APEX_DECK_DATA_DIR` values for dev/test builds and add capability negotiation for incompatible clients. Closing the installed app need not stop its Remote-access LaunchAgent.
- A read-only live probe found the installed app's daemon answering with version `0.5.1` and supporting `monitor_get`. This confirms monitor support on the daemon currently running; it does not prove which older daemon served a previous failing session.
- [ApexAgent.tsx:301](/Users/tylercaldwell/Downloads/apex-deck/src/ApexAgent.tsx:301) has no profile selector in the initial assignment form. The selector is under Settings before assignment, and [ApexAgent.tsx:310](/Users/tylercaldwell/Downloads/apex-deck/src/ApexAgent.tsx:310) shows a read-only profile field afterward. There is no command to change a saved monitor's profile while preserving its history. Add visible selection during setup and an owner-guarded profile-update command that invalidates stale checks.
- Deleting a profile from Agents does not necessarily make the monitor unusable: the monitor persists its own profile copy. Label that state as a saved profile no longer in Agents, rather than implying the configuration is missing. Missing credentials are a separate failure.

No branches were merged, stashes dropped, daemons stopped, or application processes restarted during this follow-up. The mobile test's generated lockfile dependency entries were restored to their original contents.
