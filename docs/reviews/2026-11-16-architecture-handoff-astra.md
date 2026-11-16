# Handoff to Astra: architecture review follow-through

**Date:** 2026-11-16
**From:** the session that ran the architecture review and built items 1, 2, 5, 6, 8
**Review:** `docs/reviews/2026-11-15-architecture-review.md` (included with this handoff)

## Astra follow-through on PR #24

The sections below record the original handoff at `8041bdb4`. The integration branch includes both review documents and the live-session plan with its cache measurement script.

- CI run 43895564142 finished with three Windows Rust failures and thirteen Windows app-test failures. The macOS job never acquired a runner. Four Windows app-test cases received fixes on main in `f00b6934`. This branch addresses stale Windows path, ended-step and UI wording expectations and scopes two POSIX executable-mode fixtures to platforms that can exercise them. The Linux gateway test now distinguishes a missing fixture executable from a missing confinement runtime. The desktop invitation integration still needs the remote-client CLI dispatch and build dependencies owned by another change.
- The three oversized replies match the base64 sizes of three Library videos. Updated clients request 3 MiB attachment pages from daemons advertising `attachment_chunks_v1`. Older clients can still request a whole attachment. Gallery tiles defer large video downloads until opened.
- Live sessions have passed the original two-turn probe. Task 2 separates turn-specific instructions from stable context, with regression coverage for private retries and non-room requests. The Claude driver now separates reply state from process ownership and accounts for helper follow-ups. Two clean replies were tested against one fixture process. Reusing provider processes between normal Deck turns still needs per-turn Code Mode and approval rebinding, Codex driver integration, invalidation, idle cleanup and live cost measurement.
- The shared command backend checks named request arguments against the generated schema. A file-search argument mismatch was corrected. Dynamic commands, result types and the remaining handwritten UI types still need separate migration. The protocol evolution and refusal policy is in `docs/desktop.md`.
- The host and gateway share agent name parsing. The desktop and phone share history-change preparation and execution. Four protected stores use a common versioned document reader, and host source-text assertions have behavioral replacements. These are incremental changes within items 3, 4, 7 and 10.
- The installed daemon's log prefix and responsive socket were verified. At inspection time none of 39 production step indexes contained an ended turn. Failed-turn persistence passed a host integration test.
- The VPS carry patch conflicts with current admission rules and does not account for OAuth renewal or detached browser work during maintenance. The updater's candidate compatibility test still refuses the port. The native package builder supports a Developer ID Installer identity and a notarytool Keychain profile. Actual signing/submission, branch protection and a new installer remain open.

## Where main stands

- `origin/main` = `8041bdb4`. Local `main` in `/Users/tylercaldwell/Downloads/apex-deck` is the same commit.
- Landed today, in order: `dff12a80` (item 1, command policy table), `7e611c46` + `f05e6fe2` (items 5 and 6: version scripts, clean-target, remote default-on, no debug daemon on real data), `c63b1748` + `4968a732` (item 2, generated protocol types + CI drift check), `2a6f3869` (item 8, tracing + failed-turn steps + `apex-daemon doctor`), `10979428` and `8041bdb4` (Windows compile fixes). Other agents landed `63ff0145` (direct-work continuation) and `9aec56a2`/`d879e354` (Apex Code Mode) in between.
- Installed Mac app: 0.9.16 stamped `10979428`, built 07:03 today into `release/`. Main differs from it only by `8041bdb4`, a Windows-only compile fix. A new macOS installer is not needed for behaviour; if one is built, bump first (`node scripts/bump-version.mjs <version>`) and build from a clean export, not this dirty tree (see "Shared checkout" below).

## Open work, most urgent first

### A. CI on main (run 43895564142 on `8041bdb4`)

https://github.com/l1quid8/Apex-Deck/actions/runs/43895564142

- **Windows "Check every crate" step: green for the first time.** All four crates compile on Windows. Done.
- **Windows "Test apex-core, apex-adapters and apex-host" and "Test apex-daemon": failed.** These steps had never run before (the compile error hid them). The run was still in progress when this was written, so the failing test names were not readable yet. Read them with
  `gh run view 43895564142 --log-failed | grep '^test-windows' | grep -E 'test .* FAILED|test result:'`
  Expect unix assumptions in tests (sockets, `/tmp`, permissions bits, `pgrep`).
- **Windows "Test the app" (npm): 15 failing tests**, seen on the previous run 43889761897 and already red before. Four are in scripts written today and are plain portability bugs:
  - `tests/clean-target.test.mjs:70` and `:91`: the busy check and the bad-argument cases exit 0 on Windows; look at how `scripts/clean-target.mjs` detects a running cargo (`pgrep`-style) and parses arguments.
  - `tests/gen-protocol-types.test.mjs:112` and `:131`: spawning `node`/`npx` gives empty output and a null exit; Windows needs `shell: true` or the `.cmd` name.
  The other eleven: Linux authority tests, Windows Task Scheduler tests, "Settings → Phones", "no on-screen text says bot", install shell, evaluation package. Older; owners unknown.
- **test (macos-latest): cancelled** after 15 minutes (15:22 → 15:37 UTC) with no step detail. The matrix jobs have no `timeout-minutes`; find out who or what cancelled it. On every earlier run this job failed on `desktop_stdio_invitation_approval_reconnect_and_hello`. Another agent's note in `artifacts/apex-code-mode-cli-mcp.md` says the test launches `apex-daemon remote-client` but main's `crates/apex-daemon/src/main.rs` does not dispatch that command. The working tree has an uncommitted 11-line change to that file by another agent; it may be the fix. Do not stage it; ask its owner.
- **test (ubuntu-22.04) and (ubuntu-22.04-arm):** `gateway_http::tests::legacy_allow_mcp_key_cannot_reach_private_servers_over_http` fails, pre-existing, cause not investigated.
- Green on every run: `versions-agree`, `protocol-types`, `test-windows-ipc`.

### B. Oversized daemon replies (found by `apex-daemon doctor`, not investigated)

On 2026-11-16 at 02:15 the Mac daemon refused three replies of 117, 121 and 215 MB because the connection frame limit is 32 MB (requests 175103, 175104, 175108). Some client asks for an enormous room state or step history on a huge thread and gets an error instead. Start from the log tail: `~/Library/Logs/Apex Deck/apex-daemon.log` or `<data>/desktop-daemon.log`. Reproduce the doctor read-only with
`target/debug/apex-daemon doctor --data-dir "$HOME/Library/Application Support/dev.apexdeck.app"`.
Likely fixes: page the reply (room_steps already takes `seq`/`ended`), or cap what `room_state` returns for a thread.

### C. Live bot sessions (the cache-cost fix)

- Branch `feat/live-bot-sessions` at `509d82b8`, three docs commits on top of main, unmerged and unpushed: the plan `docs/superpowers/plans/2026-10-14-live-bot-sessions.md`, `scripts/measure-claude-cache.py`, Decision 6 recorded as dropped, and the Task 1 probe results.
- The probe PASSED against real Claude Code 2.1.325 and codex-cli 0.166.0: both CLIs take a second turn on one process; Claude writes one session file for the two-turn process; Codex answers from the same ephemeral thread. Details in the plan's "Probe results" section.
- Tasks 2 to 9 (keep one Claude/Codex process per bot per room, send only new messages, idle timeout, cost baseline, compaction setting) are not started. Merge the branch first so the plan is on main, then build from Task 2. Memory note for context: `live-bot-sessions.md` in the Claude memory folder.

### D. Review items with a remainder

- **Item 5 (release hygiene):** make CI required on `main` once A is green; port the VPS maintenance patch to main; notarization for the Mac build.
- **Item 2 (generated types):** type the daemon transport's `call` against the generated `Commands` in `src/generated/protocol.ts` and retire the hand-written `src/types.ts`. The generator is `scripts/gen-protocol-types.mjs`, the schema binary `apex-protocol-schema`.
- **Item 8 (observability):** shipped, but the tracing layer and the `ended` steps for failed/stopped turns have only run in unit tests and one read-only doctor pass. The installed `10979428` build contains them; confirm in the live log that lines still read `apex-daemon: ...` and that a failed turn leaves a steps record (`.steps.jsonl` index has an `ended` list).

### E. Review items not started

- **3. Stop growing `Host`; make it a composition root.** An ongoing rule, not a one-off: new features get their own module with a narrow trait, `Host` only wires them.
- **4. One thread controller for desktop and phone.** The phone and desktop each drive threads with their own code; one controller in `src/` with two views.
- **7. Persistence: one door for ledgers, a migration convention.** Every on-disk JSON ledger goes through one module with a version field and a migration step.
- **9. Protocol evolution policy.** Write down when `PROTOCOL` bumps versus a new capability string, and how old clients are refused.
- **10. Tests that read source text.** Replace the tests that grep source files (`source_scan_no_raw_git_spawn_outside_wrapper` and kin) with ones that check behaviour or a registry.

## Shared checkout: how to land a change here without hurting anyone

Other agents edit `/Users/tylercaldwell/Downloads/apex-deck` at the same time. As of this handoff their uncommitted edits are: `AGENTS.md`, `Cargo.lock`, `Cargo.toml` (an `exclude` line), `artifacts/apex-code-mode-cli-mcp.md`, `crates/apex-cli/src/{agent_setup,authority,provider_setup}.rs`, `crates/apex-cli/tests/{standalone_startup,transport,visuals}.rs`, `crates/apex-daemon/Cargo.toml` (apex-iroh-mobile and zeroize deps), `crates/apex-daemon/src/main.rs`, `crates/iroh-mobile/Cargo.lock`, `vite.config.ts`, plus many untracked files. Never stage them.

The recipe that worked all day:

1. `git status`; `git switch -c <type>/<name>` (AGENTS.md rule).
2. Edit in a clean export when the file you need is dirty: `git archive HEAD | tar -x -C <scratch>`, edit there, then `git hash-object -w <file>`.
3. Commit with plumbing so only your hunks go in: `GIT_INDEX_FILE=<tmp> git read-tree HEAD`, `git update-index --cacheinfo 100644,<blob>,<path>`, `git write-tree`, `git commit-tree <tree> -p HEAD -m ...`, `git update-ref refs/heads/<branch> <sha> HEAD`.
4. Verify the committed tree alone: export it, `cargo check --locked --all-targets -p <crates>`, `cargo test --locked -p <crate>` (with `TMPDIR=/tmp`), and `npx tsc --noEmit` must pass before merging (AGENTS.md).
5. Merge: `git switch main && git merge --ff-only <branch>`. If a touched file is dirty in the tree but already equals your blob, `git update-index --cacheinfo` it first; the fast-forward then keeps it. Delete the branch after the merge.
6. `git push origin main`. The auto-mode permission classifier refused the push twice today; when it does, ask the Human to say "push" rather than working around it.

Traps:

- A Windows cross-compile is impossible on this Mac: `cargo check --target x86_64-pc-windows-msvc` dies in the build scripts of `aws-lc-sys`, `ring` and `blake3` (reqwest → rustls pulls them in). CI is the only Windows check; `cfg!(...)` does not gate name resolution, `#[cfg]` does.
- Cargo's shared `target/` is also used by other agents' builds; `node scripts/clean-target.mjs` refuses while any cargo runs (it freed 589 GB today).
- `release/` is a folder inside this repo, not a separate checkout; `scripts/package-pinned.mjs` builds from the working tree and only marks the stamp `-dirty`.
- Logs of an in-progress GitHub run are not downloadable; wait for completion.

## Memory notes worth reading (Claude memory folder for this project)

`architecture-review-2026-11.md`, `ci-main-red-2026-11.md`, `live-bot-sessions.md`, `shared-folder-concurrent-edits.md`, `deck-live-state-locations.md`.
