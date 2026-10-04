# UI review fixes

> **For Null.** A brief from Tyler, written up after a UI/UX review of the browser preview (1440 by 900, stand-in backend). Tyler approved every item. Read it against the current code first and challenge anything that no longer fits before you build. Items under **Decided** are Tyler's calls. Everything under "Suggested approach" is yours to change if you see a better way; say what you changed and why.

**Goal:** Make destructive actions safe, make attention signals unambiguous, and keep people in place when they add a pane or a bot.

**Order of work:** this comes after per-participant turns (`2026-10-03-per-participant-turns.md`). That work is uncommitted in this checkout today and touches the same files (`ChatPane.tsx`, chips, composer). Don't start until it's committed.

## Supersedes

These earlier decisions change. Where this brief and an older one disagree, this brief wins.

- `2026-10-03-thread-sidebar.md`, "Which thread it shows": the empty state "Select a thread…" when a terminal is focused is replaced by Stage 3, item 3.3.
- `2026-10-03-thread-sidebar.md`, "Bots. One card per participant": cards become compact rows (Stage 3, item 3.3). The `aria-label`s stay.
- `2026-10-03-thread-sidebar.md`, "Add or edit form… opens inside the sidebar, never over the conversation": adding a bot now starts in a small menu at the button (Stage 3, item 3.2). Editing stays in the sidebar.

The composer is **not** in this brief. `2026-10-03-per-participant-turns.md` section 4 already decides it: one send button, a `⋯` menu for Steer and Stop, a recipient line, a one-row queue. The only thing to carry over from the review is in Stage 4, item 4.5 (hint size).

## Stage 1: safety (do first, own commit)

### 1.1 × closes a pane; it never deletes

**Evidence:** `src/App.tsx:540`. On a chat pane, × is labelled "Delete thread" and calls `closePane`, which calls `backend.roomDelete` at once (`src/App.tsx:365`). There's no confirm and no undo, and it sits next to maximize in the same style. On a terminal, × ends the process.

**Decided:**

- × on a chat pane **closes** it. The thread stays saved, stays listed in the rail, and reopens in the layout when its rail row is clicked.
- Delete moves into a `⋯` menu on the pane head, with Rename, Fork and Export beside it, and "Delete thread…" last, in `--danger`. Choosing it asks once: "Delete <name>? Its messages and pins are removed."
- After a delete, a toast reads "Thread deleted." with an **Undo** button for 8 seconds.
- × on a terminal that is **working** or **needs input** asks first: title "<Title> is still working." (or "…is waiting for you."), body "Closing the pane ends it and anything it's running.", buttons Cancel and "End and close" (danger outline). Idle and exited terminals close at once.

**Suggested approach:**

- Add an optional `closed?: boolean` to the saved chat `Pane` (`src/types.ts`). The rail lists every chat pane; the deck and layout tree show only those not closed. Reopening clears the flag and inserts the leaf with the existing `sync`.
- Undo: hide the pane at once, and call `roomDelete` only when the 8 seconds end. Undo cancels the timer. If the app quits inside the window, the thread survives. It must fail safe and never end up half deleted.
- Put the close rule in a small pure function with tests, for example `closeNeedsConfirm(kind, status, attention): boolean` in `src/attention.ts` or a new `src/closing.ts`.

### 1.2 The rounds field shows its value

**Evidence:** `.chat-options input { width: 52px }` (`src/styles.css:477`) plus the global 16px side padding on inputs leaves no room. "Model-to-model rounds" (`src/ChatPane.tsx:1082`) shows only the spinner.

**Decided:** a stepper: `−` button, the number in tabular figures, `+` button, clamped 0 to 10. Arrow keys still change it, and it keeps the existing `disabled` rule. The buttons get `aria-label`s "Fewer rounds" and "More rounds".

## Stage 2: signals (own commit)

### 2.1 Alerts never look like counts

**Evidence:** `src/App.tsx:476`. A workspace row shows `own.length` (panes of this section) as a pill, then the attention count (`flag-count`, all sections) as a pill of the same shape. In Threads, a terminal needing approval in Code shows as an amber "1" beside the neutral "1", and nothing says where it is. Rows inside the current section already show "Needs you" or "Ready", so keep those.

**Decided:**

- Remove the neutral `own.length` pill. The rows under the workspace already list the panes.
- When some of a workspace's alerts belong to the other section, the pill says where: `1 · Code` or `2 · Threads`. Its `title` gives the full sentence, for example "1 needs you in Code".

### 2.2 The attention button doesn't move the title bar

**Evidence:** `AttentionMenu` renders after the spacer (`src/App.tsx:436`), so as it grows ("1 needs you" to "1 needs you · 1 failed · 1 ready") it pushes Providers and the layout buttons left.

**Decided:** render it right after `SectionNavigation`, before the spacer. Add ⌘J (Stage 4) as "go to the most urgent item", and show "⌘J next" in the menu footer.

### 2.3 Label the batteries; keep red for Failed

**Evidence:** `src/ChatPane.tsx:1135`. The chip shows `16% | 62%` with only a `title` saying which is which. `.usage-low` (`src/styles.css:779`) paints low values `--danger`, which is also the colour of Failed.

**Decided:**

- Chip text: `ctx 16% · plan 62%`. When low, add the word `low` in `--text` at weight 650, for example `ctx 16% low`. No alert colour.
- Keep the container-query rule that drops chip meta when space is tight (`src/styles.css:1644`).

### 2.4 Bot colours stay off the attention colours

**Evidence:** `AGENT_COLORS` (`src/identicon.ts:48`) includes `#f59e0b` (exactly `--warn`, Needs you), `#fb7185` (a step from `--danger`), and `#22d3ee` (close to `--brand-cyan`, Ready). In the preview, Opus drew `#fb7185`, so its chip, name and bubble edge read as a failure.

**Decided:**

- New agents draw from `#a78bfa`, `#60a5fa`, `#f472b6`, `#2dd4bf`, `#a3e635`, preferring unused colours in that order, as `createAppearance` does today. When all five are used, repeat; the identicon and name keep bots apart.
- Saved colours stay as they are. Colours are chosen once and stay editable (a standing decision in `2026-10-03-open-work.md`).
- **Do not change `AGENT_COLORS` itself.** `legacyAppearance` hashes into it, so changing it would recolour older agents. Add a separate pool for `createAppearance`.

## Stage 3: flow (own commit or commits)

### 3.1 + New opens a menu; the deck stays visible

**Evidence:** `setPicking(true)` (`src/App.tsx:451`) replaces the deck with the full picker. Escape does nothing. "Back to panes" (`src/App.tsx:416`) only appears when panes exist. "Gemini CLI · not installed" offers no next step.

**Decided:**

- With no panes, the full picker stays as the empty state, as today.
- With panes open, + New opens a menu anchored to the button: a filter field ("Open a terminal or thread…"), one row per tool (name, then program in mono), Terminal, and in Threads "Group chat". Typing filters, arrows move, Enter opens, Escape closes and returns focus to the button. The deck stays visible behind it.
- A tool that isn't installed is shown dimmed with "Hide in Providers", which opens Providers. Add "How to install ›" only for tools where you add an official install URL to `src-tauri/src/agents.rs` and have checked it. Don't guess URLs.

### 3.2 Add a bot where you clicked

**Evidence:** "+ Add model" sits in the middle of an empty thread, but the form opens in the sidebar at the far right. The form has six fields, and "Add to chat" (`src/ChatPane.tsx:1057`) is below the fold in a nested scroll at 900 points tall.

**Decided:**

- "+ Add model" (in the empty transcript, and in the sidebar) opens a small menu anchored to that button.
- Top: saved agents as chips, one click adds.
- Below: a new bot from a tool (Claude Code, Codex, Ollama, then More for the rest), a model, an access level, and a name pre-filled from the model with the hint "Mention as @<handle>". Name clashes get the existing error copy.
- "More options" opens the full existing form in the sidebar with these values carried over. Edit always uses the sidebar form.
- Escape closes the menu without adding anything.

### 3.3 Thread details follow the thread on screen; one row per bot

**Evidence:** `src/App.tsx:561`. The sidebar shows "Select a thread to see its bots and changes." whenever the focused pane isn't a chat. That happens after focusing a terminal and switching to Threads, while the only thread fills the deck. Each bot card also stacks model, access, two labelled readings, a usage sentence and four buttons, so two bots fill the sidebar.

**Decided:**

- Which thread it shows: the focused chat pane if one is visible; otherwise the most recently focused visible chat pane; otherwise the first visible chat pane. If no chat pane is visible, don't render the sidebar. Leave the saved open/closed preference unchanged, so it comes back when a thread does.
- The sidebar head names the thread and its workspace, with the bot count: "workspace-1 · 2 bots".
- One row per bot: avatar, name in its colour, "Tool · model · access" on one line, then `ctx` and `plan` with small bars. Edit, Save to Agents and Remove go in a `⋯` menu with the existing `aria-label`s. Usage detail and "Compact now" fold under a "Usage" disclosure, closed by default.

**Suggested approach:** put the choice of thread in a pure function, for example `detailsThread(focused, visibleChats, recentChats): string | null`, with tests, next to `detailsOverlay` in `src/detailsLayout.ts`.

## Stage 4: keyboard and polish (own commit or commits)

### 4.1 Deck shortcuts

**Evidence:** apart from Escape and the composer keys, the app has no keyboard shortcuts.

**Decided (macOS):**

| Keys | Action |
|---|---|
| ⌘1 ⌘2 ⌘3 | Agents, Code, Threads |
| ⌘T | + New menu in Code (opens the full picker if no panes) |
| ⌘N | New thread in the current workspace |
| ⌘J | Go to the most urgent item in the attention list |
| ⌘[ ⌘] | Previous or next visible pane |
| ⌘⇧↵ | Maximize or restore the focused pane |
| ⌘W | Close the focused pane, with the Stage 1 confirm rule |

- Composer keys stay as they are, including ⌘↵.
- On Windows and Linux use Ctrl+Shift with the same letter, because plain Ctrl combinations belong to the shell (Ctrl+W deletes a word).
- Check each one against the Tauri window menu and against Claude Code's and Codex's own keys inside a terminal pane. Drop or change any that collide, and say which.

**Suggested approach:** a pure `src/shortcuts.ts` that maps a key event (key, modifiers, platform) to an action or `null`, with tests. Wire it once in `App`. If xterm swallows ⌘ combinations, let them through with `attachCustomKeyEventHandler` in `src/TerminalPane.tsx`.

### 4.2 Pane heads show state, not the workspace

**Evidence:** `src/App.tsx:534` prints the workspace name in every pane head; the rail already shows it.

**Decided:** replace it with the pane's state in words: terminals "Working", "Idle" or "Exited", from `statusOf`. Chats show "<n> bots", plus "replying" while a turn runs if `App` can know that cheaply; otherwise just the count. The existing attention flag stays. Move the workspace name into the head's `title`.

### 4.3 A next step in the Agents empty state

**Evidence:** `src/ChatPane.tsx:1161`. The empty card has a heading and a sentence, with no action inside it.

**Decided:** inside the card, offer three starters, each one click to create a saved agent the person can edit:

- Reviewer: reads the change and flags bugs. Read only.
- Planner: breaks the work into steps. Read only.
- Implementer: makes the edits. Ask first.

Each gets a persona line to match. Below them: "+ New agent" (primary), and the line "Or save one from a thread with ＋ on its chip."

### 4.4 Let first run try a room without keys

**Decided:** the welcome screen (`src/App.tsx:502`) gets a secondary button "Try a sample thread", with the note "Scripted bots. No keys needed." It opens a thread with two Scripted participants (`preset: "scripted"`) whose lines show @mentions and turn taking. It must work in the native app, not only the preview. If that needs a workspace without a folder, say how you handled it.

### 4.5 Hints at 11px

`.composer-hint` is 10px (`src/styles.css:947`). The design system keeps 10px for short labels (eyebrows, badges). Make it 11px. Coordinate the hint text with per-participant turns, which rewrites it.

### 4.6 Keep the frame still on Agents

**Evidence:** in Agents, the rail, the layout buttons and the primary button are removed (`src/App.tsx:438`, `451`, `460`), so the window shifts.

**Decided:** keep the layout buttons in place and disabled. The primary button becomes "+ New agent" and does what the Agents section's own button does. Keeping the rail is your call; if you keep it, clicking a workspace goes to that workspace in the last of Code or Threads used.

## Review focus

Things no task above tests directly that would hurt most if wrong:

1. Quitting during the 8-second Undo window. The thread must still be there on restart.
2. Older agents without a saved appearance must keep their colour (`legacyAppearance` uses `AGENT_COLORS`).
3. Shortcuts while focus is in a terminal: plain Ctrl keys still reach the shell, ⌘ combinations reach the app, and ⌘↵ in the composer still steers.
4. Closing a pane that is maximized, focused, or the last one visible; and closing a thread while a bot is replying or an approval is waiting (it asks, and confirming rejects approvals as Stop does today).
5. A session saved before this change, with no `closed` field, loads with every thread open.

Add a test for each of 1, 2, 3 and 5 where the logic is pure. Check 4 in the preview.

## Must keep working

- Approval cards, "Waiting for you", the working indicator, the turn queue and steering.
- `/compact`, `/clear`, `/pin`, `/diff`, `/fork`, `/export`.
- Attention flags, counts on tabs and rows, and the window-title count.
- Dragging and resizing panes without remounting terminals (`PaneLayout.tsx`).
- The browser preview, which must behave like the native app for all of the above.
- Keyboard use: every new menu and popover is reachable, closes on Escape, and returns focus to the control that opened it.

## Out of scope

The composer (see Supersedes), a light theme, new slash commands, changing the identicon drawing, and anything in `crates/`.

## Constraints

- Start after per-participant turns is committed. One editor at a time in this checkout.
- One commit per stage at least. Don't push. Don't merge to `main`.
- No new dependencies.
- macOS file names are case-insensitive: a new file must differ from every existing one by more than case.
- No coloured left bars on new strips or rows (standing decision). Use a neutral background and a thin border.
- Copy follows the design system: sentence case, verb-first buttons, "e.g." placeholders, no emoji.
- Update `README.md` and `SPEC.md` where they describe closing panes, the picker, thread details or attention counts.

## Verification

Report real results, and say plainly what wasn't checked.

- `npm test` and `npm run build` with counts; `cargo test --workspace` if you touch `src-tauri`.
- In `npm run dev` at 1440 by 900 and again at about 820 by 1400:
  - × on a thread closes it, it stays in the rail, and clicking reopens it; Delete from `⋯` asks, Undo restores it.
  - × on a terminal after typing `work` (the preview prints for a few seconds) asks; after it finishes it closes at once.
  - The rounds stepper shows 3 and stops at 0 and 10.
  - Type `ask` in a Codex terminal, switch to Threads: the workspace pill reads `1 · Code`.
  - + New with panes open: the menu opens over the deck, filters, and closes on Escape.
  - Add a bot from the menu in an empty thread without touching the sidebar.
  - Focus a terminal, switch to Threads: the sidebar shows the thread.
  - Every shortcut in the table.
- Anything not exercised in `npm run tauri dev` is listed as untested.

## Done when

- [ ] No single click deletes a thread or ends a working terminal.
- [ ] The rounds value is always visible.
- [ ] A workspace row shows only alert pills, and they say which section an alert is in when it's not this one.
- [ ] Chips say ctx and plan, and nothing but Failed uses the danger colour.
- [ ] New agents never get amber, rose or cyan; old agents keep their colours.
- [ ] Adding a pane or a bot never hides the deck or sends the eye to the far sidebar.
- [ ] Thread details never shows "Select a thread" while a thread is on screen.
- [ ] Every shortcut works, and none steals a key from the shell or an agent.
- [ ] Nothing in "Must keep working" regressed, with evidence.
