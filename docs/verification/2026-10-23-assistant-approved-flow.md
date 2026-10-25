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

Final source validation: 2,453/2,453 frontend tests passed (`/tmp/apex-approved-flow-release-js-last.log`, final sequential rerun); 609 host tests passed, 4 ignored (`/tmp/apex-approved-flow-release-host.log`); 51 provenance tests passed. `npx tsc --noEmit` and `git diff --check` passed. One parallel rerun had an unrelated phone composer timing failure (handle tap collapses); the isolated test passed, then all 2,450 passed sequentially. These checks do not substitute for the native checklist below.

Release source commits: `3e11a16`, `cf900fd`, `118a271`, `1d7cd6d`, `0b5bf6c`, `a031b5e`, and `c4d3733`. Direct human task creation now opens the exact durable plan immediately, with a single explicit Approve and start action; retry preserves its task and worker chat.

## Native acceptance observations

The cf900fd signed package was installed through macOS Installer and launched from the protected TrustedUI application. Installed UI CDHash was 3607e73f475b4ed05c512083d9b1b3ec1fb4653f. These observations precede the final polish build and are not a claim that every workflow has passed.

- Created Approved Flow QA through Add team member, using a real ChatGPT Images avatar preview, configured provider/model/reasoning/access, local machine, and disposable folder grant. Optional first brief stayed an unsent draft. Added the disposable repository as an existing project and assigned it within the existing folder grant.
- Ordinary prompt returned QA_CHAT_OK under the saved assistant name. Escape stopped an in-flight reply while preserving an unsent multiline composer draft.
- Browser opened as a chat popup; takeover, navigation to example.com, expansion, return, close and reopen preserved URL, control ownership and unsent chat draft. Explicitly handed control back afterward.
- A real read-only delegated task completed using deepgeek. Read-only Changes/Checks and both criteria were reviewed before Mark reviewed enabled. Finished task deleted then restored without restarting, with correct Finished/Deleted counts. Worker chats remained hidden from the left sidebar.
- A separate editable task intentionally stopped before execution with unsupported Null isolation. Worker revision to Thadious exposed missing login PATH in the protected daemon. This has a source fix and regression; native retry awaits final installed build.
- Personal command proposal was declined and displayed Cancelled and Declined, so nothing ran. QA_CANCELLED.txt remained absent.
- Settings Save/reopen/Discard preserved the correct saved baseline and unsaved style draft across Memory, Connections, Rules, Schedules and Notices subviews.
- Global Agents opened reusable profiles rather than the selected assistant workspace.
- Voice helper and shared layouts/settings were exercised. Native testing found dropped consecutive preferences, reset startup mute, and overflow. Fixed these in 1d7cd6d with deterministic regressions; final native readback remains required. The test call was ended. No claim of voice acceptance is made from control state alone.
- User feedback produced compact header, polished Work/task details, fitting shared voice controls and scrolling Settings actions. Task-detail duplicate Back was caught and fixed in 0b5bf6c; 76 component regressions pass. Final native package readback remains required.

## Native acceptance checklist

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

Stale DMG cleanup completed before packaging: removed 5 old Apex Deck DMGs (including hidden .build-0.9.0 copy). Other app bundles, packages, backups, mockups and source files were retained. Exact paths/sizes/hashes:

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

A broader Downloads inventory found one additional stale worktree DMG before the new DMG build. It was also inventoried and deleted:

```json
{
  "path": "/Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan/release/Apex-Deck_0.8.2_arm64.dmg",
  "bytes": 146544941,
  "sha256": "ffab30091291bf0d42227ca7fe0aa084ec053b708d6bca0969d598a8e8475bc7"
}
```


## Final polish native readback (0b5bf6c installed)

Installer reported successful installation; protected bundle verifier confirmed UI `536ed14bc998d1feb6d9341c4dc1d491c2f926fa`, daemon `8ad77a73737378c533c92cce4aa95b19d91e2a49`, broker `caa232a61f4eab449ac1ce5be512bb8eb29dfbb7`. Cold launch reconnected to This Mac and retained QA identity/history/task state.

- Compact horizontal identity header and Work list/detail hierarchy observed in the actual signed app. Personal cancelled task opened from Work with exactly one source-aware Back action.
- Settings top/middle/bottom screenshots show Save and Discard only at the form end, scrolling away with content. Evidence: native-settings-scroll-top.png, native-settings-scroll-middle.png, native-settings-actions-at-end.png in the task visualization folder.
- Shared voice helper reached Smart Turn ready. Muted QA call remained muted for over two minutes after readiness and through preference/layout edits. Full nickname `QA verifier, helper`, pause 100→150→100, and Top bar/Pill/Bar retained together. Voice panel and Bar fit both a wide pane and a 592px pane with no horizontal scrolling. Call ended; final shared layout Pill and pause100. An initial brief call was mistakenly opened on the real Apex Assistant, then immediately muted/ended; subsequent testing explicitly checked QA workspace identity.
- Native preflight recovery surfaced a protected-receipt collision when choosing a newly created worker chat after a failed check. a031b5e fixes ONLY preflight content addressing (no execution or approval broadening), with legacy receipt migration/replay regressions, and reuses the exact worker room for same-plan retries. Full final native recovery awaits that installed revision. Root provenance suite:51/51, focused frontend44/44, TypeScript/diff check pass.

Cancelled personal task lifecycle readback: Work Finished2/Deleted0 → delete → Finished1/Deleted1 → restore → Finished2/Deleted0, status still Cancelled, Working0, no QA_CANCELLED.txt file. Re-deleted that same QA task; Empty deleted tasks(1) opened exact-count permanent confirmation. Action-time confirmation requested before final purge under Computer Use policy; no permanent deletion executed yet.

Additional real native checks: runtime dropdown offered discovered Claude adapter and actual owning-host API profiles; unknown usage/reset/context clearly disclosed and unsupported reset/compact disabled. Costs view showed sent bytes and unknown-cost replies explicitly. QA-only memory note was saved at assistant revision68 and corrected at69, with separate project notebook scope shown. Remove-and-keep-history was rejected while the delegated task was unfinished; QA assistant remained present. Browser takeover/expand/return/handback retained ownership at narrow width. Opening Browser from the composer Tools sheet revealed an unnecessary sheet left behind; c4d3733 dismisses only that sheet and retains the composer draft (observed RED→GREEN,77 component tests). Full final frontend2453/2453 passed; no new host changes after609/4ignored, provenance51/51 passed.

Final native update prepared: Apex-Deck_0.8.2_assistant-flow-r3_arm64.pkg, manifest ec232021-fa56-4377-9496-d87c323c68e9, UI78ba94fbf539499cf92ad2a6ef18a18bd121be47, daemonf3417e054c2582de48546f96530b5a8a237d20c6, brokerc67d7372dd6a710178e28ec05f8ae95cd183bc38. Protected bundle verification passed. Its Installer authorization/native recovery/browser-sheet readback remain pending; DMG not yet built.


R3 installation readback (after user approved the final macOS prompt): both /Applications and protected TrustedUI passed exact UI/daemon/broker verification against the R3 manifest. Cold launch reconnected and retained the QA assistant, its notes, unfinished delegated task revision6, and exactly one recoverably deleted personal task. User explicitly approved purging that single QA task. Native Empty deleted tasks(1) confirmation was accepted; authoritative readback showed Deleted0, No deleted tasks, and disabled Empty(0). Disposable project Git status remained clean; README intact and QA_CANCELLED.txt absent. Work v8 remains preview-only pending user review; no new DMG built.

Native R3 recovery audit: the existing failed preflight at revision6 had a consumed legacy receipt, so the broker correctly refused migration rather than replaying it. Used normal explicit Pause→Resume controls to reconcile the same task (revisions7→8); status remained Needs you and Execution has not started. Fresh Thadious preflight at revision8 is pending. This supersedes the earlier assumption that the installed-state receipt was unclaimed.

Fresh native preflight at revision8 succeeded and staged revision9: worker Thadious, original separate-copy mode, same task/request/project/criteria, no execution before explicit Approve revised plan. Approved revision9 through native UI. Actual worker completed; result revision16 contained exactly one new-file diff for QA_RESULT.md. Changes and Checks opened (structured checks were empty, not represented as passing). Both criteria checked; exact-revision16 confirmation accepted. Native task reached Done at revision20. Independent project readback found only untracked QA_RESULT.md with exact bytes `Approved flow QA passed.\n`; README unchanged, QA_CANCELLED.txt absent. Browser opened from composer Tools with the Tools sheet absent and the chat composer still visible.
QA assistant archived successfully once work settled. Archived list showed QA beside the pre-existing Fidelity assistant (which was not touched); QA restore requested for paused-state/history verification.

QA archive/restore native check passed: after successful archival, Archived assistants listed Approved Flow QA separately from the user-archived Fidelity QA Verified (untouched). Restored QA returned Paused with the saved identity/avatar/project, Finished2, NeedsYou0, Working0, Deleted0. The purged command task did not reappear. QA was archived again afterward to keep the main team sidebar clear while preserving results/history for inspection. Work v8 remains a separate clickable mockup awaiting review, so no V8 product code or new DMG was produced.

## Approved Work v8 implementation
User approved the mockup before implementation. Work now has one compact row per task, nonempty Needs you/In progress groups, collapsed History and Projects, quiet Deleted tasks and header creation. Project management retains assignments/access/notebook controls without repeating tasks. Management may be hidden while its modal/detail host remains mounted. Scoped tests135/135 and TypeScript/CSS parsing pass. Initial full v8 suite2459/2459 passed; final run follows2 origin regressions/fix. Fresh review Important finding (Work creation inherited earlier Chat origin) fixed with observed RED→GREEN tests. Minor deferred: disabled creation reason is tooltip-only for keyboard users. Native v8 comparison and final DMG still pending.

V8 release source7f094ba: final frontend2461/2461 passed (`/tmp/apex-work-v8-full-final.log`), focused135/135, npx tsc --noEmit, CSS parsing and diff check passed. Host/provenance source unchanged from previously verified609 host/4ignored and51 provenance tests. Fresh review Back-origin issue fixed; no remaining Critical/Important finding. Stale DMG inventory before v8 packaging found0 under release/worktrees (`/tmp/apex-work-v8-dmg-before.txt`); the5 old DMGs remain removed. Restored the same archived QA assistant (paused), resumed it only after confirming no unfinished work, then closed the old app cleanly for v8 update. V8 signing/native comparison pending.

V8 installed and exact protected hashes verified after user approved its prompt. Native wide view matched approved v8: one proposed row, History/Projects collapsed, no duplicated task in expanded Projects. Header New task opened its normal dialog with Projects closed; saved one unstarted read-only QA proposal. Native Manage access and Notebook reachable; Notebook Back returned to Work, task row opened exact revision1 and Work Back returned correctly. Resizing the right panel to640 exposed early overlay switching: main canvas remained full width behind the sidebar, covering tabs/CTAs. Fixed assistant-specific docking minimum400 while Threads retains560. Real component Chromium geometry regression reproduced coverage RED and then passed GREEN over320→640→320. Source d7d7749; TypeScript passes; focused4/4, full frontend2463/2463 (`/tmp/apex-work-v8-resize-full.log`). Signed repair rebuild in progress; native repair readback and final DMG pending.
Repair signed package prepared: Apex-Deck_0.8.2_work-v8-r2_arm64.pkg, manifest3b601c76-61f6-423c-a6a6-625e80104b32; UI80b8f09c1467a39a3712e96e18987c196e063789, daemon8f6cc56613d38edb6cb5c96efcb6bbfc57df6ecb, brokerc67d7372dd6a710178e28ec05f8ae95cd183bc38. Candidate bundle validation passed. Developer ID signed; notarization skipped because credentials/options were unavailable. Installer now awaits user approval; no final DMG yet.

Repair installation retry: user approved r2, but preinstall correctly refused while TrustedUI was running; exact installed hashes remained v8. Quit TrustedUI through native Cmd-Q and independently confirmed no UI process remains. Installer became unresponsive after reopening; recovered through macOS Force Quit (Installer only), reopened the same package, and restarted installation. The current macOS authentication prompt is pending. Candidate/signature unchanged; native repair acceptance and final DMG remain gated.

Final superseding readback: the r2 repair and subsequent assistant-provider update were installed successfully. The final provider build passed native narrow Work320→640→320, provider/chat/Stop/restart checks and mounted DMG exact-content verification. See docs/verification/2026-10-23-assistant-providers.md for exact signatures, checksum and the explicit limitation that the prior disposable project directory was removed externally before historical task workflow reruns. Earlier pending installer statements above are historical checkpoints, not current blockers.
