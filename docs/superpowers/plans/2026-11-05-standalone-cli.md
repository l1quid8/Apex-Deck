# Standalone Apex CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Null leads design and review; Muck assists with bounded implementation when assigned.

**Goal:** Install Apex CLI, attach Codex or Claude, create or import Jigga and Null, and run persistent multi-agent conversations and approved coding work without installing or launching the desktop or iOS app.

**Architecture:** Retain the Rust terminal client, daemon, host, adapters, routing, storage and protected command system. Package the daemon and authority service independently, start a private standalone daemon automatically, and expose provider attachment and profile management through typed host commands. Official provider runtimes own subscription authentication; Apex stores connection metadata and references, never their OAuth tokens.

**Tech Stack:** Existing Rust workspace, Tokio, Ratatui/Crossterm, local IPC, official Codex app-server JSON-RPC, unmodified Claude Code, macOS Keychain and signed installer.

**Spec:** User's standalone flow recorded in `attachments/deck-journals/pane-mw3d992a-0/chat.md` under the development data directory: install → `/login` → attach providers → `/agents create` or `/agents import` → `/new` → `/add` → group conversation. This document records the concrete technical decisions for that flow. Scope is planning only until implementation is authorized.

## Global Constraints

- No desktop or iOS app required for installation, sign-in, agent creation, chat, approved tools, restart or update.
- Standalone is the default experience, without a user-enabled feature flag.
- First acceptance platform: macOS Apple Silicon, matching the user's machine. Other platforms require their own credential and authority implementations before being advertised.
- Default standalone data: `~/.apex/`; use existing `session.json` and `rooms/` formats rather than inventing `agents/` and `threads/` stores.
- Explicit `--connect-deck` selects the existing Deck integration; never silently attach to Deck or import its data. Explicit `--data-dir` wins. Ignore inherited `APEX_DECK_DATA_DIR` in default standalone mode.
- Preserve sticky mentions, daemon-authoritative responder stars, three recent threads and the approved welcome hint, multiline/paste behavior, reconnect semantics and existing executable command catalog.
- Existing `/agents` continues to show thread members. `/agents create`, `/agents edit`, `/agents import`, and `/agents saved` manage persistent profiles.
- `/new` defaults to Talk; `/new work` asks for a workspace and creates Work through protected host commands. Talk access remains read-only; Work defaults to Ask. Never silently promote a conversation.
- Public provider options must describe verified supported methods. No fabricated download URL, arbitrary model defaults, custom Claude OAuth, copied provider tokens, or auth-file existence presented as authenticated status.
- Before changes: `git status`, preserve shared dirty work, and create the implementation task branch in the repository root. Production DMG builds only under `release/`; desktop dev only through the prescribed root command. No desktop build is needed for this CLI plan.
- Require `npx tsc --noEmit` before merge; merge only when authorized, then delete the merged task branch. No bulk staging of pre-existing changes.

## Verified Claims and Corrections

Verification date: 2026-11-05. These observations are from the current working tree, not a claim that uncommitted changes shipped.

| Muck's claim | Verified result |
| --- | --- |
| `apex` already bundles a working standalone backend | `crates/apex-cli/Cargo.toml` depends on daemon/host libraries, but `src/main.rs` only enters the client. `args.rs` explicitly says it never starts a daemon. Reusable code exists; standalone startup and distribution do not. |
| A random local port is needed | `crates/apex-daemon/src/serve.rs` already serves private local IPC and a token-protected loopback WebSocket. CLI should use IPC. No new exposed port is needed for CLI operation. |
| Codex adapter already handles browser/device login | `crates/apex-adapters/src/codex_server.rs` launches `codex app-server` and supports turn/approval events, but contains no `account/login/start`, login completion/cancel handling, browser opening or device login UI. These must be added. |
| Run `codex app-server --login` | Use documented app-server RPC, not this unverified flag. Start the server, initialize, then send account/login requests. |
| Detect `~/.codex/auth.json` to establish login | `agents.rs` has only Linux missing-credential heuristics. It explicitly notes macOS keychain use. Probe the provider's actual authenticated state. |
| Run `claude login` | Official command is `claude auth login`; `claude auth status` returns JSON and an authentication exit status. |
| Profiles are in `presets/`, compatible with `presets.rs` | Incorrect. `crates/apex-adapters/src/presets.rs` builds provider command lines. Host `documents::Session.profiles` stores profiles in `session.json`; `src/types.ts` types them as `ParticipantConfig[]`. Rooms live in `rooms/`. |
| Only data directory and authentication are missing | Protected Work actions require the provenance broker. `scripts/install-provenance.sh` currently validates/copies an Electron app bundle and admits its daemon/CLI. CLI-only installation, enrollment and updates are another required workstream. |
| Add login behind a standalone flag | Standalone is the product default. Deck connection is explicit optional integration. |
| Installer URL and example models are ready | Neither was verified as a release artifact or available account model. Publish only an actual tested artifact; use provider-discovered models or a provider default. |

## Official Provider Findings

- [OpenAI app-server](https://learn.chatgpt.com/docs/app-server): use `account/read`, `account/login/start` with `chatgpt`, `chatgptDeviceCode` or `apiKey`, completion notifications, and `account/login/cancel`. The provider performs OAuth and device polling. Current docs distinguish local/open-source integrations from commercial/hosted services; app-server subscription auth is not a blanket commercial distribution entitlement.
- [Sign in with ChatGPT](https://developers.openai.com/siwc): a separately documented integration with registration/client ID and plan-usage guidance. It is not automatically interchangeable with managed Codex login. For a commercial release, establish eligibility/registration and implement that documented path before advertising subscription sign-in; an API-key path can proceed independently.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): `claude auth login`, `claude auth status`, and logout are documented. Use the installed runtime's supported flags and status schema; never infer a session from a file.
- [Anthropic legal/authentication guidance](https://code.claude.com/docs/en/legal-and-compliance): permits running the unmodified published Claude Code binary with end-user authentication under specified conditions; also restricts third-party Claude.ai login/token intermediation. Apex must neither collect subscription credentials nor replace the official sign-in ceremony. This is an implementation boundary, not a guarantee of approval for every product distribution.
- [Claude plan/SDK guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): currently says SDK, `claude -p` and third-party usage can draw on subscription limits. Its breadth differs from the restrictions above. Keep the local unmodified-runtime path; obtain provider clarification before promising broader embedded SDK subscription access.

**Engineering decision:** Reuse existing Rust runtime adapters first. Adding Node SDK processes would not remove provider runtimes, authentication work or distribution conditions. API-key billing and subscription billing remain separate choices in the UI. Initial scope is Codex and Claude; do not show a fake “Other API provider” branch.

## Review Focus

1. A fresh macOS user with no Deck, provider runtime or provider credentials can complete setup (Tasks 1, 3, 4, 6).
2. Concurrent terminals and backend crashes do not start conflicting daemons, replay messages or lose drafts (Tasks 1, 7).
3. Canceled, expired or failed login never appears attached, leaks a credential or changes the user's unrelated provider account (Tasks 2–4).
4. Profile import preserves actual identity/instructions, detects collisions and cannot import elevated access or executable overrides silently (Task 5).
5. CLI-only protected commands work with signed provenance, while agents, injected environments and raw IPC remain unable to mint human authority (Tasks 2, 6, 7).

## Task 1: Independent Startup and Backend Ownership

**Modify:** `crates/apex-cli/src/{main,args,lib,runtime}.rs`, `crates/apex-daemon/src/{cli,serve}.rs`.
**Create:** `crates/apex-cli/src/backend.rs`, `crates/apex-cli/tests/standalone_startup.rs`.

**Interface:** `backend::ensure(data: &Path, launch: BackendLaunch) -> Result<BackendConnection, String>` (async). `BackendLaunch` distinguishes standalone autostart from explicit attach-only Deck connection. `BackendConnection` contains endpoint, protocol version and boot identity, not credentials exposed to UI.

- [ ] Add failing tests: clean-home default resolves `~/.apex`; inherited Deck environment cannot redirect it; explicit attach never starts a process; explicit absolute path wins; two simultaneous launches converge on one daemon; unresponsive/locked state is reported without deleting a live socket.
- [ ] Run `cargo test -p apex-cli --test standalone_startup`; verify those failures before implementation.
- [ ] Resolve the packaged daemon as a verified sibling of the CLI, never via workspace/PATH overrides. Reuse `DataLock`, IPC endpoint resolution, protocol handshake and bounded readiness polling. The daemon owns locking; losing startup racers connect after readiness. Add local-only serving so default standalone startup does not enable WebSocket/gateway/remote listeners.
- [ ] Keep one background backend per data directory after terminal exit so another terminal/active task is not killed. Add `apex backend status` and `apex backend stop`; stop requires explicit confirmation if work is active. Capture bounded startup errors and report incompatibility instead of endless reconnect.
- [ ] Wire daemon auxiliary modes needed by provider tool hooks through the packaged `apex-daemon` entry point. Preserve daemon role separation; dependency linkage alone is not dispatch.
- [ ] Re-run startup tests; manually launch two terminals against a disposable root and verify one backend/boot identity. No production build in this task.

## Task 2: Typed Provider Attachment and Credential Boundary

**Create:** `crates/apex-host/src/provider_connections.rs`, `crates/apex-cli/src/provider_setup.rs`, `crates/apex-cli/tests/provider_setup.rs`.
**Modify:** host `lib.rs`, `command.rs`, `storage.rs`; CLI `lib.rs`, `controller.rs`, `runtime.rs`, `ui.rs`, `authority.rs`; `shared/composer-commands.json`; daemon authority classification and provenance command admission.

**Interfaces (new host RPCs):** `provider_connections {}` → redacted status list; `provider_attach {provider,method,requestId}` → pending or verified connection; `provider_attach_cancel {requestId}`; `provider_detach {connectionId,expectedRevision}`. Typed provider-specific internal APIs accept secrets outside ordinary command/log/event serialization. Connection records contain stable ID, provider, method, runtime identity and credential reference; ephemeral browser URLs/device codes do not persist.

- [ ] Add failing tests for unknown provider/method, missing runtime, canceled/expired login, duplicate request IDs, stale completion after cancellation, denied protected mutation, secret redaction and failed keychain write rollback.
- [ ] Run `cargo test -p apex-cli --test provider_setup` and focused host provider-connection tests; observe failures.
- [ ] Add `/login` to the shared executable command catalog. Show Codex and Claude, current verified connection state, method/billing labels and runtime installation/reuse choices. Do not log auth payloads or include API keys in composer history, process arguments, room messages or ordinary events.
- [ ] Implement macOS Keychain persistence for Apex-owned API credentials. Only the daemon/provider child receives a key for the selected connection. A provider-managed credential remains owned by that provider; Apex metadata references it. Cancellation discards pending keys; locked/unavailable Keychain is an error, never a plaintext fallback.
- [ ] Treat attach/detach as explicit human configuration commands with provenance; agents and remote devices cannot trigger credential prompts or attach accounts. Sanitized reads remain available for status. Keep provider setup out of `authority.rs` except command admission.
- [ ] `/login` can reauthenticate; detaching an Apex connection does not globally log out the user's other provider tools. Warn which Apex agents are affected. Reprobe status before use; retain profiles/threads when expired.
- [ ] Re-run focused tests plus shared catalog checks. Verified auth is not a guarantee that a model has quota; report first-turn quota failures separately.

## Task 3: Codex Managed Authentication

**Create:** `crates/apex-adapters/src/codex_auth.rs` and protocol fixture tests.
**Modify:** adapters module exports, provider connection service and CLI setup UI; reuse process/protocol primitives from `codex_server.rs` without launching a work turn.

**Interface:** `CodexAuthSession::{probe,start,cancel}` uses a dedicated app-server session; `start` takes `CodexLoginMethod::{Browser,DeviceCode,ApiKey}` and returns redacted progress events tied to a login ID. API key payloads remain outside diagnostic serialization.

- [ ] Add failing fixture tests for initialize/account read; browser URL; device code; completion/account update ordering; cancel, timeout and disconnect; invalid keys; existing keychain-backed login; two concurrent attachment requests; no authentication RPC replay after uncertain delivery.
- [ ] Run focused `cargo test -p apex-adapters codex_auth` tests and observe failures.
- [ ] Launch supported official `codex app-server`; initialize and use documented account RPCs. Browser mode opens the returned official auth URL; device mode displays returned verification URL/code and waits for provider notifications. Apex does not implement token exchange or device polling. Cancel maps to the login-cancel RPC and cleans up the auth child.
- [ ] Offer reuse only after a successful account probe. Show whether the runtime account is shared with existing Codex tools before changing it. Never parse/copy `auth.json` tokens. Ensure provider turns use the same credential context as setup.
- [ ] Install missing Codex only through a versioned official distribution selected by packaging metadata; verify origin/integrity and executable version. An install failure leaves the provider unattached. Existing compatible installations can be reused after explicit selection.
- [ ] Re-run fixtures; perform real browser/device login and a real agent reply in a disposable local acceptance account. Commercial subscription distribution remains gated by the documented eligibility/registration path; do not relabel API billing as subscription use.

## Task 4: Claude Official Runtime Authentication

**Create:** `crates/apex-adapters/src/claude_auth.rs` and process fixture tests.
**Modify:** provider connection service, CLI setup UI and terminal lifecycle helper in `runtime.rs`.

**Interface:** `ClaudeAuth::{probe,login}` runs a verified unmodified Claude Code executable. `login` suspends Apex raw mode/alternate screen, gives the official process the controlling terminal and restores Apex on exit, errors, interruption and timeout. API-key mode gets the selected connection's key, isolated from subscription fallback.

- [ ] Add failing tests for exact argv (`auth login`, `auth status`), structured status parsing, version incompatibility, nonzero exit, cancel, terminal restoration, API-key precedence and no stale attached status after expired credentials.
- [ ] Run focused `cargo test -p apex-adapters claude_auth` and CLI terminal tests; observe failures.
- [ ] Detect/reuse or install an official compatible runtime. Preserve its published binary and all built-in auth methods. Apex launches its own sign-in UI only for Apex-owned API keys, never Claude account credentials. Mark connected only after a successful official status probe.
- [ ] Keep subscription requests inside the existing unmodified Claude Code execution path. API-key mode passes the user's key only to that provider child and labels API billing; never silently fall back between methods. Verify environment inherited by long-running daemon does not override the selected method.
- [ ] Re-run fixtures and real subscription/API-key reply checks separately. Record actual runtime versions and supported methods in results. Provider clarification is required for any broader promise of custom embedded SDK subscription login.

## Task 5: Persistent Agent Creation, Editing and Import

**Create:** `crates/apex-host/src/agent_profiles.rs`, `crates/apex-cli/src/agent_setup.rs`, `crates/apex-cli/tests/agent_setup.rs`.
**Modify:** host commands/document handling/storage; CLI controller/runtime/UI/authority; command catalog; provenance and daemon command classification.

**Interfaces:** `agent_profile_list {}`; `agent_profile_save {profile,connectionId,expectedRevision}`; `agent_profile_import_preview {source}`; `agent_profile_import_apply {previewId,resolutions,expectedRevision}`. Return validated `ParticipantConfig`-compatible profiles plus nonsecret connection references. Keep saved profile IDs distinct from per-thread participant aliases.

- [ ] Add failing tests for Jigga/Null persistence across restart, duplicate/case-insensitive handles, unsupported/unattached provider, disappearing model, multiline instructions, canceled wizard, malformed export, collision resolutions, stale revision and preservation of unrelated session fields.
- [ ] Run `cargo test -p apex-cli --test agent_setup` and host agent-profile tests; observe failures.
- [ ] Implement wizard fields: name, unique handle, attached provider, current model choices/provider default, instructions, and default Work access (Ask or Read in first creation UI). Save atomically through a narrow protected host command; avoid writing the entire stale session from the client. Follow existing ParticipantConfig validation and preserve unknown fields through host document handling.
- [ ] Import selected profiles from Deck's `session.json` or a versioned profile export. Source is read-only. Preview identity/instructions/provider/model; ask rename/skip for collisions. Ignore embedded executable paths, credential material and authority-bearing grants; imported profiles default to Ask pending explicit review. Unsupported providers are shown as unavailable. Bind credentials separately through `/login`; import no history or credentials silently.
- [ ] Preserve bare `/agents` member view and existing `/add`; add saved/create/edit/import subcommands. `/add` uses verified available connections and actual saved profiles. Explicitly allow creating multiple agents on one provider connection.
- [ ] Add `/new work` through the existing workspace/Work creation commands with protected authority, selecting workspace before any coding task. Reuse whole-thread command semantics and daemon routing without changing `room.rs` targeting behavior.
- [ ] Re-run tests; create Jigga/Null, restart, add both to Talk and Work threads and verify their actual instructions/model/identity.

## Task 6: CLI-only Protected Installation and Updates

**Create:** `scripts/package-cli-mac.mjs`, `scripts/install-cli-provenance.sh`, `tests/package-cli-mac.test.mjs`.
**Modify:** `crates/apex-provenance/src/main.rs`, its typed config/verification modules, host command admission, CLI authority, and protected upgrade code where needed. Keep desktop installation compatibility.

**Interface:** Versioned broker enrollment config supports an explicit CLI-only product containing exact signed CLI+daemon identities without an Electron UI identity. Installed immutable binaries, signed manifests and data-scoped receipts remain mandatory. Provider runtime identity is distinct from human issuer identity.

- [ ] Add failing tests for CLI-only enrollment, forged/ad-hoc/wrong-signer executables, tampered or writable installed paths, injected environments, unsupported/nested signing commands, foreign data roots, replayed/stale receipts and desktop configuration compatibility.
- [ ] Run focused provenance/production-storage and packaging tests; observe failures.
- [ ] Produce a signed, notarized macOS installer containing `apex`, `apex-daemon`, broker and support assets under a protected CLI product directory, plus a terminal PATH entry. Install without Electron or Deck resources. Obtain administrator consent only for system installation/enrollment, not each launch. Provider installs remain explicit and independently versioned.
- [ ] Generalize broker config to optional app identity rather than a dummy UI hash. Add narrow admissions for provider/profile/work creation operations; retain per-command human-origin checks and existing receipt verification. Never add a local trust-token shortcut or unsigned development bypass.
- [ ] Implement CLI product upgrades with verified manifests, atomic binary/config enrollment, rollback on failure, and coexistence with an installed desktop product. Do not overwrite the desktop's broker pins or authority ledger when installing/updating CLI. If the shared broker supports multiple admitted product versions, scope admission to product and data root explicitly.
- [ ] Run tests; install in a clean macOS account without Deck, exercise a real approved Work edit, deny another action, then cold-relaunch and verify installation provenance. A package file or a passing fixture is insufficient evidence.

## Task 7: End-to-end Acceptance and Runnable Handoff

**Modify:** `docs/apex-cli.md`, `docs/apex-cli-testing-results.md`, `scripts/test-apex-cli.mjs`.
**Create:** `crates/apex-cli/tests/standalone_acceptance.rs` and a versioned CLI installation/acceptance report.

- [ ] Add failing disposable-root acceptance fixtures spanning startup, provider setup, two saved profiles, Talk/Work thread creation and restart, without Deck processes/resources. Cover crashes during login, concurrent clients, delivery ambiguity, offline startup and terminal restore after provider handoff.
- [ ] Run new acceptance tests, implement missing integration wiring only, then pass them.
- [ ] Run `cargo test -p apex-cli`, affected adapter/host/daemon/provenance tests, production-storage checks, `node --test tests/cli-command-registry.test.mjs tests/package-cli-mac.test.mjs`, and `npx tsc --noEmit`. Run `git diff --check` on the scoped changes. Resolve failures; distinguish ignored tests from passes.
- [ ] Test the installed signed artifact in a fresh macOS user/VM with no desktop app, no existing Apex root and initially no provider tools. Record install artifact/version/checksum, installed runtime versions and exact supported methods.
- [ ] Complete the user journey: launch → `/login` Codex → official sign-in → `/login` Claude → official sign-in → create Jigga and Null → `/new` → `/add` both → real streamed replies. Verify sticky mentions and `@all`; restart and resume the same thread with profiles intact.
- [ ] Create a disposable `/new work` workspace, approve one real file edit/command and observe its effect; deny another and observe no effect. Confirm no desktop binary or service was loaded to authorize either. Recheck runner/Plan controls under installed provenance.
- [ ] Reauthenticate after expiration; cancel a login; test an invalid API key without exposing it; verify explicit API vs subscription selection. Import copies of the user's profiles only when authorized, comparing actual instructions/identities while leaving the source unchanged.
- [ ] Stop/restart backend during a streamed reply; confirm reconnect preserves drafts and does not resend uncertain mutations. Open two terminals and check shared updates and daemon ownership.
- [ ] Deliver the real installer location and exact install/launch commands, a short test checklist, and evidence separating fixture passes, provider sign-ins, observed replies and protected tool results. Publish no placeholder URL. No merge or public publication without authorization.

## Execution Order and Completion

Tasks 1 and 6 establish independence; Task 2 establishes the safe provider boundary; Tasks 3–4 implement provider methods; Task 5 supplies agent onboarding; Task 7 verifies the integrated installed product. Suggested execution order: 1 → 6 → 2 → 3 → 4 → 5 → 7, so protected configuration does not accumulate behind a nonexistent installer.

Implementation review checkpoints occur after each task's scoped diff and tests. Muck can own bounded provider protocol/process fixtures while Null owns startup/authority integration and final acceptance; avoid concurrent edits to shared command admission files. This plan does not claim implementation or acceptance has happened.

The local standalone product can be built and tested without waiting for a commercial provider agreement. Commercial distribution of subscription sign-in is a separate release condition, especially for Codex; choosing a Rust adapter versus an SDK does not resolve that condition. The API-key paths remain concrete first-class methods.
