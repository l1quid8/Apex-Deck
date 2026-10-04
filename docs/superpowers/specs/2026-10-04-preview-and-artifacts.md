# Preview pane and Artifacts panel

Decided with Tyler on 2026-10-04. Design canvas: https://claude.ai/artifact/5Kvaos8aKAmB6u5tMkTyDH (private to Tyler). Where the canvas and this page differ, this page wins.

Two independent features, built from two plans:

- `docs/superpowers/plans/2026-10-04-preview-pane.md`
- `docs/superpowers/plans/2026-10-04-artifacts-panel.md`

## 1. Preview pane

A web page beside your terminals, usually the dev server a terminal started.

### 1.1 What it is

- A third pane kind, `"preview"`, that can sit on either deck: Code, beside terminals, or Threads, beside threads. It stays on the deck it was added to. It drags, resizes, maximizes (□) and is saved like a terminal, and isn't tied to one terminal or thread.
- Its body is the page in an `<iframe>`, with an address bar above it.

### 1.2 Opening one

- **+ New › Preview**, on either deck, opens an empty one on that deck. The empty page lists "Servers in this workspace": the local server address each running terminal last printed, and the newest one a bot mentioned in each open thread. Picking one loads it and remembers that terminal or thread as the page's source.
- When a terminal prints a local server address (`http://localhost:5173/`, `http://127.0.0.1:8000`, `http://0.0.0.0:3000`, `http://[::1]:4000`, `http://app.localhost:5173`), its pane head shows a chip with the host, e.g. `localhost:5173`. Clicking it opens a Preview **right of that terminal**, or focuses the Preview already showing that address in this workspace. LAN and internet addresses never make a chip.
- The chip goes away when that terminal's program ends.
- The same chip shows in a **thread's** head for the newest local server address a bot mentioned in a finished reply. It opens a Preview right of that thread, on the Threads deck, or focuses the one already showing it there.

### 1.3 The address bar

Left to right: Reload, the address field, Full window, Open in browser.

- Typing: `3000` and `localhost:3000` mean `http://localhost:3000/`; other bare names get `https://`; only `http:` and `https:` load. Anything else shows "That isn't a web address. Try e.g. localhost:3000." under the bar.
- **No Back and Forward.** A page from another origin hides its history and its current address from the app, so the field shows the address you opened, not where you clicked to inside the page. Reload loads the address in the field again.
- Open in browser opens the address in your default browser.

### 1.4 Looking before loading

Before showing a page, the desktop side requests it (GET, 4 s timeout, at most 5 redirects, no proxy, headers only) and answers one of:

- **ok**: load it.
- **refused**: the final response has `X-Frame-Options: DENY`, `SAMEORIGIN` or `ALLOW-FROM …`, or a `Content-Security-Policy` whose `frame-ancestors` doesn't list `*`. Show the refused state.
- **unreachable**: nothing answered. Show the stopped state and look again every 2 s while the pane is on screen.

HTTP error statuses (404, 500) count as ok: the page shows the server's own error.

### 1.5 States and copy

| State | Head (muted) | Body |
|---|---|---|
| No address | No page yet | "Open a page." + servers list + "Pages from the internet often refuse to load inside another app. Those open in your browser instead." |
| Looking | Checking… | "Checking localhost:5173…" |
| Loaded | From Dev server (its source terminal's name), or nothing | The page |
| Unreachable | Can't connect | "Nothing is answering at localhost:5173." + "Dev server has stopped. The page comes back by itself once the server answers again." (or without the first sentence when the source still runs or there is none) · **Start Dev server again** (primary, only when the source is a terminal that has stopped) · **Show terminal** or **Show thread** (when there is a source) · "Checking every 2 s" |
| Refused | Won't load here | "github.com won't load inside the deck." + "The site tells browsers not to show it inside other apps. Most sites with a sign-in do this." · **Open in browser** (primary) · **Change address** (selects the field) · ☐ "Always open github.com in my browser" |

The host shows after the pane's name in its head, like a terminal's program title: `Preview · localhost:5173`.

"Always open … in my browser" is saved in `settings.json` as `preview.openExternally` (host names). For those hosts the refused state opens the browser by itself, once per address.

### 1.6 The frame

`sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"`, `referrerpolicy="no-referrer"`. No `allow-top-navigation`, so a page can never navigate the app away. No `allow-popups`, so links that open new windows do nothing; use Open in browser. `allow-same-origin` keeps the page's own origin (localhost:5173), which dev servers need for hot reload and storage; it never gives the page the app's origin.

The page must not be able to reach the app's commands. The first task of the plan checks this in a release build before anything else is built.

### 1.7 Full window

The Full window button (four corners icon) makes the Preview cover the rail and deck, below the title bar. It is the same frame moved with CSS, so the page does not reload. **▣** or **Esc** returns (Esc only reaches the app while focus is outside the page). Switching section ends it. □ in the pane head still maximizes within the deck: □ always means pane maximize, the corners icon always means full window.

### 1.8 Saved

A Preview is saved as `{ id, workspaceId, kind: "preview", title, url, servedBy?, deck? }`, with `deck: "threads"` when it is on the Threads deck (missing means Code). After a restart it looks at its address again and loads. A saved address that isn't a web address loads as empty.

## 2. Artifacts panel

Code from a bot's reply, shown rendered, with every version kept.

### 2.1 What it is

- A side panel inside the thread, beside the transcript, like the changes panel. The composer stays full width below.
- Only on request. Bots never create artifacts by themselves.
- Kinds: **HTML**, **SVG**, **Markdown**. Mermaid and others later.

### 2.2 Opening one

On a finished bot reply, each code block whose kind is supported gets one control in its header, beside Copy:

- **Open as artifact**: makes a new artifact at v1 and opens the panel on it.
- **Open as artifact ▾**, when the thread already has an artifact of the same kind: a menu of up to three of them, newest first, "New version of Welcome email" / "Becomes v4. Earlier versions are kept.", then "New artifact" / "Starts its own history at v1."
- **Show v3** / **Showing v3**, once the block has been opened: shows that version.
- A block over 512 KiB shows Open as artifact turned off, titled "Too large to open as an artifact."

Language tags: `html` `htm` `xhtml` → HTML; `svg` → SVG; `xml`, or no tag, whose text starts with `<svg` → SVG; no tag whose text starts with `<!doctype html` → HTML; `md` `markdown` → Markdown.

An artifact's title comes from its HTML `<title>`, else its first `<h1>`, its first `#`–`###` Markdown heading, or an SVG `<title>`; else "HTML page", "SVG image" or "Document". At most 60 characters.

### 2.3 The panel

- **Toggle:** "Artifacts · 3" in the thread's bar, beside "Changes · N", shown when the thread has any. Pressed while the panel is open.
- **Head:** the artifact's title as a button that opens the list of the thread's artifacts; under it, mono: "HTML · v3 of 3 · by Ada". Then Full window and × Close.
- **Bar:** Preview / Source / Changes tabs; ‹ v3 › version arrows; Copy source, Save to folder…, Open in browser.
- **Preview:** HTML and SVG in a sandboxed frame; Markdown with the app's own Markdown renderer.
- **Source:** the text with line numbers.
- **Changes:** this version against the one before it, three lines of context, "⋯ 12 unchanged lines" between hunks; v1 says "First version. Nothing to compare yet."
- **Foot:** speaker dot, "v3 by Ada · 2m ago", and "Runs sandboxed" (title: "It can't reach your files, the network or the app.") for HTML and SVG.
- **List:** each artifact with its kind icon, title, "HTML · v3 · Ada · 2m ago", newest first. "Save all to folder…" is not in this round.
- **Narrow thread** (thread body under 760 px): the panel covers the transcript from the right with a backdrop, like thread details. Esc with focus in it, or the backdrop, closes it.
- **Full window:** as in 1.7.

### 2.4 Rendering safely

- HTML and SVG run in `<iframe sandbox="allow-scripts" srcdoc="…">`: an opaque origin, no forms, popups, modals, same-origin or top navigation.
- The document gets `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">` inserted after its `<head>` (or in a new `<head>`), so it can't load anything from the network. The sandbox is the boundary; the policy is a second line.
- If the frame loads a second time (a link or `<meta refresh>` took it elsewhere), the panel puts the artifact back and the foot says "This artifact tried to open another page. It was put back."
- Open in browser writes the file to `<data folder>/exports/` and opens it with the default app. That copy runs outside the sandbox; it is your explicit choice, the same as saving it and double-clicking it.

### 2.5 Saved

- `rooms/<thread id as hex>.artifacts.json` beside the thread's file: `{ "version": 1, "artifacts": [{ "id", "title", "kind", "versions": [{ "source", "by", "seq", "at" }] }] }`. `by` is the bot's participant id, `seq` the reply's message number, `at` milliseconds since the epoch. Version numbers are positions, from 1.
- Deleted with the thread. Copied when the thread is forked.
- If the file can't be read, the panel says "Artifacts couldn't be read, so changes here won't be saved." and nothing writes over the file.

## 3. Not in this round

Back and Forward in Preview; recent addresses; device-width presets; Mermaid; renaming or deleting artifacts; Save all; bots making artifacts by themselves; a keyboard shortcut for full window.
