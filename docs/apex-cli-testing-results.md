# Apex CLI testing handoff — 2026-11-05

Branch: `feat/apex-terminal-cli`. Runnable binary: `target/debug/apex`.
Usage, command semantics, and signed-authority requirements: [apex-cli.md](apex-cli.md).

The approved design is now a real Rust terminal client. The HTML mockups remain
unchanged design references. Null completed the remaining implementation, with
Muck handling broker/packaging work, fixture/PTY acceptance, and independent review.
A fresh-context final reviewer identified four Important issues; all four were
fixed and received focused regression coverage before this handoff.

## Verification

| Check | Observed result |
| --- | --- |
| `cargo build -p apex-cli --bin apex` | Passed; debug executable built. |
| `cargo test -p apex-cli` | 28 passed, 0 failed, 0 ignored. |
| `TMPDIR=/tmp cargo test -p apex-core -p apex-host -p apex-daemon` | 1,647 passed, 0 failed, 18 existing ignored. |
| `cargo test -p apex-provenance` | Muck verified 83 passed, 1 existing ignored. |
| `npm test` | 3,368 passed, 0 failed, 3 skipped. |
| Affected command/menu/runner/shared-vector Node tests | 34 passed after final parser/catalog changes. |
| `npx tsc --noEmit` | Passed after final changes. |
| Packaging/upgrade/provenance Node checks | Muck verified 67 passed. Also included in the full JavaScript run. |
| `git diff --check` | Passed. |

The initial daemon integration run failed because macOS's default temporary
directory made fixture socket paths exceed the existing 100-byte assertion.
Rerunning the existing suite with `TMPDIR=/tmp` passed. No production endpoint
limit or test assertion was weakened.

## Real terminal and daemon evidence

`node scripts/test-apex-cli.mjs --no-build` executes the actual built terminal
client in PTYs against a standalone throwaway daemon fixture. Final evidence is
under `/tmp/apex-cli-acceptance-voQErV/`: `results.json`, `80x24.ansi`,
`120x40.ansi`, and fixture logs. Previous review-fix evidence is also available at
`/tmp/apex-cli-acceptance-SC4seu/`.

The acceptance flow covers:

- Empty `/new`, selecting a saved Scripted agent through CLI `/add`, and adding
  no sample transcript messages.
- A five-line bracketed paste containing `/clear`, followed by one Enter: one
  authoritative human message, with the embedded command retained as text.
- `/clear` default Cancel and explicit confirmation, verified from a second client.
- `@` completion through Tab, using a current member's actual handle.
- A real local SSE reply, switching threads before its unique tail, and verifying
  the old-room delta does not enter the newly selected transcript or rendered view.
- Daemon restart and a subsequent CLI mutation after a fresh reconnect.
- F3 draft preservation, draft roundtrips across threads, and offline F3 plus
  reconnect without replacing the user's draft.
- 80×24 and 120×40 layouts, a temporary 40×12 resize, Ctrl-C and SIGTERM exits,
  zero exit status, exact termios restoration, and enabled terminal-mode cleanup.

Focused Rust tests cover out-of-order replies interleaved with events, pending
request failure on disconnect, malformed hello/frame rejection, negotiated frame
limits, stable-ID delivery deduplication, persisted reopen after restart, member
removal/recovery, all advertised controller handlers, invalid arguments, permission
refusal, revision-bound runner review, room/snapshot races, old-boot reset,
overflow gating, character-safe editing, caret wrapping, history anchoring, and
terminal-control sanitization.

## Review fixes and decisions

- F3 dispatches navigation without replacing the composer. Thread selections keep
  separate drafts; confirmation Cancel is a neutral dismissal.
- Work thread catalog reconciliation preserves session title/archive metadata
  unless the host marks its metadata explicit; recency uses the latest recorded value.
- Agent-backed model selection uses `agent_models`; API-backed selection uses
  `room_bot_models`.
- Work `/add` reads the original saved session profile, preserving custom key
  variable names, backend settings, persona, access and media. Talk-only `/add`
  keeps using the daemon's restricted/redacted chat profile API.
- Work rename follows the current app's `chat_update_meta` path
  (`src/App.tsx::syncWorkMeta`), preserving unrelated session content. This corrects
  the plan's earlier assumption that a separate whole-session title save was needed.
- Ordinary chat posts remain ordinary host commands. Assistant-task threads are
  excluded from the terminal's submission surface; protected Work commands still
  need exact broker receipts. No trusted-client fixture mode exists in `apex`.
- Unsigned development testing is the handoff target. Signed installation is a
  separate acceptance step, as stated in the approved plan.

## Remaining production acceptance

The signed CLI/broker/pin migration code and regression tests are present, but no
production DMG, root installation/configuration change, or merge was performed.
Protected Work configuration, Plan, runner, approval and question mutations need
the signed, root-protected CLI described in the usage guide. Their unsigned
development attempts fail closed; fixture success is not signed admission proof.

Native app/phone UI acceptance and installed signed-command acceptance have not
been claimed. The current user's daemon answered a read-only protocol-1 hello at
version 0.9.8. Its chats were not mutated by this work's acceptance tests. An older
running daemon may lack responder stars until its additive state change is rebuilt.

All unrelated dirty checkout changes were preserved. No existing mockup was
replaced, no task branch was merged, and no installer was created.
