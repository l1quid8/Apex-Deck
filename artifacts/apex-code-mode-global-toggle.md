# Apex Code Mode global Auto / Off

Source implementation, November 16, 2026. No installer built or installed.

## Scoped integration verification

The toggle was isolated on `feat/global-apex-code-mode-toggle` from main at `f00b6934`, excluding unrelated uncommitted CLI, attachment, architecture, benchmark and mockup work.

- Fresh TypeScript checks passed; generated protocol types match the Rust schema; `git diff --check` passed.
- Fresh JavaScript suite: **4,016 passed, 8 skipped, zero failures**, including the desktop/phone Code Mode component scenario.
- Fresh Rust workspace run excluding the production-check package: **2,880 passed, 42 ignored**, with the existing `desktop_stdio_invitation_approval_reconnect_and_hello` test explicitly filtered out. Production checks passed separately: **6 passed**.
- The unfiltered run failed that desktop-pairing integration because committed main's daemon entry point does not dispatch `remote-client`; the child prints usage and invitation waiting times out. The toggle does not change that entry point. The main folder contains unfinished remote-client integration, which is deliberately excluded from this commit.
- The host integration regression retains the previously reviewed correction: failed-turn steps are stored separately from reply steps, and the second turn must finish before asserting its saved steps.
- Source verification only. No package, installation, or fresh installed acceptance is claimed.

## Behavior

- Desktop Settings → General has an Apex Code Mode Auto / Off control, with a searchable catalog entry. Auto is the default for older settings files.
- Phone Settings includes machine-scoped General controls. The machine is named explicitly; disconnected and insufficient-access controls are disabled. A successful command acknowledges the machine's saved choice. Failed or uncertain saves show an error and offer refresh.
- `apexCodeMode` is stored in the host's existing `saved-chats-v1/settings.json`. A dedicated `settings_code_mode_set` command updates only this field under the host's settings write lock. Full global device access is required. Ordinary desktop preference saves omit the field and preserve the latest machine choice.
- All API and CLI adapters for the host share one policy. Off removes the API tool and prompt guidance, prevents automatic Claude Code/Codex MCP registration on new turns, empties a running bridge's tool catalog, and rejects stale batch invocations.
- An Off transition interrupts active batch futures, withdraws pending Deck approvals, and marks unfinished child rows stopped. Off followed immediately by Auto still cancels the old batch. Already-running filesystem operations may finish; completed writes are preserved. Ordinary tools retain their normal access checks.
- Existing CLI prompts/catalogs cannot be erased from model context mid-turn. Cached calls are rejected by Deck; newly launched turns receive neither the bridge nor its guidance when Off.

## Verification

- Settings default/persistence regression failed before implementation; API Off regression failed because the tool remained advertised before implementation.
- Regressions cover hidden definitions/guidance, rejected stale API/MCP writes, ordinary reads remaining available, Off during an approval followed immediately by Auto, stopped child rows, automatic Claude/Codex registration, settings patch preservation, and remote command authority.
- Electron/Chromium component test passed for desktop and phone save acknowledgment, failed saves, external setting changes, disconnected machines, and insufficient phone access. This uses real components with a fixture backend, not an installed-app acceptance run.
- Final JavaScript suite: **4,044 passed, 8 skipped, no failures** (`npm test`). The new settings-change subscription was added to the backend's exhaustive coverage test, with a payload-delivery regression.
- TypeScript: `npx tsc --noEmit` passed. Generated protocol types and `git diff --check` passed.
- Host unit suite: **1,191 passed, 15 ignored**. Host integrations: **49 passed** across `host`, `lifecycle`, `legacy_import` and `runner`; host doc tests passed.
- Final Rust verification across the separated package groups: **2,887 passed, 42 ignored, zero failures**. The remaining workspace packages contributed 1,641 passes, and the production provenance package contributed 6 passes.
- Commands: `TMPDIR=/tmp cargo test --workspace --features test-support` verified the host unit suite; after correcting the stale integration assertion, all four host integration targets were rerun. Remaining packages passed with `TMPDIR=/tmp cargo test --workspace --exclude apex-host --exclude apex-host-production-check --features test-support`. `TMPDIR=/tmp cargo test -p apex-host-production-check` and host doc tests passed separately.
- Read-only code review found no blocking correctness issues.

## Check notes

The initial host suite found the expected command-count assertion after adding a command; its count was updated. It also timed out in `assistant_delegation::standing_tests::new_thread_tests::personal_new_thread_full_runs_in_one_isolated_execution`. The initial daemon suite failed two doctor assertions and five `pair_cli::tests::live` cases because the agent's long temporary directory exceeded the Unix socket path limit. Verification was repeated with `TMPDIR=/tmp` for short socket paths. The first new UI test attempt had a quoting error in its test harness; the harness was corrected and the test passed.

The full workspace run also exposed the stale `steps_without_a_reply_are_not_saved` integration assertion. The existing storage API explicitly retains failed/stopped turn records separately from replies. The test now verifies that retained failed-turn record and that its steps do not leak into the next successful reply; it waits for the second turn to finish before reading it. All host integrations pass with that expectation.

`this_target_is_built_without_the_test_support_feature` correctly rejects a combined workspace run that unifies `test-support` into the production-check package. Its instructed package-only run passed all 6 checks without that feature. No unresolved test failures remain in the final separated verification runs.

## Acceptance boundary

Source checks do not prove the currently installed build includes this setting. Packaging, installation, fresh live Claude/Codex subscription turns, and physical-phone acceptance remain separate release acceptance work.
