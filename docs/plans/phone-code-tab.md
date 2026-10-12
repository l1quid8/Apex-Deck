# Phone Code tab

Goal: the iPhone app's **Code** tab stops being an empty "not on the phone yet"
note (`src/phone/PhoneApp.tsx` ~2474) and becomes a working view of one project
on the selected machine: its files, the changes bots made, and a terminal.

Reference: the iOS design review `ios/screenshots/dark-code.png` (+ `light-code.png`,
`dark-terminal.png`, `dark-terminal-full.png`, `dark-approval.png`). Layout follows it
row for row, except what is listed under "Left out" with the reason.

Work only in `~/Downloads/apex-deck`. Other bots edit this folder at the same time,
so stage only your own hunks. Branch: `feat/phone-code-tab` off `main`.

## What the screen shows

```
TYLER'S MACBOOK                      (machine eyebrow, as today)
Code
apex-deck · main branch          ▾  (project switcher sheet)

[ Workspace files        ~/Downloads/apex-deck      > ]
[ Changes to review      Navigation.tsx · 3 files  (3) > ]

HOST TOOLS
[ Terminal               New shell in apex-deck    > ]
```

Plain rows, one state dot, quiet labels (phone list rule: no boxed cards).

## Access — no daemon permission changes in v1

From `crates/apex-daemon/src/authority.rs`:

| Piece | Command(s) | Tier needed |
|---|---|---|
| Changes to review | `room_diff` | Read, per thread |
| Files, preview, search | `folder_list`, `file_read`, `file_find`, `file_search` | Full, all threads |
| Branch name | `worktree_list` | Full, all threads |
| Terminal | `pty_spawn/write/resize/kill` + `PtyData` | Full, all threads |

So a phone below Full still gets **Changes to review** (from its own threads);
the other rows show `Needs Full access on <machine>`, same wording the Agents
tab uses (`canSeeNewThread(host.access())`). The phone never asks to raise its
own access.

## Steps

### 1. Project picker + header — `src/phone/PhoneCode.tsx` (new)
- Projects = workspaces whose host is the selected machine. Default to the
  project of the most recently opened thread on that machine; remember the pick
  per machine in localStorage.
- Subtitle: `<folder name> · <branch>` from `worktree_list` (the `Main` row's
  branch). No branch / not a repo → just the folder name.
- Offline / no projects / no machine: reuse the existing `ph-empty` patterns.
- Move the Code branch of `SideTab` into this component; PhoneApp only passes
  `link`, the host backend, workspaces, rooms.

### 2. Changes to review
- For every thread in the project, call `room_diff`; merge with `groupDiff`
  (`src/diffGroups.ts`). Row detail: first file name · `N files`; count badge.
- Tap → full-screen list grouped by bot → tap a file → diff view using
  `lineDiff` + `compact` (`src/lineDiff.ts`), red/green lines, horizontal scroll
  only inside the code block.
- Read-only. Revert stays on the Mac (it's Full + per-thread and destructive;
  phone gets it later with a confirm sheet).
- Pending approval requests are already in chat; this row does **not** duplicate
  them.

### 3. Workspace files
- Full-screen drill-down list (one folder per screen, back button + edge swipe),
  not the desktop tree. Reuse `filesTreeModel.ts` for listing state and
  `changeMarks` so changed files show M/A/D.
- Search field at the top: name search (`file_find`); a "Search in files" toggle
  switches to `file_search`.
- Tap a file → preview using the same `file_read` result shape `FilePreview.tsx`
  handles: text with line numbers, images inline, "too large / binary" note.
- Read-only on the phone in v1: no create/rename/duplicate/trash.

### 4. Terminal
- Desktop terminals can't be attached to (no `pty_list`, no scrollback replay),
  so v1 starts **a phone-owned shell** in the project folder: `pty_spawn` with
  `cwd = workspace.path`, id `phone-<deviceId>-<n>`.
- `@xterm/xterm` + fit addon full-screen; a key bar above the keyboard
  (Esc, Tab, Ctrl, ↑ ↓ ← →, `|`, `~`); resize on keyboard show/hide using the
  existing keyboard self-shrink fix.
- Leaving the screen keeps the shell alive for 10 minutes; reopening the row
  reattaches while the phone app stays running. Explicit **End shell** kills it.
- Row detail: `New shell in <project>` or `Shell running · 2 min`.

### 5. Checks
- Unit: project default/remember rule, diff merge across threads, access gating
  per tier (pure functions, `tests/phone-code-*.test.mjs`).
- Phone test-daemon check: real phone app against a throwaway seeded daemon,
  screenshots of all four screens at Read and Full tier, dark + light. No real
  data in screenshots (repo is public).
- Render each new control offscreen and look at the PNG before installing.

## Left out of v1 (and why)

- **Browser row** — there is no general "stream the host browser" command; only
  the personal assistant's browser. Needs its own design + permission story.
- **Latest build card** — nothing on the host records builds. Comes after a
  build/preview watcher exists.
- **Attaching to the Mac's existing terminals** — needs `pty_list` + scrollback
  on the daemon.
- File editing and revert from the phone.

## Order and hand-off

Steps 1 → 2 → 3 → 4, one commit each. Step 2 is the most useful on its own and
works at the default access level, so it can ship first.
Builder: Luna. Reviewer: Jigga.
