# iPhone Duo mockup spec (design: Jigga, build: Null)

Output: `mockups/iphone-duo-v1.html` (new file; never edit an older mockup).
Source of truth for look: the real phone app (`src/phone/PhoneApp.tsx`, `ThreadList.tsx`,
`phone.css`, `phone-themes.css`). Capture its preview DOM + CSS and rearrange it.
Do not hand-style lookalikes. Use sample data only: no real thread titles, machines or paths.

## The one idea

Layout follows **available width**, not the device model.

- Under 600 pt wide: today's phone app, unchanged.
- 600 pt and wider: **split view**: list on the left, open item on the right.

Why width and not "is this a Duo": the same rule covers the unfolded Duo, iPads, and iPad
split-screen, and it keeps working if Apple's final screen sizes differ from the rumours.

## Screen sizes (assumed, replace when the iOS 27 simulator arrives)

| Screen | Mock frame (pt) | Layout |
|---|---|---|
| Outer, folded (5.4") | 375 × 812 | single column (today) |
| Inner, unfolded (7.6") | 760 × 860 | split |

The inner screen has a vertical crease at the centre (x ≈ 380). Add a **"Show crease"** toggle
that draws a faint dashed line there, so we can check nothing important sits on it.

## Split view layout (unfolded)

```
┌───────────────────────── 760 ─────────────────────────┐
│ ┌── list column 320 ──┐┌──────── detail ────────────┐ │
│ │ Threads        + ⚙  ││ ‹title›  project · machine │ │
│ │ (ThreadList as is)  ││   (ThreadView as is,       │ │
│ │  selected row lit   ││    no Back button)         │ │
│ │                     ││                            │ │
│ │                     ││   composer                 │ │
│ └─────────────────────┘└────────────────────────────┘ │
│  Agents   Code   Threads   Library    (tab bar, full)  │
└───────────────────────────────────────────────────────┘
```

- **List column:** fixed 320 pt, 1 px `--line` divider on its right. Contents are today's
  Threads screen: large title, + and Settings buttons, `ThreadList`. The open thread's row uses
  the existing selected/pressed background so you can see what's on the right.
- **Detail pane:** fills the rest. It's today's `ThreadView` with the Back chevron removed
  (the list is already visible). Its own header, messages, crew chips and composer are unchanged.
  Message column max width 680 pt, centred, so lines don't get too long.
- **Tab bar:** stays at the bottom, full width, always visible in split view (on the narrow
  phone it hides inside a chat; here it doesn't need to). Hide it while the keyboard is up.
- **Tapping a thread** swaps the right pane only. The list keeps its scroll position.

### Other tabs when wide

| Tab | Wide layout |
|---|---|
| Threads | split, as above |
| Agents, Settings, Appearance, Machines | single column, centred, max width 600 pt |
| Code (terminal) | full width; the terminal gets more columns, which is the point |
| Library | grid gets more columns; opening a file shows it in a right pane like Threads |

Keep the Library right pane out of v1 if it slows the mock down; Threads split is what matters.

## Frames to draw (all side by side on one page)

1. **Folded: thread list**: today's app at 375 wide. Sanity check that nothing clips.
2. **Folded: chat open**: today's chat, with a half-typed draft in the composer
   (e.g. "Can you check the build log for").
3. **Unfolded: same chat**: split view, same thread selected, **same draft** in the composer,
   same message at the top of the view. Label the arrow between 2 and 3: "open the phone".
4. **Unfolded: nothing selected**: right pane shows a quiet empty state:
   "Pick a thread" plus a "New thread" button. No illustration.
5. **Unfolded: Code tab**: terminal at full width.
6. **Unfolded: thread menu**: the bottom sheet becomes a centred card, max width 420 pt,
   over a dimmed screen. (Bottom sheets look stretched across 760 pt.)
7. **Folded again**: back in the narrow chat from frame 2, draft still there.
   Arrow from 3: "close the phone".

## Behaviour notes to label on the mock (short captions)

- Opening and closing keeps the same thread, the draft, and the scroll position
  (anchored to the top visible message, not a pixel offset). Nothing reloads.
- Closing the phone with nothing selected shows the narrow thread list.
- If the keyboard was open, it closes on the fold change; the draft stays.
- Voice call bar/capsule: stays over the detail pane, not across the list.

## Design rules (from past rounds)

- Plain list rows, no bordered cards; one state dot; quiet labels.
- Use Deck variable names (`--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`).
- Avoid class names `.badge`, `.picker`, `.row` in the mock page itself.
- Check it at zoom 0.7 and look at a screenshot before calling it done.

## Out of scope for v1

Landscape on the inner screen, drag-to-resize the divider, two chats side by side,
iPad-only features, any code change to the app.
