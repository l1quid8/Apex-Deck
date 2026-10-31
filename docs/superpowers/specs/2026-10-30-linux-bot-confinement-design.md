# Linux: confine bots below Full, then let paired devices act

Status: revision 2, for Null's review. No code yet. Answers "Who can act on a Linux
machine" in `2026-10-30-add-a-machine-ssh-design.md`. Revision 1 was `7bc63529`.

## The problem in one picture

    Phone ── signed iroh link ──▶ daemon ──▶ Allow, answers, settings   (refused today)
    Bot below Full ── runs as the same Linux user ──▶ socket, data folder, device list

If the phone can press Allow, anything that can become a device can too. A bot
below Full can reach everything that makes a device. So the bot gets walled off
first, and only then does a device key mean a person.

## What the code does today

- The bubblewrap sandbox in `gateway_sandbox.rs` covers talk-only chats and
  gateway turns only. **In Work threads no provider has an outer sandbox on Linux.**
- Below Full, the limits are each tool's own: Claude's permission modes; Codex's
  `--sandbox`, which restricts writes but not reads; Gemini's flags. A read-only
  bot can still read Deck's data folder, including the gateway token and pairing
  files.
- API-model bots run shell commands from `api_tools/shell.rs`, also unconfined.
- Work bots are launched from: `claude_session.rs:373`, `codex_server.rs:1097`,
  `cli.rs:226`, `api_tools/shell.rs`, `api_tools/mcp_client.rs:237`.
- `api_tools/mcp_client.rs:515` keeps live MCP links in a map that doesn't know the
  bot's access level, and it also speaks HTTP MCP from the daemon itself.
- `gateway_sandbox.rs:738` has a test forbidding `--new-session`, because
  `owned_process.rs:60` stops bots by process group.

## Rule

On Linux, a process acting for a bot whose set level is below Full never runs outside
the jail. The set level decides: the level a person chose for that bot, including one
lowered from Full.

**Changed from revision 1.** Revision 1 said effective access decides, so a Full bot
waiting for the write slot would be jailed. That's wrong. The slot is about two bots
editing at once, not about trust, and that bot was outside the jail a moment ago, so
jailing it buys nothing and restarts it on every slot change. Slot and Plan limits stay
as they are today, enforced by the tool's own flags. An Edits bot without the slot keeps
its writable mount and is held by those same flags.

Full is the person, by definition, and is not jailed.

## The jail

One builder, `linux_jail.rs`, used by all five launch points. Bubblewrap around the
whole provider process, so the tool's own Read and Edit are covered, not only Bash.

### Process boundary

Every jail has all of these. The breakout tests check each one from inside.

- **New session, without `--new-session`.** Bubblewrap's flag would break group stop,
  as the test above records. Instead the registry calls `setsid()` in the child for
  jailed launches, replacing `process_group(0)`. The child becomes session and group
  leader, so its group id is still its own pid, and it has no controlling terminal to
  inject keystrokes into. `setsid()` fails on a process already leading a group, so the
  two calls are exclusive.
- **`/proc`:** fresh, from `--proc`, inside a new PID namespace. The daemon isn't
  visible there.
- **`/dev`:** the small set from `--dev`, with its own `devpts`.
- **Namespaces:** PID, IPC, UTS, cgroup and network are all new, see Network below.
  `--die-with-parent` stays.
- **Environment:** cleared, then an allowlist, as `gateway_sandbox.rs:309` does. Only
  the one provider key the bot needs is added. Nothing named for Deck's socket, data
  folder, gateway or `$APEX_DECK_BIN` passes through, nor `SSH_AUTH_SOCK`,
  `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `DISPLAY` or `WAYLAND_DISPLAY`.
- **Open files:** the test lists `/proc/self/fd` inside the jail, on a daemon with its
  listener, database and iroh sockets open. Only stdio and named jail pipes may appear.
  Rust opens files close-on-exec, so this should already hold; the test makes it a fact.

### Network

**Added in this revision.** Revision 1 shared the network, and listed the gateway port
as a harmless limit. It isn't: a shared network also shares every abstract Unix socket
and every loopback service. On a Linux desktop the X11 abstract socket lets a jailed
bot type into a person's terminal, which is a plain escape. seccomp can't read the
address inside `connect()`, and Landlock's abstract-socket scope needs kernel 6.12
where Ubuntu 24.04 has 6.8.

So the jail gets `--unshare-net`, and its only way out is a daemon-run proxy:

    bot ─▶ HTTPS_PROXY 127.0.0.1 inside jail ─▶ forwarder ─▶ bound Unix socket ─▶ daemon proxy ─▶ internet

- The proxy resolves the name, refuses loopback, private, link-local and cloud metadata
  addresses, then connects to the address it checked, so a name can't switch afterwards.
- Below Full, raw TCP and `git` over SSH stop working. HTTPS through the proxy works.
- A provider that ignores the proxy can't reach its API. Step 1 tests each one. Such a
  provider is marked "can't run below Full on this machine". There's no shared-network
  fallback.

Cost: one more moving part, and some package tools will need proxy settings. I still
recommend it, because the alternative is an escape on every desktop Linux machine.

### Filesystem

    /                        read-only
    project folder           writable at Edits and Ask, read-only at Read
    other mounts             as the thread already has them, same refusal rule
    Deck data folder         hidden, empty
    attachments folder       read-only, put back inside the hidden data folder
    /run, /var/run           hidden (Deck socket's home if there, D-Bus, systemd --user,
                             docker.sock, ssh-agent, sudo timestamps)
    /tmp                     private; the Codex hook's folder bound back in
    ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, ~/.kube, ~/.netrc,
    ~/.git-credentials, shell history            hidden
    provider homes           see Provider config

Hide mounts go last, so they win over anything bound before them.

### Writable folders are refused, not patched

Null's finding: with `$HOME` as a writable project, hiding Deck's data isn't enough,
because `~/.local/bin/codex` and `.bashrc` are then writable. A list of files to protect
back can't be complete: `.zshenv`, `.npmrc`, `.cargo/bin` and so on. So don't try.

Before every jailed launch, each writable path is resolved with `canonicalize`, which
follows symlinks and `..`. The launch is refused at Edits and Ask, and allowed at Read,
if the path:

- is `/` or `$HOME`, or contains `$HOME`;
- is inside, or contains, a protected path: the data folder, `~/.local`, `~/.config`,
  `~/.ssh` and the hidden list above, any provider home, the folders holding the daemon
  and systemd unit;
- contains any directory on the launch `PATH`, or the resolved file of the provider,
  a Node or Python runtime it uses, or a configured MCP command.

Message: "This folder holds your login files. Pick a folder inside it, or use Full."
A folder pick is rechecked at launch, because a symlink can change after it was chosen.

### Provider config

Revision 1 said settings read-only, login and session files writable "named one by
one". That fails for two reasons found while checking this review:

- **Claude's `~/.claude.json`** holds user `mcpServers` (checked on this Mac), and
  Claude writes to that file constantly. A jailed bot able to write it could add a
  server that runs in the next Full bot, outside the jail.
- **Single-file binds break atomic saves.** Saving by rename onto a bind mount gives
  `EBUSY`, so a refreshed login token can't be saved that way.

So each jailed bot gets a private provider home, `jail-homes/<room>/<bot>/`, under the
data folder and visible only to its jail:

- **Copied in, never copied back:** settings, hooks, plugins, commands, instruction
  files, `~/.claude.json`, `config.toml` and the Gemini, Grok and Muse versions.
  Changes die with the jail.
- **Directory binds, writable:** session history only, such as `~/.claude/projects` and
  `~/.codex/sessions`.
- **Copied back by the daemon when the jail ends, or during it on a change:** only the
  named login file, after checking it parses as that provider's login format.

Custom homes count: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `MUSE_AUTH_PATH`.
The builder resolves them per launch and treats them as protected paths.

**Project-local config.** Claude and others load config from the project, which a jailed
bot can write. A hook placed there runs automatically in a Full bot.

- These names are mounted read-only inside writable folders: `.claude/`, `.codex/`,
  `.gemini/`, `.grok/`, `.muse/`, `.mcp.json`. Missing ones get an empty placeholder as
  the mount point, removed when the jail ends and swept at the next launch if a crash
  left one. `CLAUDE.md` and `AGENTS.md` stay writable: they are instructions, not code,
  and bots edit them for real.
- **Hook, plugin and MCP targets:** the builder reads the config at launch. Any file a
  hook or MCP command names inside a writable folder is mounted read-only. If a command
  can't be resolved to a file, such as `$(...)` in a shell string, Edits and Ask are
  refused in that folder, and the message names the hook.

## Changing a bot's level

Null's finding: restarting the provider isn't enough, because MCP servers, running
commands and background children keep the old authority.

Each jail is one PID namespace, so ending its first process ends every descendant,
including ones that called `setsid` or double-forked. That's why the order is:

1. Refuse new tool calls for that bot, and end its turn.
2. Stop the whole process: group kill, then wait until it's reaped.
3. Drop that bot's MCP links and clear their cached tool lists. The map key gains the
   bot and level, so a link can never be reused across levels.
4. Save the new level.
5. The next turn launches fresh.

If step 2 fails, the level stays as it was and the change reports the failure. The
lower level only counts once the old process is gone.

**Limit:** a Full bot lowered to Read has no PID namespace, so group kill stops what
Deck launched, but something it deliberately detached survives. Full could already have
left anything behind, in `.bashrc` for example, so lowering it can't undo earlier Full
work. The screen says so: "Stops this bot from now on. It doesn't undo what it did at
Full."

**HTTP MCP below Full.** Wrapping a launch can't confine an HTTP server that runs
elsewhere. Rule: below Full, the daemon's API-bot client and the proxy both refuse
loopback, private and link-local MCP addresses. Public HTTP MCP servers still work,
since they don't act on this machine. Stdio MCP servers run inside the jail. Provider
CLIs reach HTTP MCP through the same proxy, so the rule holds for them too.

## Machine state: jail works, or authority stays off

At start the daemon runs a real jailed probe that tries to read a marker in the data
folder, connect to the socket, reach a loopback listener and an abstract socket it
opened, and reach the outside through the proxy. The first four must fail, the last must
work. The answer is one state:

- **Confined.** Every below-Full launch is jailed. A launch that fails to jail
  fails the turn; it never falls back. Paired devices may act.
- **Not confined** (no bubblewrap, or user namespaces blocked, as Ubuntu 24.04's
  AppArmor setting can do). Bots run as public releases do today, and paired devices
  stay refused. Setup shows "needs bubblewrap (admin)".

The state shows on the machine's row. No setting turns this on, so there is nothing for
a bot to flip. Machines with bubblewrap get jailed on update, which can break a bot's
workflow; that's the cost.

## Who can do what from a paired device

Only on a Confined machine, only through the iroh path in `call_from_device`, which
has the verified device. `authority.rs` already sets the tiers:

| Action | Tier |
|---|---|
| Allow, answer a question, Plan switch | Chat, within the thread |
| Model, reasoning, Speed | Full |
| New Work thread, move a chat | Full, all threads |
| **Anything that raises access** | Full, all threads, plus the rule below |

### What counts as raising access

Checking routes one by one is how one gets missed. So add
`authority::access_effect(command)` beside `command_needs`, an exhaustive match with
no wildcard arm: a new command doesn't build until it's classified.

Classified as able to raise, from reading `Command`:

| Route | How it raises |
|---|---|
| `RoomAddParticipant`, `RoomUpdateParticipant` | sets a level; Full tier but only one thread today |
| `RoomCreate`, `RoomImport`, `RoomFork` | new thread carrying levels |
| `ChatPromote` | the access map |
| `ChatAddParticipant`, `ChatUpdateParticipant`, `ChatImport` | must be proven to carry no level. `ChatBotPatch` already refuses `access` (`host.rs:5144`). Refused if they can |
| `RoomMount` | widens what a level can write |
| `RoomRewind`, `RoomRevert`, `RoomRevertPlan` | must be proven not to restore an older, higher level |
| `RoomRunnerStart`, `PersonalProjectDelegate`, `AssistantHandoffPrepare` | must be proven not to create or restore a bot at a higher level |
| `SessionSave`, `SettingsSave` | a saved session or default could carry levels |
| `RoomDecide` | must be proven that no choice raises a level, such as a "don't ask again" that changes mode |

A limited device is refused on every route that can raise. Step 3 starts by reading
each "must be proven" row and recording the answer with a test.

**Restore at startup.** The saved level on disk is only as good as who could write it,
and the data folder is out of a jailed bot's reach. So startup needs no extra check,
provided `SessionSave` can't set a level from a device. It's tested as such.

**A test for the whole class:** a limited device runs every command with fixture
payloads containing `"access":"full"`, and afterwards no bot on the host has a higher
level than before.

### What the daemon checks when access is raised

Under the same room lock as the write, the daemon checks:

1. The call came over iroh from a device in the device list, so the key was verified.
2. That device is Full tier with all threads.
3. The machine is Confined.
4. The request's `old_level` equals the saved level, or it's refused as stale. The
   check and the write are one atomic step.
5. For Full, the request names a folder that equals the thread's folder.

**The daemon does not check Face ID, and the protocol has no such field.** A flag sent
by the phone proves nothing. Face ID is the phone's own guard against someone holding
an unlocked phone, and it stops nobody with the device key. That's acceptable for one
reason: a Full, all-threads device already has `PtySpawn`, a shell on the machine, so
this rule adds no new power to take. A real proof would be a Secure Enclave key signing
the exact change, and I don't recommend it until a tier exists that can raise access
but can't open a terminal.

Lowering needs Full tier in that thread. `apex-daemon allow-root` stays for folder picks
and doesn't authorize raises.

The local socket, CLI and any SSH session keep today's refusal. No exemption by
caller, process or cgroup.

**Pairing itself:** `pair`, `devices` and similar stay local-socket only. The jail is
what keeps bots from them. Someone with a shell or a Full bot can add a device; that
is the person.

## Mac over SSH

The Mac's live link to a Linux machine arrives on the local socket, so it stays
refused. Second step, not in this build: the Mac pairs like a phone and sends these
actions over iroh. Apex-Terminal keeps its carried patch until then, with its known
weakness. New machines from Add a machine don't have the patch, so the Mac app can
chat there but not press Allow. The phone can.

## Update guard

Revision 1 kept the hashed regions the same and moved the change into a helper they
already call. Unchanged hashes wouldn't then prove unchanged authorization, so that's
dropped.

- The Linux branch of `call_from_device` changes openly, and the recipe's expected hashes
  are updated to match.
- The hashed set adds the new helper, `authority::access_effect` and the Confined state.
- `vps-update-allow-test.rs` asserts both sides: Not confined refuses every device
  action, Confined allows only what the tier table says and still refuses socket callers.

Order: update the installed recipe and test first, with one command the Human runs with
their key. `prepare_source` and `git apply --check` run before merge.

## Build order

1. `linux_jail.rs`, the proxy, the startup probe, the breakout tests. First a spike:
   does each provider work behind the proxy, in a private home?
2. Route all five launch points. Change-level order, MCP key. List every tool bots reach
   through `apex-daemon`, then move each to the turn's channel or refuse it.
3. `access_effect`, paired-device rules, raising rule, phone Face ID step.
4. Real runs on Docker and a real VM, all providers, including Ubuntu 24.04 AppArmor and
   a desktop session with X11.
5. Updater recipe change, then release.

Null reviews each step. Nothing from step 3 merges before steps 1 and 2 pass.

## Things that stop working below Full, on purpose

- `apex-daemon` and `$APEX_DECK_BIN`.
- `git push` over SSH keys, and any non-HTTPS network use.
- Access to services on this machine or its private network, such as a dev database or
  a dev server on localhost that the bot didn't start itself. Servers started inside the
  jail still work on the jail's own loopback.
- `sudo`.
- Edits and Ask in `$HOME` or `/`.

## Must be proven by a test, not assumed

From inside the jail, as each level: read the data folder, gateway token and device
list; connect to the socket; `systemd-run --user`; write `settings.json`, `.bashrc`,
crontab, `~/.claude.json`, `.claude/settings.json` in the project, and a file a hook names;
signal or ptrace the daemon; reach an abstract socket, X11, `127.0.0.1` and the cloud
metadata address; pair a device; `TIOCSTI` on any terminal; find an inherited descriptor.

Alternate paths: a symlink in the project to the data folder, a bind or symlink project
that resolves to `$HOME`, `..` in a mount, a symlink swapped between check and launch,
a project on a case-insensitive or second mount of the same folder.

Retiring: a bot's `setsid` background loop, a double-forked child and a stdio MCP server
are all gone before a lowered level is saved; a killed `bwrap` leaves no process behind;
a cached MCP link isn't reused after a level change.

Also: group stop still works with `setsid()`; Codex's own sandbox works nested in
bubblewrap; login refresh survives through copy-back; two bots of one provider in one
project don't overwrite each other's private home.

## Known limits

- A jailed bot can edit project files that run later: `.git/hooks`, `package.json`
  scripts, a `Makefile`. They run as the person if a person or a Full bot runs them.
  Only config that loads automatically is protected. Same on any machine.
- Session history is writable, so a jailed bot could plant text a Full bot reads on
  resume. That's misleading text, not code.
- Network stays open to public addresses, so a jailed bot can send out what it can read.
  The jail guards Deck's authority, not project secrecy.
- Login files are readable by the provider running in the jail; it needs them.
- macOS bots are not changed by this work.
