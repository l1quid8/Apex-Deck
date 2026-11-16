# Apex Deck architecture review, 2026-11-15

**Status:** Proposed. Item 1 built 2026-11-16 on `refactor/command-policy`.
**Deciders:** Human. Null reviews before any further build.
**Scope:** read-only survey of the repo at 0.9.16 (three exploration passes: Rust crates, TypeScript/Electron, remote/release).

## Context

Apex Deck is about 150k lines of Rust in nine crates and 72k lines of TypeScript, shipped to Mac, Linux, Windows, iPhone and npm. In the 30 days before this review it took about 1,260 commits, almost all written by agents. That is the single most important fact for its architecture: the code is grown by many hands that do not share memory. Anything that depends on "remembering to also update X" will be forgotten. The architecture should make the right thing the only thing that compiles.

What is sound and worth keeping:

- One daemon owns all state. Desktop, phone and CLI are thin clients over one newline-JSON protocol, with the same frames over socket, SSH, WebSocket and iroh.
- Authority is in the daemon and the OS, never the UI. Device tiers are an exhaustive match (`crates/apex-daemon/src/authority.rs`), and `apex-host-production-check` exists only to prove the production build refuses forged files.
- Electron windows are sandboxed, context-isolated and origin-checked in main.
- Pure logic is already separated in places (`turnQueue.ts`, `apex-core`, `apex-pairing`); shared JSON fixtures keep a few Rust/TS pairs honest.
- Almost no TODO/FIXME debt; the debt is structural, not sloppy.

## Ranked recommendations

### 1. Make command policy exhaustive, in one place (done 2026-11-16)

Every new daemon command had to be classified in four places: `command_needs` (exhaustive), `requires_provenance` (a flat `matches!` of 61 of 243 variants), `local_linux_cli_surface` (another `matches!`), and the TS command strings. Two lists were non-exhaustive, so a new command that should need an installed-UI receipt was unprotected by default. Fix: `Command::policy()` in `crates/apex-host/src/command.rs`, one match over all 243 variants with no catch-all, returning `Policy { provenance, linux_cli }`; the two old functions are wrappers. Generated from the old lists, so behaviour is identical.

### 2. Generate the TypeScript wire types from Rust (medium, high payoff)

`src/types.ts` hand-mirrors `apex-core`; ~700 more interfaces are scattered; ~217 command names are bare strings in `call("...")`; daemon replies are untyped `serde_json::Value`. Only 16 Rust wire tests guard drift. Decision: `schemars` derives on `Command`, `RoomEvent`, snapshot types and `Welcome`; a generator writes `src/generated/protocol.ts` (a `Commands` name→args map, the `RoomEvent` union, a `Capability` literal union from `protocol.rs:453`); `transport.ts` becomes `call<K extends keyof Commands>`; CI fails on a dirty generated diff. Typed replies trail the request side.

### 3. Stop growing `Host`; make it a composition root (ongoing rule)

`Host` (`crates/apex-host/src/host.rs`, 7k lines, ~138 public methods) has `impl Host` blocks in ~32 files and owns rooms, PTYs, storage, bus, checkpoints, assistant runs, memory, monitors, phone simulator, computer use, bot copies, runner. Rule: a new subsystem is its own struct with its own `handle(cmd)`, held by `Host` as a field; no new `impl Host` blocks. First extractions: `assistant_service`, `personal_worker`, `monitor_*`, `bot_copies`, `phone`, `runner`. Give `AgentTool` `FromStr`/`Display` and delete the three hand-written parsers (`host.rs` ×2, `gateway_http.rs`). Split `LiveRoomState` into model state and view state.

### 4. One thread controller for desktop and phone (medium)

`App.tsx` (3.5k lines, ~111 `useState`), `ChatPane.tsx` (4.3k, 74 props, ~107 `useState`, 55 backend calls) and `PhoneApp.tsx` (4.9k, 117 `useState`) are three lifted-state roots; the phone re-implements go-back, pin, fork, delete/restore, agent editing and the composer. Decision: extend the `useSyncExternalStore` pattern already used in 17 files into `src/thread/` (`threadStore.ts` fed by `hub.ts`; `threadActions.ts` holding the orchestration once, UI-free). `ChatPane` and the phone `ThreadView` become renderers. One flow at a time, starting with go-back/revert and pins; each move deletes a phone copy.

### 5. Release and version hygiene (small)

Version 0.9.16 is typed by hand in `Cargo.toml`, `package.json`, three `npm/*/package.json` and the `iroh-mobile` lockfile; CI publishes nothing and is not required green; Mac builds are not notarized; the VPS runs a carry patch (`maintenance.rs`) not on main; `iroh-mobile` pins iroh `=1.3.0` vs the daemon's `1.3`. Decision: `scripts/bump-version.mjs` + a CI check reusing `cli-release-source.mjs`'s agreement test; merge the maintenance patch to main behind a feature or setting; make `daemon.yml` required on main; one iroh pin in the workspace; notarize when a Developer ID is present.

### 6. Build-folder and dev-data hygiene (small, immediate)

`target/debug` was 457 GB (338 GB `deps`, 888k files; 118 GB incremental) because agents build with different feature sets (`remote`, `test-support`) and nothing is reused; `release/` held 69 GB of validation folders. `desktop/sidecar.mjs` falls back to spawning a **debug** daemon against the **production** data folder when the production daemon is not answering. Decision: make `remote` default-on (it has shipped); add `cargo sweep --time 7` or `scripts/clean-target.mjs` to the agents' routine; remove the prod-data fallback or require an explicit flag.

### 7. Persistence: one door for ledgers, a migration convention (medium, later)

JSON files are fine at this scale, but there are many direct writers (`checkpoints.rs` 50 sites, `assistant_git.rs` 43, `assistant_service.rs` 23, `host.rs` 19) around a single-mutex `Store`, and versioning is ad hoc (filename `-v1`, in-document `version`, `#[serde(default)]`, a runner store that refuses rather than migrates). Decision: a `Document<T>` helper in `authority_file.rs` with `version` and a chain of `migrate_vN` closures over the existing atomic write; every ledger goes through it. No database until team threads make state multi-writer.

### 8. Observability (small)

~140 `eprintln!("[apex-deck] …")`, no crash reporting, and steps from failed or stopped turns are not saved, though failed turns are what you debug. Decision: `tracing` with `room`, `turn`, `provider`, `cmd` fields and unchanged stderr shape; persist steps for failed and stopped turns; an `apex-daemon doctor` subcommand (data dir, version, protocol, capabilities, last 20 log lines).

### 9. Protocol evolution (policy)

Protocol pinned at 1 with ~30 append-only capability strings. Fine, but once item 2 generates a `Capability` enum, document in `docs/desktop.md`: capabilities are the versioning mechanism, each has an owner, removal only one release after every shipped client stops requiring it. Consider `min_daemon` in `apex-deck-update.json`.

### 10. Tests that read source text (hygiene)

~115 node tests compile `.tsx` through sucrase with import stripping or assert on source text with regex; they break on reorganisation rather than behaviour change and discourage items 3 and 4. New component tests should use `tests/helpers/electron-test.mjs` or a small `happy-dom` setup; retire the source-text tests as their subjects move.

## Trade-offs and order

Items 1, 5, 6 and 8 are cheap and behaviour-preserving. Item 2 pays for 3 and 4: typed commands make extracting services and stores safe, so do 2 before the big TS moves. Items 3 and 4 are rules applied to new work first, then opportunistic extraction; a big-bang split would collide with the in-flight plans (team threads, native code mode, live bot sessions). Item 7 deliberately keeps JSON files.

Suggested order: 1 (done) → 5 (bump script, CI required) → 6 → 2 → 8 → 5 (VPS patch to main) → 3 (AGENTS.md rule + one extraction) → 4 → 7.

## Verification

Item 1 compiles only when every variant is classified (checked 2026-11-16: `cargo check -p apex-host`, 29 targeted tests, `npx tsc --noEmit`). Item 2: the generator produces a clean diff in CI. Item 5: the check script fails on any disagreeing manifest. Item 6: `du -sh target` after a week of agent builds. Item 4: one phone copy deleted per flow with the Electron DOM tests and `desktop:smoke:multi-host` green.
