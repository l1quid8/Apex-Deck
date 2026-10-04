# Apex Deck: feature plan

This is the working plan for Apex Deck. It lists what the app should do, what
is built, and what is next. The design, code, name and visuals are our own.

Legend: **done** means built and covered by tests or a scripted UI check.
**next** is the following milestone. **later** is planned but not scheduled.

## 1. Workspaces and panes

| Feature | State |
|---|---|
| Add a folder as a workspace; list persists between launches | done |
| Each workspace has its own panes, which keep running when hidden | done |
| Pane picker: installed agents, plain terminal, group chat | done |
| Terminal panes backed by real pseudo-terminals in the workspace folder | done |
| Launch through the user's login shell so PATH matches their terminal | done |
| Layout presets (even grid, large pane on top or left), maximize and restore, close | done |
| Status dot per pane: working (recent output), idle, exited (or stopped, for a terminal restored after a restart) | done |
| Drag the line between panes to resize; drag a pane by its title bar to move or swap it | done (thread and terminal layouts are saved; panes that didn't load are dropped from them) |
| Keyboard shortcuts for sections, new panes, the next alert, moving between panes and maximizing | done (⌘W is left to the macOS window menu) |
| Close a thread without deleting it; confirmed delete with undo; confirm before closing a busy terminal | done |
| Terminal names: a second pane of a tool is numbered ("Codex 2"), renamed in place, with the program's own title muted after the name | done |
| A terminal whose program ended keeps its output and offers Start again; a non-zero exit is flagged Failed | done |
| ⋯ menus on every pane: terminals (Rename, Start again, Copy folder path, Close) and threads (Rename, Fork, Export, Delete thread…) | done |
| Remove a workspace from the list without deleting its threads: asks while something runs, undo, Removed · Show, adding the folder again brings it back | done |
| Rename a workspace; reveal its folder in Finder | done |
| Ask before quitting while agent terminals, busy shells or replying bots are running | done (logout and shutdown never ask) |
| Section tabs centred in the title bar; the active workspace row has no accent bar | done |
| Tabs within a workspace | later |
| Restore open panes after restart | done (terminals come back Stopped and are never started on launch; earlier output isn't kept. Start all and resume flags such as `--continue` are later) |
| One git worktree per agent pane so agents do not collide | later |

## 2. Group chat

| Feature | State |
|---|---|
| One transcript, any number of participants | done |
| Per-participant view of the transcript (own turns vs. labelled others) | done |
| Backends: OpenAI-compatible API, command-line tool, scripted | done |
| Presets for Claude Code, Codex, Gemini CLI and Ollama, with a model picker | done (Codex and Gemini flags not yet confirmed against the real tools) |
| Command-line participants run in the workspace folder with the terminal's PATH | done |
| Model version and reasoning effort per participant, editable after adding | done |
| Tool failures shown as one readable line; full output goes to the app log | done |
| Failures a tool prints as normal output (Claude Code does this) are shown too, with how to sign in when that is the cause | done |
| Model picker lists every current model and version per tool; effort levels follow the chosen model | done (lists are in `src/models.ts`; Codex's own list for the account is read when present) |
| Mixed backends in one chat | done |
| `@name` and `@all` routing | done |
| Policies: last addressed, everyone at once, everyone in turn | done |
| Models can @mention each other, with a round limit | done |
| Pass (a model declines to reply), failure reporting, stop | done |
| Streaming replies | done |
| Bot replies drawn from their markdown: headings, lists, tables, code blocks with a copy button, bold, italic, code | done |
| Claude Code and Codex report as they go: text as it is written, each step taken, token counts, and the tool's own error | done (Claude Code checked against the real tool. Codex goes through its app server; start-up and a failed turn were checked against the real tool, a successful turn only against its published message format) |
| A reply in progress is shown as a draft with its steps, a thinking, working or writing status and elapsed time, so it is not mistaken for the final message | done |
| Persona and access level per participant | done (access is enforced for Claude Code and Codex, advisory otherwise) |
| "Ask first" access: a bot proposes each edit and command, and waits for Approve or Reject in the chat | done for Claude Code (checked against the real tool) and Codex (checked against its message format and a stand-in server only) |
| Changes in thread details: workspace diff with added and removed lines, grouped by reported editor | done (thread baseline and edit records saved) |
| Anthropic-format API adapter | next |
| Saved bots (reuse a participant across chats) | done (Agents profiles, with saved appearance) |
| Per-participant token meter | done for Claude Code, Codex and API models (totals since the app opened; not saved) |
| Session resume for command-line tools (send only unseen messages) | next (the room already tracks unseen messages) |
| Moderator policy: a cheap model picks who answers | later |
| Shared summary when the transcript gets long | done (`/compact`, persisted summary) |
| Cancel a reply that is in flight | done (Stop cancels promptly; streamed partial text is retained) |
| Rename group chats | done (header and sidebar; saved with the session) |
| Hold your place while bots stream; "New since you looked"; a pill for an out-of-view approval card | done |
| Recipient line: who gets your message and why; examples in an empty room | done |
| Try again after a failure; Let them answer after the round limit (room_turn with a hop budget) | done |
| Quotes follow your own @mention; Send to ▾; Copy and Quote on every message | done |
| Queue added context or steer to another model | done (editable in-memory queue; Steer interrupts and starts a new turn, `@handle` selects the recipient) |
| Context and provider plan avatar meters | implemented (preview and real Codex desktop readings checked; successful Claude context check blocked by session quota) |

**Access levels.** Read only, Ask first, Can edit files, Full access. Claude
Code and Codex participants get the tool's own permission settings, so the
level is enforced by the tool. For Gemini CLI, API models and custom
commands the level is only stated in the system prompt, and Ask first is
not offered.

**How asking works.** The room owns an approval desk. An adapter that is
asked for permission hands the proposed action to the room, which announces
it (`approval_requested`) and waits for `room_decide`. Claude Code is run as
a two-way session (`--input-format stream-json --permission-prompt-tool
stdio`) and its `can_use_tool` requests are answered allow or deny. Codex's
app server sends `requestApproval` requests, answered accept or decline.
Waiting does not count against the turn's time limit. Stop and closing the
chat reject everything that is waiting. Code: `crates/apex-core/src/approval.rs`,
`crates/apex-adapters/src/claude_session.rs`, `codex_server.rs`.

## 3. Status board

| Feature | State |
|---|---|
| Each pane has a state: working, idle, exited, needs you, failed, ready | done |
| One list of every pane that wants attention, most urgent first, reachable from anywhere | done |
| Click an item to jump to its pane | done |
| Counts on the Code and Threads tabs and on each workspace | done |
| Group chats flag a failed bot, a reply that asks you something, and a new reply you have not seen | done (certain: taken from the chat's own events) |
| Terminals flag a prompt that is waiting for an answer, and work that finished while you were elsewhere | done (a judgement from what is on screen and how output arrived; the rules and their tests are in `src/attention.ts`. The approval-prompt pattern has not been checked against a live agent prompt) |
| The app's icon shows the count, and draws the eye once when something is flagged in the background | done (not yet seen on a real Mac) |
| The list also shows what is working and idle | later |
| System notification and sound when something needs you | later (an approval left waiting 2 minutes in the background bounces the dock once) |
| Approval flags stay until answered; answer routine approvals from the list; Mark ready as seen; dock badge counts only Needs you and Failed | done |
| Pane heads say what each bot or terminal is doing, with a quiet warning before the 15-minute silence limit | done |

## 4. Side panel

| Feature | State |
|---|---|
| Docked browser for `localhost` previews, kept across workspaces | next |
| Back, forward, reload, device size | later |

## 5. Agents with a brief

| Feature | State |
|---|---|
| Named agent: engine, brief, home folder | later |
| Notes and skills files per agent | later |
| Run on a schedule | later |

## 6. Voice

| Feature | State |
|---|---|
| Hold a key to dictate into the focused pane, transcribed on device | later |

## 7. Settings

| Feature | State |
|---|---|
| Light theme | later |
| Keys in the operating system keychain instead of environment variables | later |
| Editable agent list (today it is a table in `src-tauri/src/agents.rs`) | later |

Thread controls live in one right sidebar following the focused thread; narrow layouts overlay it. The header keeps a single row of chips. Pins remain above the conversation in an expandable, wrapping strip. The composer + menu offers mentions and commands, with `/` and `@` keyboard filtering.
