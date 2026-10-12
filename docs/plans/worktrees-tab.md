# Worktrees tab in the right panel

Goal: the right panel's **+** menu gets a **Worktrees** entry. It opens a tab that
lists the current project's Git worktrees and lets the user add one, open one, and
remove one, on whichever machine the project lives on.

Builder: Luna. Reviewer: Jigga. Branch: `feat/worktrees-tab` off `main` (31bdfb7).
Work only in `~/Downloads/apex-deck`. Other bots may edit this folder at the same
time, so stage only your own hunks.

## Scope (v1)

In:
- List worktrees for the project folder (`workspace.path`) of the focused pane,
  or the active project when no pane is focused. Same rule the Files tab uses
  (`src/App.tsx` ~2235).
- Each row: branch (or `detached · <short sha>`), folder path (shortened, full path
  in the title), and quiet labels: `Main`, `Changes · N`, `Locked`, `Missing`
  (prunable), `ApexAgent task`.
- Actions per row: **Open folder** (existing `backend.openTarget`), **Remove**.
- **New worktree** form at the top: branch name, "new branch from" base
  (defaults to current HEAD) or "existing branch", folder (prefilled, editable).
- **Clean up missing** button when any row is prunable (`git worktree prune`).
- Empty states: no project folder; folder is not a Git repo; machine offline
  (copy the Files tab wording).

Out (later): deleting branches, moving/locking worktrees, starting a thread or
terminal in a worktree, phone UI.

## 1. Panel model — `src/rightPanelModel.ts`, `src/RightPanel.tsx`

- Add `"worktrees"` to `TabKind` and `KINDS` (after `"files"`). It is a single tab
  like Files: `openTab` already reuses non-browser kinds; `parsePanel` already
  drops duplicates. No storage-key bump needed (unknown kinds were dropped before,
  so old saves stay valid).
- `TAB_LABEL.worktrees = "Worktrees"`.
- Extend `tests/right-panel-model.test.mjs`: opening twice gives one tab; a saved
  panel with a worktrees tab round-trips.

## 2. Host — new `crates/apex-host/src/worktrees.rs`

Use the same `Command::new("git")` pattern as `assistant_git::run_git`
(`GIT_TERMINAL_PROMPT=0`, piped output, stderr returned as the error text).
Always put `--` before paths/refs supplied by the user.

```rust
pub struct Worktree { path, head: Option<String>, branch: Option<String>,
    main: bool, locked: bool, prunable: bool, changes: Option<u32>, task: bool }
pub struct WorktreeList { root: String, items: Vec<Worktree> }   // root = main worktree

pub fn list(project: &Path, task_dir: &Path) -> Result<WorktreeList, String>
pub fn add(project: &Path, req: AddRequest) -> Result<Worktree, String>
pub fn remove(project: &Path, target: &Path, force: bool, task_dir: &Path) -> Result<(), String>
pub fn prune(project: &Path) -> Result<(), String>
```

- `list`: `git rev-parse --show-toplevel` (error → "This folder isn't a Git
  repository."), then `git worktree list --porcelain -z`. Parse records; first
  record is `main`. `changes` = line count of `git -C <wt> status --porcelain`,
  skipped (None) for prunable rows and capped at ~50 worktrees so a huge list
  stays fast. `task = path starts with task_dir` (the ApexAgent data folder used
  by `assistant_git::prepare_worktree`).
- `add`: `AddRequest { branch, new_branch: bool, base: Option<String>, folder: Option<String> }`.
  Validate branch with `git check-ref-format --branch <name>`. Default folder:
  `<parent of main>/<main name>-worktrees/<branch with / → ->`. Refuse if the
  folder already exists. New branch → `git worktree add -b <branch> -- <folder> [<base>]`;
  existing → `git worktree add -- <folder> <branch>`. Return the new row.
- `remove`: refuse `main`, refuse `task` rows ("ApexAgent manages this worktree"),
  refuse paths not in the list. `git worktree remove [--force] -- <path>`.
  When it fails because of changes and `force` is false, return an error whose text
  starts with `has-changes:` so the UI can offer "Remove anyway". Never delete the
  branch.
- Unit tests with throwaway repos in a temp dir (see the `assistant_git.rs`
  tests for setup): list main + one added; add new/existing branch; bad branch
  name; folder exists; remove clean; remove dirty without/with force; refuse
  main; refuse task path; prune after deleting a worktree folder by hand.

## 3. Commands and authority

- `crates/apex-host/src/command.rs`: add
  `WorktreeList { path }`, `WorktreeAdd { path, branch, new_branch, base, folder }`,
  `WorktreeRemove { path, worktree, force }`, `WorktreePrune { path }`
  (snake_case wire names `worktree_list`, etc.) and wire them to new `Host`
  methods in `host.rs` that pass the ApexAgent task data folder.
- `crates/apex-daemon/src/authority.rs`: all four are `full(Global)`, next to
  `FolderList`. Add rows to the authority table test.
- Run Git off the async thread (`spawn_blocking`) if the host does that for other
  Git calls; check `room_diff` and follow it.

## 4. Frontend backend plumbing

- `src/types.ts`: `Worktree`, `WorktreeList`, `WorktreeAdd` types (camelCase via
  the existing serde rename convention — check `FolderListing`).
- `src/backend.ts` interface: `worktreeList(path)`, `worktreeAdd(path, req)`,
  `worktreeRemove(path, worktree, force)`, `worktreePrune(path)`. Browser demo
  backend: throw "Worktrees aren't available in the browser demo".
- `src/commandBackend.ts`: map to the commands. Add to
  `tests/command-backend.test.mjs`.
- `src/hostBackends.ts`: forward like `listFolder`.

## 5. UI — new `src/RightWorktrees.tsx`

`RightWorktreesTab({ root, backend, visible, onOpen })`, mounted in App's
`bodies` exactly like `files` (same workspace/route lookup; `onOpen` = open
folder via `route.openTarget(path, null, false)`).

- Loads when it becomes visible and after every action; a small ↻ refresh.
- Plain rows, no boxed cards; one line for branch, one muted line for path +
  labels. Remove is a small text button; on `has-changes:` swap the row's
  buttons for "Has uncommitted changes · Remove anyway · Cancel". Busy state
  disables the row. Errors show inline under the form/row, not as alerts.
- New-worktree form collapsed behind a "New worktree" button; fields: Branch,
  a two-option "New branch / Existing branch" switch, Base (only for new),
  Folder (prefilled from the branch, editable). Enter submits.
- Styles in `src/right-panel.css`, prefixed `.right-worktrees-`. Avoid generic
  class names (`.badge`, `.row`, `.picker`).
- Test `tests/right-worktrees.test.mjs` in the style of
  `right-panel-component.test.mjs`: renders rows and labels, hides Remove on
  main/task rows, has-changes flow calls remove again with force, empty states.

## 6. Checks before handing back

1. `cargo test -p apex-host worktrees` and `-p apex-daemon authority`
   (use `TMPDIR=/tmp` inside Deck panes).
2. `npm test` and `npm run build`.
3. Render the tab offscreen and look at the PNG before anything is installed —
   with a seeded throwaway repo (main + 2 worktrees, one dirty, one missing).
   Never point checks at real user repos or the real clipboard.
4. Commit on `feat/worktrees-tab`; do not push, merge or install. Post the commit
   and the PNG for review.
