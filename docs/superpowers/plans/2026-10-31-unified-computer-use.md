# Unified Computer Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** Revision 5, incorporating Null's revision 4 review and independent implementation preflight. The Human authorized Null to orchestrate implementation until full completion on 2026-10-31. The order remains API privacy, DS4 proof, minimal image path, vision proof, then an evidence gate. Continue without repeated permission requests when proofs pass; failed proofs or required macOS permission grants remain real blockers. No live proof is claimed by this plan.

**Goal:** Give Deck's API, Claude and Codex bots one shared way to see and control Mac apps, including models that cannot read images.

**Architecture:** One small signed helper, Apex Computer, ships inside Deck and is the only thing that touches the screen. Every bot reaches it through a thin stdio MCP server that forwards to the helper's private socket. Deck opens an authenticated session for each bot, and the helper enforces that session's access, the per-app permissions, the desktop lock and Stop itself.

**Tech Stack:** Swift (Accessibility API, ScreenCaptureKit, CGEvent), Rust (`apex-adapters`), React/TypeScript (bot form), electron-builder.

**Spec:** The Design section below is the spec. It carries Jigga's plan from the 2026-10-31 group chat plus Null's five reviews and the implementation preflight.

## Design

### Why a separate helper, not a plain MCP server

Claude and Codex each start their own copy of an MCP server, and Deck's API pool starts another. A plain server would mean several processes that cannot share a lock, and each one's macOS permissions could attach to whichever program launched it. The helper is bundled inside Deck, so there is nothing extra to install.

```
API bot ──────► apex-computer-mcp ─┐
Claude bot ───► apex-computer-mcp ─┼─ private socket ─► Apex Computer.app ─► Mac apps
Codex bot ────► apex-computer-mcp ─┘         ▲          lock, permissions, sessions,
                                             │          Stop, screen access
Deck daemon ── opens and ends sessions ──────┘
```

One long-running helper gives us one lock, one macOS permission identity, and a Stop control that still works if Deck hangs. It sits idle between actions: no polling and no accessibility observers, reading only when a tool is called.

### Changes from the first plan

| First plan | This plan | Source |
|---|---|---|
| Approval card on every click and keystroke | Permission per app, per session | Null |
| No rule for several bots | One bot controls the desktop at a time | Null |
| No Stop control | Visible Stop outside Deck | Null |
| Text-only models promised full use | Allowed, with a reliability notice | Null, confirmed by the Human |
| Done when the tool works | Done when DS4 and a vision API bot finish the same native-app task in running Deck | Null |
| Reading the screen runs freely | Reading an app also needs that app's permission | Jigga: screens show private content |
| Permission cards inside Deck | Native dialog from Apex Computer | Jigga, accepted by Null for version one |
| Bot name from the server, label only | Deck-opened session, enforced by the helper | Null |
| Grant ends when the connection closes | Session bound to thread and bot, ended by Deck | Null |
| Approval skip trusted the server name | Skip identifies the bundled server by its path | Null |
| Element numbers checked against "latest" | Actions carry a snapshot id | Null |
| "Never log" with no mechanism | Redaction before the work feed, saved history and diagnostics | Null |
| No tool opened an app | `request_app` opens and focuses it after permission | Null |
| Stop halted the next action | Stop interrupts typing, lets go of keys and blocks continuation | Null |
| "Regular apps only" | Removed; apps are identified by bundle id | Null: DS4 is a menu-bar agent app |
| Full build, then test | Riskiest promise tested first | Jigga, Null |
| Overhead assumed small | CPU, memory and DS4 speed measured before any claim | Null |
| Screenshot work blocked behind the gate and also required before it | DS4 proof, minimal image path, vision proof, then gate | Null, revision 2 review |
| All redaction in a late task | Basic redaction before any live proof | Null, revision 2 review |
| Signature checked on `open_session` only | All three daemon methods checked; sessions die with their daemon connection | Null, revision 2 review |
| Stop event handled in the adapters | Helper Stop reaches the host's `room_stop` | Null, revision 2 review |
| Lease taken at the first action | Lease taken before the actionable snapshot | Null, revision 2 review |
| Synthetic-click check could guard the dialog | Never used as authorization; input is checked at its real target | Null, revision 2 review |
| Typing checked for cancellation only | Also rechecks the target and human activity | Null, revision 2 review |
| Same lease owner meant the snapshot was still good | The live element is revalidated before every action | Null, revision 3 review |
| Coordinate click allowed after a lease lapse | Returns a fresh reading and clicks nothing | Null, revision 3 review |
| `Sessions::turn` in each adapter's send path | Host `TurnStartHook`, extended and composed with the checkpoint hook | Null, revision 3 review |
| New sessions usable at once | Disabled until a policy update succeeds | Null, revision 3 review |
| Human activity meant an event in the last 2 seconds | Any human event since the observation; the helper's own events don't count | Null, revision 3 review |
| Provider errors left for the final redaction pass | API diagnostics redacted in Task 1, before the live proofs | Null, revision 3 review |

**Why a native dialog:** Deck has separate approval paths for API, Claude and Codex bots, and all of them live outside the program that does the clicking. A dialog owned by the helper covers every path with one piece of code. Version one therefore needs the Human at the Mac to grant an app, and a request with nobody there times out as refused. That is not a permanent limit: phone approval can later relay an authenticated human decision to the same enforcement point.

### Sessions

Different API bots already get separate pools, because each participant creates its own `ToolBox` (`crates/apex-adapters/src/openai.rs:70`). Connections persist across replies, so a connection is the wrong thing to hang a permission on. A session is bound to one thread and one participant.

- **Daemon identity:** All control-plane methods (`open_session`, `begin_turn`, `restrict_turn`, `finish_turn`, `end_session`) check the actual socket peer. The helper reads the peer's audit token (`LOCAL_PEERTOKEN`), resolves it with `SecCodeCopyGuestWithAttributes`, and validates it with `SecCodeCheckValidity` against the signing requirement `identifier "apex-daemon" and anchor apple generic and certificate leaf[subject.OU] = "<team>"`. The caller's own claims and the session token prove nothing here. Only debug builds of the helper may accept an unsigned dev daemon; release builds contain no override.
- **Ownership:** a session belongs to the daemon connection that opened it, and only that connection can update or end it. When the connection dies, the helper revokes all of its sessions at once: in-flight input stops, and grants, leases, snapshots and tokens are cleared. A restarted daemon reconnects, passes the check again and gets fresh tokens. Old tokens never work again, so a shim that outlived the daemon gets refusals.
- **Session versus turn:** `open_session` returns a daemon-owned `SessionId`, disabled by default, with app grants attached to it. It never returns a reusable tool credential. Each actual participant invocation has a new opaque `TurnId`, independent of the Stop generation. `begin_turn(session, turn_id, stop_generation, policy_revision, policy)` atomically revokes any predecessor and returns a fresh per-turn `TurnCapability`. A revoked capability never becomes valid again. Snapshots, actions and events carry exact session and turn identity.
- **Authenticated control plane:** every daemon method, including begin, restrict, finish and end, verifies the socket peer and owning daemon connection. An operation from a dead connection incarnation cannot take effect later. Only tool-plane calls use the bearer capability.
- **Token handoff:** set the per-turn capability with `Command::env` on that child only, never in daemon global environment, arguments, configuration or saved state. Claude gets `${APEX_COMPUTER_TOKEN}` through the injected `--mcp-config`; Codex uses `env_vars`. A nonpersisted immutable turn context accompanies `TurnRequest`, so adapters obtain `token(thread, participant, turn_id)` for the exact invocation. Never look up an unversioned current token. Capability wrapper types have redacted Debug and no Serialize.
- **Persistent API pool:** inject per-turn computer server specs outside the user-config mtime cache. A capability change replaces and tears down the previous connection. Revocation inside the helper is authoritative even if old process cleanup fails. Old shims/background processes cannot regain access in a subsequent turn.
- **Using:** an unauthenticated shim can initialize and list static schemas, but every tool call, including `list_apps`, requires a currently valid capability.
- **Disabled at first:** sessions refuse every read/control call until a successful begin-turn transaction. A failed update leaves no earlier capability usable; run that bot turn without computer tools.
- **Each turn:** ordered paired lifecycle hooks in `ConcurrentRoom::run_one` run after effective write/copy access is final: checkpoint first, computer second. Begin receives participant, unique turn id, effective access, Plan and Stop generation. Register cleanup before awaiting begin. Finish runs on normal completion, provider errors, cancellation, setup exits, future drop/panic and incomplete worker cleanup, before idle/ticket release. Cleanup carries the exact `(session_id, turn_id)` and cannot revoke a newer turn. An async-drop fallback immediately hides local capability and closes its owner connection if exact helper revocation cannot be acknowledged.
- **Cold start and timeout:** the daemon starts/connects to the helper with a separately bounded cold-start deadline before its policy transaction. The two-second deadline applies only over a ready connection. On timeout immediately hide the local capability, revoke the exact pending/active turn in the helper and await acknowledgement. If revocation cannot be confirmed, close the owning daemon connection, invalidating all of its sessions; no best-effort-only end. Connection incarnation and turn identity fence late responses.
- **Stale setup:** Stop generation is separate from turn identity. Stopped/ended sessions reject begin/restrict updates, and delayed setup cannot undo Stop. Events include session/turn incarnation, so old stop/end/finish events cannot disable or forget a new turn.
- **Downgrades:** host notifications immediately restrict the active computer capability when access is lowered or Plan is enabled, even though ordinary tools keep their turn-start policy. Within a turn, monotonic policy revisions may only restrict. This interrupts running input and drops queued actions while keeping app grants. Upgrades wait for a new turn; stale revisions never loosen policy. Talk-only/tools-disabled turns receive no computer capability.
- **Between turns:** `finish_turn(session, turn_id)` permanently revokes that turn capability, its snapshots, lease and queued input, preserving session app grants. Conditional stale finish is a no-op. A retained old token is refused during every later turn.
- **Ending:** Deck calls `end_session` on cancellation, bot removal and thread close. The helper also ends a session after 30 minutes without an action, on Stop, and on daemon disconnect, and tells Deck over the daemon's connection when the daemon is still there. Ending clears its grants, lease and snapshots.
- **Trust limit:** this is not a sandbox. A bot with full shell access runs as the Human's user and can already do a lot without Apex Computer. This design protects against mistakes and instructions planted on screen, not a bot deliberately working around it. Do not describe it as more than that.

### Permission model

- **Grant:** one app, one session. It covers reading and control of that app only, identified by bundle id and resolved to the running process. Display names are never matched, and the dialog shows the bundle id beside the name.
- **Lock:** one session holds a 60-second lease, and each read or action renews it. A second bot gets an immediate "busy" error naming the holder and does not queue, because a queued click would act on a screen that has moved on.
- **Lease before snapshot:** a session allowed to act takes the lease first and then takes the snapshot, in `request_app`, `read_screen` and `get_screenshot`. The snapshot therefore carries the epoch its first click will have. The epoch changes only when a different session takes the lease. A lapse alone doesn't change it, so a slow local model that thinks past 60 seconds can retake the lease and act on its snapshot if nobody else held it in between. The same owner doesn't mean an unchanged screen, so that action still has to pass revalidation below.
- **Read-only sessions:** a read-only or Plan session may read an app it has been granted without taking the lease, including while another bot holds it. Its read never activates the app and never changes another session's lease, epoch or snapshots. Observations are kept per session and marked observation-only permanently, so one can't drive an action even if that session later regains write access.
- **Opening and focusing:** these count as control. In `request_app`, the helper checks access and refuses at once with "busy" if another session holds the lease, so no dialog appears for a request that can't proceed. If needed it then shows the dialog without holding the lease, takes the lease, and only then opens and focuses the app. A read-only or Plan session can get a grant but never opens or focuses anything; if the app isn't running, it gets an error saying so.
- **Revalidation:** the person or the app can scroll, swap controls or change the document without moving the window, so a frame and epoch check isn't enough. Before an action the helper re-reads the live element held by the snapshot. The element must still resolve, in the same process, under the same window and document, with the same role, subrole, identifier, label, enabled state and position in the window, and a hit test at its centre must land on it or inside it. Role and title alone never pass. `type_text` and `press_key` also verify the focused editable value and caret/selection where available, plus the app/window/document identity. The same focused control with a changed value or insertion point is stale. Reacquiring a lapsed lease requires this full revalidation; if required state cannot be observed, act on nothing and return a fresh reading. During typing track the expected value/selection evolution caused by completed helper input, so its own keystrokes do not invalidate themselves. Any unexpected mismatch stops input and returns a fresh reading.
- **Actions with no element:** a coordinate click, or a `scroll` with no element, has nothing to revalidate. After a lease lapse it returns a fresh reading and does nothing, even if the lease was never taken by anyone else.
- **One action at a time:** the helper runs desktop actions in a single serial queue. When ownership changes, every earlier snapshot becomes invalid.
- **Protected, never allowed:** Apex Computer, Apex Deck, System Settings, Keychain Access, Passwords, 1Password, and macOS permission and security prompts such as SecurityAgent. These control the permission system or hold secrets. Task 6 fixes the exact bundle ids and system processes. The list is enforced twice: at the grant, and at the input target of every action, because a prompt can appear over a granted app.
- **Input target check:** before a click, the helper finds the process that actually owns the target. For an accessibility press that is the element's pid; for a `CGEvent` click it is the frontmost window at that point. Before each key event, the frontmost app and the focused element's pid are checked. Any mismatch clicks or types nothing. A synthetic-click heuristic never establishes authorization for anything.
- **Blocked by default:** Terminal and iTerm. The Human can add an exception from the helper's menu. Bots have no tool for this.

### Stop

- Stop lives in a floating pill and the menu bar, both owned by the helper.
- Stop never waits on the action queue. It runs on the main thread and sets a flag that a running action reads, and queued actions are dropped.
- The helper checks that flag before every input event, so Stop interrupts typing part-way.
- Stop releases any held keys and mouse buttons, clears grants and leases, and invalidates snapshots.
- The stopped session stays stopped. Deck is told over the daemon's connection and calls the existing `room_stop(thread, Some(participant))` (`crates/apex-host/src/host.rs:1765`), which already cancels that bot's turn, rejects its approvals and pauses the runner, so `/goal` and `/loop` halt. Only a new Human message can lead to a new session; a runner turn cannot reopen one.

### What a bot sees

| Tool | Needs a grant | Takes | Returns |
|---|---|---|---|
| `list_apps` | No | Nothing | Running and installed app names only, no window titles or contents |
| `request_app` | Shows the dialog if not yet granted | `app` | After permission, takes the lease, opens and focuses the app, then returns a `read_screen` result; or busy, refused or timed out. Read-only and Plan sessions get the grant only |
| `read_screen` | Yes | Nothing | `snapshot` id and numbered controls, such as `12 button "Save"`, including the menu bar and any open sheet |
| `get_screenshot` | Yes | Nothing | `snapshot` id, window id and one picture of the selected granted app window only |
| `click` | Yes | `snapshot`, then `element` or `x`/`y` | Fresh `read_screen` |
| `type_text` | Yes | `snapshot`, `text` | Fresh `read_screen`; refused in password fields; if interrupted, says how many characters were sent |
| `press_key` | Yes | `snapshot`, `key` | Fresh `read_screen` |
| `scroll` | Yes | `snapshot`, `direction`, optional `element` | Fresh `read_screen` |

A snapshot id binds an observation to the session, the app instance, the window and the lease epoch. A control action with a stale, missing or foreign snapshot clicks nothing and returns an error. Each snapshot from `get_screenshot` stores the window's frame and the scale used, so picture coordinates convert to screen points exactly; if the window has moved, the action is refused.

Each session has an explicit active target app/window selected by `request_app`, including grant-only selection in read-only mode. Calling it on an already granted app refocuses it without a dialog, subject to lock/access rules. Grants attach to bundle identity, but each snapshot binds a concrete process instance/start identity and window/document; PID reuse or relaunch invalidates it. Refuse ambiguous duplicate instances. Version one screenshots contain one explicitly identified window, avoiding ambiguous composite coordinates. A system-service save panel is usable only with a verified narrow attachment to that app instance and parent window; otherwise refuse it and report the limitation. Never grant the whole service.

**Human activity:** the helper tags every event it posts with a private `eventSourceUserData` value. A listen-only event tap counts events that lack the tag and come from the hardware, and a snapshot records that count when it's taken. An action is refused with "Paused: the person is using the Mac" if the count has moved since the observation, so earlier interference is caught as well as the last two seconds. Install and verify the tap before producing an actionable observation; keep it continuous, including through lease lapses, while any actionable observation exists. It is removed when none exist. A missing, disabled or restarted tap advances the activity epoch and invalidates old observations. Count foreign/untagged synthetic events conservatively if hardware origin cannot be proved. If the tap can't be installed, or macOS disables it, the helper counts that as human activity and refuses. Accessibility presses post no event, so they need no tag.

Typing rechecks the target and human activity before each key event, as well as Stop. If the Human starts using the Mac, or focus leaves the app or moves to a password field, typing halts, the reply says how many characters were sent, and the snapshot becomes invalid so the bot must read again before continuing.

### Privacy

- Screen text, screenshots and typed text must not reach Deck's work feed, saved history or diagnostics. Today `Turn::run` copies a tool's output into its work step (`crates/apex-adapters/src/api_tools/mod.rs:377`), and tool arguments reach the label and approval paths.
- Redaction happens before those points. A work step shows only "Read TextEdit" or "Typed 14 characters in TextEdit".
- The API path is redacted in Task 1, before any live proof touches a real screen. That includes diagnostics: a provider can echo the request back in an error body, and today up to 300 characters of it reach the reported error (`crates/apex-adapters/src/openai.rs:421`), with similar text at the tools-refused log line (`:407`) and the stream error (`:590`). While a request carries computer content, those places keep the URL, status and hint and drop the provider's text.
- Task 9 extends this to Claude and Codex before their first real screen call, including any Task 8 probe.
- **What this cannot cover:** the model still receives the content, so cloud models send it to their provider. Claude and Codex keep their own transcripts of what they saw. A bot can repeat screen content in its reply. The setup screen and docs must say so plainly.

### Model support

The Human confirmed that text-only models stay allowed, with this notice:

> This model can't read screenshots and relies on accessibility text. Some controls may be missing or interpreted incorrectly, making computer use less reliable.

Deck has no record today of which API models can read images. This plan adds a bot setting, off by default. If it's off, the bot still gets `read_screen`, and `get_screenshot` is refused with the notice.

Coverage varies by app for every model: some interfaces expose no usable accessibility actions.

## Global Constraints

- The MCP server name is `apex-computer`. It must not reuse `computer-use`, which is Codex's plugin.
- Tool names are exactly the eight in the Design table.
- The notice text is copied verbatim from the Design section.
- The feature is macOS only. Linux and Windows hosts, including the VPS, must not list the server.
- Never read, write or restore the real clipboard, including in tests. `type_text` uses key events or the accessibility value.
- Screenshots capture the granted app's windows, never the whole screen.
- Never log typed text, screen text, screenshots or session tokens.
- Session tokens never appear in command-line arguments, config files, saved state or the daemon's own environment.
- Do not claim low overhead without the Task 2 measurements.
- Sign Apex Computer with the same Developer ID as Deck, and do not ad-hoc sign it. An ad-hoc signature resets macOS permissions on every build.
- Accessibility is required. Screen Recording is requested only on first `get_screenshot`.
- First version covers API, Claude and Codex bots. Gemini, Grok and Muse bots do not get the server until their approval paths are checked.
- Run `npx tsc --noEmit` before any merge.
- Create the branch from `main` with `git switch -c feat/unified-computer-use`, after checking `git status`.

## Review Focus

1. A bot acts while the Human is typing or moving the mouse: the action pauses and returns "Paused: the person is using the Mac" rather than fighting for the cursor, including part-way through typing. Test in Tasks 5 and 7.
2. Text on screen tells the bot to open another app or approve something: the grant still limits it to the granted app, and the input target check refuses anything landing on the dialog or a system prompt. Test in Tasks 5 and 7.
3. The granted app quits, crashes or moves its window between read and click: the action returns an error and clicks nothing. Test in Task 7.
4. A huge app, such as a long Mail list, produces a giant element list: `read_screen` cuts off at 500 controls and says so. Test in Task 6.
5. A long API run piles up screenshots: only the latest two stay in the request, and older ones become a text placeholder. Test in Task 3.
6. A reply makes several tool calls and one returns a picture: every `role: tool` reply is appended before the picture message, or strict servers reject the request. Test in Task 3.
7. A shell-capable bot runs the shim itself or sends a made-up bot name: without Deck's token it gets no session. Test in Task 5.
8. Stop lands during a long `type_text`, or a `/goal` run is active: typing halts mid-string, no key stays held, and the bot does not continue. Test in Tasks 7, 8 and 11.
9. Codex renames the server's tools: the approval skip still matches the bundled server, and a look-alike server does not. Test in Task 8.
10. The daemon restarts while the helper and a shim keep running: the old token is refused and the new daemon gets a fresh one. Test in Tasks 5 and 8.
11. A slow model thinks past the 60-second lease: if nobody else took it, an action on an unchanged element works and a coordinate click returns a fresh reading without clicking; if someone did, the snapshot is refused. Test in Tasks 5 and 7.
12. A bot reads on a read-only turn while another bot holds the lease: the read works, the snapshot can't act, and the holder's epoch is unchanged. Test in Task 5.
13. The screen changes under an unchanged window, such as a scrolled list or a new document: the old element fails revalidation and nothing is clicked. Test in Task 7.
14. The Human touched the Mac after the observation but stopped before the action: the action is still refused, and the helper's own events never trigger this. Test in Tasks 5 and 7.
15. Stop lands while turn setup is waiting on the helper: the late update is ignored and the session stays stopped. Test in Tasks 5 and 8.
16. A provider error echoes screen text: the reported error and the log hold no screen text. Test in Task 1.

---

### Task 1: Basic redaction on the API path

**Purpose:** The proofs put real screen content through Deck's API path, so API work/approval/history and provider diagnostic redaction come first. Minimum CLI redaction must likewise precede any real CLI screen calls; Task 9 completes that audit.

**Files:**
- Modify: `crates/apex-adapters/src/mcp.rs`, `crates/apex-adapters/src/api_tools/mod.rs:355,654`, `crates/apex-adapters/src/openai.rs:407,421,590`

**Interfaces:**
- Produces: `crate::mcp::is_computer_server(name: &str) -> bool`, true for `apex-computer`; `crate::mcp::redacted_step(tool: &str, arguments: &Value) -> RedactedStep`, a label with no content and no output.

Matching by name is safe here because a wrong match only hides more. It never skips an approval: only `helper_gated` in Task 8 can do that, using the trusted bundled server. Task 9 carries the same conservative privacy behavior to CLI paths. Approval bypass and content privacy remain separate decisions.

- [ ] **Step 1: Write failing tests:** `read_screen_output_never_reaches_the_work_step`, `typed_text_never_reaches_the_label_or_arguments`, `typed_text_never_reaches_the_approval_action`, `saved_history_has_no_screen_text`, `the_model_still_receives_the_full_result`, `other_servers_keep_their_output`, `provider_error_echoing_screen_text_is_not_reported`, `tools_refused_log_has_no_provider_text_with_computer_content`, `stream_error_has_no_provider_text_with_computer_content`, `provider_errors_keep_their_text_without_computer_content`.
- [ ] **Step 2: Run** `cargo test -p apex-adapters --lib`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `Turn::mcp`, build the step from `redacted_step` instead of `args.to_string()`. In `Turn::run`, skip copying output into the step, and use the redacted text in the approval action, for this server. In `openai.rs`, track whether the request carries computer content, and leave the provider's text out of the three diagnostics when it does.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep screen content out of API bot work steps`.

### Task 2: Rough proof with DS4

**Purpose:** The main promise, that a model that can't see can use a Mac app from a text list, is untested. Find out before building the rest. This code is throwaway and is not for regular use.

**Files:**
- Create: `computer-helper/spike/` (a single Swift stdio MCP server, deleted in Task 5)
- Create: `docs/computer-use-spike.md`

**Interfaces:**
- Consumes: Task 1's redaction. The spike registers as `apex-computer` so that redaction applies.
- Produces: temporary tools `request_app`, `read_screen`, `click`, `type_text`, `press_key`, with bundle id `com.apple.TextEdit` hard-coded as the only target. `request_app` launches and focuses TextEdit with no dialog. There is no production grant/lease system, so use only harmless isolated fixtures. Even this spike checks the real target pid, focused control and secure/protected surfaces before each bounded input event, and has a directly reachable cancellation flag. Watching alone does not establish target safety. It is never added to the shared config; it is registered for the test bot only. It gets no approval skip, so Deck's normal approval rules apply during the proof.

- [ ] **Step 1: Build** the tools with the same accessibility calls Task 6 will use, and sign the spike so Accessibility permission holds between runs.
- [ ] **Step 2: Run DS4 in Deck's dev build** on: "Open TextEdit, make a new plain-text document, type `Apex computer test DS4`, and save it as `~/Documents/apex-computer-DS4.txt`." Repeat five times. Record passes, steps taken and what failed. Note whether the Save sheet appears in the accessibility list, and whether it belongs to TextEdit or a separate system service. Confirm from the saved step log that no screen text or typed text was recorded.
- [ ] **Step 3: Measure.** Record the helper's idle and active CPU and memory, plus DS4's tokens per second on the same prompt with and without the helper running. Also record DS4's longest gap between tool calls, to test the 60-second lease.
- [ ] **Step 4: Measure the synthetic-click risk.** Build a one-window test dialog. Post a `CGEvent` click at its button from an ordinary child process of a bot's shell, and also click it by hand. Record whether the posted click presses the button. This only measures exposure. No field it finds may be used as authorization.
- [ ] **Step 5: Probe human-event tracking.** Install a listen-only tap, post tagged events, and move the mouse by hand. Record whether the tag survives, whether hardware events can be told from untagged events posted by a bot's shell, and whether the tap needs Input Monitoring on top of Accessibility. A new permission goes back to the Human before Task 5. Also record the tap's idle CPU.
- [ ] **Step 6: Probe app coverage.** Dump the accessibility tree for TextEdit and for DS4, the real native target established in the conversation, unless the Human supplies another target. Do not start/stop its server in this coverage probe. Record how many controls are usable.
- [ ] **Step 7: Record** all results in `docs/computer-use-spike.md` and commit `docs: record computer use spike`.
- [ ] **Step 8: Report the DS4 result** in the chat. If DS4 never finished the task, stop here and bring it to the Human and Null instead of starting Task 3.

### Task 3: Screenshots reach API bots

**Purpose:** This is the minimal production image path. It's real code, kept after the gate, because the vision proof needs it.

**Files:**
- Modify: `crates/apex-adapters/src/api_tools/mcp_client.rs:155,162`, `crates/apex-adapters/src/api_tools/mod.rs:355,706,727`, `crates/apex-adapters/src/openai.rs:473`, `crates/apex-core/src/types.rs:117`

**Interfaces:**
- Consumes: MCP `image` blocks from the trusted server, `is_computer_server`.
- Produces: `CallResult.images: Vec<ToolImage>`; `Done.images`; `Turn::run` returns `ToolReply { text, images }`; `ToolImage { mime: String, data: String }`; `ParticipantConfig.can_read_images: bool`, `#[serde(default)]`.

The internal types are general, but forwarding stays limited to `apex-computer` in this version.

- [ ] **Step 1: Write failing tests:** `image_blocks_are_kept_with_the_text`, `tool_message_stays_text_and_image_follows_as_user_message`, `all_tool_replies_come_before_the_image_message`, `only_the_latest_two_tool_images_stay_in_the_request`, `oversized_image_is_dropped_with_a_note`, `bot_without_can_read_images_gets_no_image_and_the_notice`, `images_from_other_servers_stay_text_stubs`, `images_never_reach_the_work_step`, `old_config_without_the_field_loads`.
- [ ] **Step 2: Run** `cargo test -p apex-adapters --lib`. Expected: FAIL.
- [ ] **Step 3: Implement.** `content_text` keeps its current output, and `call` also collects images. Carry them through `Done` and `Turn::run`. In `openai.rs`, append every `role: tool` reply for the round first, then push one `role: user` message with `image_url` parts, because many OpenAI-style servers reject images in tool messages. Refuse a single image over 5 MB.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: pass computer screenshots to vision API bots`.

### Task 4: Vision bot proof and go/no-go gate

**Files:**
- Modify: `computer-helper/spike/` (adds `get_screenshot`), `docs/computer-use-spike.md`

- [ ] **Step 1: Add** a TextEdit-only `get_screenshot` to the spike.
- [ ] **Step 2: Run one vision API bot** five times on the Task 2 task, confirming it can name something visible only in the picture. The bot needs `can_read_images` set by hand in its saved config, because the form comes in Task 10.
- [ ] **Step 3: Gate.** Stop and report to the Human and Null with the numbers. The Human's full-completion request authorizes proceeding to Task 5 if both proofs pass. Record the actual files, calls, five outcomes, measurements and limitations. Missing/failed proof is not permission to declare success: fix it first or report the concrete blocker. If DS4 cannot do the task reliably, improve the design before continuing.

### Task 5: Helper, sessions, grants and Stop

**Files:**
- Create: `computer-helper/Package.swift`, `computer-helper/Sources/ComputerCore/Socket.swift`, `Lease.swift`, `Sessions.swift`, `Grants.swift`, `HumanInput.swift`, `ActionQueue.swift`, `StopSignal.swift`, `computer-helper/Sources/ApexComputer/main.swift`, `PeerCheck.swift`, `GrantDialog.swift`, `StopPill.swift`, `computer-helper/Sources/apex-computer-mcp/main.swift`
- Delete: `computer-helper/spike/`
- Test: `computer-helper/Tests/ComputerCoreTests/LeaseTests.swift`, `SessionsTests.swift`, `GrantsTests.swift`, `ActionQueueTests.swift`

**Interfaces:**
- Produces: socket at `~/Library/Application Support/Apex Computer/control.sock`, folder mode 0700, one JSON request per line. Daemon methods, all verified against the real peer and owning connection: `open_session(thread, participant, bot_name) -> SessionId` disabled by default; `begin_turn(session, turn_id, stop_generation, policy_revision, policy) -> TurnCapability`; `restrict_turn(session, turn_id, revision, policy)`; `finish_turn(session, turn_id)`; `end_session(session)`. App grants are session-scoped, capabilities/snapshots/queued input are turn-scoped. Session/turn incarnation accompanies helper events. Helper-to-daemon events on the same connection: `session_stopped(thread, participant, session_id, turn_id)`, `session_ended(thread, participant, session_id, turn_id)`. `PeerVerifier.verify(auditToken) -> Bool`, a protocol so core tests can substitute it. `Lease.acquire(session: String, now: Date) -> LeaseResult` (`.held(epoch)`, `.busy(holder: String)`), with the epoch changing only on a different owner. `Grants.check(session: String, bundleId: String, now: Date) -> GrantState` (`.granted`, `.notGranted`, `.protected`, `.blocked`, `.expired`). `Grants.stopAll()`. `StopSignal`, an atomic flag per action. `HumanInput.count() -> UInt64`, hardware events without the helper's tag, and `HumanInput.changedSince(count: UInt64) -> Bool`, true also when the tap is missing or was disabled.

- [ ] **Step 1: Write failing tests:** `second_bot_gets_busy_with_holder_name`, `lease_lapses_after_60_seconds`, `action_renews_lease`, `read_renews_lease`, `reading_takes_the_lease_before_the_snapshot`, `first_click_after_a_read_keeps_its_epoch`, `same_owner_after_a_lapse_keeps_its_epoch`, `new_owner_changes_the_epoch`, `owner_change_invalidates_snapshots`, `read_only_read_takes_no_lease`, `read_only_read_works_while_another_bot_holds_the_lease`, `read_only_snapshot_cannot_act`, `read_only_request_app_does_not_open_or_focus`, `busy_request_app_shows_no_dialog_and_does_not_focus`, `unverified_peer_cannot_open_a_session`, `unverified_peer_cannot_update_a_session`, `unverified_peer_cannot_end_a_session`, `another_daemon_connection_cannot_change_a_session`, `daemon_disconnect_revokes_its_sessions`, `old_token_is_refused_after_daemon_restart`, `restarted_daemon_gets_fresh_tokens`, `shim_without_a_token_gets_no_session`, `shim_reconnect_keeps_session_while_the_daemon_stays_connected`, `read_only_session_refuses_control`, `plan_session_refuses_control`, `end_session_clears_grants_and_lease`, `grant_covers_one_app_only`, `grant_expires_after_30_idle_minutes`, `stop_clears_every_grant_and_lease`, `stopped_session_stays_stopped`, `stop_does_not_wait_for_a_running_action`, `stop_drops_queued_actions`, `protected_app_is_refused_even_with_an_exception`, `terminal_needs_a_human_exception`, `agent_app_can_be_granted`, `human_input_since_the_observation_pauses`, `human_input_that_already_ended_still_pauses`, `the_helpers_own_events_do_not_count_as_human`, `missing_event_tap_counts_as_human_input`, `new_session_is_disabled`, `disabled_session_refuses_reads_and_control`, `first_policy_update_enables_the_session`, `session_is_disabled_between_turns`, `access_downgrade_interrupts_running_input`, `plan_turn_interrupts_running_input`, `downgrade_keeps_grants`, `older_generation_update_is_ignored`, `late_update_cannot_undo_stop`, `read_only_read_does_not_activate_the_app`, `read_only_read_does_not_renew_the_holders_lease`, `read_only_read_leaves_the_holders_snapshots_valid`, `observations_are_kept_per_session`, `read_only_snapshot_stays_observation_only_after_access_returns`, `actions_run_one_at_a_time`, `capability_is_unique_per_turn`, `old_worker_cannot_read_or_act_during_next_turn`, `stale_finish_cannot_disable_current_turn`, `late_begin_after_timeout_is_fenced`, `unacknowledged_revoke_closes_owner_connection`, `all_control_methods_require_verified_owner`, `stale_event_cannot_end_new_session`, `tap_is_ready_before_actionable_snapshot`, `tap_restart_invalidates_previous_observations`.
- [ ] **Step 2: Run** `swift test --package-path computer-helper`. Expected: FAIL.
- [ ] **Step 3: Implement** the socket, sessions, lease, grants, stop signal, human event tap and serial queue, plus a menu-bar-only app (`LSUIElement`). `PeerCheck.swift` holds the real `SecCode` requirement check, and the requirement's Team ID comes from the helper's own signature. The daemon owns cold helper startup before any policy transaction. The shim reports unavailable if no authorized session exists, and answers `initialize` and `tools/list` itself. Control tools carry `readOnlyHint: false`.
- [ ] **Step 4: Implement the dialog** ("Allow <bot> to see and control <app> for this session?") with a 60-second timeout that counts as refused, and the Stop pill and menu-bar item. The bot name comes from Deck's session. The dialog's process is protected, so the helper's own input tools can't reach it. If Task 2 Step 4 showed a bot's child process can press it, bring that to the Human before continuing.
- [ ] **Step 5: Run tests.** Expected: PASS.
- [ ] **Step 6: Stdio check.** Send `initialize` and `tools/list` to the shim. Expected: eight tools, and a second shim shares the same helper process.
- [ ] **Step 7: Live identity check.** With the real signed daemon, open a session. Confirm an ad-hoc-signed copy of a caller is refused on all five control-plane methods. Kill the daemon, confirm the surviving shim is refused, restart it, and confirm a fresh token works.
- [ ] **Step 8: Commit** `feat: add Apex Computer helper, sessions and Stop`.

### Task 6: Read tools and opening apps

**Files:**
- Create: `computer-helper/Sources/ComputerCore/ElementList.swift`, `Snapshot.swift`, `ProtectedApps.swift`, `computer-helper/Sources/ApexComputer/Accessibility.swift`, `Screenshot.swift`, `AppLauncher.swift`
- Test: `computer-helper/Tests/ComputerCoreTests/ElementListTests.swift`, `SnapshotTests.swift`, `ProtectedAppsTests.swift`

**Interfaces:**
- Consumes: `Grants.check`, `Lease.acquire`.
- Produces: `ElementList.render(nodes: [Node], limit: Int) -> RenderedList`, `limit` 500. `Snapshot { id, session, turnId, processInstance, windowId, epoch, actionable, humanCount, windowFingerprint, focusedState?, elements, frame?, scale? }`, where `elements` holds the live element and its fingerprint for each number, in memory only. `LiveElement`, a protocol so core tests can substitute the accessibility calls. `Snapshot.toScreen(x: Double, y: Double, current: Frame) -> Point?`, `nil` if the window moved. `ProtectedApps.contains(bundleId: String) -> Bool`, including system prompt processes.

- [ ] **Step 1: Write failing tests:** `numbers_controls_in_reading_order`, `password_field_value_is_never_rendered`, `list_cuts_off_at_500_and_says_how_many_were_left_out`, `empty_tree_explains_the_app_exposes_no_controls`, `menu_bar_and_open_sheet_are_listed`, `picture_coordinates_convert_with_scale`, `moved_window_returns_no_point`, `snapshot_stores_a_fingerprint_for_each_element`, `fingerprint_has_no_screen_text_outside_memory`, `display_name_match_is_not_protection`, `system_prompt_processes_are_protected`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `list_apps`, `request_app`, `read_screen` and `get_screenshot`, following the lease order in the Design section. `read_screen` uses `AXUIElementCopyAttributeValue` on the granted app's focused window and menu bar. `get_screenshot` uses ScreenCaptureKit limited to one explicitly identified granted app window, longest side 1568 pixels, JPEG, returned as an MCP `image` block. If Task 2 finds a service-owned save panel, allow it only with a narrow verified parent-app/window attachment rechecked for reads, images and input; otherwise refuse with a known limitation. Never allow an entire service process. Missing Accessibility or Screen Recording permission returns a plain instruction naming the setting.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Manual check.** Grant TextEdit, run the tools, and confirm the screenshot shows only TextEdit with another window overlapping it, and that a Save sheet is both listed and pictured.
- [ ] **Step 6: Commit** `feat: open apps and read their controls and windows`.

### Task 7: Control tools

**Files:**
- Create: `computer-helper/Sources/ComputerCore/ActionGuard.swift`, `computer-helper/Sources/ApexComputer/Input.swift`, `InputTarget.swift`
- Test: `computer-helper/Tests/ComputerCoreTests/ActionGuardTests.swift`

**Interfaces:**
- Consumes: `Lease.acquire`, `Grants.check`, `HumanInput.changedSince`, `Snapshot`, `LiveElement`, `ProtectedApps`, `StopSignal`, the serial queue.
- Produces: `ActionGuard.allow(request: ActionRequest, state: GuardState) -> GuardResult`, run before every control action in the order: stop signal, session enabled and access, grant, lease and epoch, human input since the observation, app still running, snapshot, live element revalidation, input target. `ActionGuard.continueTyping(state: GuardState) -> TypingResult`, run before every key event. `InputTarget.owner(point: Point) -> pid_t` and `InputTarget.focused() -> FocusedState`, including process/window/document/AX identity, secure state, editable value and selection/caret when available. These values stay in memory. Per-event guards compare the expected evolution of helper input as well as the original observation.

- [ ] **Step 1: Write failing tests:** `stale_snapshot_clicks_nothing`, `missing_snapshot_is_refused`, `same_owner_with_a_replaced_element_clicks_nothing`, `same_role_and_title_on_a_new_element_clicks_nothing`, `scrolled_element_clicks_nothing`, `covered_element_clicks_nothing`, `disabled_element_clicks_nothing`, `changed_document_clicks_nothing`, `unchanged_element_after_a_lapse_still_works`, `coordinate_click_after_a_lapse_returns_a_reading_and_clicks_nothing`, `scroll_with_no_element_after_a_lapse_does_nothing`, `changed_focus_refuses_typing_after_a_lapse`, `human_input_after_the_observation_refuses_the_action`, `another_sessions_snapshot_is_refused`, `observation_only_snapshot_is_refused`, `coordinates_outside_the_granted_window_are_refused`, `click_landing_on_another_process_is_refused`, `click_on_a_permission_prompt_is_refused`, `app_that_quit_returns_error`, `other_app_in_front_is_refused`, `typing_into_password_field_is_refused`, `key_shortcut_quitting_a_blocked_app_is_refused`, `cancel_between_characters_stops_typing`, `typing_halts_when_the_person_uses_the_mac`, `typing_halts_when_focus_leaves_the_app`, `typing_halts_when_focus_moves_to_a_password_field`, `interrupted_typing_reports_characters_sent`, `interrupted_typing_invalidates_the_snapshot`, `stop_releases_held_keys_and_buttons`, `changed_value_refuses_typing`, `changed_caret_or_selection_refuses_typing`, `unobservable_required_edit_state_refuses_typing`, `own_typing_matches_expected_state`, `service_sheet_without_attachment_is_refused`, `service_sheet_attachment_is_rechecked`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the guard, the input target check and the four tools. `click` prefers `AXUIElementPerformAction` with `kAXPressAction`, then falls back to `CGEvent` at the element's centre. `type_text` sends key events one character at a time, calling `continueTyping` before each. Each action returns a fresh `read_screen`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Manual check.** Mid-way through a long `type_text`, move the mouse, switch apps and press Stop, one run each. Confirm each halts at once and reports correctly, and that Stop responds while an action is running. Then read a long list, scroll it by hand, wait for the mouse to settle and have the bot click an old element: nothing should be clicked.
- [ ] **Step 6: Commit** `feat: control the granted app`.

### Task 8: Connect the bots and the host

**Files:**
- Modify: `crates/apex-core/src/concurrent.rs:96,150,715`, `crates/apex-core/tests/concurrent.rs`, `crates/apex-host/src/bot_copies.rs:2308`, `electron-builder.yml:29`, `scripts/package-mac.mjs`, `crates/apex-adapters/src/lib.rs:86,178`, `crates/apex-adapters/src/mcp.rs`, `crates/apex-adapters/src/api_tools/mcp_client.rs:111,240,523`, `crates/apex-adapters/src/api_tools/mod.rs:691`, `crates/apex-adapters/src/claude_session.rs:316`, `crates/apex-adapters/src/codex_hook.rs`, `crates/apex-adapters/src/codex_server.rs:835,1099`, `crates/apex-adapters/src/cli.rs:246`, `crates/apex-host/src/host.rs:210,1055,1115,1765,2011,2029,2254,2572,2606`
- Create: `crates/apex-adapters/src/computer.rs`

**Interfaces:**
- Produces: `apex_core::TurnStart { participant, turn_id, access, plan, stop_generation }`, nonpersisted immutable `TurnRequest` turn context, and ordered paired `TurnLifecycleHook::{before_turn,after_turn}`. Register completion cleanup before awaiting setup; keep the existing checkpoint hook first. `crate::computer::Sessions`, one per daemon, holding the verified helper connection, with `turn(thread, participant, bot_name, turn_id, access, plan, stop_generation) -> Result<()>`, `token(thread, participant, turn_id) -> Option<TurnCapability>`, `turn_ended(thread, participant, turn_id)`, `restrict_active(thread, participant, policy)`, `end(thread, participant)`, `allow_new_session(thread, participant)`, and a channel of `ComputerEvent::{Stopped, Ended}`. `BuildContext.computer: Option<ComputerContext { sessions: Arc<Sessions>, thread: String }>`, set by the host at `host.rs:1055`. `TrustedComputerRegistration`, immutable host-owned provenance of the exact injected bundled command and effective CLI config, carried through Claude and both Codex approval paths; `helper_gated(server, registration) -> bool` checks normalized identity against that registration. Tool arguments, MCP metadata and arbitrary config lookup cannot establish trust. Fail closed until injected precedence is verified. `crate::mcp::computer_spec(token: &Token) -> Option<ServerSpec>`, `Some` only on macOS when the bundled shim exists.

`BuildContext` is built per room and shared by its bots, so it carries the thread and the shared `Sessions`, never a token. Capabilities are per actual participant invocation, never per persistent participant alone. A `ComputerTurnLifecycle` hook in `apex-host` starts and finishes exact turns. Adapters forward the capability for their immutable invocation context. A mutable participant-only current-token lookup is forbidden.

Three things about the current hook seam:
- `ConcurrentRoom` holds one hook; extend this to ordered lifecycle hooks: checkpoint first, then computer. Paired cleanup covers all exits and future drop; revoke authority before idle/ticket release, even when worker cleanup is incomplete.
- `host.rs:1116` installs the checkpoint hook only for rooms with a folder. The computer hook must be installed outside that `if`, or a no-folder room would never get a session.
- A failed setup leaves the bot turn running without these tools. Bound cold start separately; apply a two-second limit to ready-connection policy setup. On timeout revoke the exact turn inside the helper; without acknowledgement close the owning connection. Effective access is `request.access`, falling back to configured access. Talk-only/tools-disabled turns get no capability. Host access-lowering/Plan-on paths immediately restrict any active computer turn.

- [ ] **Step 1: Write failing tests:** `helper_gated_tools_skip_deck_approval`, `same_name_with_another_command_is_not_gated`, `codex_normalized_name_is_gated`, `config_entry_named_apex_computer_is_ignored`, `spec_is_absent_off_macos`, `session_token_is_not_in_arguments`, `session_token_is_not_in_the_daemon_environment`, `each_child_gets_its_own_token`, `turn_start_hook_gets_final_access_plan_and_generation`, `hooks_run_in_order_checkpoint_then_computer`, `no_folder_room_gets_the_computer_hook`, `plan_turn_updates_the_session`, `read_only_turn_from_the_write_slot_updates_the_session`, `failed_update_drops_the_token`, `hung_helper_times_out_and_the_turn_continues`, `stop_during_the_hook_stops_the_turn_and_keeps_the_session_stopped`, `turn_end_disables_the_session`, `api_pool_reconnects_when_the_token_changes`, `room_stop_ends_the_session`, `participant_removal_ends_the_session`, `chat_participant_removal_ends_the_session`, `room_close_ends_the_session`, `room_delete_ends_the_session`, `helper_stop_calls_room_stop_for_that_participant`, `helper_stop_pauses_goal_and_loop`, `runner_turn_cannot_reopen_a_stopped_session`, `human_message_allows_a_new_session`, `helper_loss_clears_sessions_and_the_next_turn_opens_fresh`, `gemini_grok_and_muse_do_not_get_the_server`, `turn_id_changes_without_stop`, `finish_hook_runs_on_all_setup_and_participant_exits`, `future_drop_revokes_capability`, `stale_finish_cannot_disable_newer_turn`, `adapter_token_lookup_requires_exact_turn`, `timeout_late_reply_cannot_enable_turn`, `revoke_failure_disconnects_owner`, `cold_start_has_separate_deadline`, `live_access_reduction_interrupts_input`, `plan_on_restricts_current_capability`, `talk_only_turn_gets_no_capability`, `cli_registration_provenance_survives_clone_and_fallback`.
- [ ] **Step 2: Run** `cargo test -p apex-core`, `cargo test -p apex-adapters --lib mcp` and `cargo test -p apex-host --lib computer`. Expected: FAIL.
- [ ] **Step 3: Bundle** `Apex Computer.app` under `Contents/Resources/computer/`, signed with Deck's Developer ID, and build it in `_desktop:package`.
- [ ] **Step 4: Register the server.** Add `computer_spec(&exact_turn_capability)` after user entries, removing any config entry with the reserved name. Set `APEX_COMPUTER_TOKEN` with `Command::env` on each spawned child only (`cli.rs:246`, `codex_server.rs:1099`, `mcp_client.rs:240`). Inject the server into Claude with `--mcp-config` and `${APEX_COMPUTER_TOKEN}`, and into Codex with `-c mcp_servers.apex-computer.*` and `env_vars`. Use the injected definition even if the user defines the same name; verify precedence on each CLI before relying on it.
- [ ] **Step 5: Wire the host.** Install ordered paired `TurnLifecycleHook::{before_turn,after_turn}` and update the existing checkpoint implementer. Create one `Sessions` on the host, put `ComputerContext` in `BuildContext`, and install `ComputerTurnLifecycle` with paired exact-turn cleanup for every room with a supported bot. Call `Sessions::turn_ended` with the exact turn id on every completion/cancellation/setup exit, including drop fallback. Add active restriction notifications before access-lowering or Plan-on settings operations return; never upgrade an active turn. Call `end` in `room_remove_participant`, `chat_remove_participant`, the retiring branch of `room_close`, `room_delete` and `room_delete_owned`, and in `room_stop`, for one bot or for every bot in the thread. Run a task on `ComputerEvent`: `Stopped` calls `room_stop(thread, Some(participant))` and blocks reopening only if its session/turn identity still matches; matching `Ended` forgets that exact capability. Stale events are no-ops. Only the host's Human-message path calls `allow_new_session`.
- [ ] **Step 6: Wire the adapters.** Each send path reads `Sessions::token` and passes it to the child or the API pool. No token means the server's calls are refused, and the bot still runs. The pool replaces its `apex-computer` connection when the token changes. Reconnect to the helper with backoff, and treat a lost connection as ended sessions.
- [ ] **Step 7: Skip Deck approval** in the three paths through `helper_gated`, because the helper enforces grants, access and Plan itself.
- [ ] **Step 8: Live token forwarding.** First use no-screen authenticated handshakes; apply Task 9 minimum CLI redaction before any actual screen call. Run one real Claude and one real Codex turn in the dev build. Confirm the shim received the token and got a session, and that the token doesn't appear in `ps` output or either CLI's config files.
- [ ] **Step 9: Run** `cargo test -p apex-core`, `cargo test -p apex-adapters --lib` and `cargo test -p apex-host --lib`. Expected: PASS.
- [ ] **Step 10: Commit** `feat: give API, Claude and Codex bots Apex Computer`.

### Task 9: Finish redaction

**Files:**
- Modify: `crates/apex-adapters/src/mcp.rs`, `crates/apex-adapters/src/api_tools/mod.rs:355,654,697`, `crates/apex-adapters/src/claude_session.rs`, `crates/apex-adapters/src/codex_server.rs`, the Claude and Codex work-step parsers

**Interfaces:**
- Consumes: `helper_gated`, `redacted_step`.

- [ ] **Step 1: Write failing tests:** `claude_step_is_redacted`, `codex_step_is_redacted`, `claude_approval_detail_is_redacted`, `codex_approval_detail_is_redacted`, `api_redaction_uses_helper_gated`, `diagnostics_have_no_screen_text`.
- [ ] **Step 2: Run** `cargo test -p apex-adapters --lib`. Expected: FAIL.
- [ ] **Step 3: Implement** redaction before progress events, saved history and diagnostics on the Claude and Codex paths, while retaining conservative name-based privacy redaction even when trust cannot be proved. Approval bypass alone requires trusted registration; privacy must never become narrower because provenance is absent. Check every `eprintln!` near MCP calls.
- [ ] **Step 4: Check CLI transcripts.** Run one Claude and one Codex session, confirm what their own transcript files hold, and record it in `docs/computer-use-spike.md`. The Design section's disclosure must match what you find.
- [ ] **Step 5: Run tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: keep screen content out of Claude and Codex records`.

### Task 10: Bot setting and notice

**Files:**
- Modify: the bot form under `src/`, `src/backend.ts` (mock `listToolServers`)
- Test: the bot form's existing test file

**Interfaces:**
- Consumes: `ParticipantConfig.can_read_images`.

- [ ] **Step 1: Write failing tests:** `api_bot_form_shows_can_read_images_unticked`, `notice_shows_verbatim_when_unticked`, `claude_and_codex_forms_hide_the_box`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** a "Can read images" tick box on the API bot form with the notice beneath it when unticked. Show the same notice in chat once per thread on that bot's first `apex-computer` call. Add `apex-computer` to the mock server list. Render it offscreen and view the PNG before installing.
- [ ] **Step 4: Run** tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add image setting and text-only notice`.

### Task 11: Acceptance in running Deck

**Files:**
- Create: `docs/computer-use-acceptance.md`

The Human grants Accessibility and Screen Recording once at the start. All chats run in Deck's dev build using the AGENTS.md command, with the real model servers on.

- [ ] **Step 1: Same task, two bots.** DS4 and one vision API bot each get the Task 2 task, saving to `~/Documents/apex-computer-<bot>.txt`. Pass means each file holds the exact text and the bot's step log shows real tool calls. This is the completion gate from Null's review.
- [ ] **Step 2: Claude and Codex.** Repeat Step 1 and confirm a screenshot reaches each model by asking it to name something visible only in the picture.
- [ ] **Step 3: Limits.** Two bots at once gives "busy". Stop during a long `type_text` halts mid-string with no key held. Stop during a `/goal` run ends it and the runner stays paused. Moving the mouse during typing halts it. Scrolling a list by hand between a read and a click refuses the click. Dropping a bot to read-only during its typing halts it. Refusing the dialog stops the bot. Requesting Terminal is refused without an exception. A shim started by hand with no token gets no session. Restarting the daemon refuses the surviving shim and the next turn works. A custom-drawn app shows the gap the notice warns about.
- [ ] **Step 4: Final measurements.** Repeat the Task 2 CPU, memory and DS4 speed measurements on the finished helper.
- [ ] **Step 5: Recheck Codex's own computer-use popup.** `codex_server.rs:828` now sends app-access prompts to `mcp_question` and an approval card, which contradicts the 2026-10-04 note. Run it once from a Deck Codex bot, record what happens, and correct the note.
- [ ] **Step 6: Record** results and known gaps in `docs/computer-use-acceptance.md`, then commit `docs: record computer use acceptance`.

## Decisions from the revision 2 review

- **Screenshot order:** settled as DS4 proof, minimal image path, vision proof, gate.
- **Daemon identity:** settled as a signing requirement on the real peer for all three methods, sessions revoked with their connection, fresh tokens after a restart.
- **Token handoff:** accepted within the trust limit, with per-child tokens and tested forwarding.
- **Protected and blocked split:** kept, matched on app identity and enforced at the input target.

## Decisions from the revision 3 review

- **Temporary name-based redaction:** accepted. Name matching may hide content, but only the trusted bundled server can skip an approval.
- **Read-only observations:** accepted with no lease. They never activate the app or touch another session's lease or snapshots, and they stay observation-only permanently.
- **Old snapshots:** the same owner isn't proof of an unchanged screen. The live element is revalidated before every action, and coordinate actions after a lapse return a fresh reading.
- **Turn setup:** moved to `TurnStartHook`, which is extended and composed with the checkpoint hook. Adapters only forward the token.

## Decisions from the revision 4 review and implementation preflight

- Typing/key presses may reacquire a lapsed lease only after full focused editable state revalidation. Coordinate actions after lapse require a fresh reading.
- Session app grants outlive turns; a fresh per-turn capability does not. Stop generation is independent of unique turn identity. Stale cleanup and events are conditional on exact incarnation.
- Pair lifecycle setup/finish centrally in `ConcurrentRoom`; cover early returns, cancellation, drops and cleanup errors. Never rely on participant-only idle events.
- Bound cold startup separately from the ready-connection two-second policy transaction. Timeout revokes inside the helper, else close the owner connection.
- Global human activity remains conservative for version one. Measure nuisance pauses before changing it.
- Host settings immediately restrict active computer turns; no mid-turn upgrades.
- Carry actual trusted registration provenance through every approval path. Conservative privacy redaction stays broader than approval trust.
- Screenshots use one selected window with exact coordinate mapping. Service-owned sheets require narrow verified attachment.
- TextEdit is the initial task; inspect the installed DS4 app for real-world AX coverage unless another target is supplied.
- The Human's latest full-completion authorization replaces repeated go/no-go questions. It does not replace macOS permission grants or passing live evidence.
