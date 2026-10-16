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

- [ ] Write failing pure tests: compact −64 → expanded; compact +64 → dismiss; expanded +64 → compact; ±63 preserve; canceled gesture does nothing.
- [ ] Run `/opt/homebrew/bin/node --experimental-strip-types --test tests/phoneComposerPanel.test.mjs`; confirm the tests fail for the missing implementation.
- [ ] Implement the helper and component with the exact layout/values in the spec; handle drag outside the body, Escape/backdrop close, accessible handle, focus trapping/restoration, and selected-image URL cleanup. Inputs: Camera accepts images with `capture="environment"`; Photos accepts images and multiple selection; Files accepts arbitrary multiple files. Do not open a picker automatically.
- [ ] Add a real-component fixture proving initial compact state, handle expand/collapse, body scrolling doesn't change detent, callbacks fire once, backdrop/Close/Escape restore focus, and URLs are revoked. Include a 320px-wide/short-height viewport and Frost/Liquid rendering checks; assert no horizontal overflow and controls remain reachable.
- [ ] Run both focused test files and TypeScript, then commit the focused component with its tests.

## Task 2: Connect actual draft and host behavior

**Consumes:** `ComposerPanel` and the existing `sheet`, `drafts`, `readingRef`, `movedRef`, `openSheet`, `pickWhere`, `roomSetPlan`, and `plan_changed` paths in `PhoneApp.tsx`. **Produces:** a working + menu; all attachment sources use one destination-safe handler; the existing send pipeline honors a pending draft's selected Plan mode before posting.

- [ ] Write failing tests for attachment cancellation, failed reads, same-file reselect, navigation during picker/read, draft migration during read, and duplicate names. Assert unchanged draft text, no cross-thread attachment, no host upload before Send, and balanced busy state.
- [ ] Write failing tests for existing-room Plan acknowledgement/rejection, offline/read-only disabled reasons, first-send Plan set ordering, and a refused first-send Plan change leaving the draft unsent. Pin which room ID receives the request even if navigation occurs while awaiting it. Reuse existing phone send/recovery fixture patterns rather than fake a success path.
- [ ] Replace the old `sheet === "add"` with `ComposerPanel`, keeping the other `Sheet` flows. Factor the current file-reading handler without weakening `readingRef`/`movedRef`. Add a captured picker draft ID before input activation, not only after the native picker returns. Preserve attachment provenance and cancellation behavior.
- [ ] Wire Tools/Project/Machine to the existing sheets. Keep Copy folder path only in existing thread details. Extend Plan state minimally; apply pending draft Plan after room creation and before `roomPost`/queue dispatch. Do not optimistically show a rejected existing-room change.
- [ ] Scope theme CSS to the component, making the background and large grouped surfaces match the selected theme; add solid/Reduced Motion behavior and keyboard-safe sizing. Do not add blur to each thumbnail.
- [ ] Run focused tests, `npx tsc --noEmit`, and `npm test`; fix regressions, update the plan checkboxes with evidence, then commit.

## Task 3: Handoff and native review

- [ ] Self-review the diff against every spec acceptance condition, especially destination capture before picker launch, pending Plan failure, focus handling, and arbitrary filenames. Report any unresolved concern.
- [ ] Report branch/worktree, commits, test counts, and exact modified files to the parent. Do not merge/push/upload or edit the primary checkout.
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
