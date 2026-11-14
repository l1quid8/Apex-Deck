# Linux Codex command approval validation

The current adapter source fixes duplicate command approvals by sending Codex
an `externalSandbox` turn policy after Deck successfully launches a Linux-jailed
Ask/Edits child. Codex's nested sandbox otherwise fails inside Deck's jail and
requests approval again to retry. Ask's `untrusted` approval policy remains
enabled. Read, Full, unjailed, and non-Linux policies retain their behavior.
Helper follow-up turns carry the same policy.

## Live VPS verification

Repeated on 2026-11-14 using the real CLI in a PTY, a real Codex agent in Ask
mode, and isolated Work threads under
`~/apex-cli-test/single-approval-0913/`. The test driver accepts only the exact
requested command and answers through the CLI's A/Y or R keys.

- `fixed-2`: `echo SINGLE_APPROVAL_OK > single-approval.txt && cat single-approval.txt`
  requested approval once. The file was absent before approval, then contained
  `SINGLE_APPROVAL_OK` with a trailing newline. The agent reported success.
- `fixed-reject-2`: the equivalent command targeting `rejected.txt` requested
  approval once. Reject prevented file creation and the agent reported rejection.
- Both isolated backends stopped and their credential/data directories were
  removed. Evidence and harmless marker files remain in the test directories.
- Production service identities matched before and after both runs:
  `apex-daemon-managed@l1quid8` PID 424873, active since 2026-11-12 07:57:50 UTC;
  `apex-model-gateway` PID 320579, active since 2026-11-11 18:43:52 UTC.

The test backend SHA-256 is
`b0fc677c4cee4d78c8f48d7ad69ebebaadfea1dac7f0c0fb34cfa709560ea96e`.
Its adapter production code matches this checkout; the checkout additionally
extends the helper-follow-up transport test. Local evidence is under
`/tmp/null-codex-single-approval/evidence/`.

## Checks and release boundary

- `cargo test -p apex-adapters --lib`: 496 passed, 3 ignored, 0 failed.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.

The fix is in source and the isolated test backend. Published npm 0.9.13 and
the user's production VPS service were not replaced. No package was published.
