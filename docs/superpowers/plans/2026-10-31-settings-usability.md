# Apex Deck Settings Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after the start gate is satisfied. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make settings easier to find and understand, with clear Light/Dark/System modes, accurate scope, and advanced controls available without dominating routine use.

**Architecture:** Keep the existing React settings components and persistence paths. Add a shared settings catalog for navigation, search, scope and anchors; reorganize existing controls rather than rebuilding their underlying services. Separate appearance mode from skin styling and preserve existing saved preferences.

**Tech Stack:** React, TypeScript, existing CSS/theme tokens, Electron, existing Rust host commands and Node test runner.

**Spec:** Product brief and acceptance criteria embedded in this document, based on the live twelve-section settings review and Tyler's direction.

**Status:** Product implementation authorized 2026-10-31+ by Tyler: build settings rebuild NOW concurrently with Jigga's UCU guard fix in isolated worktree `/Users/tylercaldwell/Downloads/apex-deck-worktrees/settings-usability` on branch `feat/settings-usability`. This authorization supersedes the earlier wait-until-UCU start gate. An interactive prototype exists at `mockups/settings-v2/index.html`; it uses sample data only and does not change Apex Deck settings.

## Product brief

Settings should help someone accomplish a task without first learning Deck's implementation. Everyday choices belong up front; technical explanations, maintenance and rare configuration belong behind clearly named disclosures. Keep useful existing features discoverable through search rather than deleting them to achieve simplicity.

Tyler specifically requested a comprehensive plan to execute AFTER Unified Computer Use is finished, and called out the lack of obvious Light and Dark modes. Existing appearance code already supports light surfaces; the missing product behavior is a prominent explicit mode choice, including System, independent from skin selection.

## Global constraints

- Do not start settings product implementation while Unified Computer Use remains the active implementation/release task.
- First deliver a clickable mockup for review before changing the product UI.
- Preserve existing saved chats, keys, phone pairings, host definitions, model configuration and skins.
- Simplification must not remove any existing settings feature, option, value range or workflow. Reorganize behind named, searchable groups; preserve a control-by-control coverage map.
- Existing controls retain their behavior unless Tyler explicitly requests a behavior change.
- Dark mode uses a true black (#000000) canvas and sidebar, with neutral near-black elevated surfaces; no blue-gray base tint. Light mode remains separate and unaffected.
- Main window and pop-outs must agree on appearance and global preferences.
- Keep per-thread and per-agent controls in their respective details; settings explains defaults and global configuration.
- No new UI framework, backend rewrite, test framework or broad component rewrite.
- Reuse existing tests and add focused coverage for meaningful new behavior; no test-file proliferation for copy and spacing edits.
- Follow repository branch/build instructions; production DMG packaging runs under the canonical release directory.
- No unrequested installer execution, remote access changes, credential changes, or deletion of user configuration during this work.

## Start gate

- [x] Start gate superseded by explicit authorization 2026-10-31: implement settings rebuild NOW concurrently with Jigga's UCU guard fix (Tyler direction in Work chat). Keep UCU engine/input/permissions untouched.
- [ ] Refresh the settings inventory against final source and installed build post-UCU where observable; document deltas.

Original gate (for release finalization):
- [ ] Finish and integrate the currently authorized Unified Computer Use scope: foreground reliability, thread grants, supported adapters and invocation-time model warnings, cursor behavior/optional labels, and the newly requested background/minimized slice.
- [ ] Verify the exact combined installed build and document real-task results and remaining limitations; do not substitute agent reports or successful compilation for installed behavior.
- [ ] Confirm with Tyler that Unified Computer Use is finished enough to switch focus to this plan.

## Review focus

1. Legacy custom skins: opening or migrating settings must not unexpectedly change the existing appearance.
2. System mode: OS appearance changes must update all open windows without overriding an explicit Light or Dark selection.
3. Remote hosts: settings must make clear which machine is affected, and search must not expose controls unavailable to the current user/host.
4. Autosave: errors and rapid consecutive edits must not silently lose settings or report stale success.
5. Keyboard use: search, disclosures and section changes must preserve focus, and Escape must dismiss the innermost open UI first.

## Proposed navigation

Keep one settings surface with grouped navigation, not another collection of nested modal dialogs. The mockup validates names and grouping before implementation.

| Group | Pages | Purpose |
|---|---|---|
| Everyday | General, Appearance, Calls | Daily behavior, look and voice |
| Work | New threads, Terminal, Shortcuts | Creation defaults and work preferences |
| Connections | Models & providers, Computers, Phones | Provider configuration and connected devices |
| Capabilities | Unified Computer Use, Extensions, Model gateway | Optional features and access management |
| Maintenance | Data & storage, About & updates | Migration, locations, version and diagnostics |

Rename Hosts to Computers and Mods to Extensions in the mockup, while retaining old terms as search aliases. Do not rename commands, stored keys or protocols for a cosmetic navigation change. Group headings should help scanning rather than add a new navigation level. Advanced pages remain reachable and searchable.

## Phase 1: Clickable design and inventory

**Files:** Create `mockups/settings-v2/index.html` and, only if needed, adjacent local assets. Reference `src/SettingsPage.tsx` and existing settings components. Create `docs/superpowers/specs/2026-10-31-settings-usability.md` when the mockup direction is accepted.

- [ ] Audit every existing control against the prototype coverage map; never omit a feature to simplify the page. Inventory: source component, storage owner, scope, default, restart requirement, visibility condition and destination in the new navigation.
- [ ] Build a clickable mockup with grouped navigation, search results, basic/advanced disclosures, save feedback, and Light/Dark/System selection. Use fake configuration and keys, never live credentials.
- [ ] Include representative populated, empty, disconnected, saving and failed-save states; show both a narrow window and the current desktop width.
- [ ] Make the mockup demonstrate Appearance, Calls, provider setup, thread defaults and Unified Computer Use in enough detail to assess the hierarchy.
- [ ] Review the mockup with Tyler and record the chosen design before product implementation. Retain a coverage map so no existing setting disappears accidentally.

**Acceptance:** A user can find appearance mode, choose a call engine, locate a connection problem, and understand thread defaults without opening advanced sections.

## Phase 2: Navigation, search and scope

**Files:** Modify `src/SettingsPage.tsx`; create `src/settingsCatalog.ts`; extend existing settings styles and tests.

**Interfaces:** `SettingsScope = 'app' | 'host' | 'new-thread'`; catalog entries contain stable `id`, `section`, `label`, `keywords`, `scope`, `advanced` and `anchorId`. `searchSettings(query, entries)` returns ranked visible entries. Runtime visibility filtering occurs before search, using the same host/owner conditions as navigation.

- [ ] Introduce the catalog and grouped navigation without changing stored settings keys. Preserve existing section identifiers/deep links through aliases where labels change.
- [ ] Add a labeled search field. Search visible setting names, descriptions and aliases; rank exact label matches before keyword matches.
- [ ] Selecting a result opens its section, expands the needed disclosure, scrolls to its anchor and focuses/highlights the control. Clearing search restores ordinary navigation.
- [ ] Display concise scope labels: All chats, This Mac/current host, or New threads. For new-thread defaults, explicitly state that existing threads retain their settings.
- [ ] Provide an empty-results state and keyboard navigation; Escape clears an active search before closing settings.
- [ ] Extend existing settings tests for aliases, hidden-owner entries, result navigation and nested Escape behavior. Verify manually with keyboard and a narrow window.

**Acceptance:** Searching voice, SSH, dark, screenshots, API key or chips reaches the right available control; results never offer an inaccessible administrative action.

## Phase 3: Explicit Light, Dark and System modes

**Files:** Modify `src/themes.ts`, `src/useAppearance.ts`, `src/AppearanceSettings.tsx`, `src/appearance-settings.css`, `src/settings.ts`, appearance call sites and existing theme/pop-out tests.

**Interfaces:** Add optional `colorMode?: 'system' | 'light' | 'dark'` to `AppearanceSettings`, separate from portable `SkinFile.appearance.light`. `resolveColorMode(mode, systemDark)` returns the effective light/dark choice; derive effective appearance values at render time without rewriting the saved skin on each OS change.

- [ ] Place a visible System / Light / Dark selector at the top of Appearance, with System the default for new profiles.
- [ ] Migrate existing profiles lacking `colorMode` to explicit Light or Dark from their existing `current.appearance.light`, preserving their current look.
- [ ] Selecting another skin changes its style but does not override the user's selected mode. Imported skins retain their own portable light hint; importing does not silently change the global mode.
- [ ] In System mode, subscribe to `prefers-color-scheme` changes; clean up listeners and update the main window and existing/new pop-outs consistently.
- [ ] Replace the ambiguous Light surfaces control with this mode selector. Align the sidebar appearance shortcut with the same persisted state and clear labels.
- [ ] Audit Classic, glass and Clay in both modes: text, selected states, inputs, menus, code, terminal and approval surfaces must remain legible. Preserve solid approval surfaces.
- [ ] Extend existing theme tests for migration, explicit override, live OS changes, listener cleanup, skin import and pop-out agreement. Perform a live visual pass in both modes and System.

**Acceptance:** Mode is obvious, persists after restart, follows the OS only when System is selected, and no existing custom skin unexpectedly changes during migration.

## Phase 4: Everyday settings and appearance simplification

**Files:** Modify `src/SettingsPage.tsx`, `src/AppearanceSettings.tsx`, `src/appearance-settings.css`, `src/ChipStylePicker.tsx` and existing component tests.

- [ ] Keep General focused on routine behavior such as artifact opening and code-block Run buttons. Move voice to Calls, storage/import/cache maintenance to Data & storage, version/update actions to About & updates.
- [ ] Place compact skin choice, accent and reading density before advanced appearance tuning. Separate built-in themes from saved themes; preserve all saved entries even where names duplicate.
- [ ] Move bot-chip styling, Show effort and Show usage out of New threads into Appearance because they affect current chats too.
- [ ] Put detailed glass, background effects, empty-thread animation and skin import/export/AI-prompt tools behind named advanced disclosures. Search must still reach them.
- [ ] Keep New threads limited to actual creation defaults and clearly identify any exceptions. Use consistent card padding and heading alignment; fix the currently flush-left Bot chips subsection when moving it.
- [ ] Add a reversible Reset section action only for settings where prior values can be restored; never include keys, devices or data deletion in a generic reset.

**Acceptance:** Default pages present a manageable set of primary choices and each preference has one canonical editing location.

## Phase 5: Calls, models and connection clarity

**Files:** Modify Calls/Providers rendering in `src/SettingsPage.tsx`, `src/HostsSettings.tsx`, `src/PhonesSettings.tsx`, `src/ModelGatewaySettings.tsx`, and their existing tests. Extract Calls/Providers into focused components only if needed to keep the page manageable.

- [ ] Calls shows engine selection first, then only the active engine's relevant controls. Keep common call-layout settings in a separate shared group. Switching engines preserves inactive engine preferences.
- [ ] Consolidate default voice in Calls. Show relevant provider-key status there with a link to its canonical key editor instead of duplicate Replace/Remove controls in multiple pages.
- [ ] Models & providers separates visibility in bot creation, installation, configured credentials and verified connectivity. Never label installation-only checks as working/authenticated.
- [ ] Computers shows friendly machine name, endpoint and connection status, plus an actionable recovery hint for known failures. Retain raw diagnostics behind Details.
- [ ] Phones offers editable friendly names while keeping stable device identity underneath. Preserve pairing/access records and place identifiers and networking under Details/Advanced. Verify backend support before introducing a rename command.
- [ ] Gateway leads with endpoint status and issued access. Keep provider credentials and client access keys visually distinct; retain current owner/remote restrictions and put listener networking under Advanced.
- [ ] Extend existing tests for engine preference preservation, provider status distinctions, duplicate phone names and restricted remote controls. Test with simulated failures rather than changing live access or credentials.

**Acceptance:** A user can tell hidden, installed, configured, disconnected and verified states apart, and understands which device or provider a change affects.

## Phase 6: Capabilities, maintenance and feedback

**Files:** Modify `src/ComputerUseSettings.tsx`, `src/ModsSettings.tsx`, `src/settingsSave.ts`, settings page/styles and existing tests; reuse `src/LegacyImportScreen.tsx` and existing update components.

- [ ] Reconcile Unified Computer Use with the final implementation: global enabled state, permissions, thread approval/revocation and cursor preferences first; move technical/privacy explanations into concise help. Do not reintroduce a per-agent enable switch or global “This model” warning.
- [ ] Extensions shows status, purpose, commands and declared capabilities as text/badges, rather than disabled permission checkboxes. Clarify labels such as Options without changing extension access.
- [ ] Data & storage groups location, legacy import and remembered-model maintenance with specific action names and appropriate confirmation only for actual destructive operations.
- [ ] About & updates displays version and update status, distinguishes local test builds where available, and keeps update actions truthful to the actual installed artifact.
- [ ] Group Shortcuts by navigation, threads, panes and composer; reuse settings search for matching action names and shortcut text. Fixed shortcuts remain honestly labeled until rebinding is separately designed.
- [ ] Add compact Saving / Saved / Could not save feedback tied to the latest edit. Failed saves retain the local value for retry; stale completions must not overwrite newer edits or announce false success.
- [ ] Use switches consistently for persistent on/off preferences and checkboxes for multi-selection lists. Keep labels clickable, focus visible, and destructive actions separated from routine edits.

**Acceptance:** Every change has understandable scope and save feedback; errors are recoverable and never masquerade as a successful save.

## Phase 7: Validation and release

- [ ] Run `npx tsc --noEmit` and the existing targeted settings, save, themes, appearance, phone, provider, gateway and shortcut tests affected by the final diff. Add only behaviorally meaningful cases to those suites.
- [ ] Run `npm run build` once after integration; broaden checks only for actual failures or newly affected areas.
- [ ] Use the existing running Electron development window for UI review. Check wide/narrow layouts, keyboard navigation, Escape, search-to-advanced results, focus visibility, reduced-motion behavior and text legibility in Light/Dark/System.
- [ ] Check settings persistence across restart and cross-window updates; test legacy preferences and simulated save failures without touching real credentials/pairings.
- [ ] Inspect the whole branch for missing controls against Phase 1's inventory and review the actual UI with Tyler before packaging.
- [ ] Merge the checked change, build one signed candidate under the canonical release directory, and verify its source stamps, signatures and package contents.
- [ ] If installation is requested, cold-launch the intended installed copy and verify the delivered settings flows. Package success alone is not installed-app acceptance.

## Definition of done

- Every existing settings feature, option, range and workflow is retained and mapped to a prototype/product location; everyday and advanced controls are clearly separated.
- Dark mode has a true black canvas/sidebar with neutral near-black panels; Light mode remains unaffected.
- Search reaches the right visible control and communicates its scope.
- Light/Dark/System is prominent, persistent and consistent across windows.
- No duplicate voice editor, no global chip styling hidden under New threads, no misleading provider or model status.
- Autosave gives accurate success/error feedback and preserves the latest edit.
- The accepted mockup, final source, verified installer and observed installed behavior are distinguished in the release report.

## Explicit exclusions

No redesign of the main Work UI, no new provider authentication system, no gateway networking changes, no Unified Computer Use engine changes, no full theme rewrite, and no configurable keyboard shortcuts in this project. These require their own scope if requested.
