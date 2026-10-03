# Thread sidebar and composer verification

Verified on 2026-10-03 in the browser preview at http://localhost:1431/.

## Implemented

One app-level details sidebar follows the focused thread using a portal. Model edit/save/remove, add model, saved agents, reply policy, rounds, and Changes live there. Pane components stay mounted. The sidebar overlays when docking would leave less than 560 CSS pixels for panes. Its open state and collapsed sections persist with the existing version-1 session.

The later user instruction overrides the original brief for pins: pins remain above the transcript in a collapsed Pinned (count) row, expanding to wrapping full-text pills. They are not in the sidebar.

The composer + menu offers mentions and all existing commands, including export JSON. Typing / or @ filters; arrows and Enter/Tab select; mentions insert at the caret. Argument-free menu commands preserve the draft. No MCP command or configuration changes are included.

## Fresh automated checks

- cargo test --workspace: 166 passed, no failures.
- npm test: 74 passed, no failures.
- npm run build: TypeScript and production build passed; existing large-chunk warning remains.
- git diff --check: passed.

The Rust run exposed concurrent timestamp collisions in both scratch repositories and private git indexes. Both now include atomic counters; an eight-way concurrent snapshot regression test passes.

## Browser checks

- Actual 820 x 1399 CSS pixels (approximately the requested 820 x 1400): header remains one row; sidebar overlays. Escape closes it and returns focus to the title-bar toggle; backdrop click closes it. Canvas width was unchanged by overlay dismissal.
- Actual 1440 x 900 CSS pixels: sidebar docks and pane canvas retains 880 pixels.
- Add model and edit/save existing model work within the sidebar.
- Two panes: focusing each switches sidebar title and controls; empty thread has Add model in its transcript.
- Thread picker shows only the sidebar empty state, not stale controls from a hidden thread.
- Sidebar open state and Room/Changes expanded state survive browser reload.
- /pin with sidebar closed creates the collapsible top strip; expanding reveals the full fact.
- /diff opens the sidebar at Changes and displays preview diff data.
- @nu opens the filtered mention list; Tab selects. Selecting /diff through + preserves an existing draft.
- Temporary viewport override reset after checks.

The preview server stopped during reload; Vite was restarted on port 1431. The production app was not restarted or replaced.

## Not exercised

Native Tauri app behavior, real provider turns and approvals, native terminal resizing/focus, saved-agent selection, and an actual legacy-session fixture in the browser were not exercised in this pass. Optional session fields preserve the existing load defaults; existing storage and turn-queue suites pass. Browser diff data and model responses are simulated.
