# Assistant approved-flow verification

Implementation branch: feat/assistant-approved-flow, based on feat/background-push.
Acceptance: docs/superpowers/specs/2026-10-23-assistant-approved-flow.md; v7 composer and voice details override earlier approximate mockup geometry.

## Source and focused validation

- Threads and assistant use the same ThreadComposerBox and ComposerModeControls. Assistant registers one candidate with the existing VoiceCallBar, VoiceCallControls, VoiceCallCapsule, voice coordinator and local speech engine.
- Request/event-correlated personal bridge tests pass: exact event speech, no history/replay, cancellation/late replies, approval attention, wrong-owner rejection, failed cancellation.
- Host stop tests pass: stops provider future, no late reply/task; cancelled held-cost approval is superseded; failed reply is not restarted after recovery.
- Native dev launch used the required root command. Development UI and checkout daemon were blocked by installed provenance pins; this is expected fail-closed behavior. Protected workflow QA must run in the properly installed signed package.
- Independent review found five Important issues: old-host Escape support, lifecycle wire shape, owning-host runtime provider choices, kept Settings saved baseline, and nested Back label. All five were fixed with observed failing-to-passing targeted regressions. No Critical finding.
- Lifecycle uses durable deleted metadata and purged authority tombstones. Restore is inert; Empty requires exact deleted set, revisions and no outstanding operation receipts. Worker-change startup recovery stages a revised same-task proposal and requires fresh explicit approval.
- Browser uses the existing host browser/profile and preserves session on popup/expand/return. The existing backend has one shared assistant profile per host and does not report selectable profiles or exact tab IDs. No new browser engine was introduced.

Final source validation: 2,438/2,438 frontend tests passed (`/tmp/apex-approved-flow-release-js.log`); 608 host tests passed, 4 ignored (`/tmp/apex-lifecycle-host-tests-verified.log`); 48 provenance tests passed. `npx tsc --noEmit` and `git diff --check` passed. These checks do not substitute for the native checklist below.

## Native acceptance checklist — pending packaged app

- [ ] Add teammate: configured provider/model/reasoning/access, folder/machine, full avatar controls and optional brief.
- [ ] Chat: ordinary question remains Chat, named attribution, one candidate, no bot row; type/Shift+Enter/Enter, TLDR/Plan, attachments/paste, failed send and draft preservation, Stop/Escape.
- [ ] Voice: app default + chat-only override, Bar/Pill/Top bar, mute/end/tuck, granular settings, speech sample/voice engine if available; no false success from controls alone.
- [ ] Runtime chip: owning-host providers, offered text models/effort/speed/access confirmation, truthful unknown quota/context/reset and saved history totals.
- [ ] Work: pending/active/cancelled/finished openable, source-aware Back, no card left-edge decorations; no unsupported generic Retry.
- [ ] Task lifecycle: cancel, delete, restore, empty with exact count; restart persistence; no resurrected task/history or automatic restart.
- [ ] Delegation: one task identity and hidden worker chats by lineage; explicit keep; supported blocked plan revision and fresh approval.
- [ ] Read-only result review distinct from editable changes/checks and exact revision acceptance; actual questions/approvals remain reachable.
- [ ] Settings: save/reopen/save/discard baseline, unsaved drafts through subviews/browser, all original preferences/rules/memory/costs/privacy/schedules/notices.
- [ ] Assistant remove/restore: rejects pending work, preserved identity/history/notes, restore paused through Archived assistants.
- [ ] Browser: mini popup default, expand same session, return, control handoff, hide without relinquishing control, preserved chat draft and narrow pane geometry.
- [ ] Global Agents and keyboard sections never select/route named assistant; left sidebar is assistant entry point.
- [ ] Offline, reconnect and packaged app cold relaunch preserve correct identity and state.

## Release

Stale DMGs inventory/cleanup and final signed artifact verification will be recorded below. No source-check, mockup or suite pass is treated as installed-app verification.

Stale DMG cleanup completed before packaging: removed 4 old Apex Deck DMGs (including hidden .build-0.9.0 copy). Other app bundles, packages, backups, mockups and source files were retained. Exact paths/sizes/hashes:

```json
[
  {
    "path": "/Users/tylercaldwell/Downloads/apex-deck/release/Apex-Deck_0.8.2_arm64.dmg",
    "bytes": 147802856,
    "sha256": "f551382e043bffb97559ddc896115fdab1b09bb4471b6d059533e8042c53f14f"
  },
  {
    "path": "/Users/tylercaldwell/Downloads/apex-deck/release/Apex-Deck_0.8.2_team-simplify_arm64.dmg",
    "bytes": 147707872,
    "sha256": "f3746766c3dbc5881c8b19392d7a4e4409ed8ee636f311908875f4d8b7ad422d"
  },
  {
    "path": "/Users/tylercaldwell/Downloads/apex-deck/release/v0.9.0-assets/Apex-Deck_0.9.0_arm64.dmg",
    "bytes": 147708007,
    "sha256": "ce419969ac1a371655dfa9017ab836cbbb32ea49524ee33ba0a2f0fab4f4e48a"
  },
  {
    "path": "/Users/tylercaldwell/Downloads/apex-deck/release/.build-0.9.0/release/Apex-Deck_0.9.0_arm64.dmg",
    "bytes": 147708007,
    "sha256": "ce419969ac1a371655dfa9017ab836cbbb32ea49524ee33ba0a2f0fab4f4e48a"
  }
]
```
