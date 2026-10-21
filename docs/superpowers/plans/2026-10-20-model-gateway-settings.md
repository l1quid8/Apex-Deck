# Model Gateway Settings Implementation Plan

Goal: Implement the approved Model gateway Settings mockup using the existing gateway and local owner authority.

Architecture: Add local-only status/configure commands beside the existing local-only key commands. A daemon-owned controller persists listener configuration and controls the live listener. React uses these commands through the desktop local backend; remote/device/token clients cannot administer it.

Constraints: Preserve MCP isolation, including legacy keys. Preserve unrelated working files. No deployment or merge. Use existing theme tokens. Readiness means configured/installed, not an invented successful completion.

- [x] Add regression coverage proving remote/device sessions cannot query or configure the gateway; implement persisted listener controls and test enable/disable/failure rollback.
- [x] Add typed UI API, validation and tests; implement Settings navigation, endpoint configuration, keys/Providers tabs, one-time secret reveal/copy, scope/caps, revoke confirmation, empty/loading/error states.
- [x] Verify component interactions and owner restriction, run npm test, cargo test -p apex-daemon and npx tsc --noEmit; review diff.

Review focus: stale async replies after host changes, secret lifetime, disabled/failed listeners, invalid numeric limits, remote authority bypasses. Existing key format has no expiry: display “Until revoked” rather than offering a nonfunctional expiry control. Existing spend periods are UTC epoch-aligned 30-day buckets, and caps can overshoot by one request; explain this accurately.

Verification: 1,776 JavaScript tests passed; TypeScript passed. Daemon suite: 117 unit tests and 25 integration tests passed; one live-Grok test intentionally ignored. Real UI-to-daemon flow verified listener enable/disable, key issuance and revocation, one-time reveal dismissal, hashed storage, HTTP 401 without a key and after revocation, and a 390px layout without horizontal overflow. Evidence: `/tmp/apx-gateway-settings-qa/summary.json`.

Independent review identified persisted-bind startup failure and overlapping listen-address changes. Fixed by retaining the local owner socket after saved gateway errors (also corrupt configuration), and requiring the gateway to be disabled before listen-address/port edits. Regression test observed failing before recovery changes and passing after. Shared checkout was switched by concurrent voice work; task edits were moved to an isolated worktree and removed from the shared checkout while preserving voice edits.

Desktop remote-feature all-target compilation passed after updating three test-only Daemon constructors to include the shared gateway key store and runtime.
