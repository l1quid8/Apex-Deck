# Linux: confine bots below Full, then let paired devices act

Status: revision 6, for Null's review. No Deck code yet. The "Spike" results below came
from throwaway Docker runs against revision 3. The snapshot Git results came from a script
on Git 2.25, 2.43 and 2.54, not from Deck's code.
Answers "Who can act on a Linux machine" in `2026-10-30-add-a-machine-ssh-design.md`.
Earlier revisions: `7bc63529`, `4227a3e5`, `9812b519`, `e4316011`, `26348014`.

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
- `gateway_sandbox.rs:353` already builds a private root from named system folders
  rather than binding `/`. This design reuses that shape.
- `codex_hook.rs:78` reaches the daemon over a Unix socket, and `phone_env.rs:38` hands
  bots the daemon socket. Neither can stay as it is inside the jail.
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
  listener, database and iroh sockets open. Only stdio and the jail's control socket may
  appear.
  Rust opens files close-on-exec, so this should already hold; the test makes it a fact.

### Unix sockets

**Added in this revision.** Null's finding, and it's real. Spike on Ubuntu 24.04's
bubblewrap, kernel 7.0: with the project read-only and a new network namespace, a jailed
process connected to a host service's socket inside the project and got its reply.
Read-only mounts don't stop `connect()`, and network namespaces only separate abstract
sockets. Landlock's rule for this isn't on the kernels we need.

So a jailed process may not make a Unix socket at all. A seccomp filter, passed with
bubblewrap's `--seccomp`, refuses:

- `socket()` with domain `AF_UNIX`. The domain is a plain argument, so seccomp can see
  it, unlike the address inside `connect()`.
- `socketpair()` of type `SOCK_DGRAM` or `SOCK_SEQPACKET`, whose sockets can be pointed
  somewhere else. Stream pairs stay, because they are already connected and can't be
  redirected; Node and Python use them for child processes.
- `io_uring_setup`, which would make the same socket without the system call.
- Any other syscall ABI: x32 numbers and 32-bit `socketcall`, otherwise a compat binary
  walks around the filter.

The filter is a small fixed BPF program for x86_64 and arm64, built by `linux_jail.rs`
with no new library. It is inherited by every descendant and can't be removed.

Three details, from Null's review. Checks on `socketpair` mask the type's flag bits, so
`SOCK_DGRAM|SOCK_CLOEXEC` can't pass as an unknown value; the rule allows `SOCK_STREAM` and
refuses everything else, rather than listing what's bad. Checking the architecture isn't
enough on x86_64, because x32 calls share `AUDIT_ARCH_X86_64`, so the filter also refuses
any syscall number with bit 30 set. These two are new since the spike and are untested.

Spike result under this filter: the host-socket connect is refused; `git`, `npm`, Node
child processes, a Node server on the jail's loopback, and `claude` and `codex` start-up
all work. A real signed-in turn is still unproven, so step 1 tests it per provider.

There is no list of permitted socket paths, because nothing in the jail needs one. Bots
reach the daemon by one inherited channel:

    daemon ── socketpair, fd inherited at launch ──▶ forwarder in the jail
           ── a fresh connected fd for each request, sent over SCM_RIGHTS ──▶

The forwarder listens on the jail's own loopback and joins each TCP connection to a
fresh fd, so it never calls `socket(AF_UNIX)` and no socket file exists in the jail.
Spike: this passes bytes both ways with the filter on. Each connection opens with a
purpose, either `proxy` or `codex-hook`. The daemon checks it against that jail's bot, so
the channel carries only those two. A bot that hijacks the forwarder gains nothing,
because the daemon applies the same rules to every connection.

`--codex-hook` changes to use this loopback port inside a jail, with a per-launch token,
since its socket at `codex_hook.rs:78` can't be opened there. `APEX_DECK_PHONE_SOCKET`
isn't passed below Full.

### Network

**Added in this revision.** Revision 1 shared the network, and listed the gateway port
as a harmless limit. It isn't: a shared network also shares every abstract Unix socket
and every loopback service. On a Linux desktop the X11 abstract socket lets a jailed
bot type into a person's terminal, which is a plain escape. seccomp can't read the
address inside `connect()`, and Landlock's abstract-socket scope needs kernel 6.12
where Ubuntu 24.04 has 6.8.

So the jail gets `--unshare-net`, and its only way out is a daemon-run proxy:

    bot ─▶ HTTPS_PROXY 127.0.0.1 inside jail ─▶ forwarder ─▶ inherited channel ─▶ daemon proxy ─▶ internet

- The proxy accepts only `CONNECT` to port 443. Plain HTTP and other ports are refused.
- It resolves the name and connects to the address it checked, so a name can't switch
  afterwards. It refuses loopback, RFC 1918, link-local, CGNAT `100.64.0.0/10` (Tailscale
  lives here), IPv6 local ranges, IPv4-mapped and NAT64 forms of any of those, and cloud
  metadata addresses.
- **The machine's own addresses:** it also refuses every address on the machine's
  interfaces, read fresh per connection, plus the public address iroh observes for this
  machine. A public address on the box is no more outside than `127.0.0.1` is.
- **What this can't see:** a service published through a tunnel or a reverse proxy on
  another machine. Any stranger can already reach that URL, so the bot gets nothing a
  stranger lacks, provided it holds no credential for it. That proviso is why HTTP MCP is
  off below Full, see below.
- Below Full, raw TCP and `git` over SSH stop working. HTTPS through the proxy works.
- A provider that ignores the proxy can't reach its API. Step 1 tests each one. Such a
  provider is marked "can't run below Full on this machine". There's no shared-network
  fallback.

Cost: one more moving part, and some package tools will need proxy settings. I still
recommend it, because the alternative is an escape on every desktop Linux machine.

### Filesystem

    /                        private and empty; only the entries below exist
    /usr /bin /sbin /lib*, the /etc entries from gateway_sandbox.rs     read-only
    PATH folders, provider and runtime install folders                  read-only
    project folder           writable at Edits and Ask, read-only at Read
    other mounts             as the thread already has them, same refusal rule
    Deck data folder         hidden, empty
    attachments folder       read-only, put back inside the hidden data folder
    /tmp                     private; the Codex hook's folder bound back in
    provider homes           see Provider config

**Changed from revision 2.** That revision bound `/` and hid a list of secrets, and the
list could never be complete. Now nothing is present unless named, as the chat sandbox
already works. `/run`, `/var/run`, `~/.ssh`, `~/.aws` and the rest aren't there at all,
which also removes most host sockets from view. A named PATH folder that overlaps a
protected path, such as `~/.ssh`, isn't bound.

Nothing is mounted over a bound folder to hide part of it. Such a hide can't hold: a
path that's missing at launch has nothing to cover, and the kernel drops a mount from
every namespace when its path is removed or replaced on the host, which an atomic save
or a fresh login does. Tested on 7.0: `~/.aws` made later, `.claude.json` replaced by
rename and `~/.ssh` swapped for a new folder all became readable in a running jail.

### Writable folders are refused, not patched

Null's finding: with `$HOME` as a writable project, hiding Deck's data isn't enough,
because `~/.local/bin/codex` and `.bashrc` are then writable. A list of files to protect
back can't be complete: `.zshenv`, `.npmrc`, `.cargo/bin` and so on. So don't try.

Before every jailed launch, each writable path is resolved with `canonicalize`, which
follows symlinks and `..`. The launch is refused at Edits and Ask if the path:

- is `/` or `$HOME`, or contains `$HOME`;
- is inside, or contains, a protected path: the data folder, `~/.local`, `~/.config`,
  `~/.ssh`, `~/.gnupg`, `~/.aws`, any provider home, the folders holding the daemon
  and systemd unit;
- contains any directory on the launch `PATH`, or the resolved file of the provider,
  a Node or Python runtime it uses, or a configured MCP command.

Protected content is compared through the mount table, as device plus path inside that
filesystem. Both sides count every mount below them: a project's nested mounts, and any
filesystem mounted inside a protected folder, so a second view of `~/.ssh/keys` on its own
tmpfs is that folder's content. Home and `PATH` folders count only their own content, so a
project that is its own mount under home stays allowed. A bind mount can show the
same content under an unrelated path, so comparing names, or walking up from a path, misses
it (Null's Task 1 review reproduced both directions).

At Read, a path is refused if it's inside a protected path, holds one, or shows any of its
content under any name, whether or not that protected path exists yet. So `$HOME`, `/` and
any folder around a home are refused at Read too. The other three rules above don't
apply at Read. If the table can't be read the launch stops. Hard links aren't visible this
way: a file hard-linked out of a protected folder into a project stays readable. Only a
person can make one of those, because the source isn't in the jail, so it's a stated limit.
The table is read once per launch; mounts made later by a person or a Full bot are outside
the guarantee.
A person who deliberately points a login path into a project, for example by making
`~/.aws` a symlink to a folder inside it, is also outside this boundary: the path is
resolved at launch, and that project's bot can see what's written there later.

Message: "This folder holds your login files. Pick a folder inside it, or use Full."
A folder pick is rechecked at launch, because a symlink can change after it was chosen.

### Provider config

Revision 3 copied the host's config into a private home, then scanned it for automatic
commands against a table of known keys. Null's finding: a test on sample configs can't see
a key that a later provider version adds. **The scan is gone,** along with its refusal of
Edits and the read-only project-config placeholders. Two facts replace them:

- Code that runs inside the jail can't reach device authority, however it got started, so
  automatic commands in the jail don't need refusing.
- The danger is lower-writable code running outside the jail, and Lower-writable folders
  below closes that for hooks, `.git/hooks` and everything else in one rule.

Each jailed bot gets a private provider home, `jail-homes/<room>/<bot>/`, under the data
folder and visible only to its jail. It's **generated, not copied**: Deck writes a minimal
config from the values it set itself (model, reasoning, Deck's own hook) plus an allowlist
per provider. A setting not on the list isn't carried, so an unknown key can't arrive by
default. The host's `~/.claude`, `~/.claude.json`, `config.toml`, plugins and instruction
files aren't in the jail's view at all, as the private root already ensures, nor is a
custom `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` or `MUSE_AUTH_PATH`, each treated as a
protected path.

- **Stdio MCP servers:** carried by name from a person's config and run in the jail.
- **Directory binds, writable:** session history only, such as `~/.claude/projects` and
  `~/.codex/sessions`.
- **Copied back by the daemon when the jail ends, or during it on a change:** only the
  named login file, rewritten from its known fields after parsing, so an extra field
  doesn't reach a Full bot. Atomic saves give `EBUSY` on a single-file bind, so login
  refresh can't use a bind.

Project config loads as usual inside the jail. `CLAUDE.md`, `AGENTS.md`, `.claude/` and the
rest stay writable. A hook a bot plants there runs jailed, at the bot's own level.

Costs: below Full, plugins and custom hooks don't load, and a new provider setting needs
adding to the list before jailed bots see it. A provider that won't start on a generated
home is "can't run below Full on this machine", found in step 1.

### Lower-writable folders

**New in this revision.** Null's finding, and checking it found more than `.git/hooks`.
Deck itself runs things in project folders outside any jail:

- `project_check.rs:113` runs a project command with `sh`, and `runner/checks.rs:33` runs
  configured checks. Starting a runner is only Chat tier (`authority.rs:172`).
- `bot_copies.rs:520` runs `git status` with no hardening, so a `core.fsmonitor` a jailed bot
  put in `.git/config` runs outside the jail. Only some paths set `core.fsmonitor=false`
  (`git_changes.rs:66`, `monitor_evidence.rs:396`, `personal_worker.rs:148`), and that
  flag doesn't cover `diff.external` or a `filter.*.clean` driver, so it can't be completed.

One rule covers these, hooks and project scripts alike:

> **Deck's automatic project operations never run a jailed bot's code outside the jail, and
> a Full bot doesn't start in a folder a jailed bot could write until a person accepts that
> folder.**

**Taint.** A jail with a writable folder records that folder, resolved, in the data folder.
The record is on disk before the jail starts, and it is never cleared by Deck.
Read-only jails record nothing, so Full alongside Read has no gate.

**Deck's own work always jails.** Every project-folder spawn goes through one function,
`project_process()`. On a tainted folder it runs the command in a jail at Edits, accepted or
not: `git` in `bot_copies.rs`, changes, runner and project checks. A test fails on a raw
spawn outside it.

**Snapshots stay outside the jail, with Git isolated.** Revision 4 exempted
`checkpoints.rs:95` on the claim that it reads no repository config. That was wrong. Null ran
a project script through a global `filter.*.clean` and `.gitattributes`, and I reproduced it.
It's also worse than that finding, because it needs no global config: a nested repository
in the folder, with `core.fsmonitor` in its own `.git/config`, ran that command during the
snapshot's `git add --all`.

Snapshots can't simply move into the jail, because the store lives in the hidden data folder.
They need no project code either, only bytes. Three parts make that true, and all three are
needed. Revision 5 had only the first, and Null showed it wasn't enough: a global
`init.templateDir` put a filter in the store's own config, and `.gitattributes` still changed
CRLF to LF.

*Every Git call is isolated.* One function runs all of them, including `git init` in
`store()` and `gc` in `compact()`, which today run separately with no hardening. It sets:

    GIT_CONFIG_NOSYSTEM=1  GIT_CONFIG_GLOBAL=/dev/null  GIT_ATTR_NOSYSTEM=1
    HOME and XDG_CONFIG_HOME = an empty Deck folder
    -c core.attributesFile=  -c core.fsmonitor=false  -c core.hooksPath=/dev/null

and clears every inherited `GIT_*` variable it doesn't set itself, including
`GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`. The `HOME` line isn't a spare: Git before 2.32
ignores `GIT_CONFIG_GLOBAL`, so without it Ubuntu 20.04's Git 2.25 would read the person's
config.

*The store is rebuilt, never trusted.* New stores use `git init --bare --template=`. Before
the first use of a store in each daemon run, old or new, Deck makes a scratch store the same
way next to it, copies its `config` over the store's, deletes `hooks/` and writes
`info/attributes`. Copying from a scratch init keeps what Git probes per filesystem
(`ignorecase`, `symlinks`), and replacing the file removes any `include.path` and
`extensions.worktreeConfig`. Objects are kept, because they're data and nothing runs them. If
this step fails, that snapshot fails and nothing runs Git against the store.

*Attributes can't convert bytes.* `$GIT_DIR/info/attributes` outranks every `.gitattributes`,
including nested ones and macros, on all Git versions. Deck writes one line:

    * !filter !diff !merge -text -crlf !eol !ident !working-tree-encoding

`-text` stops line-ending changes. The others return each attribute to unspecified, so no
driver is named. `diff` stays unspecified rather than unset, so the diff panel still shows
text files as text. This replaces no setting above: a config key that can run code stays
removed even with its attribute cleared.

Spike, on Git 2.25.1 (Ubuntu 20.04), 2.43.0 (Ubuntu 24.04) and 2.54 (macOS), in throwaway
containers on the Linux ones. A planted template put a filter, `core.fsmonitor`, `textconv`
and two hooks into a store through today's plain `git init`. With only the isolation settings,
`git add` ran the project's script three times, which reproduces Null's finding. After the
rebuild, nothing ran across `ls-files`, `add -A`, `write-tree`, `read-tree`, `checkout-index`,
`diff` and `gc`, with a hostile global config, a nested `.gitattributes`, a macro attribute and
a nested repository's `core.fsmonitor` all in place. Stored blobs matched the folder for CRLF
under `text eol=lf`, `eol=crlf`, `ident`, `working-tree-encoding=UTF-16LE`, a filter and a
macro, and restore returned every file byte for byte. Not yet run: `GIT_*` clearing, Git for
Windows, and Deck's own code, which hasn't changed.

**Cost:** snapshots taken before this change can hold converted bytes: LFS pointers,
normalised line endings, re-encoded text. No check can tell which, so they aren't restored at
all. New checkpoints carry `raw: true`. Going back to a checkpoint without it gives "This
snapshot is from an older Deck, so only the chat can go back." One rule replaces revision 5's
LFS pointer check. Later checkpoints in a list are never older than the one chosen, so raw
and old trees are never compared. A one-time loss: Revert to a message from before the update
stops working, on every platform, since one code path is simpler than a Linux branch.

**Full bots are gated.** A Full launch, or a mount, on a folder overlapping a tainted one
is refused until a person accepts it:

    This folder has bots with lower access writing to it.
    A Full bot here can run code they wrote, now or later, as you.
    [ Accept this folder ]   [ Keep Full out ]

Acceptance is per folder and standing, because Full and Edits in one project is a normal
team, and asking at each launch would train people to click. It covers future edits by
lower bots, and the card says so. It's recorded with who and when, listed in the machine's
settings, and can be withdrawn. Withdrawing stops any Full bot in that folder the way
lowering a level does, and the gate applies again from its next launch. The gate works the
other way too: an Edits launch in a folder with a live, unaccepted Full bot gets the same
card.

Acceptance authorizes like raising access, see below. A bot can't press it: jailed ones
can't reach the daemon, and Full is the person.

**What this costs.** One tap per shared folder, Linux only. Project checks fail if they need
something the jail lacks, such as a local socket, and say why.

**The stated claim** now reads: a process in the jail can't gain device authority itself, and
Deck's automatic project operations don't run its code outside the jail. A Full bot in an
accepted folder is outside this claim. Known limits covers what's left.

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

**HTTP MCP below Full is off.** Revision 2 allowed public addresses, and that's wrong: a
public address says nothing about where tools execute, as a reverse proxy can publish a
local server. Deck can't tell what such a server can do, so:

- API bots below Full get no HTTP MCP servers from the daemon's client.
- Provider CLIs below Full get a private home with HTTP MCP entries and their tokens
  stripped, so a jailed bot holds no credential for them. If it adds one itself it
  reaches only what a stranger on the internet could.
- Stdio MCP servers run inside the jail.

A per-machine list of trusted MCP servers, set by a person, is the way to add this back
later. It isn't in this build.

## Machine state: two separate facts

**Changed from revision 3,** which let one passing probe do two jobs. Null's finding: a
probe shows the sandbox works today. It says nothing about what unjailed bots left behind.

- **Jail works.** Re-tested at each boot, nothing carried over.
- **Host trusted.** A person's decision, recorded once per data folder.

| Jail | Host | Bots below Full | Paired devices |
|---|---|---|---|
| Fails | either | don't start | refused |
| Works | not trusted | jailed | chat only, as today |
| Works | trusted | jailed | act, under the rule below |

Full bots run in every row, because Full is the person.

**The probe.** At start the daemon runs a real jailed probe that tries to read a marker in
the data folder, connect to the socket, reach a loopback listener and an abstract socket it
opened, connect to a Unix socket it put in a bound test folder, and reach the outside
through the proxy. The first five must fail, the last must work. It fails where there's no
bubblewrap or user namespaces are blocked, as Ubuntu 24.04's AppArmor setting can do, and
setup shows "needs bubblewrap (admin)".

A below-Full launch has one path, through the jail, whatever the state says, so a failed
probe can't leave anything new behind. Talk-only chats already refuse in this case
(`isolation_available`). A machine with bubblewrap gets jailed on update, and a machine
without it loses its below-Full bots until an admin fixes it. That's the cost. No setting
turns this on, so there's nothing for a bot to flip.

### What the epoch can and can't do

Two different things can survive from the unjailed past:

- **A live process.** It runs as the user, so it already has more than any device key
  gives: it can run anything. No record in the data folder can defend against it, and
  no software step can prove it's gone. Stopping it is a job for a person, and only a
  rebuilt machine is certain.
- **A planted record.** A device key an old bot wrote into `devices.json` and kept a copy
  of. If the bot is later jailed, it can dial in through the relay on port 443 and press its
  own Allow. That is a real jail escape, and this is what the epoch stops.

So `confined_epoch` is a random value written only by `trust-host`, and only a device record
carrying it can act. Its job is narrow: once a person has established trust, it voids every
pairing made before that moment. **It doesn't establish trust, and nothing in the data folder
can.**

**`TRUST_SALT` is gone.** Null's finding, and it's right: a constant in a public build can't
tell a real trust record from a forged one. A same-user process can write anything the
daemon can. So a malicious bot running unjailed on an old build, after this format is public,
could plant a trust record and an epoch-bearing device. The jail build can't detect that, and
this design doesn't claim to. It's the "Known limits" entry below, and the only full cure is
a boundary a same-user process can't cross: a new account, a rebuilt server, or a root-owned
record. What Deck does offer is visibility: Settings shows "Trusted on <date>" and every
device, on the Mac and phone.

The hidden data folder protects the epoch afterwards, because every below-Full bot from then
on is jailed and only Full, which is the person, can read it. That holds only after a trusted
bootstrap.

### Trust is always a person's decision

**Changed from revision 4,** which trusted a machine automatically if setup found no data
folder. Null's finding: an old bot, or a person, could have deleted that folder. A missing
folder proves nothing, so there's no automatic path. The check decides only which door is
offered, never the answer.

`apex-daemon trust-host` is the one mechanism, run from the person's own shell or SSH session:

1. It stops the daemon, which ends every bot.
2. It prints some of what could outlive that: the user's other processes, crontab, user
   systemd units, autostart entries, and recently changed shell start-up files. **The output
   says this list is incomplete.** It can't be otherwise, and Deck can't vouch for what's
   left out of it.
3. It saves the boot id and asks the person to look and reboot, then to run it again. A
   reboot ends detached processes. The daemon may come back in between; its bots are jailed
   and it stays Not trusted.
4. On the second run, with a new boot id, it stops the daemon again, writes a new epoch and
   the trust record, and leaves every existing device record without an epoch.

`--no-reboot` skips steps 3 and 4's wait, for accounts that can't reboot, and adds to the
wording that anything already running stays running. Without sudo, that's the only way.

The wording says what this is: "Deck can't check this machine for you. Only continue if you
trust what has run on this account." A hostile live process could run this command itself,
but by the argument above that gives it nothing new.

**On Add a machine,** setup pauses once, after Deck has started and before pairing, because
`trust-host` voids devices paired earlier:

    Trust this machine?
    Your phone can press Allow here only if you trust what has run on this account.
    Deck can't check that. Pick Trust for a new server, or one you know.
    [ Trust this machine ]   [ Not now ]

- **Trust this machine** runs `trust-host --no-reboot` over the signed-in SSH session, so the
  person's own credentials and tap carry the decision. It's offered only when setup found no
  data folder.
- **Not now** carries on and pairs without an epoch. The row reads "Not trusted yet", with
  the command. Trusting later means pairing that phone again.
- **A server that already has a data folder** isn't offered the button. It always gets the
  row and the command, so a known history gets the reboot by default.

Automatic trust stays possible only behind a real provisioning boundary, such as setup
creating a new Linux account. That moves bots, logins and projects to another user, so it
isn't in this build.

Apex-Terminal takes the command, then its phone pairs again.

## Who can do what from a paired device

Only on a machine that is Confined and trusted, only for a device with the current epoch,
and only through the iroh path in `call_from_device`, which has the verified device.
`authority.rs` already sets the tiers:

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
| `FolderAccept` (new) | lets a Full bot run lower bots' code; same rule as a raise |

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
3. The machine is Confined and trusted, and the device record has the current epoch.
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
- The hashed set adds the new helper, `authority::access_effect`, the machine state and
  the epoch check.
- `vps-update-allow-test.rs` asserts each machine state: Not confined and Confined but not
  trusted refuse every device action, Confined and trusted allows only what the tier table
  says and still refuses socket callers.

Order: update the installed recipe and test first, with one command the Human runs with
their key. `prepare_source` and `git apply --check` run before merge.

## Build order

1. `linux_jail.rs`, the seccomp filter, the forwarder, the proxy, the generated home, the
   startup probe, the breakout tests. First a spike: does a real signed-in turn of each
   provider work behind the proxy, under the filter, on a generated home?
2. Route all five launch points. Change-level order, MCP key. Taint record and the Full
   gate. `project_process()` and every project-folder spawn moved onto it. Isolated Git in
   `checkpoints.rs`. List every tool bots reach through `apex-daemon`, then move each to the
   turn's channel or refuse it.
3. Host trust: `trust-host`, the epoch, the setup card. Then `access_effect`, paired-device
   rules, raising rule, phone Face ID step.
4. Real runs on Docker and a real VM, all providers, including Ubuntu 24.04 AppArmor and
   a desktop session with X11.
5. Updater recipe change, then release.

Null reviews each step. Nothing from step 3 merges before steps 1 and 2 pass.

### Step 1 spike results, 2026-10-30

Scripts are in `tests/linux-jail-spike/`. Ubuntu 24.04, bubblewrap 0.9.0, arm64 Docker
(privileged, kernel 7.0), Claude Code 2.1.316, Codex 0.166.0. Each run used the real filter
bytes, a forwarder holding no Unix socket, and a proxy outside the jail.

| Check | Result |
| --- | --- |
| `AF_UNIX` socket, datagram and seqpacket pairs, with and without `SOCK_CLOEXEC` | refused |
| Stream pairs, with and without `SOCK_CLOEXEC`; `AF_INET` | allowed |
| Plain HTTP, port 8443, metadata address through the proxy | refused |
| `https://example.com` through the proxy | 200 |
| Claude, Codex, Gemini with a bad key | request reached the provider; Codex 401, Gemini 400 |
| Claude one-shot with a scripted model: Bash ran, file written, `/run` and `~/.ssh` absent | pass |
| Claude live session: stream-json, `--permission-prompt-tool stdio`, Allow answered | pass |
| Codex scripted turn, `workspace-write` and `danger-full-access` | pass |
| Codex scripted turn, `read-only`: its own sandbox refused the write inside the jail | pass |
| `codex app-server` initialize | pass |

Signed-in turn, 2026-10-30: Claude and Codex each logged in fresh inside a throwaway container
and wrote their file from inside the jail (`signed-in.sh`, run with the Human, result checked
by Null). That run used an empty home and the spike's filter.

Still unproven: login refresh and copy-back; Grok, Muse and Antigravity; x86_64, so the x32 rule hasn't run;
unprivileged containers and Ubuntu 24.04 AppArmor. The spike home is empty, not a generated
one from the allowlist. Gemini needs Node 20 or newer.

One change for `linux_jail.rs`: the spike's bot inherited the control channel, fd 3. The
forwarder must hold it alone, so the launcher starts the bot without that fd.

## Things that stop working below Full, on purpose

- `apex-daemon` and `$APEX_DECK_BIN`.
- `git push` over SSH keys, and any non-HTTPS network use.
- Access to services on this machine or its private network, such as a dev database or
  a dev server on localhost that the bot didn't start itself. Servers started inside the
  jail still work on the jail's own loopback, over TCP only.
- Anything needing a Unix socket inside the jail. That includes Postgres on its default
  socket, tmux, and probably headless Chrome. Tests that need these need Full.
- HTTP on any port, and HTTPS on any port but 443.
- HTTP MCP servers.
- Everything below Full, on a machine where the jail doesn't work.
- Provider plugins, hooks and any setting not on the generated list, for bots below Full.
- A Full bot in a folder a lower bot can write, until a person accepts that folder.
- Paired devices acting on any Linux machine, until a person has trusted it and the device paired after that.
- Project checks and runner checks that need something the jail doesn't have.
- `sudo`.
- Edits and Ask in `$HOME` or `/`.

## Must be proven by a test, not assumed

From inside the jail, as each level: read the data folder, gateway token and device
list; connect to the socket; `systemd-run --user`; write `settings.json`, `.bashrc`,
crontab, and the host's `~/.claude.json`;
signal or ptrace the daemon; reach an abstract socket, X11, `127.0.0.1` and the cloud
metadata address; pair a device; `TIOCSTI` on any terminal; find an inherited descriptor.

Sockets: connect to a host command socket placed in the project, in a PATH folder and at
a symlinked path; make an `AF_UNIX` socket through `socket()`, `socketpair(SOCK_DGRAM)`,
the same with `SOCK_CLOEXEC` and `SOCK_NONBLOCK` set, io_uring, and a 32-bit and x32 binary;
call a socket syscall by its x32 number from a 64-bit binary; open a connection on the
forwarder for a purpose other than the two allowed.

Proxy: every refused range in each encoding, the machine's own public address, a name
that changes answer between lookups, a redirect from a public URL to a refused address,
port 80, and a port on the machine's public address.

State: bubblewrap removed, then restart: no below-Full bot starts, and a Full bot does.
Host trust: a device record without the epoch can't act; `trust-host` replaces the epoch,
voids every device, and doesn't finish until the boot id has changed, unless `--no-reboot`
was given; a probe failure after trust runs no below-Full bot and keeps trust; a server with
no data folder is Not trusted until a person chooses, and setup never trusts on its own;
the Trust button isn't offered when a data folder exists; "Not now" pairs a device that
can't act; a device paired before Trust can't act afterwards.

Generated home: an unknown executable setting in the host's Claude and Codex config, on
the real launch path, doesn't appear in the jail's home; the same setting in project config
runs jailed and fails every check in the first paragraph of this section; a host config
that doesn't parse launches with the generated defaults and says so.

Lower-writable folders: a Full launch and a Full mount on a folder a jail could write are
refused until accepted, including parent and child folders; the taint is on disk before the
jail starts, and survives a crash at that moment; an Edits launch beside a live Full bot
gets the same gate; a limited device can't accept. With `core.fsmonitor`, `diff.external`,
a `filter.*.clean` driver, `.git/hooks/*` and a project check all planted by a jail: every
Deck-run path (changes, bot copies, runner, project check) runs them in the jail or not at
all. A test fails on a raw project-folder spawn outside `project_process()`. Withdrawing
acceptance stops a Full bot there and gates its next launch.

Snapshots: with a planted global and system filter, an `init.templateDir` that plants config
and hooks, `textconv`, `core.fsmonitor`, `core.attributesFile`, `core.hooksPath`,
`GIT_CONFIG_PARAMETERS` in the daemon's environment, a nested repository with its own
`core.fsmonitor`, an old store made through plain `git init`, and root, nested and macro
`.gitattributes` naming each, every Git call in `checkpoints.rs`, including `init` and `gc`,
runs nothing from the project on the oldest and newest Git we support, Windows included.
Snapshot then restore returns identical bytes for CRLF, `ident`, `working-tree-encoding` and
filters. A checkpoint without `raw` is chat-only. If rebuilding the store fails, no Git call
runs against it.

Alternate paths: a symlink in the project to the data folder, a bind or symlink project
that resolves to `$HOME`, `..` in a mount, a symlink swapped between check and launch,
a project on a case-insensitive or second mount of the same folder. The same set against
the taint check.

Retiring: a bot's `setsid` background loop, a double-forked child and a stdio MCP server
are all gone before a lowered level is saved; a killed `bwrap` leaves no process behind;
a cached MCP link isn't reused after a level change.

Also: group stop still works with `setsid()`; Codex's own sandbox works nested in
bubblewrap; login refresh survives through copy-back; two bots of one provider in one
project don't overwrite each other's private home.

## Known limits

- **The claim covers confined processes and Deck's automatic project operations.** It can't
  stop a person typing `git commit` or `make` in their own terminal, including the Code
  tab, or a Full bot in another folder deliberately running this folder's code. Those run
  as the person. The Code tab shows a banner in such a folder; nothing else can be done
  from here.
- **An accepted folder is a chosen bridge.** Once a person accepts a folder, a lower bot's
  code, written then or later, can reach a Full bot there, and from it a device key.
  Withdrawing stops new runs. It can't undo what already ran.
- **Host trust is a statement.** `trust-host` records a person's decision. It proves nothing
  about what is on the account, and its inspection list is incomplete. A rebuilt server or a
  new Linux user is the only clean answer.
- **A trust record can be forged before the jail arrives.** A same-user process on a pre-jail
  build can write the record itself, and Deck can't tell. Settings shows the date and
  devices; a date nobody recognises means rebuild.
- **Going back to a pre-jail build** runs unjailed bots that can read the epoch, and the
  later jail build can't detect that. Run `trust-host` again after any such rollback.
- **A root-owned record would be stronger.** Mac grants live in a root broker
  (`devices.rs:4`), out of a same-user process's reach. Linux keeps the owner-only
  registry here, because no-sudo installs must work too. A later step could use root
  where setup has it.
- Session history is writable, so a jailed bot could plant text a Full bot reads on
  resume. That's misleading text, not code.
- Network stays open to public addresses, so a jailed bot can send out what it can read.
  The jail guards Deck's authority, not project secrecy.
- Login files are readable by the provider running in the jail; it needs them.
- macOS bots are not changed by this work.
