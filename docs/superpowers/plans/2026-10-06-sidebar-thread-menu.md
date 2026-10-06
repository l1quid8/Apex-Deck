# Sidebar thread ⋯ menu: Rename, Pin, Share as PDF, Fork, Export, Delete

Author: Jigga (plan) · Reviewer: Null · Implementer: Gronk · Branch: work on `main` in `~/Downloads/apex-deck` only (no `apex-deck-*` folders).

## Goal
Each thread row in the left rail (`.pane-row`, `src/App.tsx` ~line 997) gets a **⋯** button (shown on hover/focus, always shown while its menu is open) and a right-click that opens the same menu. Items:

1. Rename
2. Pin to top / Unpin
3. Share as PDF
4. Fork
5. Export (existing Markdown export)
6. — separator — Delete thread… (danger)

Code/terminal/preview rows get the menu too but only their existing items (Rename, Close, etc. from `paneMenuItems`) plus Pin. Share/Fork/Export are chat-only.

## What already exists (reuse, don't rebuild)
- `paneMenuItems()` in `src/paneMenu.ts` – chat items Rename/Fork/Export/Delete.
- `runPaneMenu()` in `src/App.tsx` ~739 – dispatches actions. Fork/Export go through `setThreadRequests` into `ChatPane`.
- `deleteThread()` in `src/App.tsx` ~685 – already shows a ConfirmDialog ("Delete X? Its messages, pins and temp files are removed.") **and** an 8 s undo (`UNDO_MS`). Human asked for a confirm; that's satisfied. Change body text to end with "This can't be undone after a few seconds." — nothing else.
- Workspace row ⋯ menu (`.pane-menu-wrap` / `.pane-menu`, `toggleMenu`, outside-click + Escape close) – copy this exact pattern for thread rows.
- `exportThread.ts` – `exportMarkdown`, `exportFileName`.
- `shell:exportFile` in `desktop/main.mjs` writes to Downloads via `writeNew`.

## Changes

### 1. Menu model – `src/paneMenu.ts`
- Add actions `"pin" | "share_pdf"` to `PaneMenuAction`.
- `paneMenuItems(kind, terminal, preview, { pinned })`: chat → Rename, Pin to top|Unpin, Share as PDF, Fork, Export, sep, Delete thread…. Other kinds: insert Pin after Rename.
- Unit tests in the existing paneMenu test file for both pinned states.

### 2. Pin – `src/types.ts`, `src/App.tsx`
- Add `pinned?: boolean` to `Pane` (persisted with panes the same way `closed` is; check that the save/load path round-trips unknown optional fields — add a test).
- `runPaneMenu` "pin" → `setPanes(list => list.map(p => p.id === pane.id ? { ...p, pinned: !p.pinned } : p))`.
- Sort in the rail only: `own` sorted stable, pinned first, otherwise current order. Put the sort in a small pure helper (`pinnedFirst(panes)` in `src/layout.ts` or new `src/railOrder.ts`) with a test. Does **not** change pane order on the deck.
- Show a small pin glyph (`DeckIcon` if one exists, else 📌-free SVG) before the title on pinned rows, `aria-label="Pinned"`.

### 3. ⋯ on thread rows – `src/App.tsx` + CSS
- Inside the `.pane-row`, after the flag, add `<span className="pane-menu-wrap">` with the ⋯ button (`aria-label={\`More for ${pane.title}\`}`) and a `.pane-menu` rendered from `paneMenuItems(...)`; each item calls `setPaneMenu(null); runPaneMenu(pane, action)`.
- `onClick` of the ⋯ button and menu items must `stopPropagation()` so the row doesn't also focus the pane.
- Row `onContextMenu`: `preventDefault()`, then open the same menu (`menuOpener` = the ⋯ button so Escape returns focus there).
- CSS: ⋯ hidden (`opacity:0`) until `.pane-row:hover`, `.pane-row:focus-within`, or menu open. Keep the menu opening the same direction as the workspace menu. Long titles must still ellipsize; the button must not push the row wider.
- Keyboard: Shift+F10 / ContextMenu key on a focused row opens the menu.

### 4. Fork/Export/Share for threads that aren't mounted
Risk: Fork/Export are handled inside `ChatPane` via `threadRequests`. A **closed** thread (`pane.closed`) may not have a mounted `ChatPane`, so the request would be dropped silently. Gronk: verify. If unmounted, either (a) open the thread first (`focusPane`) then dispatch, or (b) load the transcript via backend directly. Prefer (a) – simplest, and the user sees what they're exporting.

### 5. Share as PDF
Flow: renderer builds a standalone, printable HTML document of the chat → main process renders it in a hidden `BrowserWindow` → `webContents.printToPDF` → write to Downloads → reveal it (same toast + `openTarget(path, true)` as Export).

- **`src/exportThread.ts`**: `exportHtml(t: ThreadExport, at: Date): string`. Self-contained HTML with inline CSS (no app stylesheet, no scripts): title, date, participants, pinned notes, then each message as a bubble with speaker name, timestamp, and body rendered through the app's existing markdown renderer to static HTML (`renderToStaticMarkup(<Markdown .../>)` if that works outside the app; otherwise the markdown→HTML path in `markdownText.ts`). Code blocks monospace with wrap (`white-space: pre-wrap`) so nothing is cut off at the page edge. Light theme, print-friendly. `@page { margin: 16mm }`, `break-inside: avoid` on short bubbles only.
- **Escape everything** – message text is untrusted. Any raw HTML in markdown must stay escaped. Tests: a message containing `<script>` / `<img onerror>` comes out inert.
- `exportFileName(title, "pdf", at)` → `.pdf`; widen the format union.
- **`desktop/main.mjs`**: new `handle('shell:exportPdf', async (_e, name, html) => …)`:
  - `new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })`.
  - Load via `loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))` (or a temp file if data-URL size is a problem on big threads; test with a ~2,000-message thread).
  - Block navigation and new windows on that webContents (`will-navigate` → preventDefault, `setWindowOpenHandler` → deny), and no network: `session` from a fresh `partition: 'pdf-export'` with `webRequest.onBeforeRequest` cancelling anything not `data:`.
  - `printToPDF({ printBackground: true, pageSize: 'A4' or 'Letter' by locale, margins default })`, write with `writeNew(downloads, name, buffer)`, always `win.destroy()` in `finally`. 30 s timeout.
  - `writeNew` currently takes a string; make it accept a Buffer.
- **`desktop/preload.cjs`**, **`src/electronShell.ts`**, **`src/backend.ts`**, **`src/commandBackend.ts`**: add `exportPdf(fileName, html): Promise<string | null>` alongside `exportThread`. Browser preview/demo backend: not supported → throws, which triggers the fallback.
- **`ChatPane.tsx`**: new `share_pdf` thread request → `sharePdf()`:
  ```
  try exportPdf(...) → notify("Saved PDF to …"), reveal
  catch → exportAs("markdown") and notify("Couldn't make a PDF, saved Markdown instead: <reason>", "error")
  ```
  This is the fallback the human asked for.

### 6. Out of scope
Share sheet / AirDrop / link sharing; multi-select; drag to reorder pins; pinning workspaces.

## Tests / verification (Gronk, before claiming done)
- `npm test` all green (480 today + new), `tsc` clean.
- Unit: paneMenu items (pinned/unpinned, each kind), `pinnedFirst`, `exportHtml` escaping + includes names/timestamps/code, `exportFileName` pdf.
- Run the app (demo mode is fine for UI): screenshot rail with hover ⋯, open menu, right-click menu, a pinned thread at top, delete confirm dialog.
- Real Electron build: Share as PDF on a normal thread, one with long code blocks, one closed thread. Open the PDFs and check nothing is clipped. Force a failure (e.g. throw in handler) and confirm Markdown fallback lands in Downloads.
- If running tests inside a Deck pane: `TMPDIR=/tmp npm test` (socket path length issue).

## Hand-off
Null reviews this plan first (security of the hidden PDF window, the closed-thread case, persistence of `pinned`). Gronk implements after Null's notes are folded in, commits on `main`, does **not** push or build a DMG until the human says so.

## Null review — required implementation corrections

Reviewed against current source on 2026-10-06. Proceed with the plan incorporating these requirements; these supersede the corresponding suggestions above.

1. **Closed-thread requests must survive mounting and wait for loaded data.** `ChatPane.tsx` initializes `lastMenu` from `menuRequest?.n`, so reopening and dispatching in the same React batch silently consumes the request. Merely delaying dispatch can instead export empty initial entries before asynchronous restoration finishes. Queue each action with an explicit identity, execute only after successful thread initialization (`ready`), acknowledge it back to App, and clear it after consumption so remounting cannot replay it. Report load failures rather than exporting an empty chat. Verify closed-thread Fork, Export and PDF against a known saved transcript, including participants and pins, and verify no duplicate action after closing/reopening.
2. **Persist pins for every supported pane kind.** Chat descriptors currently round-trip extra fields, but `savedPanes` and `loadedPanes` in `src/closing.ts` explicitly reconstruct terminal and preview descriptors and discard `pinned`. Preserve and normalize the boolean in both directions for all three kinds; test round trips and missing/invalid values. Check a real restart as well as the helper test.
3. **Sidebar Rename needs its own target.** The rail `ThreadName` does not receive `renameRequests`; the mounted pane header does. Give the rail its own rename request or direct edit trigger so Rename works for closed rows without reopening. Do not wire one request to both editors and activate both at once.
4. **PDF isolation needs an actual isolated session.** Set a unique, nonpersistent partition per export on the BrowserWindow's `webPreferences` (a fixed `pdf-export` partition is reused, not fresh). Install request blocking and permission-denial handlers on that exact session before loading; no preload. Add a CSP to the generated document: `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. Block new windows, navigation, downloads and embedded frames; no untrusted raw HTML, resource URLs or inline event attributes. If using a temporary file, allow only the exact generated main document rather than all `file:` URLs, and delete it in `finally`. Test remote and local resource attempts, not just script strings. Electron references: https://www.electronjs.org/docs/latest/api/session and https://www.electronjs.org/docs/latest/api/web-request.
5. **Timeout must stop the export, not only reject a promise.** On timeout destroy the hidden window and prevent a late PDF write; clear the timer and dispose listeners in every completion path. Test two simultaneous exports and timeout fallback with no late duplicate files.
6. **Fallback must await a confirmed save.** Current `exportAs` returns void and catches its own failure. Refactor the underlying save operation to return an awaitable result and propagate errors. PDF failure should try Markdown; announce fallback success only after a non-null saved path. Treat a null PDF result as an explicit failed/unsupported result unless it means user cancellation, in which case do not create a fallback file. If both saves fail, show the failure without claiming a file exists. `writeNew` in `desktop/files.mjs` already accepts Buffer; no helper change is needed, just avoid string coercion in the new PDF handler.
7. **Menus must stay usable in the rail.** Stop keyboard propagation from child controls so pressing Enter on a menu item does not invoke the row's Enter handler and reopen/focus it. Support focus entering the menu, arrow navigation, Escape return, and closing when focus leaves. Check top/bottom rows and a scrolled narrow rail for clipping; reposition or portal the menu when necessary. Use distinct row/header menu identities so the same pane does not render two open menus.
8. **Printable rendering must remove interactive artifacts.** `markdownText.ts` is a parser, not an HTML renderer; reuse its block/inline structure or static React rendering with export CSS. Hide Copy/action controls, remove scroll/max-height restrictions, wrap long code and table cells, and allow long messages to split across pages. Verify multi-page PDFs visually and check their extracted text includes the first and last messages, Unicode names, code and tables.

Review status: plan approved for implementation with the corrections above. No product source changed and no implementation tests were run during this plan review.
