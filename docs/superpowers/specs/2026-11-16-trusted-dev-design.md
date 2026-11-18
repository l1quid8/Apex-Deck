# Trusted local development

Approved direction: signed snapshots (user, 2026-11-16). No DMG, installer,
or hot-reload issuer. Test the current checkout against the user's existing
threads, with matching UI/daemon and an explicit return to production.

## Approaches

- Live Vite UI plus debug daemon: rejected. Neither is a protected signed
  issuer; starting the debug daemon on live data fails provenance ownership.
- Reinstall production each iteration: works but defeats the requested workflow.
- Signed local snapshot with reversible trust switching: selected by the user.

## Interface and build

`npm run desktop:dev:build` incrementally compiles the daemon and CLI, builds
the UI, and seals a Developer ID signed app directory. One source stamp and
content fingerprint identify the snapshot. `desktop:dev:start` builds then
activates it; `desktop:dev:stop` returns to production;
`desktop:dev:status` reports the observed mode and daemon identity.

Development starts only from `/Users/tylercaldwell/Downloads/apex-deck`.
Use one ignored `staging/trusted-dev` workspace, never release output. Build
as the user; administrator authorization is only for activation/restoration.
Reuse the installed native computer-use helper, explicitly record that fact;
native-helper changes still need the dedicated native build/release workflow.
No production packaging scripts, authority installer, or legacy re-pin script.

## Trust switch

Keep production's protected app and broker executable intact. Copy the signed
snapshot into a fixed separate root-owned `TrustedDev/Apex Deck.app` slot.
Validate anchored signatures, signing team, hardened runtime, dangerous
entitlements, ASAR integrity, Electron fuses, contained symlinks, and exact
binary hashes on the protected copy. Preserve the production config in a
root-owned state record; change only primary UI/daemon/CLI pins while active.
Standalone pins remain unchanged. Reload the existing broker to load pins.
Never recreate, copy back, or reset keys, journal, receipts, ownership locks,
thread data, or identities. Dev activity persists when returning to production.

Stop the production user service before starting the dev user service on the
same canonical data folder. Use a distinct dev LaunchAgent and explicit data
folder so packaged app startup cannot rewrite production's service or enable
automatic updates. Both UI and daemon run as the ordinary user. Require UIs
and computer helper to be closed and agent work to be idle before switching.
Refuse foreign owners, other-account consumers, unexpected config changes,
unsigned/ad-hoc candidates, production signature drift, and concurrent switches.

## Recovery and retention

Persist recovery state before trust changes. Failed activation restores original
pins and the production service. Stop restores the saved production config only
after verifying the original app and current dev config; never restore stale
pins after an unrelated upgrade. Keep recovery state on incomplete rollback.
Stop is idempotent. No SIGKILL, broad process-name killing, or authority deletion.
One staged snapshot and one active protected snapshot; replace only inactive
outputs. Do not prune unrelated release/build folders.

## Verification

Test state transitions and failure injection with temporary paths/fake services,
including rejection before live changes, exact config preservation, rollback,
foreign owners, stale restore, and repeated stop. Run TypeScript and relevant
existing provenance/packaging tests. Build a real signed snapshot and validate
it read-only before administrator activation. Installed acceptance: same source
stamp, protected chat loads, protected submission succeeds in a disposable
thread, switch back, production chat loads. Report any checks requiring user
authorization or UI interaction as pending. Code switching does not undo data
migrations; incompatible schema changes must not use live-data testing.
