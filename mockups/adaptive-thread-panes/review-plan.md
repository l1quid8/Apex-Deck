# Plan and shell integration review

**Scope:** reviewed the detailed design plan against `index.html`, `styles.css`, and the integrated `app.js`; only the shell files and this review were changed. No product source or fixture data was edited.

## Integration findings and fixes

- `app.js` binds `#reset`, but the shell had no reset control. Added a visible **Reset study** button with the expected ID.
- The runtime renders `.thread-row-title` and `.thread-row-meta`; the stylesheet only styled `.thread-name`. Added title and participant/archive metadata styles and changed rows into readable two-line buttons.
- The runtime renders `.pane-status`, not `.status-label`. Added a readable status style with a text label and a status marker.
- The runtime sets `--actual-columns` on the pane grid. The prior CSS calculated its own cap from `--requested-columns`, which could disagree with the runtime's fitted width. Grid tracks now use `--actual-columns` at desktop, tablet, and phone sizes.
- Focus expansion and span are controlled by runtime inline grid styles. Removed CSS grid-span rules from `.expanded` so CSS no longer forces a span the runtime has disabled; retained the tall expanded-pane minimum height.
- Pane actions are text controls, not icon-only controls. Increased hit targets to 32px and added a narrow-pane container layout that wraps actions under the title, leaving the title visible.
- Increased transcript and tile excerpt copy to 13px, improved select contrast and label size, and tightened top chrome so the conversation workspace gets more room.
- Removed inert Add thread, account, and more-options buttons and converted the unimplemented Agents, Code, and Library navigation links to static labels. Replaced the hardcoded Tyler Caldwell footer with **Workspace / Local preview**.
- Added styles for `.hidden-selection` and `.empty-results`, which the runtime reviewer is adding.

## Contract check

All existing runtime IDs and select option values remain intact: `dataset` (`history`, `open`), `layout-mode` (`focus`, `grid`), `columns` (`1`–`4`), `composer-mode` (`shared`, `per-pane`), `search`, `thread-list`, `pane-grid`, `shared-composer`, `destination`, `shared-draft`, `preview-send`, `feedback`, `snapshot-label`, and `workspace-count`. Added `reset` to satisfy the already-present optional reset handler. The page still loads `data.js` before `app.js` with `defer`.

## Remaining verification

This is a shell integration review, not an acceptance result. The browser reviewer should confirm readable controls and responsive reachability at the plan's four viewport sizes, especially the narrow-pane action wrap and phone toolbar; runtime resize behavior and keyboard focus restoration also need integrated verification.
