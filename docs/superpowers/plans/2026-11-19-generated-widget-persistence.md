# Generated widget persistence implementation plan

Goal: restore each generated card's settings after safe teardown, with a cached image instead of fallback flashes.

The user selected a host-owned widgetState/setWidgetState bridge in the conversation. Keep existing sandbox shutdown, permissions, no-network policy and watchdog. Persistent JSON is limited to 4 KiB, depth 16 and 512 nodes. Scope by existing identity/code/runtime digest. Snapshots are raster PNGs captured only from the isolated generated view; never capture the Deck window. Bound both caches, write atomically in the app data directory, and return only a requested card's cache to its trusted owning Deck renderer. Unsupported clients retain readable fallback.

- [x] Add validator and bounded host-owned storage with reconstruction/corruption/identity tests.
- [x] Add exact-key state protocol, restore before behavior, reject stopped/spoofed writes, and cache screenshots outside sandbox.
- [x] Reserve a blank slot before initial rendering; show cached image during remount. Update guidance with validated restore/save examples.
- [x] Run TypeScript, focused security/lifecycle tests, then Electron authority and lifecycle probes; document exact evidence and gaps.

Work stays in this agent copy; no branch switch, commit, merge, push or installer build, following the active Deck workspace instruction. A requested plan-review agent could not start because the collaboration service returned “no rollout found”; self-review substitutes until independent review is available.

Results and outstanding environment-dependent acceptance are recorded in `docs/superpowers/reviews/2026-11-19-generated-widget-persistence.md`.
