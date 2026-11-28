# PR92 review fixes

Goal: Fix chat creation, surface asserted blockers in questions, retain unresolved mixed risks, and investigate the Windows menu crash. Do not merge.

1. Reproduce all three defects with host tests before changing production code.
2. Separate a chat's validated assigned project from its absent execution folder. Persist the exact project in the initial protected room authority transaction; revalidate it for discovery and actions. Cover create, later edits, undo, revocation and unassigned chats.
3. Detect explicit risks before trailing question punctuation, retaining hypothetical and genuine interrogative exclusions.
4. Keep full bounded risk evidence for resolution; require each risk-bearing clause to resolve, keeping truncated or ambiguous evidence open. Explicit global clearance can resolve multiple issues.
5. Investigate the native Windows menu crash without retries or skips. Capture lifecycle diagnostics and native crash artifacts if existing logs cannot establish the cause.
6. Run host regressions, TypeScript, protocol checks and relevant Node tests, then independent review. Submit changes for CI; no merge or app installation.

Plan reviewed by a second model before implementation. Windows validation must be recorded separately from Mac results.
