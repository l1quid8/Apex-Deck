# Apex Deck

A desktop workspace for running coding agents side by side, with group chats
where several models share one conversation.

Apex Deck is open source (MIT) and runs on your own machine. It does not
include any model usage: you bring your own command-line agents and API keys.

**Status: early.** Version 0.1 covers the first milestone below. Expect rough
edges.

## What works in 0.1

- **Workspaces.** Add project folders. Each one keeps its own set of panes,
  and panes keep running when you switch to another workspace.
- **Terminal panes.** Real terminals in the workspace folder. Launch a plain
  shell, or any coding agent Apex Deck finds installed (the list is in
  `src-tauri/src/agents.rs`).
- **Layout.** Panes can be arranged any way you like. Drag the line between
  two panes to resize them. Drag a pane by its title bar onto the side of
  another to put it there, or onto the middle to swap the two. Three
  buttons give a ready-made arrangement: an even grid, a large pane on top,
  or a large pane on the left. Rearranging never restarts a terminal. Each
  pane can be maximized and restored or closed, and its head says what it is
  doing: Working, Idle or Exited for a terminal, and how many bots a thread
  has. Closing a thread only takes it off the deck: it stays saved and listed
  in the rail, and clicking it opens it again. To delete a thread, use
  **Delete thread…** in its ⋯ menu; it asks once, and **Undo** brings it back
  for 8 seconds. A terminal that is working or waiting for you asks before it
  closes.
- **Adding panes.** **+ New terminal** and **+ New thread** open a menu over
  the deck: type to filter, Enter opens, Escape closes. Tools that aren't
  installed are listed last, with a link to hide them in Providers.
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
  its flag until you type in it.
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
  wants to do, with the change drawn as added and removed lines, and an
  Approve and a Reject button. Nothing happens until you choose, the pane is
  flagged as waiting on you, and the time you take does not count against
  the reply's time limit. Stop rejects whatever is waiting.
- **Thread details.** The right sidebar shows the focused thread, or the
  thread on screen you looked at last, and holds its bots, reply policy,
  rounds and Changes. Each bot is one row with its context (`ctx`) and plan
  readings; Edit, Save to Agents and Remove are in its ⋯ menu. **+ Add model**
  opens a small menu where you click it: saved agents first, then a tool,
  model and access level, with the name filled in from the model. **More
  options** opens the full form. It overlays
  the conversation in narrow windows. Pins stay above the conversation in a
  collapsible strip, with full text wrapping when expanded.
- **Changes.** `/diff` opens Changes in thread details, comparing the workspace
  against the thread's starting snapshot and grouping files by reported editor.
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
- **Queue and steer.** While models reply, Enter queues your message for
  the next turn. You can edit or remove queued messages. Steer (or
  Command/Ctrl+Enter) interrupts the current turn and sends immediately;
  `@name` selects the next model. Streamed text is kept as an interrupted
  reply. Pending messages stay in the open pane and are not saved across
  app restarts. Steering currently starts a new turn for all providers,
  including Codex; its native `turn/steer` protocol is not wired in.
- **Avatar batteries.** The left half shows context remaining, the right
  half the provider account's plan remaining. Usage cards show reset times,
  other plan windows and session token totals, with a Compact now button.
  Unknown readings draw full without inventing a percentage. Claude Code
  reports plan usage during replies; Codex also reports it when joining.
  Plan readings are shared across agents using the same provider account.
  Command-line turns stop after 15 minutes without output, with approval
  waits excluded; active work has no fixed total time limit.
- **Provider filtering.** Choose which tools appear in new terminal and bot
  selections; your choices are saved across restarts.
- **Live activity and token counts.** See replies in progress and activity
  status lines, with steps from Claude Code and Codex and per-participant
  token counts for the chat.

## Requirements

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20 or newer
- The Tauri 2 system dependencies for your platform:
  <https://tauri.app/start/prerequisites/>

## Run it

```sh
npm install
npm run tauri dev
```

The built app also accepts folders on the command line, so `apex-deck .`
opens the current project as a workspace.

To build an installable app:

```sh
npm run tauri build
```

The resulting `target/release/bundle/macos/Apex Deck.app` contains the interface
and native backend. Move it to Applications and launch it normally; Node.js,
a development server and an open terminal are not needed to run the packaged app.
Coding agents still use the command-line tools installed and signed in on your Mac.

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

⌘W is left to macOS, which closes the window with it.

Use **Providers** in the top bar to hide tools you do not use. Toggle any provider,
choose **Hide uninstalled tools**, or **Enable all** to restore the list. Choices are
saved across restarts and apply to new terminal and bot selections in all three
sections. Existing profiles, conversations and running terminals are kept.

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
Running model turns and terminal processes are not restarted automatically.
Use **Delete thread** to remove a saved conversation. Switching sections or quitting
the application keeps your chats. Browser demo data is stored separately in browser storage.

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
bubble is replaced by the final reply, and the bot's chip shows the tokens
it has used in this chat; hover for the split between input and output.

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

**Changing a participant.** Click the pencil on its chip to change its
model, effort, access or persona. It keeps its @handle and its place in the
conversation.

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

How "Ask first" was checked: with Claude Code against the real tool
(approving wrote the file and listed the change, rejecting left the file
alone). With Codex only against its published message format and a stand-in
server, because Codex needs a sign-in to run a turn. If Codex behaves
differently on your Mac, the chat shows its error.

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
| `src-tauri` | The desktop shell: terminal sessions, agent detection, and the commands the interface calls. |
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
from `src-tauri/icons/icon.icns`; the PNG and Windows icon files there use
the same artwork, with the kit's simplified drawing at 64 pixels and below.

The full source kit and its usage guide are in `branding/macos`, unchanged
from how it was delivered. Where each file in the app comes from:

| In the app | From the kit |
|---|---|
| `public/branding/mark.svg` | `Vectors/BrandMark.svg` |
| `public/branding/logo-dark.svg`, `logo-light.svg` | `Vectors/LogoStackedDark.svg`, `LogoStackedLight.svg` |
| `public/branding/logo-horizontal.svg` | `Vectors/LogoHorizontalDark.svg` |
| `public/branding/menu-bar-template.svg` | `Vectors/MenuBarTemplate.svg` |
| `public/branding/app-icon.png`, `src-tauri/icons/icon.png` | `PNG/AppIcon-1024.png` |
| `src-tauri/icons/icon.icns` | `ApexDeck-32bit.icns` |
| `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png` | `PNG/AppIcon-32.png`, `AppIcon-128.png`, `AppIcon-256.png` |
| `src-tauri/icons/icon.ico` | built from `PNG/AppIcon-16` to `AppIcon-256` |

The brand colors in `src/styles.css` (`--brand-mint`, `--brand-cyan`) are the
kit's Mint `#3DEF91` and Cyan `#1ED7EE`. Light-background and horizontal
logos, wordmarks, a template menu-bar mark and Xcode assets are in the kit
for future surfaces. The current app has no menu-bar tray, so the template
mark is available without adding a new tray feature.

## Tests

```sh
cargo test --workspace   # room logic, adapters, terminals
npm test                 # provider preference behavior (Node.js 22.6+)
npm run build            # type-check and bundle the interface
```

The adapter tests run against a local mock server and small shell commands,
so they need no API key and make no outside requests.

## Roadmap

See [SPEC.md](SPEC.md). Next up: a status board across all panes with a
"needs you" state, a docked browser for `localhost` previews, and an
Anthropic-format API adapter.

## License

MIT. See [LICENSE](LICENSE).
