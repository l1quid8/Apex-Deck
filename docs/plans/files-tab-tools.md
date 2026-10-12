# Files tab tools

Goal: the right panel's **Files** tab becomes a working file browser for the
project instead of a bare tree. Today it can only expand folders, click a file
(which opens it in the Mac's default app), and mark files this thread changed
with `M`.

Builder: Luna. Reviewer: Jigga. Branch: `feat/files-tools` off `main` (982e0a9).
Work only in `~/Downloads/apex-deck`. Other bots may edit this folder at the same
time, so stage only your own hunks. `docs/plans/worktrees-tab.md` is untracked and
not ours: leave it alone.

## Why (what is broken or missing today)

- **Remote projects can't open files at all.** `onOpen` calls `openTarget`, and
  `OpenTarget` is `Need::Never` for remote devices (`authority.rs` ~132). On a
  project that lives on another machine, clicking a file does nothing and shows
  no error. A built-in preview fixes this.
- No way to find a file by name or search inside files.
- No right-click menu: no copy path, reveal, rename, new file, delete.
- Deleted files from the thread's diff never show (they aren't in the tree), and
  a changed file deep in a closed folder is invisible.
- Every `Folder` keeps its own state, so there's no refresh, collapse-all or
  keyboard navigation. That's why step 1 is a model refactor.

## Scope

In (four commits, in this order, each reviewable on its own):

1. **Tree model + toolbar + read-only menu.** Refresh, Collapse all, Changed only,
   Show hidden, a "Changed in this thread" section, folder change dots, keyboard
   navigation, right-click menu with the read-only actions, drag a row into a chat.
2. **Preview.** Clicking a file opens it inside the tab (text with line numbers,
   Markdown rendered, images, "Changes" view from the thread diff). Works on
   remote machines.
3. **Find and search.** Find a file by name (fuzzy) and search text inside files.
4. **File operations.** New file, New folder, Rename, Duplicate, Move to Trash.

Out (later): editing file contents, upload/drag-in from Finder, Git stage/discard,
regex search, a file watcher, phone UI.

## 1. Tree model, toolbar, menu

### Model — new `src/filesTreeModel.ts` (no React, tested on its own)

Replace the recursive self-loading `Folder` with one state object the tab owns:

```ts
type Entry = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; listing: FolderListing };
interface FilesTree { root: string; expanded: Set<string>; entries: Map<string, Entry>; selected: string | null }
interface Row { path: string; name: string; depth: number; folder: boolean; changed: ChangeMark | null; hasChangedInside: boolean; loading?: boolean; error?: string; truncated?: boolean }
type ChangeMark = "M" | "A" | "D";

export function visibleRows(tree, opts: { changes: Map<string, ChangeMark>; changedOnly: boolean; showHidden: boolean }): Row[];
export function toggle(tree, path): FilesTree;
export function collapseAll(tree): FilesTree;
export function revealPath(tree, path): { tree: FilesTree; needs: string[] }; // expands parents, lists folders still to load
export function moveSelection(rows, selected, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End"): ...;
export function changeMarks(diff: ThreadDiff | null, root: string): Map<string, ChangeMark>;
```

- `changeMarks` replaces `changedSet`. Mark from `DiffFile.patch`: `A` when it
  has `--- /dev/null`, `D` when `+++ /dev/null`, else `M`. Keep `changedSet`
  exported (or update its callers/tests) so nothing else breaks.
- `hasChangedInside`: a folder row gets a small dot when any changed path is
  under it.
- **Changed only**: show only changed files and the folders leading to them,
  auto-expanded (use `revealPath` for each). Deleted files appear here too.
- **Show hidden** off by default: hides names starting with `.` and always hides
  `.git` and `.DS_Store` contents. Changed files are shown even when hidden.
- Remember `expanded`, `changedOnly` and `showHidden` per project root in
  `localStorage` key `apex-deck.files-tab.v1` (`{ [root]: {...} }`, keep at most
  20 roots, drop oldest). Parse defensively like `parsePanel`.

### UI — `src/RightFiles.tsx`

- Toolbar row at the top (plain icon buttons, `title` + `aria-label`):
  **Find** (step 3), **Refresh** ↻, **Collapse all**, a **⋯** menu with
  ✓ Changed only, ✓ Show hidden, New file, New folder (step 4).
- **Changed in this thread** section above the tree when the diff has files:
  collapsible, lists each changed file as `relative/path` with its mark and
  `+N −M`, click → preview's Changes view (step 2). Deleted files are listed here
  (struck through, Changes view only).
- Refresh reloads the diff and every expanded folder's listing. Also reload when
  the tab becomes visible (as now).
- Render the flat `visibleRows` list with `padding-left` by depth. Keep
  `role="tree"`/`treeitem`/`aria-expanded`/`aria-level`; one row is tabbable
  (roving tabindex).
- Keyboard on the tree: ↑/↓ move, → opens folder or moves into it, ← closes or
  goes to parent, Enter opens file / toggles folder, F2 rename, ⌘⌫ Move to Trash
  (step 4), ⌘C copies the relative path.
- **Right-click menu** (use `src/Menu.tsx`, pointer anchor; same on a ⋯ shown on
  row hover). Read-only entries in this step:
  - Open (preview, step 2)
  - Open in default app — only when the project is on this Mac
    (`workspaceHost(workspace) === "local"`), else hidden
  - Reveal in Finder — same rule (`openTarget(path, null, true)`)
  - Copy ›  Relative path / Full path / File name
  - Add to chat — inserts `` `relative/path` `` into the focused chat's composer
  - Show changes — when the file is changed
  - (step 4 adds a separator, then New file…, New folder…, Rename…, Duplicate,
    Move to Trash)
  On a folder: Open in default app/Reveal, Copy ›, Add to chat, Collapse inside,
  Find in folder… (step 3), then the step 4 entries.
- **Drag a row into a chat**: `draggable`, `dataTransfer.setData("text/plain",
  relativePath)`. Check the composer accepts a plain text drop; if not, leave it
  out and say so in the hand-back.
- Copy uses `writeClipboard` from `src/threadCopy.ts`. **Tests must stub the
  clipboard; never touch the real one.**

### "Add to chat" plumbing

No composer insert path exists today. Follow the `OPEN_SETTINGS_EVENT` pattern
(`src/ModView.tsx:166`): export `INSERT_COMPOSER_EVENT = "deck:insert-composer"`
with `detail: { paneId: string; text: string }`. `ChatPane` listens, ignores
other pane ids, inserts at the caret (or appends with a leading space if the
box has text), focuses the box. App passes the focused chat pane id to
`RightFilesTab` (it already computes `pane` in the `files` body, `App.tsx` ~2236);
disable "Add to chat" when there's no chat pane.

## 2. Preview

### Host — new `crates/apex-host/src/project_files.rs`

One module for every new file command. Shared guard:

```rust
/// `path` resolved inside `root` (both canonicalized), or an error. Refuses
/// anything that escapes the root through `..` or a symlink, and anything inside `.git`.
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String>
```

For paths that don't exist yet (create/rename target), canonicalize the parent
and check the parent, then validate the last name (not empty, not `.`/`..`, no
`/` or `\0`).

```rust
#[derive(Serialize)] #[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Text { text: String, size: u64, truncated: bool },     // first 512 KB, cut at a char boundary
    Image { mime: String, data: String, size: u64 },        // base64, ≤ 5 MB, by extension: png jpg jpeg gif webp svg
    Binary { size: u64 },
    TooLarge { size: u64 },                                 // image > 5 MB
}
pub fn read(root: &Path, path: &Path) -> Result<FilePreview, String>
```

Text = valid UTF-8 and no NUL in the first 8 KB. Keep `MAX_WORKSPACE_READ`
(512 KB) as the text cap; reuse the constant.

### Command + authority

- `command.rs`: `FileRead { root: String, path: String }` → `file_read`, wired to
  a `Host::file_read` that runs in `spawn_blocking`.
- `authority.rs`: `full(Global)` next to `FolderList`. Add a row to the authority
  table test.

### Frontend

- `types.ts`: `FilePreview` union (match the serde shape exactly).
- `backend.ts`: `fileRead(root, path)`; browser demo throws "Files can't be read in
  the browser demo". `commandBackend.ts` + `tests/command-backend.test.mjs`;
  `hostBackends.ts` forwards like `listFolder`.
- New `src/FilePreview.tsx`, shown in the Files tab: the tree shrinks to the top
  part and the preview fills the rest (drag handle between them, height saved
  in the same `files-tab.v1` storage). Close × returns the tree to full height.
  - Header: file name, muted relative folder, size; buttons Copy path,
    Open in default app / Reveal (local only), Add to chat, and a
    **File / Changes** switch when the file is changed.
  - Text: monospace with line numbers, no wrap, horizontal scroll. Markdown files
    get a **Preview / Source** switch using `src/Markdown.tsx`.
  - Image: `<img src="data:...">` fitted to width; SVG only through `<img>`,
    never inlined.
  - Binary / TooLarge / errors: one muted line plus Open in default app when
    local.
  - Changes: render `DiffFile.patch` from the diff the tab already has. Reuse the
    line rendering from `DiffPanel.tsx` if it's exportable; otherwise a small
    +/− coloured renderer.
  - "Truncated — showing the first 512 KB" note when `truncated`.
- Clicking a file now opens the preview (not the default app). Double-click (or
  ⌥-click) keeps the old "open in default app" when local.

## 3. Find and search

### Host (`project_files.rs`)

```rust
pub fn find(root: &Path, query: &str, limit: usize) -> Result<Vec<String>, String>   // relative paths, best first
pub struct Hit { path: String, line: u32, text: String }   // text trimmed to 240 chars
pub struct SearchResult { hits: Vec<Hit>, truncated: bool }
pub fn search(root: &Path, query: &str, case_sensitive: bool, folder: Option<&Path>) -> Result<SearchResult, String>
```

- Listing files: in a Git repo `git -C root ls-files -co --exclude-standard -z`
  (respects .gitignore); otherwise walk with a skip list (`.git`, `node_modules`,
  `target`, `dist`, `build`, `.next`, `.venv`, `__pycache__`), stop at 50,000
  files. Use the `run_git` pattern from `worktrees.rs` (`GIT_TERMINAL_PROMPT=0`,
  `--` before user input).
- `find` ranking (pure fn, unit-tested): case-insensitive subsequence match on the
  relative path; bonus for matches in the file name, consecutive runs, and the
  start of a word; shorter paths win ties. Limit 100.
- `search` is plain text (no regex in v1). In a Git repo:
  `git grep -n -I --no-color --untracked --exclude-standard -F [-i] -e <query> -- [folder]`;
  read stdout line by line, stop and kill after 500 hits → `truncated`. Not a
  repo: the same walker, files ≤ 1 MB, UTF-8 only, same cap. Exit code 1 from
  git grep means no hits, not an error.
- Empty or whitespace-only query → error, never a full dump.

### Commands

`FileFind { root, query }`, `FileSearch { root, query, case_sensitive, folder: Option<String> }`
(folder checked with `inside`). Both `spawn_blocking`, both `full(Global)`.

### UI

- Toolbar **Find** opens a box above the tree (⌘F while the tab has focus). Two
  modes on a small switch: **Name** / **Text**.
  - Name: debounce 150 ms, results replace the tree as a flat list
    (name bold, folder muted); Enter/click opens preview and `revealPath`s it
    in the tree; Escape clears and returns to the tree.
  - Text: Enter runs it (no live typing search); an **Aa** toggle for case.
    Results grouped by file (`path · N`), each hit `line: text` with the match
    highlighted. Click → preview scrolled to that line with the line
    highlighted. "Showing the first 500 matches" when truncated.
  - "Find in folder…" from a folder's menu pre-fills Text mode scoped to that
    folder, shown as a removable chip.
- Stale responses are dropped (keep a request counter).

## 4. File operations

### Host (`project_files.rs`)

```rust
pub fn create(root, parent: &Path, name: &str, folder: bool) -> Result<String, String>  // new full path
pub fn rename(root, path: &Path, new_name: &str) -> Result<String, String>          // same folder only
pub fn duplicate(root, path: &Path) -> Result<String, String>                       // "name copy.ext", "name copy 2.ext"…
pub fn trash(root, path: &Path) -> Result<(), String>
```

- All go through `inside`. Refuse the root itself and anything in `.git`.
  Refuse when the target already exists ("A file named X is already here.").
  New files are created empty with `create_new(true)`.
- Duplicate copies files only in v1 (folders: "Duplicating folders isn't
  supported yet.").
- **Move to Trash, never permanent delete.** Add the `trash` crate
  (`trash = "5"`) to `apex-host`; check it builds on the Hetzner Linux target
  (the daemon there is built with `--features remote`). If it can't trash
  (no Trash on that machine), return an error; do not fall back to deleting.
- Unit tests with temp dirs (`std::env::temp_dir()`, canonicalized, as in
  `folders.rs`): create file/folder, name with `/` refused, `..` escape refused,
  symlink escape refused, `.git` refused, rename onto an existing name refused,
  duplicate naming sequence. Trash: one test behind `#[ignore]` (it touches the
  real Trash); say so in the hand-back.

### Commands

`FileCreate { root, parent, name, folder }`, `FileRename { root, path, name }`,
`FileDuplicate { root, path }`, `FileTrash { root, path }`. All `full(Global)`.
Authority table rows for each.

### UI

- New file / New folder: an inline name box appears as the first row inside the
  target folder (expanding it); Enter creates, Escape cancels, errors show under
  the box. New file then opens its preview.
- Rename (F2 or menu): the row turns into an inline box with the name selected up
  to the extension. Enter saves, Escape cancels.
- Move to Trash: `ConfirmDialog` — "Move `name` to the Trash?" (folders:
  "…and everything in it?"). Mention when the file has thread changes.
- After every operation reload the parent folder's listing and the diff;
  keep selection on the new/renamed row. Close the preview if its file was
  trashed or renamed (or follow the rename).
- Busy state per row; errors inline, never `alert`.

## Styling

`src/right-panel.css`, all classes prefixed `.right-files-` (no `.badge`, `.row`,
`.picker`). Plain rows, no boxed cards; marks as small coloured letters
(M amber, A green, D red, matching the Changes colours); one dot for folders with
changes inside. Toolbar icons from `DeckIcon` where one exists. Check it in both
light and dark skins.

## Tests

- `tests/files-tree-model.test.mjs`: rows/depth, toggle, collapse all, changed
  only shows ancestors and deleted files, hidden filter (changed hidden files
  still shown), keyboard moves, `changeMarks` A/M/D, storage parse repairs junk.
- `tests/right-files.test.mjs` (style of `right-panel-component.test.mjs`):
  toolbar actions, menu entries hidden for remote projects, Add to chat fires the
  event with the right pane id, preview kinds render, find results open preview,
  search grouping + truncated note, rename/new inline flows, trash confirm.
  Stub backend; stub clipboard.
- `tests/command-backend.test.mjs`: every new command's wire name and args.
- Rust: `cargo test -p apex-host project_files` and `-p apex-daemon authority`
  (use `TMPDIR=/tmp` inside Deck panes).

## Checks before handing back (after each commit)

1. The Rust and JS tests above, `npm test`, `npm run build`, `cargo build`.
2. Render the tab offscreen against a seeded throwaway project folder (a Git repo
   with nested folders, a dotfile, an image, a Markdown file, a binary, and a
   thread diff with M/A/D) and look at the PNG before anything is installed.
   Screenshots: tree with Changed section, a menu open, text preview, Markdown
   preview, Changes view, name find, text search results, inline rename.
   Never point checks at real user projects or the real clipboard.
3. Commit each step on `feat/files-tools`; do not push, merge or install. Post
   each commit hash and its PNGs for review.
