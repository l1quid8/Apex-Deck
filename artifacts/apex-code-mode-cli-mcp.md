# Apex Code Mode for subscription CLIs

Source implementation and acceptance, 2026-11-16. Base checkout: `21b00b49`.
This is not an installed-build acceptance report. No installer was built or installed.

## Implementation

- Claude Code and Codex worker turns automatically receive the `apex-code-mode`
  stdio MCP server and guidance to use its `deck_code_mode` tool for suitable
  multi-file tasks. No MCP registration command or saved MCP-config edit is needed.
- Deck's own executable acts as a small stdio relay to an ephemeral loopback
  listener. A random 256-bit capability authenticates the connection; credentials
  are passed through child environment variables, not launch arguments or steps.
- The MCP catalog exposes only the existing bounded JSON batch tool. Execution
  reuses the Rust executor, root checks, four-read concurrency, filtering, ordered
  writes, per-child approvals, refusal handling, and partial-result reporting.
- CLI MCP approval gates remain in place. In Ask mode the probes saw an outer
  batch-tool approval followed by each individual write approval. Approving the
  outer call does not authorize its writes.
- Stop wakes the bridge immediately and terminates the owned CLI process tree.
  Relay EOF and MCP cancellation also drop the active batch and pending approval.
  Remaining stages do not run. Already completed writes are not rolled back.
- The bridge and CLI share the silence timer and approval-wait accounting.
  Completion, timeout, failure, and dropped response futures destroy the listener.
- Claude's host-issued computer MCP registration is preserved in the same config
  override. Codex receives a separate server-table override.
- Gateway/model-only/computer-only turns are excluded. Linux jailed turns do not
  advertise the host-loopback relay, which is not reachable in their network
  namespace. Windows host helper wiring and Linux jail transport remain outside
  this macOS acceptance.

## Live subscription acceptance

Used the real installed CLI executables, with the new source adapter and test
relay helper: Claude Code `2.1.325`; Codex CLI `0.166.0`. No API-model substitutes.
Each probe used a disposable scratch directory, not a project containing user work.

Both agents made the requested Deck MCP batch, read one record containing 9 units,
created `allowed.txt` only after approval, and left `denied.txt` absent after denial.
Both reported total **9** and status **partial**, and neither retried the denial.
Persisted executor step IDs confirmed execution through Deck, rather than native
CLI file tools. The final acceptance pair took 29.26 seconds combined.

| CLI | Reported input tokens | Reported output tokens | Correctness |
| --- | ---: | ---: | --- |
| Claude Code | 90,156 | 641 | 9 units; approved file created; denied file absent |
| Codex | 90,202 | 268 | 9 units; approved file created; denied file absent |

These are CLI-reported usage counters for this acceptance task, including its
existing tool/prompt context. They are not savings measurements or an On/Off
benchmark; cache breakdown was not captured.

A separate real-CLI Stop probe paused each agent at its first child write approval,
then called Deck cancellation. Both turns ended with an error/cancel result, zero
files, and exactly one write approval; the second write was never presented.
The two Stop probes took 13.67 seconds combined. Canceled-turn tokens unavailable.

## Reproduction and automated coverage

- `cargo test -p apex-adapters --test code_mode_cli -- --ignored --nocapture`
  explicitly runs the subscription acceptance and Stop probes; ignored by default.
- Five MCP unit tests exercise the catalog/unknown-tool boundary, real reads and
  refusal-preserving output, ordered approve/deny writes, authenticated transport
  with pipelined notifications, and pending-approval interruption through Stop,
  relay disconnect, and MCP cancellation.
- A CLI registration regression excludes Gemini, tool-free, gateway MCP-disabled,
  and computer-only turns while enabling worker Claude Code and Codex.
- `npx tsc --noEmit`: passed.
- `npm test`: 4,041 passed, 8 skipped, zero failures.
- `cargo test -p apex-adapters`: 662 passed, 16 ignored, zero failures.
- Initial bare `cargo test` failed five `pair_cli::tests::live` cases because this
  session's inherited temporary-directory path made their Unix socket names exceed
  macOS's 100-byte limit. Cases: `a_phone_that_claims_is_paired_when_the_terminal_says_y`,
  `anything_but_y_denies_the_phone`, `ctrl_c_cancels_the_invitation`,
  `json_mode_approves_only_the_code_it_is_given`, and
  `without_remote_access_pair_says_how_to_turn_it_on`.
  Full rerun with `TMPDIR=/tmp cargo test`: **2,849 passed, 42 ignored, zero
  failures**, including all five phone-pairing cases. No product change was needed
  for the temporary-path limitation.

## Remaining acceptance boundaries

The existing installed Deck application has not been replaced. Source-adapter CLI
acceptance does not prove installed provenance, the desktop Stop button, or phone
interactions. The global Auto/Off setting and batch-row/filtered-byte mockup UI
remain separate implementation work. Automatic availability does not guarantee
that a model chooses batching for every suitable task.

## Isolated main integration verification (2026-11-16)

Integrated only the subscription MCP implementation, regression tests, plan, and
this report onto `origin/main` at `4968a732`; unrelated shared-checkout edits and
private benchmark evidence were excluded.

- `npx tsc --noEmit`: passed.
- `npm test`: 4,013 passed, 8 skipped, zero failures. This isolated tree excludes
  unrelated uncommitted prototype/adversarial tests from the earlier snapshot.
- Initial `TMPDIR=/tmp cargo test` failed the existing
  `desktop_stdio_invitation_approval_reconnect_and_hello` test: it launches
  `apex-daemon remote-client`, but main's unchanged `src/main.rs` does not dispatch
  that command. The daemon prints its usage and the invitation wait times out.
  Neither that entry point nor its pairing test was changed by this integration.
- `TMPDIR=/tmp cargo test -- --skip desktop_stdio_invitation_approval_reconnect_and_hello`:
  2,848 passed, 42 ignored, zero failures, one known baseline test excluded.
  All six new MCP/registration regressions passed.

The full unfiltered Rust suite is therefore not green on this main baseline.
No installer was built or installed during integration.
