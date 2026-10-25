# iOS connection branch consolidation

The iOS admission fixes and platform follow-up were consolidated into
`fix/ios-connection-admission` in its existing worktree. The branch was first
advanced from `253da44` to current `main` (`d0fde75`) by a fast-forward; those
upstream changes did not overlap any iOS fix paths. While verification ran,
another session merged the voice fix as `430d61c` and switched the shared
checkout to `main`. The isolated iOS commit was rebased onto that merge; the
voice merge and shared branch were preserved. Its upstream changes affect only
the two voice-sidecar Python files, so the verified Node/Rust sources are
unchanged. TypeScript was rerun after this rebase.

All 37 selected iOS source, test and review files were copied from the shared
checkout and verified against their captured SHA-256 hashes. Both original dirty
checkouts were backed up before transfer. The unrelated `.python-version` file
was excluded. The voice branch and its commits are outside this change.

## Fresh verification

- `npx tsc --noEmit`: passed.
- Full `npm test`: 2,535 passed, 3 skipped, 1 failed. The browser shortcut test
  expects 13 forwarded shortcuts but finds 12. The same failure was reproduced
  using pristine `d0fde75` files; no iOS paths are involved in that test.
- `TMPDIR=/tmp cargo test --features apex-daemon/remote`: 1,588 passed, 13 ignored.
- Separate `TMPDIR=/tmp cargo test -p apex-host-production-check`: 6 passed.
- Both edited desktop modules pass `node --check`; `git diff --check` passes.

The Node log is `/tmp/null-ios-consolidated-node.log`; its independent current-main
reproduction is `/tmp/null-ios-consolidated-baseline-browser.log`. Rust and
production-boundary logs are `/tmp/null-ios-consolidated-rust.log` and
`/tmp/null-ios-consolidated-production.log`.

## Remaining acceptance

This consolidation changes no platform policy. Linux protected phone actions
still require unavailable provenance; full phone action support there remains a
separate product/security decision. The two Linux-only tests still need a Linux
runner. The Mac development build still requires the protected service and
refuses admission without it. Signed installed Mac UI plus physical-iPhone
validation remains outstanding. No release, installation, merge or deployment
was performed.
