# Apex standalone CLI

The CLI starts or reuses the same local backend as the desktop. Agents and
threads persist in one shared store, regardless of which interface is installed
first; the desktop and iOS apps remain optional. On macOS, new installations use
`~/Library/Application Support/dev.apexdeck.app/`. Provider subscription sign-in stays inside the official
Codex and Claude Code runtimes; install those runtimes before provider setup.

### npm install (recommended)

```sh
npm i -g @apex-deck/cli
apex
```

On first run, `apex` prints a one-time setup command:

```sh
sudo "<path-it-prints>/@apex-deck/cli/bin/apex" setup
```

Enter your administrator password once. This installs the root-owned authority
service and enrolls exact binary identities. After that, `apex` opens directly.
Upgrades via `npm i -g @apex-deck/cli` print the same `sudo … setup` hint when
the installed standalone build is older; run it once per new version. To remove
the standalone installation while keeping chat data:

```sh
sudo "$(npm root -g)/@apex-deck/cli/bin/apex" uninstall
```

Data, keys, journal and authority roots are preserved across install →
uninstall → reinstall; only the product binaries and service plist are removed
and recreated.

`@apex-deck/cli` depends on `@apex-deck/cli-darwin-arm64` (Apple Silicon). The
`apex` launcher in `@apex-deck/cli` always execs
`/Library/Application Support/Apex Deck Provenance/Standalone/apex` — never a
copy inside `node_modules`.

### Direct archive install

The macOS Apple Silicon test archive contains signed `apex`, `apex-daemon`, and
`apex-provenance` binaries, with a CLI-only authority installer. From the extracted
archive directory:

```sh
sudo /bin/bash ./install-cli-provenance.sh "$PWD"
apex
```

The explicit administrator step installs the root-owned authority service and
enrolls exact binary identities. It needs no Electron application. When Deck's
authority already exists, the installer preserves its keys, journal and existing
pins, adding separate standalone pins. It restarts that service. It supports
upgrades (same version identical = no-op, rebuilt same version = replaces when
fingerprints differ, older = refused), refuses while `apex` or its backend is
running, and rolls back on failure. The archive is signed, **not notarized**;
installed acceptance is recorded separately in `docs/apex-cli-standalone-results.md`.

From the repository root, the development binary is:

```sh
./target/debug/apex
```

Keep `apex-daemon` beside `apex`. An unsigned debug binary can test startup,
menus and wizard cancellation; login initiation, profile saves and Work actions
fail closed until the exact signed binaries are installed/enrolled.
To select independent data or jump to a thread:

```sh
./target/debug/apex --data-dir /absolute/path/to/data --thread thread-id
```

To explicitly attach to a running Deck backend instead of starting one:

```sh
apex --connect-deck
```

Both interfaces honor an explicit `APEX_DECK_DATA_DIR`; `--data-dir` wins and
selects a separate store deliberately. No import command is needed between
the default CLI and desktop. An existing legacy `~/.apex/` store is selected
in place when it is the only populated store, preserving path-bound authority.
The shared selection is recorded once in `shared-store-v1.json` under the
standard desktop data directory. Both clients use that selection thereafter.
If both old roots already contain data before selection, startup reports the
conflict and preserves both; automatic reconciliation of those histories is
not implemented. `--data-dir` can explicitly select either existing root.
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`
overrides are refused so setup and persistent backend use the same default
provider-owned credential stores. Standalone subscription children do not
inherit API-key, token or alternative-cloud billing overrides.
`--help` and `--version` work without a terminal. Interactive use requires both
stdin and stdout to be terminals. Piped input, generic JSON execution and runtime
injection overrides are refused. `apex backend status` reports the active boot;
`apex backend stop` requires terminal confirmation and a protected receipt.
Quitting the CLI or desktop leaves the shared backend and other clients' work
running. Backend stop affects every connected interface. Both interfaces must
be updated to this build for live agent synchronization and lifecycle behavior;
an older desktop is not upgraded by installing the CLI archive.

## First test

1. `/login` opens Codex/Claude choices. Choose an existing verified subscription,
   official browser sign-in, or Codex device code. This shares the official
   runtime's account with the user's other provider tools; Apex copies no tokens.
2. `/agents create` chooses an attached provider, then asks for name, handle,
   provider default/model ID, multiline instructions and Ask/Read access. Type
   `save` after reviewing the summary. Escape or `/cancel` discards the wizard.
3. Create Jigga and Null independently, or repeat with several agents on one
   provider. `/agents saved` lists profiles; `/agents edit <handle>` edits them.
4. `/new` asks Work or Chat; `/new chat [title]` creates Talk; `/new work` creates Work in the folder your terminal is
   in (or `/new work <folder>`, relative to it) through the protected command path. `/add` selects a saved agent.

API-key entry/Keychain storage and automatic provider runtime installation are
unfinished; this test build exposes subscription methods only. Model entry can
use the provider default or a model ID; there is no model-discovery wizard yet.
Names determine mentions, matching Deck: the handle must match that derived name.

`/agents import /absolute/path/to/session.json` previews supported Codex/Claude
profiles and imports one explicitly chosen profile at a time. Source files are
read-only. It copies name/instructions/model to a standalone name-derived identity,
defaults access to Ask, excludes credentials, executable overrides and grants,
and copies no history. Collisions are skipped; import does not yet offer renaming.

Open an existing disposable thread with `/threads`, or type `/new` and Enter.
A new thread is empty. Use `/add` to choose one of the user's saved profiles,
then send a message. Type `@` to complete a member's current handle. Subsequent
untagged messages follow the daemon's responder selection, as in the app.
`@all` is the last completion entry. The client never expands mentions locally.

Stars use the daemon's `untagged_responders` field. With an older daemon that
does not expose it, responder stars are unavailable; routing still happens in
the daemon. Reopening a thread preserves its own routing state.

## Controls

- Enter sends; Shift+Enter, Alt+Enter, or Ctrl-J inserts a newline. Some terminal
  emulators cannot distinguish Shift+Enter; Alt+Enter and Ctrl-J remain available.
- Bracketed paste inserts text without sending. The composer grows from two to
  eight rows, then scrolls internally. Input is limited to 256 KiB.
- Up/Down select menu rows; Enter or Tab activates one. Mouse selection works in
  menus and recent threads. Completion inserts at the cursor.
- PageUp/PageDown and mouse wheel scroll history. New output follows the bottom
  while the user is already there; scrolling up retains the reading position.
- Esc closes a menu and stops active work in the selected thread. Idle Esc does
  nothing. Ctrl-C exits this client without stopping other clients' work.
- F1 opens Welcome, F2 opens pending approvals/questions, F3 opens Threads,
  and F4 shows members/models/activity/responders.

The client restores raw mode, cursor, alternate screen, mouse capture, bracketed
paste and keyboard enhancements on exit, handled errors, SIGINT, SIGTERM and
panic. No process can restore terminal state after SIGKILL.

## Commands

The app and terminal consume `shared/composer-commands.json`; terminal handlers
remain typed Rust code. `/help` opens the same command choices.

| Command | Behavior |
| --- | --- |
| `/login [codex\|claude]` | Choose and authenticate an official subscription runtime. |
| `/agents create`, `/agents saved`, `/agents edit <handle>` | Manage persistent standalone profiles. |
| `/agents import <absolute-path>` | Preview and import one supported profile with Ask access. |
| `/threads [prefix]` | Open the picker; a unique title/ID prefix opens directly. |
| `/new`, `/new chat [title]`, `/new work [folder]` | Pick Work or Chat, or create Talk, or Work in the terminal's folder (or the given one). |
| `/rename <title>` | Save shared thread metadata. |
| `/add [profile]` | Pick a usable saved agent profile; no fabricated credentials. |
| `/remove [@name]` | Pick and confirm removal. The last member may be removed. |
| `/agents` | Show members, models, access and authoritative stars. |
| `/stop [@name]` | Stop all selected-thread agents or one named member. |
| `/model [@name]` | Choose a daemon-provided model; confirm before saving. |
| `/access [@name]` | Choose and confirm a Work agent's access. Talk threads keep read access. |
| `/clear` | Confirm deletion of this shared thread's messages everywhere. Default is Cancel. Agents/settings stay. |
| `/compact` | Summarize earlier context for the whole thread. |
| `/curate`, `/curate undo` | Use the daemon's whole-thread history curation/undo. |
| `/plan` | Toggle the thread's Plan mode through the protected command path. |
| `/goal [objective]` | Show state or review workers/objective/finite limits before starting. |
| `/loop [10m prompt]` | Show state or review a repeating prompt and finite limits. |
| `/goal pause\|resume\|clear` | Operate the current goal; clear confirms ending or dismissal. |
| `/loop pause\|resume\|clear` | Operate the current loop. Intervals are 10 seconds through 24 hours. |
| `/usage` | Show reported per-agent token totals; missing values say unavailable. |

Goal/loop starts use the app's current defaults: 30 turns/runs, 120 invocations,
two-hour lifetime, and a $5 best-effort reported-cost cap. Unknown provider costs
remain unknown. Revisions and stable request IDs protect runner mutations.

Thread-wide commands reject agent arguments. Unknown slash commands stay local;
absolute paths such as `/usr/local/bin/apex` are messages. Prefix `//` to send a
literal slash command. `/lead`, `/resume`, `/session`, and `/approval` are absent.

F2 decisions show the actual approval or question. Approval needs a separate
confirmation; the default is no approval. Questions support options, free text,
multiple labels separated by `|`, and cancellation. Expired requests are refused
by the daemon, including when another client already resolved them.

## Connection and delivery

The terminal reconnects after 250 ms, 500 ms, 1 s, 2 s, then at most 5 s between
attempts. It preserves the draft during reconnection. Failed thread loads clear
stale thread rows; a live transport still allows onboarding and shows the error.
Events use boot/sequence cursors, per-room recovery cursors, and selection
generations. Stream buffers are bounded; overflow requires an authoritative reload.

Human messages have stable client message IDs. An uncertain submission keeps its
ID and content; a human retry reconciles it with the authoritative transcript.
The client does not automatically replay messages, destructive operations,
configuration changes, approvals, or runner mutations after a disconnect.

All agent text, tool output, titles and notices are rendered as inert text.
Terminal escape/control sequences are stripped. Generated UI payloads are not
executed; the CLI does not advertise interactive generated-answer support.

## Development and signed authority

The debug binary can exercise ordinary shared chat operations against a running
daemon. Protected Work configuration, Plan, runners, approvals and question
decisions require the separately signed, root-installed `dev.apexdeck.cli` build
and an exact CLI CDHash pin in the existing provenance broker. An unsigned
development binary reports the refusal; there is no test/fixture authority switch
in the production client.

After CLI-only installation, `apex` on PATH resolves to:

```sh
'/Library/Application Support/Apex Deck Provenance/Standalone/apex'
```

The `/Applications/Apex Deck.app` copy does not provide that protected launch
path: its parent directory is writable by administrators, so the broker refuses
protected submissions from it. The signed binary must also match `cliCdhash` in
the installed broker configuration.

Old authority configurations keep CLI admission disabled until explicit installer
enrollment. Packaging does not itself install the broker, alter root configuration,
merge a branch or build a DMG.

## Rebuild and disposable acceptance

```sh
cargo build -p apex-cli --bin apex
cargo build -p apex-daemon --features test-support --bin apex-daemon-fixture
cargo test -p apex-cli
node scripts/test-apex-cli.mjs
python3 scripts/test-apex-standalone.py
```

The acceptance script builds a test-only daemon fixture and runs real PTY clients
against short temporary directories under `/tmp`. It does not mutate the user's
chat data. It prints the evidence directory containing terminal captures and
machine-readable results. Fixture interoperability does not establish native
app/phone UI or installed signed-command acceptance.
