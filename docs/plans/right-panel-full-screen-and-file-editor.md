# Right panel full screen + file editor

Two features, built in parallel by two bots on one branch.

- **Track A, full screen side panel:** Hyke.
- **Track B, edit files in the Files tab:** Thadious.
- **Reviewer:** Jigga reviews each commit. The human merges.

Folder: `~/Downloads/apex-deck-worktrees/ui-upgrade-right-side-bar-fullscreen-and-file-editor`
Branch: `ui-upgrade/right-side-bar-fullscreen-and-file-editor` (from `bed9b9f`).

## Shared-folder rules (read first)

- Both bots work in the **same folder on the same branch**. **Don't** switch
  branches, create branches, stash, reset or rebase here, because that would
  pull files out from under the other bot.
- Each track owns its own files (listed below). Touch only your own files. If
  you need a change in the other track's file, ask in chat.
- Stage only your own paths: `git add <paths>`. Never use `git add -A` or `git commit -a`.
  Run `git status` before each commit.
- Commit when each task is done. Don't push and don't merge.
- Before each commit, run `npx tsc --noEmit` and the tests for the files you
  touched. Track B also runs `cargo test -p apex-host project_files` and
  `cargo test -p apex-daemon authority`.
- Run dev builds **only** from `~/Downloads/apex-deck`, using
  `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
  Don't build or install from this folder. For screenshots, render
  components offscreen (as the existing `tests/*-component.test.mjs` do) and
  look at the PNG.

### File ownership

| Track A (Hyke) | Track B (Thadious) |
|---|---|
| `src/rightPanelModel.ts` | `crates/apex-host/src/project_files.rs` |
| `src/RightPanel.tsx` | `crates/apex-host/src/host.rs` (file_write only) |
| `src/App.tsx` | `crates/apex-host/src/command.rs` |
| `src/right-panel.css`: **only** a new block at the end headed `/* Full screen */` | `crates/apex-daemon/src/authority.rs` |
| `src/shortcuts.ts` | `src/backend.ts`, `src/commandBackend.ts`, `src/types.ts` |
| `src/styles.css` (`.thread-details` rules only) | `src/FilePreview.tsx`, `src/RightFiles.tsx` |
| `tests/right-panel*.test.mjs` | new `src/FileEditor.tsx`, `src/fileEditorModel.ts`, `src/file-editor.css` |
| | new `tests/file-editor*.test.mjs`, `package.json` / lock (CodeMirror only) |

---

## Track A: full screen side panel (Hyke)

**Goal:** one button makes the right side panel fill the work area, and the same
button puts it back. While it fills the area, the threads and terminals beneath it keep running.

### A1. Model (`rightPanelModel.ts`)

- Add `full: boolean` to `RightPanelState`. It defaults to `false`.
- `parsePanel` reads `full === true` and treats anything else as `false`. The saved panel
  key stays `apex-deck.right-panel.v1`, because a missing field just reads as false.
- Add `setFull(s, full)`. If `full` is true, it also sets `open: true`.
- Closing the panel (`onClose` path in App) also clears `full`. If the panel is
  reopened later, it opens docked.
- Tests: parse old saves (no `full`), parse `full: "yes"` → false, setFull opens
  the panel, and close clears full.

### A2. Button and keys (`RightPanel.tsx`, `shortcuts.ts`)

- Put an expand button just before the hide `×` in the tab strip. Use the same ⤢/⤡
  glyphs and labels as the ApexAgent dock: `Expand side panel` and `Collapse side panel`, with
  `aria-pressed`.
- Add a shortcut **⌘⇧\\** in `shortcuts.ts` that toggles full screen. If the panel is
  closed, the shortcut opens it in full screen.
- **Esc** collapses full screen only when focus is not in an input, textarea,
  contenteditable or `.cm-editor`, and no menu or dialog is open. Esc never
  hides the panel.
- When full screen, the tab strip labels always show. The 300px container query
  won't hide them anyway at that width, but check it.

### A3. Layout (`App.tsx`, CSS)

Use the ApexAgent expanded pattern (`apex-agent-dock.css:89`) as the model:

- Add the class `right-panel-expanded` to `.body` when `panel.open && panel.full`.
- Hide `.canvas` with `display: none` but keep it mounted. Set `inert` +
  `aria-hidden` on `<main class="canvas">`, the same way ApexAgent full does.
- `#thread-details` becomes `flex: 1 1 0; width: auto; max-width: none`, with no
  overlay and no backdrop.
- **Don't render** the `SidebarHandle` for details while the panel is full screen.
- The left rail (projects) stays as it is.
- **Narrow windows:** when `overlayDetails` would be true, full screen still wins.
  The panel fills the body with no backdrop.
- **ApexAgent full:** only one of the two can be full at a time. Expanding the side panel
  collapses ApexAgent full, and expanding ApexAgent collapses side panel full.
- The `.right-panel` keeps `container-type: inline-size`, so tabs can react to width.

### A4. Things to check in each tab at full width

- **Browser tab:** the native browser view is positioned using `BrowserView`'s
  ResizeObserver. Toggle full screen on a loaded page and confirm the page
  follows the new size with no stale strip or overlap. If it lags, re-measure on the
  toggle.
- **Dashboard/Tasks/Details:** cap the content width to stop very long lines.
  Use `.right-panel-expanded .right-panel-body > *:not(.right-files-shell):not(.right-browser) { max-width: 960px; margin-inline: auto; }`.
  Files and Browser use the full width.
- Focus: after a toggle, focus stays on the toggle button.

### A5. Done when

- Toggle by button, by shortcut and by Esc. The setting persists across reload.
- Terminals/threads under it keep running, and their scroll position and layout are unchanged on return.
- Hidden tabs keep their state (they stay mounted, as today).
- Offscreen PNGs of docked and full screen views, in both light and glass skins, are attached for review.

---

## Track B: edit files in the Files tab (Thadious)

**Goal:** a text file open in the Files preview can be edited and saved, on
this Mac or a remote machine, without silently overwriting a change a bot
made in the meantime.

**Out of scope:** multi-file tabs, a minimap, Git stage/discard, format on save,
language servers, and the phone UI.

### B1. Daemon: version + write (Rust)

`project_files.rs`:

- `FilePreview::Text` gains `version: String`, the file's
  `"{mtime_ns}-{size}"` taken from the same metadata used to read it.
- New `pub fn write(root, path, text: &str, expected: Option<&str>) -> Result<String, String>`
  that returns the new version.
  - Resolve the path with `inside()` and `reject_symlink()`. Refuse anything under `.git`.
    The file must already exist and be a regular file. **No creating here.**
    New files still go through `create`.
  - If `text.len() > 512 KiB` (`MAX_WORKSPACE_READ`), refuse with "File is too large to edit here."
  - If `expected` is `Some` and the current version differs, return the exact error
    string `"changed-on-disk"`. The UI matches on it.
  - **Atomic write:** write a temp file in the same folder (`.<name>.apexdeck-<rand>`),
    copy the original's permissions, `sync_all`, then `rename` it over the target.
    On any error, remove the temp file.
- Tests: write and read back, wrong `expected` refused, the target unchanged after a refusal,
  a symlink escaping the root refused, `.git/config` refused, the size cap enforced, permissions kept
  (0755 stays 0755), and no temp file left behind after a failed write.

Wiring, which copies `file_create` at each layer:

- `command.rs`: `FileWrite { root, path, text, expected: Option<String> }`.
- `host.rs`: `file_write` via `spawn_blocking`.
- `authority.rs`: add `FileWrite { .. }` to the same `full(Global)` arm as
  `FileCreate`, plus a row in the authority test table.
- `backend.ts`: `fileWrite(root, path, text, expected: string | null): Promise<string>`.
  The browser demo throws "File actions aren't available in the browser demo".
- `commandBackend.ts`: `call<string>("file_write", { root, path, text, expected })`.
- `types.ts`: add `version: string` to the text preview type.

Remote machines and the phone route through the same command, so nothing else
is needed. Note in the commit that the **Hetzner daemon needs an update** before
editing works there. Older daemons return an unknown-command error, and the UI
shows "This machine's Deck needs an update to edit files."

### B2. Editor component

- **Use CodeMirror 6** (`@codemirror/state`, `view`, `commands`, `search`,
  `language`, `language-data`, `autocomplete`). It gives undo, find/replace,
  bracket matching and highlighting for ~100 languages, without building any of that ourselves.
  **Load it lazily** (`import()` inside `FileEditor.tsx`) so the main bundle
  doesn't grow. Don't use Monaco, because it's far heavier and needs workers.
- `src/fileEditorModel.ts` (no React, tested): `isEditable(preview, path)`,
  dirty tracking (`text !== savedText`), `saveErrorKind(error) →
  "conflict" | "outdated-daemon" | "other"`, and the language from the extension
  via `language-data`.
- `src/FileEditor.tsx`: a CodeMirror view with line numbers, the active line, the search
  panel (⌘F) and indent-on-input. Its theme comes from CSS variables (`--bg`, `--panel`,
  `--line`, `--accent`, `--muted`) so all skins, including glass, work. Put the styles in
  `src/file-editor.css`.

### B3. Preview → edit flow (`FilePreview.tsx`)

- An **Edit** button shows in the header only when all of these are true: the preview is `text`, it's
  **not truncated**, the view is `file` (not Changes), and the file isn't deleted.
- **Markdown:** Edit switches to source editing. The Preview/Source toggle hides while
  editing.
- **Header while editing:** `Save` (disabled when clean), `Done` (back to read-only,
  which asks first if there are unsaved edits), and a `●` dot by the filename when dirty.
- **⌘S** saves when focus is inside the editor. **Esc** inside the editor does
  nothing to the panel (Track A's Esc rule already skips `.cm-editor`).
- **Save** calls `fileWrite(root, path, text, version)`. On success, store the new version,
  mark it clean, call `onRefresh` so the thread diff and `M` marks update, and
  show "Saved" for 1.5 s.
- **Conflict (`changed-on-disk`):** show a bar above the editor that says "This file changed on
  disk since you opened it." with buttons **Reload** (discard my edits and re-read) and
  **Save anyway** (`expected = null`), plus **Copy my version** to the clipboard.
  Never drop the user's text without a click.
- **Unsaved edits guard:** if the user closes the preview, opens another file in the tree,
  switches the view to Changes, or the file is renamed or trashed, use
  `ConfirmDialog`: "Discard unsaved changes to <name>?". RightFiles needs a small
  `confirmLeave()` hook on the preview to do this. Also add a `beforeunload`
  guard while dirty.
- **While editing:** don't re-read the file when `diff` changes (today the effect
  depends on `file`). Re-read only when the user isn't editing.

### B4. Wide layout (`RightFiles.tsx`, `right-panel.css` is Track A's, so put this in `file-editor.css`)

- When the Files tab is **≥ 720px wide** (container query on `.right-panel`),
  show the tree on the left (resizable, default 280px, saved in the existing
  `apex-deck.files-tab.v1` prefs) and the preview/editor on the right at full height.
  Below 720px, keep today's stacked layout with the drag bar.
- This works with or without Track A. Track A's full screen just makes it the usual case.

### B5. Done when

- Edit and save a file locally and on a remote project. The `M` mark appears.
- A bot changes the file mid-edit, then Save shows the conflict bar, and both
  Reload and Save anyway behave.
- Truncated, binary, image and deleted files show no Edit button.
- Closing with unsaved edits always asks first.
- `cargo test` (apex-host, apex-daemon), `npm test`, and `npx tsc --noEmit` pass.
- Offscreen PNGs of the editor in dark, light and glass, plus the conflict bar, are attached.

---

## Order and hand-off

1. Both tracks start now. The only shared file is `right-panel.css`, where Track A appends one
   block at the end and Track B doesn't touch it.
2. Each task (A1–A4, B1–B4) is its own commit with a `feat(panel):` / `feat(files):`
   prefix. Post the hash in chat for Jigga's review.
3. When both are approved, the human tries it in the dev build
   (run from the main folder) before anything merges.
