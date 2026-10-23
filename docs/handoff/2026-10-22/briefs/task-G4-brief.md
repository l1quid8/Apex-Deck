# Task G4: Packaged app hands off to the protected TrustedUI copy

## Why (observed 2026-10-22)

`scripts/install-provenance.sh` copies the signed app to
`/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app` (root-owned) and
pins its CDHashes. The broker (`crates/apex-provenance/native/peer.m`) only trusts peers whose
executable path is root-owned and non-writable at every component, so neither the UI nor the
daemon of `/Applications/Apex Deck.app` (user-owned, inside group-writable `/Applications`) can
ever be trusted — even with identical CDHashes.

Users still launch the `/Applications` copy (Dock, Spotlight, Finder). When they do,
`desktop/main.mjs` → `startAgent()` → `installAgent` rewrites
`~/Library/LaunchAgents/dev.apexdeck.daemon.plist` with the running app's
`resourcesPath/bin/apex-daemon` (the untrusted one) and reloads it. Result: the trusted daemon
is replaced by an untrusted one, protected ledgers become unavailable, and the user's assistants,
tasks and conversations disappear from the app.

## Required behavior

In the packaged macOS app only (`app.isPackaged`, `process.platform === 'darwin'`), at startup
before any daemon/agent work:

1. Determine whether the running bundle is the protected copy (compare the canonical
   `app.getAppPath()`/bundle path against the fixed TrustedUI path; the path is a constant, not
   configurable by env/argv — consistent with "no key/service-path environment overrides").
2. If not the protected copy AND the protected copy exists AND its `CFBundleShortVersionString`
   equals the running app's version: launch the protected copy (`open -a <path>` or
   `shell.openPath`, forwarding nothing that the packaged startup would refuse) and quit this
   instance **without** touching the LaunchAgent or starting a daemon.
3. If not the protected copy and the protected copy is missing or a different version: continue
   as today, but never rewrite an existing LaunchAgent that currently points at the TrustedUI
   daemon with a non-trusted path; surface a visible, concrete notice (existing settings/notice
   mechanism) that protected assistant data needs the trusted install (re-pin), instead of
   silently downgrading.
4. `launchAgent.mjs`'s agent install must prefer the TrustedUI daemon path when the protected
   copy is installed and the versions match, regardless of which bundle is running.
5. Development builds and isolated QA (`APEX_DECK_DATA_DIR` absolute) keep current behavior.

Keep the logic in a small pure module (e.g. `desktop/trustedInstall.mjs`) with all filesystem
and process effects injected, matching how `launchAgent.mjs` injects effects so tests never touch
the real `~/Library`.

## Tests (TDD — RED first)

Node tests (existing `tests/*.test.mjs` style, `node --experimental-strip-types --test`):
- running from /Applications, trusted copy present & same version → handoff, no agent write;
- trusted copy missing → no handoff, agent not downgraded from an existing trusted path, notice raised;
- version mismatch → no handoff, notice;
- running from trusted path → no handoff, agent points at trusted daemon;
- dev build / isolated data dir → unchanged behavior.
Run focused tests, `npm test`, `npx tsc --noEmit`.

## Constraints

No env var/argv can change the trusted path or force/skip handoff in packaged builds.
Commit only this task's files.
