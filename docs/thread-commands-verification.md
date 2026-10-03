# Thread commands verification

Branch: `feat/thread-commands`. Production app is kept running; no push or merge.

## Browser preview

Checked at `http://localhost:1431/` using Brave:

- `/foo` displays an unknown-command warning and preserves the composer text.
- `//foo` sends `/foo` as a message, without executing a command.
- `/pin use scratch files only` adds a neutral pinned-facts strip and survives browser reload.
- `/clear` clears messages and retains the existing pin.
- The × beside a fact removes that selected fact.

## Remaining verification

Fresh automated checks on 2026-10-03: 165 Rust tests and 69 frontend tests pass; production build (including TypeScript) passes. The space-containing filename regression in git patches was reproduced and fixed. Git tests verify private-index isolation, nested folders, missing baselines and non-git fallback. Export tests verify concurrent writes do not overwrite existing files. Fork tests verify saved-copy reads, cutoff truncation and no target overwrite.

Native end-to-end checks with real Claude Code and Codex agents, Finder reveal, and dev restart were not exercised in this continuation. Previous preview observations above are retained as prior observations, not fresh checks. Production was not restarted.
