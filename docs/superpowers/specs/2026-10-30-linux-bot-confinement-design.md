# Linux: confine bots below Full, then let paired devices act

Status: design for Null's review. No code yet. Answers "Who can act on a Linux
machine" in `2026-10-30-add-a-machine-ssh-design.md`.

## The problem in one picture

    Phone ── signed iroh link ──▶ daemon ──▶ Allow, answers, settings   (refused today)
    Bot below Full ── runs as the same Linux user ──▶ socket, data folder, device list

If the phone can press Allow, anything that can become a device can too. A bot
below Full can reach everything that makes a device. So the bot gets walled off
first, and only then does a device key mean a person.

## What the code does today (wider than the earlier doc said)

- The bubblewrap sandbox in `gateway_sandbox.rs` covers talk-only chats and
  gateway turns only. **In Work threads no provider has an outer sandbox on Linux**,
  so this isn't only a Claude gap, as earlier notes said.
- Below Full, the limits are each tool's own: Claude's permission modes; Codex's
  `--sandbox`, which restricts writes but not reads; Gemini's flags. A read-only
  bot can still read Deck's data folder, including the gateway token and pairing
  files.
- API-model bots run shell commands from `api_tools/shell.rs`, also unconfined.
- Work bots are launched from: `claude_session.rs:373`, `codex_server.rs:1097`,
  `cli.rs:226`, `api_tools/shell.rs`, `api_tools/mcp_client.rs:237`.

## Rule

On Linux, a process acting for a bot below Full never runs outside the jail.
Effective access decides, so a Full bot turned read-only because another bot is
writing counts as below Full. Full is the person, by definition, and is not jailed.

## The jail

One builder, `linux_jail.rs`, used by all five launch points. Bubblewrap around the
whole provider process, so the tool's own Read and Edit are covered, not only Bash.

    /                        read-only
    project folder           writable at Edits and Ask, read-only at Read
    other mounts             as the thread already has them
    Deck data folder         hidden, empty
    attachments folder       read-only, put back inside the hidden data folder
    /run, /var/run           hidden (Deck socket's home if there, D-Bus, systemd --user,
                             docker.sock, ssh-agent, sudo timestamps)
    /tmp                     private; the Codex hook's folder bound back in
    ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, ~/.kube, ~/.netrc,
    ~/.git-credentials, shell history            hidden
    provider config          read-only, see below
    provider session + login files               writable, named one by one
    PID namespace            new, so /proc/<daemon> and ptrace are out of reach
    IPC namespace            new
    network                  shared (bots need their APIs)

Order matters: the hide mounts go last, so a project folder of `$HOME` or `/`
still can't show the data folder. A project folder inside the data folder is refused.

The Ask level gets the same jail. A person approving one command doesn't mean they
meant it to reach Deck's keys, which is the attack Null found.

**Provider config is the trap.** `~/.claude/settings.json` can hold hooks. A jailed
bot that could write it would run code in the next Full bot, outside the jail. So
settings, hooks, plugins, commands, `CLAUDE.md`, `~/.codex/config.toml` and their
Gemini, Grok and Muse versions are read-only. Only session history and the login
file are writable; login stays writable so tokens can refresh. Same reason for
`~/.bashrc`, `~/.profile`, `~/.config/systemd`, `crontab`: `/` and `$HOME` are read-only.

### Things that stop working inside the jail, on purpose

- Bots below Full can't call `apex-daemon` or `$APEX_DECK_BIN`. Each tool bots use
  through it must be listed and moved to the turn's own channel or refused.
- `git push` over SSH keys fails below Full; the bot says so.
- `sudo` fails.

## Machine state: jail works, or authority stays off

At start the daemon runs a real jailed probe that tries to read a marker in the data
folder and connect to the socket; both must fail. The answer is one state:

- **Confined.** Every below-Full launch is jailed. A launch that fails to jail
  fails the turn; it never falls back. Paired devices may act.
- **Not confined** (no bubblewrap, or user namespaces blocked, as Ubuntu 24.04's
  AppArmor setting can do). Bots run as public releases do today, and paired devices
  stay refused. Setup shows "needs bubblewrap (admin)".

No setting turns this on, so there is nothing for a bot to flip. Machines with
bubblewrap get jailed on update, which can break a bot's workflow; that's the cost.

## Who can do what from a paired device

Only on a Confined machine, only through the iroh path in `call_from_device`, which
has the verified device. `authority.rs` already sets the tiers:

| Action | Tier |
|---|---|
| Allow, answer a question, Plan switch | Chat, within the thread |
| Model, reasoning, Speed | Full |
| New Work thread, move a chat | Full, all threads |
| **Raise a bot's access** | Full, all threads, plus the rule below |

**Raising access rule.** The phone sends the bot, old level and new level, and shows
the person that exact change with Face ID first. Raising to Full also needs the folder
named. The daemon refuses a raise whose "old level" doesn't match, so a stale tap can't
apply. Lowering needs only Full tier. `apex-daemon allow-root` stays for folder picks and
doesn't authorize raises.

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

Keep the hashed regions unchanged: extend `Host::device_folder_command`, already
called by the Linux prefix, into a general `device_linux_command(command)`. It needs the
device checks done first, which `remote.rs` already does through `authority::allowed`.

The recipe's `vps-update-allow-test.rs` asserts phone calls are refused. On a test host
with no probe passed the machine is Not confined, so refusal should still hold, but
Apex-Terminal has bubblewrap and I won't depend on that accident. Update the installed
test first; the Human runs one command with their key. `prepare_source` and
`git apply --check` run before merge.

## Build order

1. `linux_jail.rs` + startup probe + tests that try to break out from inside.
2. Route all five launch points; restart a live session when effective access changes
   jail state. Survey and fix tools bots reach through `apex-daemon`.
3. Paired-device rules, raising rule, phone Face ID step.
4. Real runs on Docker and a real VM, all providers, including Ubuntu 24.04 AppArmor.
5. Updater test change, then release.

Null reviews each step. Nothing from step 3 merges before steps 1 and 2 pass.

## Must be proven by a test, not assumed

From inside the jail, as each access level: read the data folder, gateway token and
device list; connect to the socket; `systemd-run --user`; edit `settings.json`,
`.bashrc`, crontab; signal or ptrace the daemon; reach the daemon's abstract sockets, if
any; pair a device; follow a symlink in the project folder to the data folder.

Whether nested sandboxes work: Codex's own sandbox inside bubblewrap.

## Known limits

- A jailed bot can write `.git/hooks` or scripts in its project. They run as the person
  if the person or a Full bot runs them later, outside the jail. Same on any machine.
- Network stays open, so a jailed bot can send out what it can read. The jail guards
  Deck's authority, not project secrecy.
- Login files are readable by the provider running in the jail; it needs them.
- The gateway port on 127.0.0.1 stays reachable, but its key is hidden.
- macOS bots are not changed by this work.
