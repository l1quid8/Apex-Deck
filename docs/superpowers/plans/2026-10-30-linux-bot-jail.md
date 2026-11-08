# Linux bot jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bot below Full on Linux runs in a bubblewrap jail, so that on a machine a person has trusted, a paired device can act.

**Architecture:** One module, `crates/apex-adapters/src/linux_jail/`, builds the jail. All five launch points call it. The bot's only way out is a daemon-run CONNECT proxy reached over one inherited channel. Host trust and device rules live in `apex-daemon` and `apex-host`.

**Tech Stack:** Rust, bubblewrap 0.9+, a hand-built classic BPF seccomp filter, tokio. No new crates.

**Spec:** `docs/superpowers/specs/2026-10-30-linux-bot-confinement-design.md` (revision 6, approved `e7d3b822`).

## Global Constraints

- Nothing below Full launches outside the jail on Linux. There is no fallback and no setting.
- The set level decides, not the effective level. Full is never jailed.
- `linux_jail` builds on every Unix so its pure logic is tested on macOS. Kernel behaviour is tested in Docker (`apex-deck-linux-test`) and later on a real VM.
- No `--new-session`: jailed launches use `setsid()` in the child instead of `process_group(0)`.
- The bot process never holds the control channel. Only the forwarder does.
- Refused message for unsafe folders: "This folder holds your login files. Pick a folder inside it, or use Full."
- Steps 1 and 2 pass before anything from step 3 merges. Null reviews each step.
- macOS and Windows bots don't change, except the snapshot change, which applies everywhere.
- Rust tests run with `TMPDIR=/tmp` when inside a Deck pane.

## Review Focus

- A project folder reached by a second path (bind mount, case change, symlink): it's refused the same as the direct path. Pinned in Task 1 by comparing device and inode, and through the mount table.
- A protected folder mounted inside a project, or shown under another name: refused at every level. Pinned in Task 1 by `Mounts` and in the kernel test.
- A Read-level project that contains `~/.ssh` or the data folder, or where one could appear later: refused, because a hide on a live bind doesn't last. Pinned in Task 1.
- `socket()` with a family nobody listed (`AF_VSOCK`, `AF_ALG`): refused. Pinned in Task 1 with an allowlist.
- A proxy target that resolves to both a public and a refused address: only checked addresses are dialled. Pinned in Task 2.
- A bot process killed while its jail is starting: no forwarder or proxy task outlives it. Pinned in Task 3.

---

## Step 1: the jail itself

### Task 1: Filter, arguments, environment, folder refusal

**Files:**
- Create: `crates/apex-adapters/src/linux_jail/mod.rs`, `seccomp.rs`, `paths.rs`
- Modify: `crates/apex-adapters/src/lib.rs`, `crates/apex-adapters/src/gateway_sandbox.rs` (share the system path list)
- Test: unit tests in each file; `crates/apex-adapters/tests/linux_jail_kernel.rs` (Linux only)

**Interfaces:**
- Produces: `seccomp::filter() -> Vec<u8>`; `paths::Mounts`; `paths::check_writable(path: &Path, guard: &Guard, mounts: &Mounts) -> Result<PathBuf, Refused>`; `paths::check_read(path, protected, mounts) -> Result<PathBuf, Refused>`; `paths::Guard { home, protected, path_dirs, executables }`; `JailSpec`; `bwrap_args(&JailSpec, &Mounts, is_dir) -> Result<Vec<OsString>, Refused>`; `jail_env(&JailSpec) -> Vec<(String, OsString)>`.

- [x] Write failing tests. Filter: a small BPF interpreter in the test runs the real bytes for every case in the design. Folders: `/`, `$HOME`, parent of `$HOME`, inside and around each protected path, a PATH folder, a symlink to `$HOME`, `..`, and the same folder by a different case on macOS. Arguments: every process-boundary flag, `--chdir`, no hide mounts. Environment: a blocked name passed as a provider key never appears.
- [x] Run them and see them fail.
- [x] Implement. `socket()` is an allowlist of `AF_INET`, `AF_INET6` and `AF_NETLINK`, which is stricter than the design's `AF_UNIX` refusal.
- [x] Run unit tests on macOS and the kernel test in Docker, with `git`, Node, Claude and Codex starting under the new filter. Grok, Muse and Gemini start-up move to Task 5.
- [x] Commit.

### Task 2: Proxy and control channel

**Files:** Create `crates/apex-adapters/src/linux_jail/proxy.rs`, `channel.rs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `proxy::refused(ip: IpAddr, own: &[IpAddr]) -> bool`; `proxy::serve(stream, resolver, own_addrs)`; `channel::serve(control: UnixStream, purposes: Purposes)`, which hands one fresh fd per request and ends when the jail closes its side.

- [x] Failing tests: every range in the design in each encoding (IPv4-mapped, NAT64, 6to4), own addresses read per connection, port 80 and 8443 refused, a name with mixed answers dials only checked ones, a name changing between lookups dials only what was checked, a purpose other than `proxy` or `codex-hook` is refused.
- [x] Implement, then pass on macOS.
- [x] Commit.

### Task 3: In-jail init, launch and group stop

**Files:** Create `crates/apex-adapters/src/linux_jail/init.rs`, `launch.rs`. Modify `owned_process.rs` (`Registry::spawn_session`), `crates/apex-daemon/src/entry.rs` (`__jail-init` handled before tokio starts).

**Interfaces:**
- Consumes: Task 1 `JailSpec`, `bwrap_args`, `jail_env`; Task 2 `channel::serve`.
- Produces: `launch::jailed_command(&JailSpec, bwrap) -> Result<Jailed, JailError>`, where `Jailed { command, .. }` and `Jailed::spawn(self, &Registry) -> (OwnedChild, control)`; `Registry::spawn_session`; `init::run(fd, port, argv) -> !`, which listens on `port` for the proxy and `port + 1` for the Codex hook.

- [x] Failing Linux tests: the bot's `/proc/self/fd` shows only stdio; the forwarder passes bytes under the filter; group kill leaves no process; `setsid` plus double-fork children die with the jail; `TIOCSTI` fails.
- [x] Implement. Init forks: the child keeps the control fd and forwards, the parent closes it and `exec`s the bot.
- [x] Pass in Docker.
- [x] Commit.

### Task 4: Generated provider homes and access-only logins

**Files:** Create `crates/apex-adapters/src/linux_jail/home.rs`

**Interfaces:**
- Produces: `home::prepare(data_dir, room, bot, &Backend, values: &HomeValues) -> Result<JailHome, JailError>`.

- [x] Failing tests: an unknown executable key in host Claude and Codex config doesn't reach the jail home; HTTP MCP entries and tokens are stripped; stdio MCP is carried by name; an extra field in a login file isn't staged; a host config that doesn't parse gives defaults and a notice; two bots of one provider get separate homes.
- [x] Implement per provider, reusing the sign-in document parsers in `gateway_sandbox.rs`.
- [x] Real signed-in turn on a generated home with an access-only login, host login unchanged, using a fresh login in a throwaway container. Needs the Human for sign-in.
- [x] Deck's own login per provider in `logins/<provider>`, refreshed outside the jail for Claude and Codex (`refresh::ensure`, called by the launch in Task 6). The person's login is never written. Gemini's command is settled in Task 5.
- [ ] Task 6: a Sign in for a bot below Full signs in `logins/<provider>` on Deck's minimal settings, and readiness checks that login, not the person's.
- [x] Commit.

### Task 5: Startup probe and breakout suite

**Files:** Create `crates/apex-adapters/src/linux_jail/probe.rs`, `tests/linux-jail/`

**Interfaces:**
- Produces: `probe::run(&ProbeEnv) -> ProbeResult`; `JailState::{Works, Fails(reason)}`, re-tested at each boot.

- [ ] Write the design's "Must be proven" jail, socket and proxy lists as one Docker suite, including an unprivileged container with AppArmor's restriction on.
- [ ] Implement the probe: five checks must fail, the sixth must work.
- [ ] Pass in Docker on arm64 and x86_64. x32 needs the x86_64 run.
- [ ] Commit, then send step 1 to Null.

## Step 2: route everything through it

### Task 6: All five launch points

**Files:** Modify `crates/apex-adapters/src/cli.rs`, `claude_session.rs`, `codex_server.rs`, `api_tools/shell.rs`, `api_tools/mcp_client.rs`, `phone_env.rs`, `codex_hook.rs`

- [x] Failing test: each launch point below Full on Linux yields a jailed command, and refuses when the state is Fails. `APEX_DECK_PHONE_SOCKET` is absent. Codex's hook uses the loopback port and a per-launch token.
- [x] Implement, list every tool bots reach through `apex-daemon`, and move each to the channel or refuse it.
- [x] Commit (`447d8ac5`).

### Task 7: Changing a level, MCP links

**Files:** Modify `api_tools/mcp_client.rs:515`, the host's participant update path in `crates/apex-host/src/host.rs`

- [x] Failing tests: `setsid` loop, double fork and stdio MCP server are gone before a lowered level is saved; a failed stop keeps the old level; a cached link isn't reused; API bots below Full get no HTTP MCP.
- [x] Implement in the design's five-step order. The map key gains bot and level.
- [x] Commit.

### Task 8: Taint, the Full gate and `project_process()`

**Files:** Create `crates/apex-host/src/folder_trust.rs`, `crates/apex-host/src/project_process.rs`. Modify `project_check.rs`, `runner/checks.rs`, `bot_copies.rs`, `git_changes.rs`, the desktop and phone card.

- [ ] Complete the design's Lower-writable and Alternate paths regression tests. Existing source scans do not prove confinement; see Null's 2026-11-03 review.
- [x] Complete implementation: opaque project-command wrappers enforce jail-or-refuse at execution; acceptance covers only the selected folder and descendants. See the 2026-11-07 integration review for the Linux Git-index correction and remaining validation matrix.
- [x] Commit (`3975b88d`).

### Task 9: Snapshot isolation

**Files:** Modify `crates/apex-host/src/checkpoints.rs`, the Revert path and wording.

- [x] Failing tests: the design's Snapshots list, on the real `checkpoints.rs` calls.
- [x] Implement isolated Git, the once-per-run rebuild under a lock, `info/attributes` and `raw`. A failed rebuild runs no Git.
- [ ] Run in Docker on Git 2.25 and 2.43, on macOS, and in Windows CI. (macOS covered by the host suite; Docker/Windows CI still owed.)
- [x] Commit (`0e0c6fc9`); step 2 sent to Null: pending review.

## Step 3: trust and devices

### Task 10: `trust-host`, epoch, setup card

**Files:** Create `crates/apex-daemon/src/trust_host.rs`. Modify `devices.rs`, `crates/apex-daemon/src/cli.rs`, `src/phone/sshRun.ts`, `src/phone/RemoteSsh.tsx`, Settings on Mac and phone.

- [x] Cover the reviewed Host trust regressions, including shutdown, existing device sessions, and unchanged-boot refusal. Unit, live-iroh and scoped subprocess coverage is recorded in the integration review.
- [x] Complete implementation: scoped waited daemon shutdown, live-session epoch invalidation and a durable pending reboot baseline close the reviewed defects.

### Task 11: `access_effect` and device rules

**Files:** Modify `crates/apex-daemon/src/authority.rs`, `call_from_device`, `Command`, phone settings screens.

- [ ] Complete behavioral proof for every "must be proven" row; classification assertions alone do not exercise real device mutations.
- [x] Complete the real-device-route whole-class regression: a limited device runs every command with `"access":"full"` fixtures and no level rises. This uses the real protocol route with a test Linux policy, not physical-device acceptance.
- [x] Complete the five atomic daemon checks and native phone Face ID guard. Bound old-level/folder checks run under the room lock; the native biometric transport boundary is verified in the isolated simulator harness. Fully paired-phone acceptance remains in Task 12.
- [x] Commit (`02258231`); step 3 sent to Null: pending review.

## Step 4 and 5: proof and release

### Task 12: Real runs

- [ ] All providers in Docker, then a real Ubuntu 24.04 VM with AppArmor, then a desktop session with X11. Native iPhone checks owed from Add a machine: Stop, trust reset, Face ID, Files picker, QR tab.

### Task 13: Update recipe, then release

- [ ] Change the recipe's expected hashes and `vps-update-allow-test.rs`. The Human runs one command with their key. `prepare_source` and `git apply --check` pass before merge.
- [ ] Ask the Human for the go on the pre-release.

---
## Earlier status (Ds4 review, 2026-11; superseded by Null review below)

Merge commits `f8ecb06b` and `32ed6a7e` were reviewed: conflict resolutions are deliberate, no conflict markers remain, and all jail/trust files survive both parents intact. `npx tsc --noEmit` passes; `cargo check` passes (warnings only). Rust suites pass under `TMPDIR=/tmp` (macOS sun_path fix): apex-adapters linux_jail 89/89, apex-daemon full, apex-host 1005/1006 (the one failure, `ordinary_read_chat_dispatch_does_not_wait_for_task_integration`, is a pre-existing main-side 2s-timeout test that passes alone under parallel load — flaky, not a jail/merge regression).

Held items before merge:
- Task 5 Docker probe suite (arm64/x86_64) — needs Docker.
- Task 9 Docker (Git 2.25/2.43) and Windows CI — needs infra.
- Task 12 real runs: providers in Docker, Ubuntu 24.04 VM + AppArmor, X11 desktop, native iPhone checks (Stop, trust reset, Face ID, Files picker, QR tab) — needs infra/human.
- Task 13 recipe hashes + `vps-update-allow-test.rs` + `prepare_source`/`git apply --check`, Human runs one command with their key, then go for pre-release.
- Null review of steps 2 and 3 (Task 9/11 step-sends) pending.

## Re-sync and merge hold (Null, 2026-11-03)

The interrupted re-sync integrates main `646722ba` into feature `db69c6f2`.
The two textual conflicts are resolved, and eight new main commands are
explicitly classified in `access_effect`. TypeScript and the daemon remote
compile check pass. The full frontend run had 3,343 passes, 1 popout subprocess
timeout, and 3 skips; the isolated popout rerun passed.
Fresh Rust library suites (`TMPDIR=/tmp`, remote feature, two test threads)
passed: adapters 474, core 97, daemon 243, host 1,064; 18 tests ignored in
total. These results do not cover Linux kernel or installed-app acceptance.

**Do not merge into main or release this candidate yet.** The user's merge
authorization remains recorded, but the implementation is not ready: Null's
fresh review found unconfined project operations, ineffective daemon shutdown
and existing-session revocation, a bypassed reboot wait, overbroad folder
acceptance, incomplete access-raise admission, and an unused non-biometric
Face ID helper. Tasks 8, 10, and 11 are reopened accordingly.

See [the concrete findings and required regressions](../../reviews/linux-jail/2026-11-03-null-merge-review.md).
The shared checkout and unrelated branches are preserved. No production
build or release is established by this re-sync.

## Security-fix integration closeout (Null, 2026-11-07)

The six implementation findings above are resolved in `59598e4f` plus the
current-main reconciliation `3e750381`. Main was fast-forwarded to that reviewed
integration; its tree matched the tested feature tree, TypeScript passed again,
and the phone/command-backend smoke tests passed on main. This supersedes the
earlier security implementation merge hold, not the release matrix in Tasks
5, 8, 9, 11, 12 and 13. The current-main review records exact results, the
additional local old-level and Linux Git-index regressions, and the remaining
platform/native acceptance limits. No installer or release is established.
