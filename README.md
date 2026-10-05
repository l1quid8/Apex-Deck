# Apex Deck

A desktop workspace for running coding agents side by side, with group chats
where several models share one conversation.

Apex Deck is open source (MIT) and runs on your own machine. It does not
include any model usage: you bring your own command-line agents and API keys.

**Status: early.** Version 0.1 covers the first milestone below. Expect rough
edges.

## What works in 0.1

- **Workspaces.** Add project folders. Each one keeps its own set of panes,
  and panes keep running when you switch to another workspace. A
  workspace's ⋯ menu renames it, shows its folder in Finder, or removes it
  from the list. Removing never deletes anything: its threads stay saved,
  **Undo** brings it straight back for 8 seconds, and later it comes back
  when you add the same folder again or choose it under **Removed · Show**
  at the foot of the rail. Its terminals end; if one is working or waiting
  for you, or one of its threads is replying, it asks first.
- **Terminal panes.** Real terminals in the workspace folder. Launch a plain
  shell, or any coding agent Apex Deck finds installed (the list is in
  `crates/apex-host/src/agents.rs`). A second terminal of the same tool in a
  workspace is numbered ("Codex 2"); double-click a name, or focus it and
  press F2, to rename it. When the program sets its own title, such as
  Claude Code's "Writing tests for auth", it shows muted after the name in
  the pane head, the rail and the attention list. When the program ends, the
  pane keeps its output and a bar at the foot says how and when it ended,
  with **Start Codex again** and **Close**; a program that ends with an
  error is flagged Failed. A terminal's ⋯ menu has **Rename**, **Start
  again**, **Copy folder path** and **Close**.
- **Terminals after a restart.** Terminals and their arrangement in Code are
  saved with your threads, as a name and a tool only. After a restart they
  come back **Stopped**, never started: choose **Start Codex** to run it
  again. Earlier output isn't kept, and a tool that is no longer installed
  can't be started.
- **Preview.** **+ New › Preview** shows a web page beside your terminals or
  threads. When a terminal prints a local server address, or a bot mentions
  one in a thread, a chip in its head opens it right of that pane. A stopped
  server or a site that refuses to be shown inside another app gets words,
  not a blank box, and a stopped server's page comes back by itself. The
  full-window button gives the page the whole window; Esc returns. Pages run
  sandboxed: they can't reach the app or navigate it away.
- **Layout.** Panes can be arranged any way you like. Drag the line between
  two panes to resize them. Drag a pane by its title bar onto the side of
  another to put it there, or onto the middle to swap the two. Three
  buttons give a ready-made arrangement: an even grid, a large pane on top,
  or a large pane on the left. Rearranging never restarts a terminal. Each
  pane can be maximized and restored or closed, and its head says what it is
  doing: Working, Idle, Exited or Stopped for a terminal, and how many bots a thread
  has. Closing a thread only takes it off the deck: it stays saved and listed
  in the rail, and clicking it opens it again. A thread's ⋯ menu has
  **Rename**, **Fork**, **Export** and **Delete thread…**; deleting asks
  once, and **Undo** brings it back for 8 seconds. A terminal that is working or waiting for you asks before it
  closes.
- **Quitting.** Closing the window, ⌘W, ⌘Q and Quit in the app menu ask
  first while a coding agent's terminal is open, a shell is working or
  waiting for you, or a bot is replying or waiting on an approval. The
  question lists up to five of them. Threads and their messages are saved;
  replies in progress are not. Quit from the Dock, logging out and shutting
  down don't ask.
- **Adding panes.** **+ New terminal** and **+ New thread** open a menu over
  the deck: type to filter, Enter opens, Escape closes. Tools that aren't
  installed are listed last, with a link to hide them in Settings.
- **Attention.** A pane that wants you is marked wherever you are in the
  app: an amber dot when it is waiting on you, red when something failed,
  cyan when there is a result you have not seen. The Code and Threads tabs
  and each workspace show a count, and a button beside the tabs lists every
  flagged pane; choose one to go to it, or press ⌘J for the most urgent. A
  workspace's count says when an alert is in the other section, such as
  `1 · Code`. A group chat is flagged when a bot
  fails, when a reply ends with a question, or when a reply arrives while
  you are elsewhere. A terminal is flagged when it shows a prompt that
  blocks until answered (an approval, a yes or no, a password) or when a
  long run of output ends while you are looking at something else. For
  terminals this is a judgement from what is on screen, so it can be wrong
  either way. Looking at a pane clears its flag; a waiting terminal keeps
  its flag until you type in it, and a thread whose bot is stopped on an
  approval card keeps its flag until you answer the card ("Null wants
  approval: Run npm test · +1 more").
  - **Answering from the list.** A command, or an edit of 20 changed lines
    or fewer, can be answered right in the attention list with **Allow
    once** or **Deny**; anything bigger shows **Open to answer**. Always
    allow is only offered on the card itself. Codex tool calls that its
    hook denies by itself say so: "Denied automatically in 6m".
  - **Mark ready as seen** clears every Ready flag at once. The dock badge
    counts only what needs you or failed. An approval left waiting for 2
    minutes while Apex Deck is in the background bounces the dock once.
  - **Pane heads** say what is happening: "Null · Running: npm test ·
    1m 12s", "2 replying · Null: Editing src/App.tsx", and for a terminal
    "Working 4m". A command-line bot that has said nothing for 5 minutes
    reads "Quiet 6m · stops at 15m", since such turns stop after 15 minutes
    of silence.
- **Group chat.** One conversation with any number of models. Each
  participant is reached through one of three backends, and you can mix them
  in the same chat:
  - an HTTP API that speaks the OpenAI-style chat completions format
    (hosted providers that offer it, or a local server such as Ollama)
  - a command-line tool that reads a prompt on standard input and prints a
    reply
  - a scripted participant with canned lines, for trying the feature without
    any model
- **Turn taking.** `@name` picks who answers, `@all` asks everyone. Without a
  mention the room follows its policy: whoever you addressed last, everyone
  at once, or everyone in turn. Models can @mention each other, up to a
  limit you set, and there is a stop button.
- **Approvals.** Set a Claude Code or Codex participant to "Ask first" and
  it stops before every file edit and every command. The chat shows what it
  wants to do, with the change drawn as added and removed lines, and **Allow
  once**, **Always allow** and **Deny**. Nothing happens until you choose, the
  pane is flagged as waiting on you, and the time you take does not count
  against the reply's time limit. Stop rejects whatever is waiting.
- **Always allow.** It saves a rule with the thread, so that bot may do the
  same thing again in this thread without a card: a tool with any arguments,
  that exact command, edits with the same title (one file, or any edit of the
  same number of files), or the same permission question. The card says what
  the rule would cover before you choose: always on cards that can spend money
  or publish, and while Always allow is hovered or focused on the others.
  Thread details lists each rule with the date it was allowed; **Remove** takes
  it back at once and the bot asks again next time. Codex is only told to
  remember a choice for its own session, which ends with the turn, so the
  thread's list is the only lasting record.
- **Thread details.** The right sidebar shows the focused thread, or the
  thread on screen you looked at last, and holds its bots, reply policy,
  rounds and Changes. Each bot is one row with its context (`ctx`) and plan
  readings; Edit, Save to Agents and Remove are in its ⋯ menu. **+ Add model**
  opens a small menu where you click it: saved agents first, then a tool,
  model and access level, with the name filled in from the model. **More
  options** opens the full form. It overlays
  the conversation in narrow windows. Pins stay above the conversation in a
  collapsible strip, with full text wrapping when expanded.
- **Artifacts.** On a bot's reply, **Open as artifact** on an HTML, SVG or
  Markdown code block shows it rendered in a panel beside the thread,
  sandboxed: it can't reach your files, the network or the app. Later blocks
  can become new versions; Source and Changes show the text and what
  changed, and the panel can go full window. Saved with the thread, copied
  when it is forked.
- **Changes.** `/diff` opens Changes in thread details, comparing the workspace
  against the thread's starting snapshot and grouping files by reported editor.
  **Ask for review ▾** in its head attaches the whole change as one patch file
  (`review-since-start-<n>.patch`) and fills the composer with "@name Review
  this change." for the bot you pick; it never sends. Over 2,000 lines it
  offers one file per patch. Bots that can't open the attachments folder (API
  models and scripted bots) say "Can't read attachments".
- **Composer tools.** Click + for mentions and commands, or type `/` or `@`
  to filter the menu. Arrows select; Enter or Tab picks. Mentions insert at the
  cursor. Commands without arguments run while preserving your draft.
- **Clearing a chat.** Send `/clear` to empty the conversation and keep the
  participants. Models only know what the transcript holds, so they start
  fresh.
- **Compacting a chat.** Send `/compact` to have the model you addressed last
  summarize the conversation, with read-only access. From then on the models
  see that summary in place of the older messages, which keeps long threads
  cheap. You still see every message, and you can open the summary from the
  divider where it was made.
- **Agent profiles.** Save reusable participants with model, reasoning effort,
  access and persona settings, then add them to other chats.
- **Saved threads.** Chats, participants, options and completed messages are
  saved automatically across restarts.
- **Thread names.** Double-click a thread's title in its header or sidebar
  to rename it. Enter saves; Escape cancels. Focus a title and press Enter
  or F2 to rename with the keyboard.
- **Reading while bots work.** The transcript follows new replies only
  while you are at its bottom. Scrolled up, it keeps your place and shows
  "3 new · Jump to latest", and "Null is waiting for you · Show" when an
  approval card is out of view. Coming back to a thread, a hairline "New
  since you looked" marks where the replies you missed begin; it is saved
  with the thread and clears when you send.
- **Who gets your message.** A line above the message box always says who
  your message goes to and why: "To Null · last addressed", "To Jigga · you
  mentioned", "To everyone · everyone at once", with "queued (busy)" when
  they are at work. Its reason opens Room. An empty room offers example
  messages built from a real handle, and before the first message the hint
  teaches @all.
- **Try again and Let them answer.** A bot's failure notice has **Try
  again**, which runs that bot once more on the conversation as it is
  without reposting anything. When the round limit cuts bots off, the
  notice says who was asked next ("Jigga asked Null next.") and offers
  **Let Null answer**, which buys exactly one reply.
- **Quotes and message actions.** Quoting a reply no longer adds its bot's
  handle when you @mention someone yourself, and **Send to ▾** hands the
  quote to another bot or to everyone. Every message, yours included, has
  Quote, Copy and Fork from here; in a pane under 360px wide they fold into
  one ⋯.
- **Queue and steer.** While models reply, Enter queues your message for
  the next turn. You can edit or remove queued messages. Steer (or
  Command/Ctrl+Enter) interrupts the current turn and sends immediately;
  `@name` selects the next model. Streamed text is kept as an interrupted
  reply. Pending messages stay in the open pane and are not saved across
  app restarts. Steering currently starts a new turn for all providers,
  including Codex; its native `turn/steer` protocol is not wired in.
- **Avatar batteries.** The left half shows context remaining, the right
  half the provider account's plan remaining. A low side gets a thin outline;
  a critical one a thicker outline and the word "low". The cells keep the
  agent's colour, because red means something failed. Usage cards show reset
  times, other plan windows and the bot's token totals for this thread, with
  a Compact now button.
  Unknown readings draw full without inventing a percentage. Claude Code
  reports plan usage during replies; Codex also reports it when joining.
  Plan readings are shared across agents using the same provider account.
  Command-line turns stop after 15 minutes without output, with approval
  waits excluded; active work has no fixed total time limit.
- **Provider filtering.** Choose which tools appear in new terminal and bot
  selections; your choices are saved across restarts.
- **Live activity and token counts.** See replies in progress and activity
  status lines, with steps from Claude Code and Codex and per-participant
  token counts for the thread, saved with it.

## Requirements

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22.13 or newer

## Run it

The desktop app is Electron. Every thread, terminal and saved file lives in
`apex-daemon`, on this Mac or on another machine you reach over SSH, and a
real Chromium browser is docked in the Preview pane. See
[docs/desktop.md](docs/desktop.md).

```sh
npm install
npx install-electron       # fetches Electron's binary now rather than on first use
npm run desktop:dev        # Vite with hot reload, and Electron pointed at it
```

To build the app, `npm run desktop:package` writes
`release/mac-arm64/Apex Deck.app`, and `npm run desktop:dmg` puts it in
`release/Apex-Deck_<version>_arm64.dmg`. Move the app to Applications and open
it with right-click → **Open** the first time: it is signed ad hoc, not
notarized. Coding agents still use the command-line tools installed and signed
in on your Mac.

To run the daemon on a Linux server and use it from this Mac, see
[docs/daemon-ubuntu.md](docs/daemon-ubuntu.md).

### Upgrading from 0.4.0

0.4.0 was a Tauri app. The Electron app reads the same saved threads and
settings, and on its first launch copies over what the old window kept for
itself: installed mods, model names typed before and sidebar widths. Quit
0.4.0 before opening it; if it is still open, the new app asks you to.

To work on the interface alone, `npm run dev` opens it in a browser with a
stand-in backend. Terminals only echo and chat replies are canned in that
mode; a badge in the title bar says so.

## Using Apex Deck

The main navigation has three sections:

- **Agents:** reusable bot profiles with model, effort, access and persona settings.
- **Code:** live terminal panes in your project folders.
- **Threads:** saved group chats. Use **+ Add model** or **Add a saved agent** to bring a
  profile into a chat, or **Save to Agents** in a bot's ⋯ menu to keep it.

An empty Agents section offers three starting roles: Reviewer, Planner and Implementer.
With no workspace yet, **Try a sample thread** opens a thread with two scripted bots, so
you can try @mentions and turn taking without any model or key.

Keyboard shortcuts (on Windows and Linux, use Ctrl+Shift instead of ⌘):

| Keys | Action |
|---|---|
| ⌘1 ⌘2 ⌘3 | Agents, Code, Threads |
| ⌘T | New terminal |
| ⌘N | New thread |
| ⌘J | Go to the most urgent item that wants attention |
| ⌘[ ⌘] | Previous or next pane |
| ⌘⇧Enter | Maximize or restore the focused pane |
| ⌘, | Settings |

⌘W is left to macOS, which closes the window with it; like ⌘Q, that asks first while agents are running.

**Settings** (the gear in the top bar, or ⌘,) holds app-wide choices. They are saved
in `settings.json`, beside the session file, and General shows that folder.

- **General:** where data is saved, the version, and **Clear** for the model names
  the bot form remembers.
- **Providers:** hide tools you do not use, choose **Hide uninstalled tools**, or
  **Enable all**. This applies to new terminal and bot selections in all three
  sections; existing profiles, conversations and running terminals are kept. Below,
  **API keys** lists the variable names your saved agents read keys from and whether
  the app can see each one. Only yes or no is checked, never the value.
- **New threads:** who answers, model-to-model rounds and the access new bots start
  at. Threads you already have keep their own settings.
- **Terminal:** font size and scrollback. Open terminals update straight away.
- **Shortcuts:** the list above.

Thread commands:

- `/compact` summarizes earlier turns; `/clear` clears the conversation while keeping participants and pins.
- `/pin <fact>` puts a fact in every model's instructions on every turn. Pins survive clearing and compacting; remove them with × in the Pinned strip.
- `/diff` shows workspace changes since the thread started, grouped by the agents that reported them. Full diffs require git; otherwise it lists reported edits with an explanation.
- `/fork [name]` copies the conversation into a new thread. The fork icon on a message copies through that message. Both threads share the same folder.
- `/export` saves Markdown to Downloads; `/export json` saves the transcript as JSON. Per-message timestamps and tool calls are not stored, so they are not included.
- Start a message with `//` to send a literal `/`. Unknown commands keep your text and show a warning.

Photos and files: paste them into the composer, drop them on the thread, or choose
**Photo or file** from the **+** menu (20 MB each). They are copied into the app's
data folder, one folder per thread, and sent as file paths, so each agent opens them
with its own tools and later turns don't resend the bytes. Claude Code and Gemini
are given read access to that folder.

## Saved data

Chats, participants, options and completed messages are saved automatically.
On macOS the native app stores them in
`~/Library/Application Support/dev.apexdeck.app/saved-chats-v1/` using atomic file replacements.
Workspace folders previously remembered by the app are migrated on first launch.
Running model turns and terminal processes are not restarted automatically:
terminals and their Code layout are saved as names and tools only, and come
back Stopped until you start them.
Use **Delete thread** to remove a saved conversation. Switching sections, removing a
workspace from the list or quitting the application keeps your chats. Browser demo data
is stored separately in browser storage.

## Adding models to a group chat

Go to **Threads**, click **+ New thread**, then **+ Add model**. Give the
participant a name and pick how to reach it under **Connect through**.

| Preset | What it runs | Model choice |
|---|---|---|
| Claude Code | `claude -p` in its event mode, once per turn | Default, a short name that follows the newest version (`opus`, `sonnet`, `haiku`, `fable`, ...), a specific version (`claude-opus-5-5`, `claude-sonnet-4-6`, ...), or any name you type |
| Codex | `codex app-server`, one short session per turn (falls back to `codex exec --json`) | Default, the models Codex reports for your account, the built-in list, or any name you type |
| Gemini CLI | `gemini -p`, once per turn | Default, a shortcut (`auto`, `pro`, `flash`, `flash-lite`), a specific version, or any name you type |
| Ollama | Your local Ollama server | Listed from the server |
| Other API | Any OpenAI-compatible endpoint | Listed from the server, or typed |
| Custom command | A command you enter | Whatever the command does |
| Scripted | Nothing; canned lines for testing | None |

Agent presets are greyed out when the tool is not installed. They run in the
workspace folder, with the same PATH your terminal has. The exact flags for
each tool are in `crates/apex-adapters/src/presets.rs`.

**Model and reasoning effort.** Both are dropdowns and both are optional.
Leave them on Default to use whatever the tool or server is set to, pick
from the list, or choose the last entry to type an exact name. Names you
type are remembered. The effort list changes with the model: it shows only
the levels that model accepts, and is switched off for models with no
effort setting. The built-in lists live in `src/models.ts`. For Codex they
are replaced by the list Codex keeps for your account
(`~/.codex/models_cache.json`) when it has one.

**While a bot works.** Claude Code and Codex report what they are doing as
they go, so a reply appears as it is written instead of all at once at the
end. Until the turn is over the reply sits in a dashed bubble that cannot be
mistaken for a finished message: it lists the steps taken so far (the file
being read, the command being run), shows the text written so far in a
dimmer colour, and ends with a moving status line that says whether the bot
is thinking, working or writing and for how long. When the turn ends the
bubble is replaced by the final reply. Hover the bot's chip for the tokens it
has used in this thread, split into input and output. The totals are saved
with the thread; `/clear` keeps them and a fork starts at zero.

Claude Code is run in its event mode (`--output-format stream-json`). Codex
is run through its app server (`codex app-server`), the same interface its
own apps use, because `codex exec` only hands over each message once it is
complete. If the app server cannot be started, Apex Deck falls back to
`codex exec --json`: same reply and steps, but each message arrives whole.
The other presets print only their answer, so they show text and the status
line and nothing else.

**When a tool fails.** The chat shows the line that explains it, wherever
the tool printed it. If the tool is not signed in, the message says how to
sign in. The full output goes to the app's log.

**Changing a participant.** Click its header chip to pick a model and reasoning
level, then Apply. These settings are saved for this thread only. A reply
already in progress finishes with its original settings; a dot marks the
change until that reply finishes, and the next reply uses the new settings.
Reasoning choices follow the selected model. For access or persona, choose
Edit from the bot’s menu in thread details. Its @handle and conversation stay
intact.

**Access.** There are four levels:

| Level | What the bot may do |
|---|---|
| Read only | Read files. No edits, no commands. |
| Ask first | Propose each edit and command, and wait for your Approve or Reject. |
| Can edit files | Edit files in the workspace without asking. |
| Full access | Edit files and run commands without asking. |

For Claude Code and Codex the level is turned into the tool's own permission
settings, so it is enforced by the tool. "Ask first" is offered for those
two only, because it needs the tool to stop and wait. For the other presets
the level is only stated to the model as an instruction.

Configured MCP servers and plugins stay enabled for Claude Code and Codex.
Ordinary read tools run without a card. MCP tool names containing trading or
publishing terms (including order, transfer, cancel, post, send, and delete)
ask every time, even at Full access, unless you chose Always allow for that
tool in this thread. Their cards say "can spend money or publish" and show the
server, tool name, and complete JSON arguments; Allow once is for that call only.
Stopping that participant rejects its pending approvals. Some read names, such
as `get_open_orders`, also match and ask.

**Codex approvals.** Deck adds a `PreToolUse` hook at launch on supported Unix Codex app servers (tested with Codex 0.160.0). It runs Deck itself (`apex-deck --codex-hook`) before each MCP call. Reads go through; trading and publishing tool names get the same approval card as Claude, even if a tool was configured to auto-approve. Codex turns no longer need a tool inventory on this path.

Deck checks that Codex lists its exact hook as trusted before starting a turn. On first use, or when the helper command changes, it trusts only that hook through Codex's settings API, adding:

```toml
[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]
trusted_hash = "sha256:…"
```

The hook is passed only when Deck launches Codex; these trust lines alone add no hook to Codex in a terminal. The helper denies a call if it cannot get Deck's answer within 9.5 minutes, before Codex's 10-minute hook limit. An abandoned wait removes its card. If hooks are unavailable, the helper is missing, trust fails, or the platform is Windows, Deck falls back to listing all MCP tools and overriding their approval policies. If that inventory fails, the turn is refused. Deck never falls back to `codex exec`.

These MCP approvals cover Claude Code and Codex agent presets, not custom CLI commands or Gemini. Hook mode discovers the `!` menu's server names separately, when panes or menus open, using the cached list.

How "Ask first" was checked: Claude Code against the real tool (approving wrote the file and listed the change; rejecting left the file alone). Codex hook coverage and deny behavior were checked against real app-server probe turns; adapter tests cover read calls, repeated risky calls, both gate orders, trust, and inventory fallback. Two real adapter smoke turns checked the bundled helper and trust reuse. Native desktop approval-card checks are still pending.

**API keys.** For "Other API", enter the *name* of an environment variable
that holds your key. The key itself is never written to disk by Apex Deck; it
is read from the environment when a turn runs. Because desktop apps do not
always inherit your shell's environment, start Apex Deck from a terminal
where the variable is set, or set it in your system environment.

**Cost.** Each reply from an agent preset is a separate run of that tool and
counts against your subscription or credits for it. The whole conversation
is sent on every turn.

Give a participant a persona if you want a custom bot: a name plus a short
description of how it should behave.

## Project layout

| Path | What it is |
|---|---|
| `crates/apex-core` | Group chat logic: participants, transcript views, turn taking. No network or process code. |
| `crates/apex-adapters` | Backends: OpenAI-compatible HTTP streaming and command-line tools. |
| `crates/apex-host` | Everything a host does: threads, terminals, agent detection, saved sessions and settings, and the commands the interface calls. |
| `crates/apex-daemon` | `apex-daemon`, which runs a host for the desktop app, over SSH, or as a service on a server. |
| `desktop` | The Electron app: windows, the docked browser, and the link from each window to a daemon. |
| `build/icons` | The app icons the packaged app is built with. |
| `src` | The interface (React and TypeScript, xterm.js for terminals). |
| `src/layout.ts` | How panes are arranged: the layout tree and every change to it, with no interface code. |
| `src/attention.ts` | When a pane counts as needing you: the rules for terminals and chats, with no interface code. |
| `src/markdownText.ts` | The reader for the markdown in bot replies. |
| `SPEC.md` | The feature plan and what is left to build. |
| `public/branding` | Approved logos used by the interface and browser preview. |
| `branding/macos` | The brand kit: the approved logo, editable vectors, macOS icon files and Xcode assets. |

## Branding

The mark is a mint and cyan pixel diamond around a `>_` terminal prompt. It
appears in the title bar, startup screen and welcome screen, and the browser
preview uses it as its favicon. The native bundle uses the matching icon
from `build/icons/icon.icns`; the PNG and Windows icon files there use
the same artwork, with the kit's simplified drawing at 64 pixels and below.

The full source kit and its usage guide are in `branding/macos`, unchanged
from how it was delivered. Where each file in the app comes from:

| In the app | From the kit |
|---|---|
| `public/branding/mark.svg` | `Vectors/BrandMark.svg` |
| `public/branding/logo-dark.svg`, `logo-light.svg` | `Vectors/LogoStackedDark.svg`, `LogoStackedLight.svg` |
| `public/branding/logo-horizontal.svg` | `Vectors/LogoHorizontalDark.svg` |
| `public/branding/menu-bar-template.svg` | `Vectors/MenuBarTemplate.svg` |
| `public/branding/app-icon.png`, `build/icons/icon.png` | `PNG/AppIcon-1024.png` |
| `build/icons/icon.icns` | `ApexDeck-32bit.icns` |
| `build/icons/32x32.png`, `128x128.png`, `128x128@2x.png` | `PNG/AppIcon-32.png`, `AppIcon-128.png`, `AppIcon-256.png` |
| `build/icons/icon.ico` | built from `PNG/AppIcon-16` to `AppIcon-256` |

The brand colors in `src/styles.css` (`--brand-mint`, `--brand-cyan`) are the
kit's Mint `#3DEF91` and Cyan `#1ED7EE`. Light-background and horizontal
logos, wordmarks, a template menu-bar mark and Xcode assets are in the kit
for future surfaces. The current app has no menu-bar tray, so the template
mark is available without adding a new tray feature.

## Tests

```sh
cargo test --workspace   # room logic, adapters, terminals, the daemon
npm test                 # the interface's logic and the Electron shell's (Node.js 22.6+)
npm run build            # type-check and bundle the interface
npm run test:e2e         # the protocol client against a real apex-daemon
npm run desktop:smoke    # the Electron app, driven end to end
```

The adapter tests run against a local mock server and small shell commands,
so they need no API key and make no outside requests.

## Roadmap

See [SPEC.md](SPEC.md). Next up: a status board across all panes with a
"needs you" state, a docked browser for `localhost` previews, and an
Anthropic-format API adapter.

## License

MIT. See [LICENSE](LICENSE).

Type `!` in a thread composer to suggest the addressed participant’s tool servers. For example, `@null !x-mcp read my recent posts`. Enter inserts the highlighted server; names match without case, hyphens, underscores, dots or spaces. A known typo stays unsent. If discovery is unavailable, messages can still send. Servers remain enabled by default and write-tool approval rules still apply. Claude suggestions become available after its first turn.
