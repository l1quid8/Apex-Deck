# Adaptive thread panes — detailed mockup plan

**Goal:** Evaluate readable, snapping thread panes with the user's own conversations before deciding on production work.

**Architecture:** A frozen minimized snapshot feeds a standalone DOM prototype. State (selection, ordering, spans, drafts and local preview messages) lives only in the page. Rendering and ResizeObserver adapt individual panes independently of the browser window.

**Tech stack:** Browser-native HTML, CSS and JavaScript; existing Playwright Core for verification; no new dependencies.

**Specification:** The design and interaction sections below constitute the mockup specification. The user explicitly requested the mockup be created, so this plan authorizes the throwaway study, not product implementation.

## Purpose and boundary

Create an inspectable, clickable design study for the user's crowded Threads workspace. Use real local titles, participants and short transcript excerpts. Deliver a standalone HTML/CSS/JavaScript prototype under `mockups/adaptive-thread-panes/`; do not modify production components, start a development/release build, merge, or change the live session. The user requested ten Luna agents; run ten separately scoped agents in batches of three because the coordinator occupies the fourth slot.

## Evidence and assumptions

The supplied screenshot shows roughly fourteen chats competing with repeated composer, avatar, folder and queue furniture. Current source uses absolute pane rectangles with 8px gaps in `src/PaneLayout.tsx`, with continuous divider resizing and drag-to-split/swap. Current saved session has fewer open chat panes than the screenshot. Therefore show two explicit datasets: currently open chats and a fourteen-thread density study selected from real saved workspace threads, including closed chats labeled as archived. Never present archived threads as currently open. Use snapshot timestamps; historical participant lists do not prove current running status. Unknown queue/activity/unread values remain unknown or explicitly simulated.

## Design direction

Retain Deck's quiet dark workspace, system sans-serif typography, restrained teal selection accent, small rounded pane frames, left project/thread rail and top Threads navigation. Prioritize thread title, conversation and state. Avoid perspective scaling and tiny text. Text reflows; code can scroll. Body copy stays at least 13px. Suggested tokens: canvas #101112, panel #181a1c, raised #222528, border #34383c, text #edf0f2, muted #a6afb6, accent #72d6c5. These are design defaults, not user-approved production tokens.

## Screens and layout

1. Default Focus: selected chat occupies two grid columns and two rows where space allows; monitoring panes occupy the remainder and scroll without shrinking below useful height. Selecting another thread expands that thread without changing its stable list position. All threads stay discoverable.
2. Grid: equal monitoring panes in one to four discrete columns. The selector controls an upper bound; the available workspace width determines the actual safe column count.
3. Composer comparison: shared destination-locked composer by default, switchable to per-pane composers for evaluating the unresolved preference. Both modes use the same per-thread draft map.
4. Dataset control: current open chats or fourteen real saved threads. Search matches title and member names. A selected thread excluded by filtering remains the explicit composer destination or selection changes only after a deliberate action; never silently retarget a draft.
5. Small screens: sidebar collapses, controls wrap, single-column chat list. Short windows scroll rather than clipping the composer. No horizontal page overflow.

## Adaptive contents

Measure each pane's actual width AND height with ResizeObserver. Full: width >=420 and height >=300; title, readable transcript, participants and unobtrusive footer. Compact: width >=240 and height >=180; smaller header, fewer transcript entries, no folder chip, queue as a small count if known. Tile: width <240 OR height <180; title (up to two lines), member names, latest excerpt and explicit Expand control. The header title is the last element to lose room. Keep status labels in text as well as color. Thresholds are prototype tuning values.

## Snapping and movement

Support one-to-four column presets and pane spans of one or two. Provide a visible drag handle, a ghost outline, and commit only on release at valid snap targets. Escape and pointer cancel roll back; no intermediate layout persistence. Keyboard alternatives must allow movement and span adjustment without dragging. Layout controls cannot cause drafts to switch threads. Disable impossible span controls in a one-column viewport. Respect reduced motion; use only brief action-driven transitions.

## Composer and routing contract

Show `To: full thread title` and the available participant handles. The selected pane and composer share an accent. Incoming/simulated updates never select a pane. Save draft before any selection, composer-mode, filter or dataset change. Drafts are keyed by real immutable thread ID, never by title or list index. No localStorage, live API or real Send. A button labeled `Preview send` adds only a clearly marked local preview message and confirms that nothing was sent. Keep source snapshot excerpts distinct from preview messages. Reset returns UI state and in-memory drafts to defaults after an explicit control action.

## Data minimization and provenance

Read session.json once and extract chat IDs, titles, workspace label, closed flag, participant display names/IDs and up to the last three nonempty transcript text excerpts, each bounded in length. Omit credentials, backends, tool results, attachments, filesystem paths, permissions, environment and original drafts. Escape all strings using textContent. Store the minimized fixture in a local script plus a provenance JSON containing capture time, counts and extraction rules. Keep the preview bound to loopback; do not deploy or share externally. Do not touch live data.

## Ten Luna assignments and owned artifacts

1. UI audit: source furniture, visual conventions and thresholds (read-only).
2. Data audit: persistence schema and snapshot selection (read-only).
3. Interaction contract: routing, snapping and failure cases (read-only).
4. Shell and CSS: `index.html`, `styles.css`; adhere to integration contract below.
5. Runtime: `app.js`; adaptive rendering, datasets, selection, drafts and snap controls.
6. Snapshot fixture: `data.js`, `provenance.json`; minimized real local data only.
7. Independent usability/accessibility review: `review-accessibility.md`; scoped fixes if assigned.
8. Browser verification: `verify.mjs`, `verification.json`, screenshots; exercise actual interactions.
9. Plan/builder review: `review-plan.md`; reconcile plan against resulting prototype.
10. Final refinement: inspect integrated visual and interaction defects, fix only agreed prototype files and record `review-final.md`.

Agents 1–3 investigate independently. Agents 4–6 build disjoint artifacts using the fixed contract. Agents 7–9 review and verify the integrated result independently; the coordinator resolves their findings. Agent 10 follows with bounded final refinement. No agent may write another agent's active artifact. Record the exact ten task names and outcomes in `README.md` after verification.

## Review focus

- Mixed archived/open dataset: historical threads must never appear to be active merely because they are displayed in the density study.
- Focus while editing: selecting a thread, toggling modes, reordering and filtering must not leak draft contents into another destination.
- Extreme geometry: a wide, shallow panel uses the height threshold; a tall narrow panel uses the width threshold; controls remain reachable at phone widths.
- Interrupted drag: cancelled gestures restore exact order; moving controls must be outside the transcript's scroll/text selection area.
- Missing source room or empty transcript: show a calm `No captured messages` state, keep thread identity and mark unavailable data rather than inventing content.

## Deliverable steps

- [x] Inspect repository status and preserve unrelated work; create the scoped mockup branch.
- [x] Read the supplied screenshot, pane implementation and persistence schema.
- [x] Write this design, integration contract, agent assignment and acceptance plan.
- [x] Capture the minimized fixture and verify titles/counts against the captured session (14 saved chats, 4 open and 10 archived).
- [x] Integrate the shell, runtime and responsive styling.
- [x] Complete independent accessibility, browser and builder reviews.
- [x] Resolve concrete review findings; complete Luna's final refinement.
- [x] Verify the final artifact and record honest limitations. Preview is served at http://127.0.0.1:8767/; automatic browser opening was attempted but unavailable because browser controls were offline and native Chrome access timed out.

## Final verification and limits

The coordinator reran `node mockups/adaptive-thread-panes/verify.mjs` after the final CSS changes: **11 passed, 0 failed**. `npx tsc --noEmit` also passed. All ten Luna assignments completed. See `verification.json`, review documents and screenshots in the prototype folder for evidence.

The preview demonstrates column/span presets and snapped pane reordering, rather than the production split tree or a draggable divider resize. Pointer dragging has a movement threshold and cancellation; touch long-press is not implemented (touch may use native controls). Transcript text is safely displayed as excerpt text, so Markdown syntax remains visible. No live activity, queue, unread simulation, persistence, screen reader certification, native build or product integration is claimed. The four-open count belongs to the recorded snapshot and may differ from the current running workspace.

## Integration contract

HTML IDs: `dataset`, `layout-mode`, `columns`, `composer-mode`, `search`, `reset`, `thread-list`, `pane-grid`, `shared-composer`, `destination`, `shared-draft`, `preview-send`, `feedback`, `snapshot-label`, `workspace-count`. Load `data.js` followed by `app.js` with defer. Fixture global `window.THREAD_SNAPSHOT = {capturedAt, focusedId, threads:[{id,title,workspace,closed,members:[{id,name}],messages:[{speaker,text}],open}]}`. CSS classes: `.pane`, `.selected`, `.full`, `.compact`, `.tile`, `.pane-header`, `.pane-title`, `.pane-body`, `.pane-footer`, `.thread-row`, `.active`, `.draft`, `.snap-preview`. Runtime may add clear semantic elements and additional classes. Agents may not switch branches, modify production files or overwrite another agent's owned artifacts.

## Acceptance walkthrough

- Open the preview and see real captured thread names/excerpts and its design-only boundary.
- Switch open/history datasets; counts and archived labels remain honest.
- Type draft A, select B, type draft B, switch back: draft A is intact. Repeat across composer modes, filtering and layout changes.
- Preview a send: only the local mockup changes; no network request or daemon call.
- Resize a pane across width and height thresholds; contents change while text remains readable.
- Change columns/spans, reorder via pointer with ghost preview, cancel with Escape, and use keyboard equivalents.
- Verify no filter/dataset action silently redirects the composer; messages never select another thread.
- Inspect 1440x900, 1100x700, 800x600 and 390x844. Check focus visibility, label associations, reduced motion, no horizontal overflow and no console errors.
- Run `npx tsc --noEmit` as repository guard; report any pre-existing failure accurately. This is not a product build or installed acceptance.
- Save browser results/screenshots and open the working preview for the user. Leave the task branch unmerged for review.
