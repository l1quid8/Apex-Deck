# Thread details sidebar

> **For Null.** This is a brief from Tyler, written up after a click-through of the dev build. Read it against the current code first and challenge anything that no longer fits before you build. Tyler's decisions are marked **Decided**. Everything under "Suggested approach" is yours to change if you see a better way; say what you changed and why.

**Goal:** Move the chat's controls out of the header and into one right sidebar, so the conversation gets the space back.

**Why:** Measured in the dev build at about 820 points wide (Tyler's portrait monitor):

- `.chat-bar` wraps to three rows (chips, `+ Add model`, saved agents, `Changes`, `Who answers`, rounds) before the first message.
- `.add-form` opens inline and pushes the conversation down by roughly a third of the window.
- `DiffPanel` opens as a right column inside `.chat-body` and leaves the transcript about 280 points wide.
- Pins have already moved once (left sidebar, then the `.pins` strip) and still take a row above the transcript.

So the header is doing a sidebar's job, and there is already half a right sidebar inside each pane.

## Decided

1. **One sidebar for the app, not one per chat.** It sits on the right, mirrors `.rail` on the left, and shows the focused thread. With several panes open, a sidebar inside each pane leaves no room for messages.
2. **The header keeps one row.** Compact bot chips plus one toggle. Nothing else.
3. **Everything else moves into the sidebar:** bot details and their edit, save and remove actions; add model; add a saved agent; who answers; model-to-model rounds; pins; changes.
4. **Narrow windows:** the sidebar is closed by default and slides over the pane area instead of squeezing it.

## What the header becomes (`.chat-bar`)

- One row that never wraps. When chips run out of room, drop the `describe(p)` text first, then the usage numbers, and keep avatar and name. If they still do not fit, the row scrolls sideways.
- Clicking a chip still inserts the @mention.
- The edit, "Save to Agents" and remove buttons leave the chip and move to the sidebar.
- Removed from the header: `+ Add model`, the "Add a saved agent" select, the `Changes` toggle, `.chat-options`.
- Two small counts stay visible when the sidebar is closed, each opening the sidebar at its section: changed files (the number `Changes · N` shows today) and pins (`Pinned · N`). Hide a count when it is zero.
- The `.pins` strip above the transcript goes away.

## The toggle

- A button at the right end of the title bar, the mirror of the "Hide workspaces" button, labelled "Show thread details" / "Hide thread details", with `aria-expanded` and `aria-controls`.
- Shown only in Threads. Hidden in Agents and Code.
- Open or closed is saved with the session (see Persistence).

## The sidebar

An `<aside>` after the pane area in `.app`, about 320 points wide, with its own scroll. Head: the thread's name and workspace, and a close button. Sections, in this order, each collapsible:

1. **Bots.** One card per participant: avatar, name, the `describe(p)` line, access level in words, context and plan levels with labels, and the token detail that is a tooltip today. Actions on each card: Edit, Save to Agents, Remove. Keep the existing `aria-label`s ("Change settings for X", "Save X to Agents", "Remove X").
   Below the cards: `+ Add model` and "Add a saved agent".
2. **Add or edit form.** The existing `.add-form`, laid out in one column. Same fields, same validation, same behaviour. It opens inside the sidebar, never over the conversation.
3. **Room.** "Who answers" and "Model-to-model rounds", unchanged.
4. **Pins.** The pinned facts with a remove button each. Adding stays `/pin`. An add field here is fine if it is small; skip it if it is not.
5. **Changes.** What `DiffPanel` shows today, including Refresh.

Which thread it shows:

- The focused chat pane. Switching focus switches the content at once.
- A terminal is focused, or there is no thread: an empty state, "Select a thread to see its bots, pins and changes."
- Closed means nothing is rendered and the layout is exactly as if the sidebar did not exist.

Commands:

- `/diff` opens the sidebar at Changes and loads the diff.
- `/pin` keeps working with the sidebar closed; the pin count in the header updates.

First run must not get harder: a thread with no bots shows a primary `+ Add model` button in the empty transcript, which opens the sidebar with the form ready.

## Narrow windows

- Decide by the width actually left for panes, not the viewport: the left rail may be open or hidden. Measure the pane area (a `ResizeObserver` is enough).
- If docking the sidebar would leave the pane area under about 560 points, the sidebar overlays the right edge of the pane area instead: absolutely positioned, with a shadow, and the panes do not resize.
- In overlay mode, Escape and a click outside close it.
- Docking and undocking may resize terminals. It must never remount them (panes are absolutely positioned for this reason; see `PaneLayout.tsx`).

## Suggested approach

`ChatPane` owns all of this state today (participants, options, pins, changes, diff, the form draft). Lifting it into `App` is a large, risky move. A portal keeps the state where it is:

- `App` owns the open state and the `<aside>` element, and passes each `ChatPane` the slot element and whether the sidebar is open.
- The focused chat pane renders its details into the slot with `createPortal`. Other panes render nothing there.
- Put the sidebar's content in its own file (for example `src/ThreadDetails.tsx`) so `ChatPane.tsx` gets smaller, not larger.
- Put the dock-or-overlay rule in a small pure function with tests, in the style of `layout.ts` and `attention.ts`.

## Persistence

- `AppSession` gains optional fields for the sidebar being open and which sections are collapsed. Older session files must still load. No version bump unless you find a reason.
- Section collapse state is for the app, not per thread.

## Must keep working

- Approval cards, "Waiting for you", the working indicator, the turn queue and steering.
- `/compact`, `/clear`, `/pin`, `/diff`, `/fork`, `/export`.
- Attention flags and counts.
- The Agents tab (`profileMode`): its inline form and agent library stay as they are.
- The browser preview, which must behave the same as the native app for all of the above.
- Keyboard use: every control reachable, focus moves into the sidebar when it is opened from the keyboard and returns to the toggle when it closes.

## Out of scope

Redesigning the form's fields, new commands, resizing the sidebar by dragging, anything in the Code or Agents tabs.

## Constraints

- The working tree has uncommitted thread-commands work. Finish and commit that first, and keep this change in its own commit or commits. Do not push.
- One editor at a time in this checkout.
- No new dependencies.
- macOS file names are case-insensitive: a new file must differ from every existing one by more than case.
- Update `README.md` and `SPEC.md` where they describe the chat header, Changes or pins.

## Verification

Report real results, and say plainly what was not checked.

- `npm test`, `npm run build`, `cargo test --workspace`, with counts.
- In `npm run dev`, at about 820 by 1400 and again at about 1440 by 900:
  - sidebar closed: the header is one row and the first message starts right under it
  - sidebar open and docked
  - sidebar open as an overlay, closed with Escape and with a click outside
  - add a bot and edit a bot from the sidebar
  - two chat panes side by side: focus each and watch the sidebar follow
  - a terminal focused: the empty state
  - `/diff` and `/pin` with the sidebar closed
- Anything not exercised in the native app (`npm run tauri dev`) is listed as untested.

## Done when

- [ ] At 820 points wide with the sidebar closed, `.chat-bar` is one row.
- [ ] Opening the add or edit form never moves the conversation.
- [ ] Changes and pins no longer take space inside or above the transcript.
- [ ] There is one sidebar, and it follows the focused thread.
- [ ] Under the width threshold it overlays and the panes do not resize.
- [ ] Open state and section collapse survive a restart; an older session file still loads.
- [ ] Nothing in "Must keep working" regressed, with evidence.
