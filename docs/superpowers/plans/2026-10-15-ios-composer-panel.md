# iOS Composer Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user explicitly selected Luna as implementer; the parent reviews the result.

**Goal:** Replace the old attachment sheet with the user's chosen Claude-style compact, expandable composer panel.

**Architecture:** Extract a focused controlled `ComposerPanel` from `PhoneApp.tsx`; the parent retains attachment, draft, host, and navigation authority. Use a pure detent helper for gesture rules, scoped CSS for layout, the existing system file inputs for media, and the current theme tokens. Keep all unrelated sheets unchanged.

**Tech Stack:** React 19, TypeScript, Capacitor/WKWebView, CSS, Node test runner, existing Vite/Electron UI-test harness.

**Spec:** `docs/superpowers/specs/2026-10-15-ios-composer-panel-design.md` (read it before implementation).

## Global Constraints

- Preserve all user-owned files and the primary checkout. Implement in the supplied isolated worktree and task branch.
- No new dependency, native photo-library indexing, fake thumbnails, or unsupported controls.
- Compact 48%, expanded 88% of the available frame; safe areas, 44×44 minimum hit regions, 16px labels, 13px metadata, 16px card corners, 12px group gaps.
- Reuse the seven-theme system and its native Reduce Transparency fallback.
- No `desktop:dev` outside the primary checkout. No DMG, upload, deployment, merge, or push. Do not touch unrelated live bot session plans or mockups.
- Require `npx tsc --noEmit` and appropriate tests. Report actual command results and any missing native verification.

## Review Focus

- Picker completes after changing threads: attach to the captured draft (or its migrated thread), never the newly visible thread.
- Picker cancel/read rejection/reselect same file: text survives, busy count resets, inputs clear, and retry works.
- Scrolling the expanded body, nested picker navigation, and small phone keyboards: no accidental dismissal or hidden controls.
- Offline/Read-only access, delayed Plan acknowledgement, or refused Plan request: no fake enabled state or unintended send.
- Keyboard/focus and appearance changes: no background interaction, leaked image URLs, unreadable light surfaces, or transparency when disabled.

## File Map

- Create `src/phone/ComposerPanel.tsx`: isolated presentation, dialog focus, detents, local image previews, media inputs, action rows.
- Create `src/phone/composerPanel.ts`: pure detent/gesture decisions and captured attachment destination helper if useful.
- Create `src/phone/composer-panel.css`: phone panel layout and compact/expanded treatment, scoped to this component.
- Modify `src/phone/PhoneApp.tsx`: replace only `sheet === "add"`, share attachment handling, delegate navigation, add acknowledged Plan toggle and pending-draft preference.
- Modify `src/phone/main.tsx`: import the component stylesheet after shared phone styles; keep `phone-themes.css` last.
- Modify `src/phone/phone-themes.css`: include the new surface in glass/solid selectors without changing unrelated layouts.
- Modify `src/phone/icons.tsx` only if required for media icons; use the existing icon helper.
- Create `tests/phoneComposerPanel.test.mjs` (pure behavior) and `tests/phone-composer-panel.test.mjs` (real component rendering/events with a bounded fixture, following existing `tests/bot-settings.test.mjs`).

## Task 1: Panel shell and interaction

**Interfaces:** export `type PanelDetent = "compact" | "expanded"` and `panelDrag(detent: PanelDetent, deltaY: number): PanelDetent | "dismiss"` from `composerPanel.ts`. Threshold is 64 CSS px: upward delta ≤ −64 expands; downward ≥64 collapses expanded or dismisses compact; smaller motion preserves the detent. All movement decisions apply only to the handle/header. `ComposerPanel` consumes `onClose`, `onPick(kind: "camera" | "photos" | "files", files: File[])`, `files`, `onRemoveFile`, `onTools`, `project`, `machine`, `onProject`, `onMachine`, `plan`, `planPending`, `planDisabledReason`, `onPlanChange(on: boolean)`, and `planError`; define/export its precise prop type in the component. Use stable attachment keys rather than assuming filenames are unique.

- [x] Write failing pure tests: compact −64 → expanded; compact +64 → dismiss; expanded +64 → compact; ±63 preserve; canceled gesture does nothing.
- [x] Run the pure tests with Node's TypeScript test support; the new tests passed after the implementation was added.
- [x] Implement the helper and component with the exact layout/values in the spec; handle drag outside the body, Escape/backdrop close, accessible handle, focus trapping/restoration, and selected-image URL cleanup. Inputs: Camera accepts images with `capture="environment"`; Photos accepts images and multiple selection; Files accepts arbitrary multiple files. Do not open a picker automatically.
- [x] Add a real-component fixture proving initial compact state, handle expand/collapse with actual pointer input, body scrolling doesn't change detent, callbacks fire once, backdrop/Close/Escape restore focus, and URLs are revoked. Include a 320px-wide/short-height viewport and glass/flat theme rendering checks; assert no horizontal overflow and controls meet the 44px hit target.
- [x] Run both focused test files and TypeScript; commit follows the full-suite check.

## Task 2: Connect actual draft and host behavior

**Consumes:** `ComposerPanel` and the existing `sheet`, `drafts`, `readingRef`, `movedRef`, `openSheet`, `pickWhere`, `roomSetPlan`, and `plan_changed` paths in `PhoneApp.tsx`. **Produces:** a working + menu; all attachment sources use one destination-safe handler; the existing send pipeline honors a pending draft's selected Plan mode before posting.

- [x] Test attachment cancellation, failed reads, same-file input clearing, captured-draft migration while a read is pending, and duplicate names. The shared production read helper preserves text and balances busy state; attachment bytes remain draft data until Send.
- [x] Test Plan acknowledgement/rejection, desired false on a reused pending room, captured room ID, and offline/read-only disabled reasons. Refused Plan changes block continuation.
- [x] Replace the old `sheet === "add"` with `ComposerPanel`, keeping the other `Sheet` flows. Share the production file-reading helper without weakening `readingRef`/`movedRef`; capture the draft ID before activating the picker; preserve attachment provenance and cancellation behavior.
- [x] Wire Tools/Project/Machine to the existing sheets. Keep Copy folder path in existing thread details. Apply pending draft Plan after room creation and before posting/queue dispatch; don't optimistically change an existing room after a rejected request.
- [x] Scope theme CSS to the component and grouped surfaces; add solid/Reduced Motion behavior and safe-area sizing without per-thumbnail blur.
- [x] Run focused tests, `npx tsc --noEmit`, and `npm test`; 1,465 tests passed. Commit follows self-review.

## Task 3: Handoff and native review

- [x] Self-review the diff against the spec acceptance conditions, including destination capture before picker launch, pending Plan failure, focus handling, URL cleanup, and arbitrary filenames. Native visual verification remains with the parent.
- [x] Report branch/worktree, commits, test counts, and exact modified files to the parent. Do not merge/push/upload or edit the primary checkout.
- [ ] Parent independently reviews source/diff and runs TypeScript plus focused tests. Fix review findings in Luna's worktree.
- [ ] Parent syncs/builds a signed simulator app from the implementation worktree (iOS builds only; no desktop dev instance) and installs it while preserving paired data. Use `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- ENABLE_DEBUG_DYLIB=NO`; unsigned builds break Keychain identity. Inspect compact/expanded, keyboard, Classic/Liquid/Frost, and picker cancellation. Actual camera capture requires real hardware; document that limitation.
- [ ] Parent reports implemented/reviewed state and any native limitations. A merge or TestFlight upload requires a later release request.

## Reference files supplied by the user

- Current Apex menu: `/var/folders/1s/z_vgd5616hgbkbppz4_4k_f40000gn/T/codex-clipboard-4d39eefd-c5c8-4bb3-ac70-19200b26f92b.png`
- Claude compact: `/Users/tylercaldwell/Pictures/Photos Library.photoslibrary/resources/derivatives/masters/F/FEF8D134-2EAD-4632-9287-BD2819BA70C8_4_5005_c.jpeg`
- Claude expanded: `/Users/tylercaldwell/Pictures/Photos Library.photoslibrary/resources/derivatives/masters/E/E126F0AF-0525-4252-9F6D-5FD60CB1736C_4_5005_c.jpeg`
- Fourth image is another alternative; the user chose Claude, so follow the second and third references.

## Plan self-review

The spec is covered by the component, integration, and native-review tasks. The five review-focus cases are pinned to tasks 1–2. All new interfaces are declared above; existing project/machine protections and host authority remain in `PhoneApp`. The user already requested planning followed by Luna implementation, so dispatch this approved direction without another execution-method question.
