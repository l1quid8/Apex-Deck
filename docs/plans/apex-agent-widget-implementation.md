# ApexAgent floating widget implementation

**Goal:** Build the approved `docs/mockups/apex-agent-widget-v2.html` as a persistent assistant in Apex Deck, replacing the setup-heavy modal with conversation, Activity and Settings.

**Architecture:** App retains host/workspace/folder ownership and durable host polling. A floating shell owns only presentation, placement and explicit project selection. ApexAgent retains guarded per-project requests and conversation. Host source editing is a separate validated command that never replaces an assignment.

**Scope:** Existing read-only monitoring and model backend; one widget across pages; per-project history; adaptive checks; unresolved blockers persist through visits. No fabricated integrations, voice or external sending. Existing unrelated adapter/theme edits remain intact. Production app and daemon must be packaged together.

## Work and checks

- [x] Host source update/discovery commands: validate folder, host, conversation and every source; deduplicate; preserve findings/history/decisions and pause; reject stale checks. Run host/daemon Rust regressions.
- [x] Conversation panel: first message assigns work after source confirmation; suggested sources are removable chips; choose a compatible default profile; Chat/Activity/Settings; saved source edits preserve history; stale discovery/mutations cannot cross projects.
- [x] Floating shell: remembered draggable avatar, edge snapping, keyboard activation/movement, project switcher, aggregate live blocker count, owner-linked bubbles, save-before-success drops, accessible controls and reduced motion.
- [x] App integration: persistent mount across pages, explicit project binding, guarded callbacks/source replies; identity-bearing thread/file drops; Cmd+K in deck/native browser; browser overlays include avatar, panel, bubbles and tooltips.
- [x] Verification: npm test; npm run build; Rust host/adapters/daemon tests; actual Electron interaction/screenshots for page persistence, setup, blocker retention, resolution, drag, switching and browser coverage.
- [x] Package/install: release daemon + Developer ID signed bundle, backup installed app, replace bundle and verify the installed executable/daemon together with isolated data.
- [ ] Live restart: wait for this conversation's agent turn to finish, relaunch the installed app, let it reload its LaunchAgent, and verify live read commands. Deferred runner: `/tmp/apex-widget-restart.mjs`; log: `/tmp/apex-widget-live-restart.log`. Restarting the current daemon during this turn would cancel the installer itself.

## Verified results (October 9, 2026)

- `npm test`: 965 passed, 0 failed, exit 0.
- `npm run build`: exit 0; existing bundle-size warning remains.
- `TMPDIR=/tmp cargo test -p apex-host -p apex-adapters -p apex-daemon --features apex-daemon/remote`: 551 passed, 0 failed, exit 0 (host 178, adapters 215, daemon 158).
- Actual React/Electron widget smoke: 9 passed, 0 failed, exit 0, both development and installed executable. Uses a deterministic local HTTP model and isolated data, not real account data. Screenshots reviewed in `/tmp/apex-widget-screenshots`.
- Release daemon build, signed package, and installed app/daemon signature verification: exit 0. Installed `/Applications/Apex Deck.app`; backup `/tmp/apex-deck-before-widget/Apex Deck.app`.

Regression coverage includes project/folder moves, stale source discovery and replies, assignment ownership, source-edit history preservation, snapshot ordering, resolved/snoozed findings, keyboard/native-browser routing, rendered attention/sidebar persistence, and narrow-window composer visibility. A mock-HTTP timing dependency in clock tests was replaced by a deterministic check callback while retaining the real scheduling/claim/evidence/merge path.

## Review focus

- Drop/save and discovery completion after switching, removing or moving project: never apply to the new owner.
- Closing/reading widget or dismissing a bubble: never resolve durable findings or pause work.
- Source edits during model checks: stale results cannot change history or settle/reopen findings.
- Native browser overlap: avatar remains reachable; overlapping UI freezes browser only while necessary.
- Narrow viewport, keyboard focus, reduced motion and long project/status text: readable controls with no clipped status/glow.
