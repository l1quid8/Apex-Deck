# Standalone CLI implementation and test evidence

Historical evidence for the earlier private-store build. Current shared CLI and
desktop behavior is documented in [shared-store results](apex-cli-shared-store-results.md).

Date: 2026-11-05. Branch: `feat/standalone-cli`. Null implemented startup,
profile storage and terminal integration; Muck implemented provider authentication,
packaging and independent review. Existing dirty work was preserved. No merge,
desktop build, installed authority modification or account switch was performed.

## Implemented test scope

- Default standalone data is `~/.apex/`; inherited Deck data settings are ignored.
  An explicit `--connect-deck` remains attach-only. The CLI finds its sibling
  daemon, checks its version, launches detached and converges through the existing
  kernel data lock. Startup errors retain the owner/socket and include diagnostics.
- `--local-only` skips WebSocket, saved remote settings and saved HTTP gateway
  startup. The backend survives terminal exits. `backend status` reads a real
  handshake; stopping requires confirmation and a one-shot root receipt bound to
  the backend boot, not a PID read from mutable JSON.
- `/login` opens Codex/Claude methods. Initiation requires a protected typed
  `provider_setup_begin` receipt. Codex uses official app-server account RPCs and
  browser/device completion/cancellation. Claude uses official `auth login` and
  status, with Apex restoring the terminal before/after provider control.
- Official runtimes retain subscription credentials. Setup and the standalone
  backend strip inherited API/token/cloud-billing overrides and reject alternate
  credential-home overrides. Expired/unavailable runtime probes exclude those
  profiles from `/add`. API keys are not silently reused.
- `/agents create` uses the existing multiline editor, shows a save summary,
  supports Escape and `/cancel`, and preserves the wizard after a failed save.
  `/agents saved` and `/agents edit <handle>` use persistent profiles.
- Protected narrow `agent_profile_save` uses a compare-and-swap revision under
  the same store lock as session writers, retains unrelated session fields and
  accepts only Codex/Claude profiles with Ask/Read access. Mentions follow Deck's
  existing name-derived routing. A stale save cannot overwrite newer profiles.
- Import previews explicitly selected supported profiles from a bounded regular
  source file. It copies name/instructions/model into a standalone name-derived
  identity, excludes arbitrary programs, credentials, history and grants, and
  defaults to Ask. Duplicate handles are skipped.
- `/new work` asks for an absolute existing workspace and creates Work through
  protected `room_create`; it no longer silently creates Talk.
- CLI-only macOS packaging stages and signs CLI, daemon and authority binaries.
  Explicit installer enrollment supports a fresh broker or separate standalone
  pins alongside existing desktop pins, preserving keys/journal. The installer
  itself was reviewed and syntax checked, not executed.

## Observed verification

- Production-binary PTY test: `/tmp/apex-standalone-u4jvc47i/checks.json`.
  Independent autostart; no network listener; two terminals share one boot; raw
  IPC cannot start login or save agents; wizard fields and cancellation; terminal
  restoration; backend survives terminal exits. **Passed.**
- Provider runtime probes: Codex `0.166.0`, Claude Code `2.1.309`; both returned
  `loggedIn=true`, `method=subscription`. Probes did not initiate login, alter an
  account, read credential files or send a model request.
- Provider fixtures exercise initialize/account status, early completion,
  login-ID binding, redaction, allowed auth URLs, missing runtimes and environment
  isolation. Agent tests cover multiline instructions, confirmation, invalid
  handles/access, safe imports and edit validation.
- Host profile storage: two focused tests passed, including Jigga/Null read-back
  from a reopened store and preservation of unrelated session data.
- Daemon library: 182 passed, one ignored at the first complete daemon run.
- JavaScript command catalog and packaging tests: five passed. Installer shell
  syntax check passed. TypeScript no-emit check passed.

Broad Rust verification (`TMPDIR=/tmp cargo test -p apex-cli -p apex-host
-p apex-daemon -p apex-provenance`) completed with **1,520 passed, zero failed,
21 ignored** across 31 test binaries/doc-test groups. Host unit tests accounted
for 1,127 passed and 17 ignored. A later CLI integration run passed all five
tests, including persisted Jigga/Null profiles across a daemon process restart.
The initial broad run without the short `TMPDIR` failed existing daemon tests
because this thread's inherited temporary directory exceeded Unix socket limits;
the rerun used short disposable paths. The first new restart test dropped its
event receiver prematurely; retaining the receiver corrected that test harness.

Final CLI/provenance rerun after review fixes: **137 passed, zero failed,
three ignored**. Existing fixture/PTY acceptance passed at 80×24 (Ctrl-C) and
120×40 (SIGTERM), covering streaming, multiline paste, shared clear confirmation,
thread switching, daemon restart, per-thread drafts, resize and terminal restoration.
Evidence: `/tmp/apex-cli-acceptance-C2wnsX`.

## Signed test artifact

`release/Apex-CLI_0.9.8_arm64.tar.gz` — 17,531,949 bytes.

SHA256:
`04ce26f1bb6859b926ebf37c2aee80134f9988bb14f7b826d7d546917db2900c`

Packaging ran from `release/`. Read-back verified the archive checksum, all three
manifest binary hashes and all three Developer ID signatures (team `75N5HW62JH`).
The unpacked `apex --version` returned `apex 0.9.8`. The standalone PTY script was
then rerun against that exact signed, unpacked CLI and its sibling backend:
all five checks passed, including simultaneous startup racing to one backend boot.
Evidence: `/tmp/apex-standalone-0xk3md0u/checks.json`.

To test, extract the archive, change to the extracted `Apex-CLI_0.9.8_arm64`
directory, then run explicitly:

```sh
sudo /bin/bash ./install-cli-provenance.sh "$PWD"
apex
```

Inside Apex: `/login`, choose Codex or Claude and reuse or complete official
subscription sign-in; `/agents create` for Jigga and Null; `/new`; `/add` for each;
then address either agent. The installer does not run during packaging or tests.

## Acceptance boundary and remaining work

This is a local macOS Apple Silicon subscription test build. The full seven-task
plan is **not** claimed complete. Still required:

- Execute the explicit administrator installer and observe signed protected
  profile saves, provider sign-in/reuse and actual replies with no desktop app.
  Fresh-account installed acceptance and approved/denied Work edits remain open.
- Secure masked API-key input/Keychain storage, persistent typed provider
  connection records, automatic verified runtime installation and model-choice
  discovery are unfinished. Only subscription methods are shown.
- A signed/notarized PKG, automatic updates and standalone installer upgrades
  remain unfinished. The generated archive has signed binaries; its shell
  installer and manifest do not constitute a notarized installer.
- Import collision renaming and preservation of source profile IDs are absent;
  histories are not imported. Editing cannot change a mention identity.
- Provider commercial distribution approval requirements remain outside this
  local test build. No commercial subscription entitlement is asserted.

The administrator install changes the existing authority service when one exists,
so it must be run explicitly by the user after reviewing the package. Packaging
alone did not establish installed acceptance.
