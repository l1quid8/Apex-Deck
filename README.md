# Apex Deck

A desktop workspace for running coding agents side by side, with group chats
where several models share one conversation, a personal assistant that hands
work to them, and an iPhone app to follow along from anywhere.

Apex Deck is open source (MIT) and runs on your own machines. It does not
include any model usage: you bring your own command-line agents and API keys.

**Status: early, moving fast.** Current release: **0.6.1** (Mac app, Linux
daemon). iPhone: TestFlight **1.1 (5)**. Expect rough edges. Release notes are
in [docs/releases](docs/releases).

## What's in it

**Group chats with many models.** One thread, any number of participants:
Claude Code, Codex, Gemini CLI, Ollama, any OpenAI-compatible API (Venice and
the like), a custom command, or scripted test bots. `@name` picks who answers,
`@all` asks everyone. Replies stream in with the steps each bot is taking.
Quote, react, pin, fork, retry and revert messages. Each bot's avatar shows
context left and tokens used.

**Terminals and preview.** Real terminal panes in your project folders, and a
Chromium preview pane for `localhost`. Arrange panes any way you like; the
layout is saved. ⌘J jumps to whatever needs you.

**Projects on any machine.** Add folders on this Mac or on a server you reach
over SSH. Every thread shows where it runs. The work lives in `apex-daemon`,
so a Linux server keeps working while your Mac sleeps.

**Safe by default.** Four access levels per bot (Read only, Ask first, Can
edit files, Full access), enforced by Claude Code and Codex themselves, and by
Apex Deck for bots reached through an API.
Tools that can spend money or publish ask every time, even at Full access,
unless you choose Always allow for that tool in that thread.

**ApexAgent, a personal assistant.** A floating avatar opens one
conversation across all your projects, with Chat, Tasks and Notifications.
Ask for something and it plans a task, waits for your Approve where needed,
hands the work to a thread bot, and reports back on one updating card. It
keeps memory, rules and schedules, and can watch projects for you. Messages
can be read aloud. See [docs/apexagent-delegation.md](docs/apexagent-delegation.md).

**iPhone app.** Pair a phone by scanning a QR code in Settings → Remote
access and approving it on the Mac. The phone then reaches your machines on
Wi-Fi or cellular with no VPN, port forwarding or account, over an encrypted
[iroh](https://www.iroh.computer/) connection (direct when possible, relayed
when not). Pair each machine on its own. Chats, ApexAgent, push notifications
and a voice call are on the phone.

**Library.** Every picture and video your bots make is kept in one place,
across every paired machine, on Mac and phone. Image and video models from
custom providers can join a thread and are woken only when you tag them.

**Your look.** Optional glass skins, background patterns, glow and accent
colours, in Settings → Appearance.

## Requirements

- macOS on Apple Silicon for the desktop app
- [Rust](https://rustup.rs) (stable) and [Node.js](https://nodejs.org) 22.13
  or newer to build from source
- The command-line agents you want to use (`claude`, `codex`, `gemini`, ...),
  installed and signed in

## Install

Download the DMG from the latest
[release](https://github.com/l1quid8/Apex-Deck/releases), move **Apex Deck**
to Applications and open it. The app is Developer ID signed but not
notarized; if macOS blocks it, use System Settings → Privacy & Security →
**Open Anyway**.

To run the daemon on a Linux server and use it from your Mac or phone, take
the Linux binary from the same release and follow
[docs/daemon-ubuntu.md](docs/daemon-ubuntu.md).

## Build from source

```sh
npm install
npx install-electron       # fetches Electron's binary now rather than on first use
npm run desktop:dev        # Vite with hot reload, and Electron pointed at it
```

`npm run desktop:dev` uses the same data folder as an installed Apex Deck.
To keep a dev build apart, set `APEX_DECK_DATA_DIR` to a folder of its own.

| Command | What it does |
|---|---|
| `npm run desktop:package` | Builds `release/mac-arm64/Apex Deck.app` |
| `npm run desktop:dmg` | Builds `release/Apex-Deck_<version>_arm64.dmg` |
| `npm run iphone:open` | Builds the phone app and opens it in Xcode |
| `npm run dev` | The interface alone in a browser, with a stand-in backend |

Builds use a Developer ID certificate when your keychain has one, so macOS
keeps permissions such as Full Disk Access across rebuilds; otherwise they are
signed ad hoc (`APEX_DECK_SIGN_IDENTITY=-` forces ad hoc). See
[docs/desktop.md](docs/desktop.md) for how the app, daemon and browser fit
together.

## Using Apex Deck

**Start a thread.** **+ New thread**, then **+ Add model**. Pick how to reach
the bot under **Connect through**, and optionally a model and reasoning
level. Save a bot you like to **Agents** to reuse it. No models yet? **Try a
sample thread** opens one with two scripted bots.

| Preset | What it runs |
|---|---|
| Claude Code | `claude -p` in its event mode, once per turn |
| Codex | `codex app-server` (falls back to `codex exec --json`) |
| Gemini CLI | `gemini -p`, once per turn |
| Ollama | Your local Ollama server |
| Other API | Any OpenAI-compatible endpoint, with tools Apex Deck runs for it (below); model list, reasoning, context and balance shown where the provider reports them |
| Custom command | A command you enter |
| Scripted | Canned lines for testing |

Agents run in the project folder with the same PATH as your terminal. Exact
flags are in `crates/apex-adapters/src/presets.rs`. Each reply is a separate
run of that tool and counts against your subscription or credits.

**API keys.** Paste a key in the bot form. Apex Deck keeps it in the macOS
Keychain (or a file only you can read on Linux) and never shows it again.

**Access levels.**

| Level | What the bot may do |
|---|---|
| Read only | Read files. No edits, no commands. |
| Ask first | Propose each edit and command, and wait for Approve or Reject. |
| Can edit files | Edit files in the project without asking. |
| Full access | Edit files and run commands without asking. |

For Claude Code and Codex the level becomes the tool's own permission
settings. For a custom command it is an instruction to the model.

**Tools for API bots.** Ollama and Other API bots get tools that Apex Deck
runs for them in the thread's folder: read, find and search files, write and
edit files, run shell commands (also in the background for the rest of the
reply), fetch web pages, keep a to-do list, ask you questions, and use your MCP
servers. The MCP servers are the ones Claude Code is set up with: user-wide and
per-project entries in `~/.claude.json`, and a project's `.mcp.json` only for
servers you approved there. A server starts the first time a bot uses it.
The access level decides what each tool may do:

| Level | Read and search | Edit files | Run commands |
|---|---|---|---|
| Read only | Yes | No | No |
| Ask first | Yes | Asks | Asks |
| Can edit files | Yes | Yes (outside the project: asks) | Asks |
| Full access | Yes | Yes | Yes |

At every level, reading outside the project and fetching a web page ask unless
the bot has Full access, and so do edits to files that can start programs
(`.mcp.json`, `.claude/`, `.git/`, `.codex/`, `.vscode/`), and MCP tools that can spend money or publish always
ask. Plan mode allows reading only, until you approve the bot's plan. A model
that doesn't take tools answers without them and is told it has none.

**Thread commands.**

- `/pin <fact>` puts a fact in every bot's instructions on every turn.
- `/compact` summarizes earlier turns; `/clear` empties the chat but keeps
  bots and pins.
- `/diff` shows changes in the project since the thread started.
- `/fork [name]` copies the conversation into a new thread.
- `/export` saves Markdown to Downloads; `/export json` saves JSON.
- `!` suggests the addressed bot's tool servers, e.g. `@bot !x-mcp read my posts`.
- Start a message with `//` to send a literal `/`.

Paste, drop or attach photos and files (20 MB each). Bots get a path to the
file and open it with their own tools.

**Shortcuts** (Ctrl+Shift instead of ⌘ on Windows and Linux):

| Keys | Action |
|---|---|
| ⌘1 ⌘2 ⌘3 | Agents, Code, Threads |
| ⌘T / ⌘N | New terminal / New thread |
| ⌘J | Go to what most needs you |
| ⌘[ ⌘] | Previous or next pane |
| ⌘⇧Enter | Maximize or restore the focused pane |
| ⌘, | Settings |

## Saved data

Everything is saved automatically by `apex-daemon`. On a Mac that is
`~/Library/Application Support/dev.apexdeck.app/`. Running bot turns and
terminal processes are not restarted after a quit: terminals come back
Stopped until you start them. Restarting the daemon interrupts replies in
progress.

## Project layout

| Path | What it is |
|---|---|
| `crates/apex-core` | Group chat logic: participants, transcripts, turn taking |
| `crates/apex-adapters` | Backends: command-line agents and HTTP providers |
| `crates/apex-host` | Threads, terminals, ApexAgent, saved data, the commands the interface calls |
| `crates/apex-daemon` | The service that runs a host on a Mac or Linux server |
| `crates/apex-pairing`, `crates/iroh-mobile` | Phone pairing and the phone's iroh connection |
| `desktop` | The Electron app |
| `src` | The interface (React, TypeScript, xterm.js); `src/phone` is the phone app |
| `iphone` | The iPhone (Capacitor) project |
| `docs` | Design notes, setup guides and release notes |

## Tests

```sh
cargo test --workspace   # chat logic, adapters, terminals, the daemon
npm test                 # interface and desktop shell logic
npm run build            # type-check and bundle the interface
npm run test:e2e         # the protocol client against a real apex-daemon
npm run desktop:smoke    # the Electron app, driven end to end
```

Adapter tests use a local mock server and need no API key.

## Roadmap

See [SPEC.md](SPEC.md).

## License

MIT. See [LICENSE](LICENSE).
