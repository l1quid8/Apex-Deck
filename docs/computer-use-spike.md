# Native computer-use spike (Task 2, throwaway)

Status on 2026-10-31: **built and signed; supervised proof pending Accessibility setup and source review.** This is not a production helper, grant/lease system, or evidence that DS4 can complete the task. No live TextEdit input has been sent.

## Artifact and identity

Build only this standalone package with `computer-helper/spike/scripts/build-spike.sh`. It does not build Deck, produce a DMG, or add production dependencies. Runtime artifacts and SwiftPM output are excluded from Git.

Stable bundle: `~/Library/Application Support/Apex Computer Spike/Apex Computer Spike.app`.

MCP command: the absolute path to that bundle's `Contents/Helpers/SpikeMCP`. LaunchServices opens the enclosing app without activation; all AX reads and task input occur inside that app, not in the stdio relay.

Signing identifier `dev.apexdeck.computer.spike`; Developer ID Application: Tyler Caldwell (`75N5HW62JH`), matching Deck's Developer ID team. Build refuses ad-hoc fallback and refuses replacing a running spike executable. `codesign --verify --deep --strict` passes for the app and nested helpers.

Designated requirement:

```
identifier "dev.apexdeck.computer.spike" and anchor apple generic
and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */
and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */
and certificate leaf[subject.OU] = "75N5HW62JH"
```

## Human setup and Stop

1. In System Settings → Privacy & Security → Accessibility, use `+` and select the exact stable `.app` above, then enable it. The agent has not requested a prompt, granted access, reset TCC, or edited permission databases.
2. Run the quoted absolute `Contents/Helpers/SpikeMCP --status` command for actual `accessibilityTrusted`, `listenEventAccess`, and `tapHealthy` booleans. A requested or selected permission is not proof of trust.
3. Recheck listen access after Accessibility changes. Whether this machine needs a separate Input Monitoring grant remains unmeasured. Only if necessary, the Human may enable this exact app in Privacy & Security → Input Monitoring; the agent must not do so itself.
4. Use the **Computer Spike** macOS menu-bar item. **STOP — cancel all input** sets the cancellation latch on the main thread immediately. **Start new isolated run** explicitly clears Stop/cancelled requests and retries a missing tap. Quit/relaunch the same signed bundle if macOS requires a restart after granting access, then recheck status.
5. The app starts stopped. Opening then closing a relay connection, including `--status`, stops the fixture. Establish the persistent proof bot's MCP connection first, then the Human chooses **Start new isolated run** before asking that one bot to act. A subsequent disconnect stops it again. Only the Human menu resets Stop; there is no MCP reset tool.

The main thread never performs an AX tree traversal. JSON reading and matching `notifications/cancelled` handling remain independent of the sequential action worker. EOF/socket loss, app termination, per-action deadlines, and the menu Stop cancel control. This does **not** claim that Deck's own Stop already cancels an MCP call; its turn bridge remains unverified.

## Tools and bounds

Only `request_app`, `read_screen`, `click`, `type_text`, `press_key` are listed. Exactly `com.apple.TextEdit` is accepted as the MCP target. All four control tools truthfully advertise `readOnlyHint:false`; `read_screen` alone advertises true. Ordinary Deck approvals apply.

- `request_app({app})` is the only operation that launches/focuses TextEdit, rejecting ambiguous instances. `read_screen({})` neither launches nor focuses.
- Snapshots use random IDs and retain in-memory process launch identity, AX window/document, focus identity/fingerprint/value/range, and activity epoch. Every control requires the current snapshot. Human input, foreign or secure focus, changed window/document, changed focused control, stopped state, missing/broken tap, or a target-process change refuses further input.
- AX traversal bounds: 500 listed controls, 2,000 visited nodes, depth 20, approximately two seconds aggregate plus one in-flight AX call; individual messaging timeout 0.1 seconds. Children are fetched in chunks of 32. Secure values and foreign-owned subtree content are omitted. Labels/values are capped at 200 characters; output stays below 24,000 UTF-8 bytes plus metadata. Large focused editable values over 4,096 UTF-16 units are refused for typing.
- Click takes a numbered element, preferring live AXPress. Text controls without AXPress require matching identity, enabled state, frontmost target and live hit-test ancestry. There are no arbitrary coordinates in MCP.
- Typing uses one Unicode grapheme per tagged CGEvent down/up pair; at most 256 graphemes and ten seconds per call. It verifies expected text and UTF-16 selection after each cluster before sending the next. Unsupported editable state is a refusal. Error results count delivered clusters and attempt a fresh bounded reading without making it actionable.
- Keys are limited to Cmd-N, Shift-Cmd-T, Cmd-S, Shift-Cmd-G, Return, Escape, Tab and four arrow keys. Key actions and clicks have two-second deadlines. Down/up pairs have no held key spanning an AX wait. Keyup is immediate cleanup of the event just posted.
- No clipboard access, AppleScript save shortcut, filesystem document-write shortcut, screenshots, or production grant bypass exists.

The listen-only global session tap observes mouse and keyboard categories, counts this process's tagged events separately, and invalidates snapshots for every other event. Tap disablement invalidates observations and prevents control. Event tags and process fields are **not** authorization or authenticated hardware-origin evidence. Actual tag survival, keyboard-mask coverage, hardware vs untagged synthetic behavior and permission requirements remain to be measured. Callback work is limited to category/counter/latch updates; no AX reads or content logging occur there.

Private socket directory mode is 0700 and socket mode 0600; one relay connection is admitted. These permissions are not a sandbox or protection from another same-user process. The spike is suitable only for the isolated harmless proof fixture.

## Isolated registration (not performed)

Create one dedicated canonical proof-project path, used as one Work room with exactly one proof bot. Use a unique proof folder and run-numbered filenames; never overwrite an existing Documents file. Document creation and saving must remain native. Its `.mcp.json` owns `mcpServers.apex-computer` with the absolute signed relay command. Add only that canonical project's `enabledMcpjsonServers += ["apex-computer"]` in Claude settings, preserving before-state and other keys. Do not add a global `mcpServers` registration or `enableAllProjectMcpServers`; do not add a second bot. This is project/room isolation, not a per-bot ACL. Ask access and Plan off are required for the proof; normal tool approvals remain in force.

The parent owns the actual registration and fresh signed backend deployment carrying Task 1's redaction. No `.mcp.json`, `~/.claude.json`, shared settings, live bot, or Deck daemon/model process was changed by this implementation.

## Operator diagnostics (not run)

`SpikeMCP --probe-ds4` reads the existing running `local.ds4.app` only. It returns aggregate roles, counts, press-action count, menu-bar presence and truncation. It does not launch, focus, click, send keys, or start/stop DS4's model server. If DS4 is absent, it refuses. No labels or values are persisted.

`SpikeMCP --show-test-dialog` deliberately opens/activates the spike's own one-window synthetic-click test dialog. Do not call until the Human and parent coordinate it. The nested `SpikeEventProbe --untagged-dialog-click`, invoked as an ordinary bot-shell child, posts an untagged down/up at that dialog's recorded button center only while the spike remains frontmost. Record whether its button count changes, then compare with a manual click. This is an exposure test, never authorization. No diagnostic dialog or synthetic probe has been invoked yet.

`SpikeMCP --status` reports only generic permission/state/event-category/probe counts. Stderr contains generic failure codes; neither process logs screen/typed data to disk. Screen data exists in tool responses and transient snapshots, so the parent must verify Task 1 on the actual protected backend before proof and inspect saved step logs afterward.

## Evidence and remaining experiments

Build/signature checks and six pure safety tests pass. The no-permission protocol smoke checks initialization, all five truthful schemas, unknown-method rejection, denied screen reading and invalid control refusals without a valid input request. `npx tsc --noEmit` passes. These checks do not prove native UI behavior.

| Required measurement | Current result |
|---|---|
| App Accessibility trust after signed relaunch | false; no prompt requested |
| Listen access / tap health | false / false before Human grants anything |
| Five DS4 TextEdit/save runs | pending; zero executed, zero passes claimed |
| Exact saved bytes and native Save panel ownership | pending |
| Stop/cancellation during real typing | pending; pure latch semantics tested |
| TextEdit/DS4 AX coverage | pending permission and operator coordination |
| Idle/active app+relay CPU/RSS | idle baseline may be sampled; active pending |
| DS4 tokens/s with/without helper, longest tool gap | pending same-prompt controlled runs |
| Synthetic vs manual click exposure | pending |
| Tagged vs hardware vs untagged events; tap CPU | pending |
| Saved Deck history/diagnostic privacy inspection | pending fresh protected backend and live proof |

DS4 has not finished the experiment. Do not proceed to Task 3/production helper work on the basis of this build.
