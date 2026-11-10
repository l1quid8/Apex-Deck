## Focused-pane targeting (2026-11-10, design only)

In `../adaptive-thread-panes.html`, select threads with ⌘/Ctrl-click, then maximize a pane (□ or double-click its title). The composer targets only that pane with its separate draft; multi-selection and #thread picking are suspended. Restore with ▣ or Escape to recover the previous selection and multi-thread draft. The same rule applies when Even grid, Horizontal or Vertical zoom reaches one visible pane; zoom out to restore multi-targeting. Focus left/right keeps multi-targeting while its side panes remain visible. Sends stay local to this mockup.

## Response next-step study (2026-11-10, design only)

Open `../adaptive-thread-panes.html?next-steps` to see illustrative next-step chips beneath the latest agent reply in each thread. They wrap within the response width, keep the shared composer clear, and disappear on dismissal or the next human message. Clicking adds a sample prompt to that thread inside the mockup only; existing single/multi drafts are preserved. No message reaches a service. The labels are illustrative, not generated from the captured conversations. Required mid-task questions are outside this placement study.

## Current routing study (2026-11-08)

The standalone `../adaptive-thread-panes.html` remains design-only. Pane selection appends one stable thread chip per line in click order, with the initial caret after the first chip. Manually grouped tags still broadcast. `@` picks agents; `#` picks threads.

The destination list starts collapsed. Valid sends take one click, including scoped commands; routing blockers still prevent delivery. The summary counts actual agents, commands and files. Expanded rows show the recipient or exact command and file labels without repeating message prose. `verify-collapsed-review.mjs` checks this at both viewport sizes and checks attachment-button visibility.

Mock attachments insert reusable, atomic ImageN references at the cursor. Their line determines destinations; previews show `[ImageN: filename]` and files separately. Repeated references attach the file once per destination. Deleting a reference keeps the tray file; unplaced files block Send. Tray actions reinsert a reference, explicitly reference all selected threads, or remove the file and all references. Commands cannot receive files. The tray occupies document flow above the prompt. Actual upload, thumbnails and provider payload integration are outside this standalone mockup.

Rebuild with `node mockups/adaptive-thread-panes/build-real.mjs`. Browser checks: `verify-inline-attachments.mjs`, `verify-selection-tags.mjs`, `verify-thread-picker.mjs`, `verify-slice-routing.mjs`, `verify-multi-esc.mjs`, `verify-multi-select.mjs`, and `verify-fill-zoom.mjs` (all in this directory). The Escape check now uses stable chips and the rich editor; its earlier plain-@ title fixture was obsolete.

---

# Adaptive thread panes

## Thread picker correction (2026-11-08, design only)

`#` with no search shows only this message's selected destinations. Typing also searches other saved threads in a separate “adds to selection” section. Already tagged destinations are disabled; stable IDs remain internal. Rows show project names, with member names for matching titles. The picker closes the expanded To list and uses full-width Deck menu rows. The tagged editor fills the composer without an inner border.

Run `node mockups/adaptive-thread-panes/verify-thread-picker.mjs` for the focused browser regressions at both viewport sizes; `verify-slice-routing.mjs` covers payloads and duplicate validation, including malformed/pasted duplicate tokens.

## Fill-rule zoom (2026-11-08, newest; Jigga owns real-app.js)

For your real threads (up to 200), zoom means **how many panes are on screen**, not a camera scale. The zoom bar is gone.

- Every zoom level is a whole number of columns × visible rows that fills the pane area exactly: no margins, no cut-off panes. A short last row widens, so odd counts leave no hole.
- 100% is the comfortable layout (most panes at least 280 wide and 200 tall). Zooming all the way out fits every thread; all the way in, one pane fills the area. Columns only ever decrease as you zoom in.
- Ctrl/⌘ + scroll or pinch moves one level at a time (a trackpad pinch adds up small moves; it never skips). Panes glide 220 ms to their new place, and the pane under the pointer stays on screen.
- Scrolling is free while you scroll and glides to the nearest whole row when you stop.
- Grid column dividers are gone (zoom sets the columns). The Focus divider still resizes.
- Above 200 threads (scale test only) the old camera map with nested blocks is unchanged.
- Checks: `node mockups/adaptive-thread-panes/verify-fill-zoom.mjs` (94 checks, real Ctrl+wheel/wheel in headless Chrome, 3 layouts × 1512×945 and 1100×650; screenshots in /tmp/jigga-fill). `verify-zoom.mjs` below tests the earlier camera zoom for real threads and is out of date.

## Zoom map (2026-11-08, earlier round, camera zoom; superseded for real threads)

The panes beside the focus pane (Focus left/right), or every pane (Even grid), sit on a zoomable map. Built in `real-app.js` + `real-mk.css`; rebuild with `build-real.mjs` as before.

- **At 100% nothing changes:** same layout, same normal scrolling. A 28px map bar above the panes shows where you are and has − 100% + · Fit · Back. Grouping never appears for your real threads.
- **Zoom** toward the pointer with pinch or Ctrl/⌘ + scroll, the − / + buttons, or keys (− + 0 ⇧1 ⌫ with the map focused). **Pan** by scrolling, dragging the empty background, middle-dragging, arrow keys, or the small map.
- **Detail follows size on screen:** a live pane (the real 28px title bar and its actions) once it is at least 120×56 px (when the title bar runs out of room □ goes first, then ⋯; × stays to the end); below that a drawn card (name first, then last words), then a chip, then a block. Nothing off screen is built or drawn. Limits (set in code): at most 48 live panes on the map (the big pane in Focus left/right is extra) and a budget of about 30,000 drawn marks a frame; when the budget runs out, the remaining blocks stay closed. Measured at +1B (not limits): the Fit overview draws 1,001 marks; the busiest frame found zooming from Fit to 100% drew 8,950 and the budget was never reached (probe: `node mockups/adaptive-thread-panes/probe-zoom-peak.mjs`, 2026-11-08).
- **Past 200 threads** (scale test only) threads nest in 10 × 10 blocks: 100, 10,000, 1,000,000 … Clicking a card or block only ever zooms in; Back and Fit zoom out.
- **Keep my place:** order, the composer's destination, drafts and each thread's reading position survive zooming, full screen and layout switches. Reset (100%) returns to the original layout. Zooming never selects a thread; clicking inside a live pane still does.
- **Synthetic data:** "Scale test ▾" adds up to +1B synthetic threads, or a thread with up to 1B synthetic agents. Synthetic panes say so in the title bar and transcript, blocks are hatched, and the small map counts them.
- **Agent background:** a sunflower of sunflowers. With more agents than fit, each mark is a cluster that opens as you pinch or click it; at most 14,000 marks a frame.
- **Accessibility/automation:** each drawn card has an invisible button laid over it ("Zoom to …"), so keyboards, screen readers and Unified Computer Use can open it.
- **Fixed on the way:** panes now open on their latest message (the old code scrolled `.chat-body`, but `.transcript` is the scroller).
- **Checks:** `node mockups/adaptive-thread-panes/verify-zoom.mjs` (66 checks, screenshots in /tmp/jigga-zoom).

## Standalone file (current): `../adaptive-thread-panes.html`

Built from Deck's **real UI**, not hand-styled. `base-real.html` is a frozen capture of the browser preview (`npx vite --port 5391`, Deck 0.9.9) using the user's own appearance (Clay Black, terminal bot chips) seeded into the preview's settings. `capture-real.mjs` made it (it writes to `/tmp/jigga-atp/`; copy the result here). `build-real.mjs` clones the real title bar, sidebar rows, pane head, messages, composer, bot chips, Details panel, ⋯ menu and layout picker, fills them with `data.js` (14 real threads) and `bots-real.json` (real bot names, avatar seeds and colours), and writes the standalone file. Mockup-only CSS is `real-mk.css` (`mk-` prefix); behaviour is `real-app.js`.

Rebuild after editing any of those: `node mockups/adaptive-thread-panes/build-real.mjs`. Never hand-edit the output.

Layouts: Even grid, Focus left, Focus right (the first open pane takes the tall slot; drag a pane into it to change focus). No snapping: the focus divider and grid column dividers resize freely and live (double-click a divider to reset), and dragging a title bar lifts the pane so it follows the pointer while the others glide aside; Esc cancels. Park on shelf was removed 2026-11-08.

New thread + Add bots (2026-11-08): `+ New` (title bar or the project row's new-thread button) adds a "Group chat" pane in the first slot (the tall pane in Focus left/right, first cell in Even grid) and opens the add menu. The menu is Deck's real "Who's in this thread?" form (`quick-add-real.html`, captured from the preview; editor removed because Deck starts it closed when saved agents exist) docked in the shared composer, growing upward over the panes so nothing reflows. Empty panes drop the emblem, eyebrow, location line and texture when under 480×460.

Agents, not bots (2026-11-08): the user renamed "bot" to "agent" app-wide. `build-real.mjs` rewrites every readable "bot" in the capture (text, aria-label, title, placeholder; never class names, styles or scripts), and `real-app.js` uses "agent" in its own strings.

Picked but not prompted (2026-11-08, new): when a thread has agents but no messages, their avatars replace the rain texture as a faint watermark behind the welcome (grid shape picked per pane, 40-170px faces). Small panes (under 480×460) show them instead as a quiet row above "Type a message below…" and drop the big heading. The first message removes them.

New agents (2026-11-08): "+ Another agent" in the add menu clones Deck's real new-agent editor (Claude Code / Codex / Ollama, model, access, effort, name, persona), up to 4. Untouched names follow the tool and never collide; a taken or invalid @name blocks Add. Added agents join the thread, the chips, Details and the backdrop, and are offered as saved agents next time; Reset forgets them. If no saved agents are left to pick, the menu opens on an editor. More…, Write it and More options only show a note.

New (not in Deck yet), tagged "new" in the UI: the shared composer's To line, Focus right, and title-first head fitting (Deck's CSS splits spare room between the title and the spacer, which is why real panes show "A…" beside empty space).

---

## Earlier server version (superseded)

Design-only study using a frozen, minimized snapshot of local Apex Deck threads. No production components or live session data are changed by this preview. `Preview send` operates only in this page. Drafts and layout experiments last until reset or reload.

Detailed design, ownership, routing rules and acceptance walkthrough: [mockup plan](../../docs/superpowers/plans/2026-11-07-adaptive-thread-panes.md).

## Open locally

The current real-capture study is built with `node mockups/adaptive-thread-panes/build-real.mjs`
and opens directly at `mockups/adaptive-thread-panes.html`.
In its multi-thread composer, inline attachment chips can be dragged between words
to move their destination. Dragging a file from the tray inserts another reference;
clicking the tray's file button remains available for insertion at the cursor.
The stacked attachment preview remains visible while the routing review is collapsed.
Click the stack to expand file previews and placement controls. Preview images are
illustrative mock files; this does not implement native file uploads.
`node mockups/adaptive-thread-panes/verify-attachment-drag.mjs` checks actual mouse
drags, routing, stacked previews, and text clearance at both desktop viewport sizes.

From the repository root:

```sh
python3 -m http.server 8767 --bind 127.0.0.1 --directory mockups/adaptive-thread-panes
```

Visit http://127.0.0.1:8767/. This serves only the preview folder. The fixture contains real conversation excerpts; keep it local.

## Try the design

1. Compare the open-chat dataset and the fourteen-thread saved-history study. Archived labels distinguish closed threads.
2. Select different threads and compare Focus and Grid layouts.
3. Adjust the column limit; the actual grid adapts to available space.
4. Write different drafts in two threads, switch back and compare shared/per-pane composer modes.
5. Use the pane grip for a snapped reorder, Escape to cancel, or keyboard movement/span controls.
6. Resize the viewport to inspect full, compact and tile behavior.
7. Preview a send, then reset. No message leaves this page.

## Agent contributions

The user requested ten Luna agents. The runner has four concurrent slots including the coordinator, so these tasks run in batches of up to three:

| Agent task | Contribution |
| --- | --- |
| luna01_ui | Inspected current pane geometry, chrome and responsive source conventions |
| luna02_data | Inspected session/room schema and spatial ordering |
| luna03_interaction | Drafted snapping, composer and accessibility interaction contract |
| luna04_shell | Built standalone workspace shell and responsive CSS |
| luna05_runtime | Built selection, responsive pane rendering, draft and layout interactions |
| luna06_snapshot | Extracted minimized real-thread fixture and provenance |
| luna07_accessibility | Independent usability and keyboard review |
| luna08_browser | Browser interaction and responsive verification |
| luna09_plan | Builder review against the detailed plan |
| luna10_refinement | Final bounded visual and interaction refinement |

Verification results and limitations are recorded alongside the preview after review. This artifact does not prove native application behavior or release readiness.

## Verified result

All ten Luna tasks completed. The final coordinator rerun passed **11/11 browser checks** and `npx tsc --noEmit`. Browser checks cover real fixture identity/counts, archived labels, draft isolation, hidden selection, local preview sends, discrete columns/spans, keyboard focus, drag rollback/reorder, five responsive viewports and local-only requests with no runtime errors. See [verification.json](verification.json) and [review-final.md](review-final.md).

Snapshot: fourteen saved conversations, four open and ten archived at capture time. Plain excerpts retain Markdown characters. Snapping is demonstrated through discrete column/span controls and drag reordering; native divider resizing and touch long-press are outside this prototype. No assistive technology certification is claimed. Automatic opening was attempted but computer/browser controls were unavailable; use the local URL above.

## 2026-11-08 — zoom target, empty-line Send, five layouts (Jigga)
- Zoom follows the active pane(s) (focused thread, or every ⌘-selected one). When several active panes can no longer all stay on screen, zoom follows the pointer instead (sticky while the pointer stays still), down to one pane filling the area. Nothing active in the map → pointer, else centre.
- Send with a `#thread` line that has no message: Send stays clickable, shakes, and that thread's pane and tag flash red for ~1.2 s; nothing is sent.
- **Five layouts (2026-11-08, newest):** the user asked for Horizontal and Vertical as their own choices above Even grid, so Arrange panes lists five: **Horizontal** (wide rows stacked, scrolling down), **Vertical** (tall columns side by side, scrolling sideways), **Even grid**, **Focus left**, **Focus right**. The Even grid submenu and its cards are gone. Each choice has a one-line description and a stripe icon; the `new` pills only mark what the real app doesn't have yet. Inside, Horizontal and Vertical are still the grid's band arrangements (`state.layout 'grid'` + `state.gridDir 'h' | 'v'`); `layoutKey()` / `setLayout()` in `real-app.js` map the five choices onto that. Zoom sets how many bands are on screen (rows ≥ 56 px, columns ≥ 120 px) down to one band filling the area; the usual zoom is the most bands at ≥ 200 px tall / ≥ 280 px wide. Scrolling settles on whole bands; in Vertical an ordinary wheel over the map, a sideways swipe, ←/→ and Page keys scroll sideways. Arrow keys on a flat map move one whole row/column. Bands apply only to the flat map (≤ GROUP_AT threads).
- Checks: `verify-active-zoom.mjs` (42), `verify-grid-direction.mjs` (103: five choices in order, one tick, stripe icons, one-line descriptions, no submenu, all 20 layout switches, plus the band checks). Screenshots in `/tmp/jigga-active-zoom`, `/tmp/jigga-grid-dir`.
