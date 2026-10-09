# Glass Themes v4 Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development and work only in the isolated worktree. The human explicitly requested parallel GPT Luna implementation of the reviewed v4 design.

**Goal:** Implement v4's optional glass skins, live Appearance settings, safe import/export and persistent user skins in Apex Deck.
**Architecture:** A bounded data module owns the theme contract; AppearanceSettings uses the existing app settings lifecycle; a separately imported CSS layer styles actual Deck components and activity metadata.
**Tech Stack:** TypeScript, React, CSS, Node test runner, existing Electron runtime.
**Spec:** docs/superpowers/specs/2026-10-08-glass-themes-v4-design.md

## Global Constraints
- No edits in main checkout, HTML mockups or original glass kit. No external assets or new dependencies.
- Classic remains default; existing approval/Stop behavior is preserved.
- Imported skins contain only known numeric/boolean values and no CSS.
- All agents own disjoint files; do not commit while another agent is modifying files.

## Review Focus
- Malformed and oversized imports preserve current state.
- Imported skins survive switching skins and restart.
- Classic does not acquire visual changes from glass CSS.
- Pending approvals remain opaque and >=12px even at extreme values.
- Glow reflects real activity and reduced-motion preference; narrow layouts keep controls reachable.

### Task 1: Theme contract and persisted settings (Luna helper 1)
Files: src/themes.ts, src/settings.ts, tests/themes.test.mjs, tests/settings.test.mjs.
Interfaces: AppearanceValues, SkinFile, AppearanceSettings {current:SkinFile,saved:SkinFile[]}; BUILTIN_SKINS {id,name,note,appearance}[]; DEFAULT_APPEARANCE; parseSkin(text):SkinFile; readAppearance(raw):AppearanceSettings; themeVariables(values):Record<string,string>; themeMode(values):'classic'|'flat'|'glass'; skinPrompt(description):string.
- [ ] Write behavior tests for rejected fields/ranges/types/bytes and v1 migration; run them and verify red.
- [ ] Implement contract and all seven v4 presets. Use --deck-hue, --deck-glow (0..1), --deck-blur, --deck-opacity (0..1), --deck-radius, --deck-backdrop (0..1), --deck-density. Classic returns no overrides.
- [ ] Add optional appearance to AppSettings; readSettings includes it only when saved (preserves old/default settings shape). Validate current and salvage valid saved skins, cap gallery at 50.
- [ ] Run scoped tests; report commands and results.

### Task 2: Appearance controls (Luna helper 2)
Files: src/AppearanceSettings.tsx, src/appearance-settings.css, tests/appearance-settings.test.mjs, docs/themes.md.
Interface: AppearanceSettings({value:AppearanceSettings,onChange:(value:AppearanceSettings)=>void}). Imports Task 1 API; no SettingsPage or App edits.
- [ ] Add behavioral component/render checks matching repository test conventions.
- [ ] Build preset previews, sliders/toggles, Save skin, durable import gallery, export/download, and Copy AI prompt. Read file size before text; errors leave value untouched. Communicate clipboard failures.
- [ ] Controls have labels, keyboard support and narrow-width layout; minimum 12px body copy. Prompt generation copies a truthful contract, it does not fake generation.
- [ ] Run scoped tests and report integration requirements.

### Task 3: Glass surfaces and actual activity (Luna helper 3)
Files: src/glass-theme.css, src/ChatPane.tsx, src/ThreadDetails.tsx if relevant, tests/glass-theme.test.mjs.
Interface: :root[data-deck-theme='glass'|'flat'], [data-deck-light='true']; values from Task 1; bubbles get data-activity='working'|'waiting'|'idle' and --agent-color from real bot color.
- [ ] Inspect real layout and v4 primitive CSS; create behavior/static styling checks for activity and safety boundaries (do not mirror every rule).
- [ ] Add only presentation metadata to actual chat activity. Style panels, toolbar, sidebar, composer, messages, code, tools and details using opt-in rules; no layout rebuild or simulated state.
- [ ] Make hue/glow/frost/opacity/corners/backdrop/density visibly affect appropriate surfaces, respecting flat and reduced-motion. Fix hardcoded colors in the opt-in layer for Frost.
- [ ] Approval colors/typography remain protected, opaque and >=12px. Keep pending amber glow and action text readable.
- [ ] Run scoped tests and report.

### Task 4: Root integration and final verification (controller)
Files: src/App.tsx, src/SettingsPage.tsx, src/main.tsx; browser smoke harness in /tmp.
- [ ] Connect Appearance section and replace disabled General theme row with an Appearance navigation action.
- [ ] Apply current appearance through root data attributes and declared CSS variables, removing overrides on Classic. Import new CSS after existing stylesheet.
- [ ] Verify full npm test and build. Exercise preset selection, import rejection, saving/reloading, sliders, flat/light and mobile with real demo mode screenshots.
- [ ] Request independent review; route fixes to original helpers. Keep worktree and branch for human inspection; do not merge/push.
