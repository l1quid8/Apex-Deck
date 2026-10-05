# Phase 3: the Electron desktop shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apex Deck runs as an Electron app whose Rust work all happens in
`apex-daemon`, on this Mac or on a server reached over SSH, with a real
Chromium browser docked in the Preview pane.

**Architecture:** Electron's main process starts (or finds) a local
`apex-daemon serve` and relays protocol lines between the window and the
daemon's socket, or an `ssh HOST apex-daemon --stdio --attach` child for a
remote host. The protocol client lives in the renderer (`src/daemon/client.ts`)
so the phone app can reuse it. Things that touch the screen or the local disk
(dialogs, saved files, the dock, quitting, the docked browser) stay in Electron
main. The React UI is unchanged apart from a transport split in `backend.ts`,
a connection banner, Settings → Hosts and the browser pane.

**Tech Stack:** Electron 44 (`BrowserWindow`, `WebContentsView`,
`contextBridge`), plain ESM JavaScript for main (`.mjs`) and a CommonJS
sandboxed preload (`.cjs`), React 19 + TypeScript in the renderer, Vite 8,
the system `ssh`, electron-builder for the unsigned `.app`, Rust for two small
daemon additions.

**Spec:** `docs/superpowers/specs/2026-10-05-remote-and-electron.md`. Builds on
phase 2 (`docs/superpowers/plans/2026-10-05-phase-2-apex-daemon.md`): protocol
v1, `hello {since: {boot_id, seq}}`, the local socket, `--stdio --attach`.

## Global Constraints
- Protocol stays v1. Daemon changes are additive: `serve --exit-on-stdin-close`
  and `apex-daemon data-dir`.
- Renderer windows run with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. The UI gets only the preload bridge; docked pages
  get no preload at all.
- One data folder, shared with the Tauri app: the daemon's default. The lock
  from phase 2 keeps the two apps from opening it together.
- No new network listeners beyond phase 2's localhost WebSocket.
- SSH uses the system `ssh` with `BatchMode=yes`: existing keys, agent and
  `~/.ssh/config` only. Deck never asks for or stores a password.
- Tauri keeps building and working until the user signs off on Electron;
  removing `src-tauri` is a follow-up, not part of this phase.
- `demoBackend` stays in `backend.ts` untouched (another session has edits
  there).
- Copy style: plain words in UI text, as in the rest of the app.

## Review Focus
1. **The SSH connection drops mid-reply** (Wi-Fi change, laptop sleep): the
   window reconnects and resumes with no missing or doubled messages; a
   command that was in flight fails with words saying it may not have
   finished. Tests: client unit tests (task 2), e2e resume (task 2).
2. **Cmd+R or a resync while agents run on this Mac:** agents and terminals
   keep running, because the host lives in the sidecar, not the window.
   Test: smoke test reloads during a scripted turn and still sees the reply
   (task 4).
3. **Electron is force-quit or crashes:** the sidecar it started must not be
   left running agents with no window. Test: `--exit-on-stdin-close` (task 1).
4. **A menu or dialog opens over the docked browser:** the native view must
   not cover it. Tests: overlap unit test and smoke check (task 7).
5. **Hostile input reaching the shell:** an SSH destination starting with
   `-`, an export name with `../`, a page in the docked browser trying to
   navigate the Deck window or reach the bridge. Tests: `hosts.mjs`,
   `files.mjs`, smoke check of navigation blocking (tasks 5, 6, 7).

## File map
- `crates/apex-daemon/src/cli.rs`, `serve.rs`, `main.rs`: the two additions.
- `src/daemon/client.ts`: protocol client. No DOM, no Electron.
- `src/commandBackend.ts`: `Backend` built from a `Transport` and a `Shell`.
- `src/tauriShell.ts`: today's Tauri code, moved from `backend.ts`.
- `src/electronShell.ts`: `Transport` and `Shell` over `window.apexDeck`.
- `src/connection.ts`: connection status store for the banner and loading screen.
- `src/ConnectionBanner.tsx`, `src/HostsSettings.tsx`, `src/PathPrompt.tsx`,
  `src/BrowserView.tsx`, `src/browserGeometry.ts`.
- `desktop/main.mjs`: app, window, `app://` protocol, menu, IPC wiring.
- `desktop/preload.cjs`: the bridge.
- `desktop/sidecar.mjs`: find the binary, ask it for the data folder, start
  and stop the owned `serve`.
- `desktop/link.mjs`: one connection per window (unix socket or ssh child),
  split into lines.
- `desktop/lines.mjs`, `desktop/quit.mjs`, `desktop/files.mjs`,
  `desktop/hosts.mjs`, `desktop/backoff.mjs`: pure logic, unit tested.
- `desktop/browser.mjs`: docked browser views.
- `desktop/smoke.mjs`: drives the real app for the smoke test.
- `electron-builder.yml`, `docs/desktop.md`, `SPEC.md` §8, the design spec.

## Interfaces

```ts
// src/daemon/client.ts
export interface Link { send(line: string): void; close(): void;
  onLine(cb: (line: string) => void): void; onClose(cb: (reason: string) => void): void; }
export type Connect = () => Promise<Link>;
export interface Welcome { host_id: string; boot_id: string; protocol: number; last_seq: number; resumed: boolean }
export type Status =
  | { kind: "connecting" }
  | { kind: "connected"; hostId: string }
  | { kind: "reconnecting"; attempt: number; reason: string; retryAt: number }
  | { kind: "resync" }                      // resumed: false after a drop; the window reloads
  | { kind: "failed"; reason: string };     // protocol mismatch; no automatic retry
export class DaemonClient {
  constructor(connect: Connect, options?: { delay?: (attempt: number) => number; timers?: Timers });
  start(): Promise<Welcome>;                // resolves on the first welcome; retries until then
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on<T>(event: string, cb: (payload: T) => void): () => void;
  onStatus(cb: (status: Status) => void): () => void;
  retryNow(): void;
  close(): void;
}

// src/commandBackend.ts
export interface Transport {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  saveAttachment(room: string, name: string, bytes: Uint8Array): Promise<string>; // raw over Tauri, base64 over the daemon
  readAttachment(path: string): Promise<ArrayBuffer>;
}
export type Shell = Pick<Backend, "pickFolder" | "pickPath" | "startupFolders" | "artifactSave"
  | "artifactOpenExternal" | "exportThread" | "openTarget" | "copyAttachment" | "flagAttention"
  | "requestCriticalAttention" | "onFileDrop" | "onQuitRequested" | "quitHeard" | "quitApp"
  | "quitStopsWork" | "hosts" | "browser">;
export function commandBackend(transport: Transport, shell: Shell): Backend;

// Backend gains (backend.ts):
//   quitStopsWork: boolean;            // false when the work goes on after quitting (remote, or a daemon Deck didn't start)
//   call<T>(cmd, args): Promise<T>;    // for mods/host.ts; demo rejects
//   hosts?: HostsApi;                  // Electron only
//   browser?: BrowserApi;              // Electron only
```

```js
// window.apexDeck (desktop/preload.cjs)
{
  daemon: { connect(): Promise<number>, send(gen, line), onLine(cb(gen, line)), onClose(cb(gen, reason)) },
  connection: { current(): Promise<{ id, name, remote: boolean, owned: boolean }>,
                list(), add({ name, ssh, command }), remove(id), use(id) },
  shell: { pickPath(kind, title), saveFile(name, contents), exportFile(name, contents),
           openExternal(url), openLocal(path, reveal), setBadge(count), attention(critical),
           startupFolders(), readLocalFile(path), pathForFile(file),
           onQuitRequested(cb), quitHeard(n), quitApp(), onMenu(cb(action)) },
  browser: { show(pane, bounds, url), bounds(pane, bounds), hide(pane, snapshot: boolean),
             navigate(pane, url), reload(pane), back(pane), forward(pane), close(pane),
             onState(cb(pane, state)), onShortcut(cb(keyEvent)) },
  smoke: boolean,
}
```

---

### Task 1: daemon additions

**Files:** Modify `crates/apex-daemon/src/cli.rs`, `serve.rs`, `main.rs`. Test
`crates/apex-daemon/tests/lifeline.rs`, CLI unit tests in `cli.rs`.

- [ ] Write failing CLI tests: `serve --exit-on-stdin-close` parses into
  `ServeOptions { exit_on_stdin_close: true, .. }`; `--exit-on-stdin-close`
  without `serve` is an error naming it; `data-dir` parses to
  `Action::DataDir`; `data-dir --data-dir /d` keeps `/d`.
- [ ] Write a failing e2e test: `apex-daemon data-dir --data-dir <tmp>` prints
  `<tmp>` and exits 0; without `--data-dir` it prints the same default the
  daemon would use (`paths::host_paths(None)`).
- [ ] Write a failing e2e test (`lifeline.rs`): start `serve
  --exit-on-stdin-close` with piped stdin and a temp data dir; attach a socket
  client; start a terminal running `sleep 600` and a scripted agent turn that
  sleeps; drop the stdin pipe. The daemon must exit 0 within `WIND_DOWN + 5 s`,
  `daemon.sock` and `daemon.json` must be gone, and the `sleep` process must
  have ended (its pid from `ps`). A second case kills the parent shell holding
  the pipe with `kill -9` and expects the same.
- [ ] Run them; they fail on parsing.
- [ ] Implement: `Action::DataDir` prints `paths::host_paths(data_dir)?.data`;
  in `serve`, when the option is set, a task reads stdin to EOF and then
  resolves the same stop future SIGTERM uses. stdin is otherwise unused by
  `serve`.
- [ ] Run `cargo test -p apex-daemon`; all pass. Commit
  `feat: apex-daemon serve --exit-on-stdin-close and apex-daemon data-dir`.

### Task 2: the protocol client

**Files:** Create `src/daemon/client.ts`, `tests/daemon-client.test.mjs`,
`tests/e2e/daemon-client.e2e.mjs`, `tests/e2e/link.mjs` (a Node `Link` over a
child's stdio or a unix socket). Add `"test:e2e": "cargo build -p apex-daemon
&& node --test tests/e2e/*.e2e.mjs"` to `package.json`.

**Interfaces:** Produces `DaemonClient`, `Link`, `Connect`, `Status`,
`Welcome` (above).

- [ ] Unit tests with a fake link and fake timers, each written and seen to
  fail first:
  - `start()` sends `hello {protocol: 1}` first and nothing else until the
    welcome; resolves with it; status `connected`.
  - `call` sends `{id, cmd, args}` with increasing ids; replies resolve or
    reject by id, in any order; `err` becomes an `Error` with that message.
  - Events go to `on(name)` listeners only; an event with `seq` at or below
    the last one seen is dropped.
  - The link closing rejects every pending call with "The connection to the
    host was lost, so this may not have finished." and sets status
    `reconnecting` with the close reason; calls made while not connected
    reject at once with "Not connected to the host." (no queueing).
  - Reconnect sends `hello {protocol: 1, since: {boot_id, seq: last}}` after
    `delay(attempt)` (default 1, 2, 4, 8, 16, then 30 s); `retryNow()` skips
    the wait. `resumed: true` → `connected`, and replayed events reach
    listeners once. `resumed: false` → `resync`.
  - A welcome whose `protocol` isn't 1, or a hello `err`, → `failed` with
    the daemon's words; no further automatic attempts; `retryNow()` tries again.
  - A link that closes before the welcome during `start()` keeps retrying
    with the close reason in status; `start()` resolves on the first welcome.
  - A line that isn't JSON closes the link (`close()` called) and reconnects.
- [ ] Implement `client.ts` to pass.
- [ ] e2e test against the real binary: spawn `target/debug/apex-daemon serve
  --exit-on-stdin-close --data-dir <tmp>`, wait for `daemon.sock`, connect
  `DaemonClient` through a socket `Link`; create a room with the scripted
  participant used by the Rust tests (`Backend::Cli` running `sh -c` that
  prints a line), post, and see `room-event` `message_added` for the bot.
  Then destroy the socket mid-turn (a script that sleeps 1 s before
  answering), reconnect: `resumed: true`, the bot's message arrives exactly
  once. Then restart the daemon on the same folder: reconnect gives `resync`.
- [ ] `npm test` and `npm run test:e2e` pass. Commit
  `feat: a protocol client for apex-daemon that reconnects and resumes`.

### Task 3: split the backend into a transport and a shell

**Files:** Create `src/commandBackend.ts`, `src/tauriShell.ts`,
`tests/command-backend.test.mjs`. Modify `src/backend.ts` (interface,
selection; `demoBackend` untouched except the three new fields),
`src/mods/host.ts` (use `backend.call` instead of Tauri's `invoke`),
`src/App.tsx` (`quitStopsWork`: when false, a quit request skips the "still
running" question and quits once saves land).

- [ ] Write `command-backend.test.mjs` first: a recording transport and a
  stub shell; a table with every command-backed `Backend` method, its
  arguments, and the exact `cmd` and `args` today's `tauriBackend` sends (copy
  them from `backend.ts` lines 134–229 as they are now, e.g.
  `roomStop("t", undefined)` → `room_stop {id: "t", participant: null}`,
  `roomCreate(..., "")` → `cwd: null`, `apiModels` → `{baseUrl, apiKeyEnv}`).
  Also: shell methods are passed through untouched; `saveAttachment` and
  `readAttachment` go to the transport's own methods.
- [ ] Run it; it fails (no module).
- [ ] Move the command mapping into `commandBackend`, and the Tauri imports
  into `tauriShell.ts` as `tauriTransport()` and `tauriShell(transport)`.
  Tauri's shell keeps today's behaviour exactly, including `artifact_export`,
  `export_thread` and `open_target` through the host, and has
  `quitStopsWork: true`.
- [ ] `mods/host.ts`: replace the static Tauri import with
  `(await getBackend()).call(cmd, args)`.
- [ ] `npm test`, `npm run build` (typecheck) pass; `cargo tauri dev` still
  starts the Tauri app, opens a saved thread and runs a terminal (by hand,
  noted in the commit). Commit
  `refactor: the backend is commands over a transport plus a shell`.

### Task 4: Electron runs the UI on a local daemon

**Files:** Create `desktop/main.mjs`, `desktop/preload.cjs`,
`desktop/sidecar.mjs`, `desktop/link.mjs`, `desktop/lines.mjs`,
`desktop/backoff.mjs`, `desktop/smoke.mjs`, `src/electronShell.ts`,
`src/connection.ts`, tests `tests/desktop-lines.test.mjs`,
`tests/desktop-sidecar.test.mjs`. Modify `package.json` (`main:
"desktop/main.mjs"`, `electron` devDependency, scripts `desktop`,
`desktop:dev`, `desktop:smoke`), `src/backend.ts` (pick Electron when
`window.apexDeck` exists), `src/App.tsx` (the loading screen shows
`connection.ts` status words).

- [ ] Unit tests first: `lines.mjs` splits chunks into lines across chunk
  boundaries, handles `\r\n`, and errors past 32 MB (matching `MAX_FRAME`);
  `sidecar.mjs`'s `daemonBinary({ packaged, resourcesPath, repo, env })`
  picks `APEX_DAEMON_BIN`, then `resources/bin/apex-daemon` when packaged,
  then `target/debug/apex-daemon`; `serveArgs(dataDir)` is
  `["serve", "--exit-on-stdin-close"]` plus `--data-dir` only when
  `APEX_DECK_DATA_DIR` is set.
- [ ] Main process:
  - `app.setPath("userData", <appData>/dev.apexdeck.desktop)` (the browser
    profile and `hosts.json` live there, apart from the host's data).
  - `app://deck/` serves `dist/` (registered privileged: standard, secure,
    fetch, CORS) with a path check that refuses anything outside `dist/`;
    `APEX_DECK_DEV_URL` loads the Vite server instead.
  - One `BrowserWindow` 1400×900, min 900×600, title "Apex Deck", preload,
    sandboxed. `will-navigate` and `setWindowOpenHandler` on the UI refuse
    everything and open http(s) links with `shell.openExternal`.
  - Local daemon: run `apex-daemon data-dir`, then try the socket. If it
    answers, use it and mark `owned: false`. Otherwise spawn `serve
    --exit-on-stdin-close` with stdin piped, wait for the socket (50 ms
    polls, 15 s), and fail with the child's stderr if it exits first (the
    Tauri app holding the lock lands here with the daemon's words).
  - `daemon:connect` opens a new socket connection for the window, closing
    its previous one, and returns a generation number; lines and close
    reasons carry it, and the renderer ignores old generations.
- [ ] Renderer: `electronShell.ts` builds a `Link` from the bridge and a
  `Transport` from `DaemonClient` (`saveAttachment` sends base64,
  `readAttachment` decodes it). `resync` reloads the window.
- [ ] Smoke test (`npm run desktop:smoke`: builds the daemon and the UI, then
  runs Electron with a temp `APEX_DECK_DATA_DIR`, a hidden window and
  `APEX_DECK_SMOKE=1`). With the smoke flag the renderer puts its backend on
  `window.__deck`; `smoke.mjs` drives it with `executeJavaScript` and exits
  non-zero on any failure:
  - the loading screen goes away and `__deck.backend.demo === false`;
  - create a room with a scripted participant, post, see its reply event;
  - start a 3-second scripted turn, reload the window halfway, and after the
    reload see the reply in `roomCreate`'s snapshot (the host kept working);
  - a terminal running `echo smoke` sends `pty-data` containing it.
- [ ] Commit `feat: Electron shell that runs the UI on a local apex-daemon`.

### Task 5: the shell's own jobs in Electron

**Files:** Create `desktop/quit.mjs`, `desktop/files.mjs`, tests
`tests/desktop-quit.test.mjs`, `tests/desktop-files.test.mjs`. Modify
`desktop/main.mjs`, `desktop/preload.cjs`, `src/electronShell.ts`.

Rule: what the person saves or opens lands on the machine with the screen.

- [ ] Unit tests first:
  - `quit.mjs` mirrors `apex-host/src/quit.rs`: a request gets number n and
    is held; `heard(n)` stops the 2 s fallback; unanswered → let through;
    after `confirm()` nothing is held.
  - `files.mjs`: `safeName("../../etc/passwd")` → `passwd`; names that are
    empty, `.`, `..` or only separators are refused; `writeNew(dir, name,
    bytes)` adds ` (2)`, ` (3)` before the extension like `export::write_new`
    and never overwrites.
- [ ] Main + preload + shell:
  - `pickFolder`/`pickPath`: `dialog.showOpenDialog` (local host only; task 6
    covers remote).
  - `artifactSave`: save dialog, then main writes the file. `exportThread`:
    `writeNew` into `app.getPath("downloads")`. `artifactOpenExternal`:
    `writeNew` into `<userData>/exports`, then `shell.openPath`.
  - `openTarget`: on this Mac, the host's `open_target` (unchanged); remote
    in task 6.
  - `flagAttention`: `app.setBadgeCount` (dock badge), `app.dock.bounce
    ("informational")` when nudged; `requestCriticalAttention`:
    `bounce("critical")`; `win.flashFrame` off macOS.
  - File drops: a capture-phase `drop` listener on the window takes files
    that have a path (`webUtils.getPathForFile` in preload), stops the event,
    and reports paths and the drop point; `dragover` is always
    prevented so a drop never navigates. `copyAttachment` on this Mac is the
    host's `copy_attachment` (folders work as before).
  - `startupFolders`: existing directories in Electron's argv after the app
    path.
  - Quit: window `close` and `before-quit` go through `quit.mjs`; the
    renderer gets `quit-requested`; `quitApp` confirms, closes the owned
    sidecar's stdin, waits up to 15 s for it to exit (then SIGKILL), then
    `app.exit(0)`. Not owned → just exit. `quitStopsWork` is `owned`.
  - Menu: app (About, Settings… ⌘,, Quit), Edit (roles, so copy and paste
    work in fields), View (Reload, Toggle Developer Tools, zoom), Host (task
    6), Window.
- [ ] Extend the smoke test: quitting with nothing running exits 0 and the
  sidecar is gone; with a running terminal the renderer is asked (the
  `quit-requested` handler runs and a question is shown).
- [ ] Commit `feat: dialogs, saved files, the dock, file drops and quitting in the Electron shell`.

### Task 6: hosts over SSH

**Files:** Create `desktop/hosts.mjs`, `tests/desktop-hosts.test.mjs`,
`src/HostsSettings.tsx`, `src/ConnectionBanner.tsx`, `src/PathPrompt.tsx`.
Modify `desktop/main.mjs`, `desktop/link.mjs`, `desktop/preload.cjs`,
`src/electronShell.ts`, `src/SettingsPage.tsx` (a Hosts section when
`backend.hosts` exists), `src/App.tsx` (banner; the menu's "Manage Hosts…"
opens Settings → Hosts).

- [ ] Unit tests first (`hosts.mjs`):
  - `validHost({name, ssh, command})`: `ssh` must be non-empty, must not
    start with `-`, and has no whitespace or control characters; `command`
    defaults to `apex-daemon` and must match `^[\w@%+=:,./~-]+$`; names are
    trimmed, 1–40 characters, unique.
  - `sshArgs(host)` is exactly `["-T", "-o", "BatchMode=yes", "-o",
    "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o",
    "ConnectTimeout=15", "--", host.ssh, "<command> --stdio --attach"]`.
  - `load`/`save` of `hosts.json` (`{version: 1, hosts, last}`) keeps
    unknown fields, drops invalid hosts with a warning, and falls back to
    "This Mac" when `last` is gone.
- [ ] Link: a remote connection spawns `ssh` with `sshArgs`; the close reason
  is the last 2 KB of ssh's stderr (so "Permission denied (publickey)",
  "Host key verification failed" and the daemon's "no apex-daemon is
  running" reach the banner as they are).
- [ ] Remote differences in the shell (`connection.current().remote`):
  `quitStopsWork: false`; `startupFolders` → `[]`; `pickFolder`/`pickPath`
  ask with `PathPrompt` ("Folder on vps", an absolute path, checked with
  `pathsExist` before it closes); `openTarget` opens http(s) here and
  otherwise rejects with "That file is on vps; Deck can't open it on this
  Mac."; `copyAttachment` reads the file here (`readLocalFile`, 20 MB cap,
  folders refused with words) and sends it with `saveAttachment`.
- [ ] UI: Settings → Hosts lists This Mac and saved hosts, adds (name, SSH
  destination such as `me@vps` or a `~/.ssh/config` alias, daemon command),
  removes, and connects; switching saves `last` and reloads the window on the
  new host. The window title is "Apex Deck — vps". The Host menu lists the
  same with a check on the current one, plus "Manage Hosts…".
  `ConnectionBanner` shows while not connected: "Reconnecting to vps… next
  try in 4 s" with Try now, the close reason in small type, and for
  `failed` a Use This Mac button.
- [ ] Verify against the stand-in Ubuntu server from phase 2 (Docker, sshd,
  systemd, `apex-daemon@test`): add it as a host, connect, run a chat with
  a scripted participant, `docker pause` it for 60 s and unpause (the banner
  shows, then the reply arrives once), then stop the unit (the banner shows
  the daemon's words).
- [ ] Commit `feat: connect the Electron app to apex-daemon on another machine over SSH`.

### Task 7: the docked browser

**Files:** Create `desktop/browser.mjs`, `src/BrowserView.tsx`,
`src/browserGeometry.ts`, `tests/browser-geometry.test.mjs`. Modify
`src/PreviewPane.tsx` (uses `BrowserView` when `backend.browser` exists; the
iframe, probe and "won't load here" notice stay for Tauri and the demo),
`desktop/main.mjs`, `desktop/preload.cjs`, every overlay that lacks a role
(menus get `role="menu"`, dialogs `role="dialog"`, pickers
`role="listbox"`), `desktop/smoke.mjs`.

- [ ] Unit tests first (`browserGeometry.ts`):
  - `viewBounds(rect, zoom)` rounds a DOM rect times the zoom factor to whole
    pixels and never returns a negative size.
  - `covered(pane, overlays)` is true when any overlay rect overlaps the pane
    by at least 1 px, false for touching edges.
- [ ] Main (`browser.mjs`): one `WebContentsView` per pane, all on the
  `persist:deck-browser` session; `sandbox: true`, no preload, no node.
  `show` sets bounds *before* adding the view and then focuses it (the spike's
  blank pane and missing accessibility content came from a view with no bounds
  until the first resize); `hide` removes it from the window but keeps the
  page; `close` destroys it. State events: url, title, loading, canGoBack,
  canGoForward, and load errors (`did-fail-load` code and words).
  `hide(pane, true)` first sends a `capturePage()` snapshot. Permission
  requests are denied except clipboard writes and fullscreen; popups open as
  child windows on the same session (sign-in flows need them); downloads go
  to Downloads. `before-input-event`: ⌘/Ctrl shortcuts that `shortcuts.ts`
  owns are sent to the UI instead of the page; copy, paste, cut, select all,
  undo, redo and find stay with the page.
- [ ] `BrowserView.tsx`: a placeholder div; a `ResizeObserver` plus a
  `requestAnimationFrame` check after layout changes report bounds; hidden
  when the pane is off screen, minimized or behind Settings; a
  `MutationObserver` looks for `[role=dialog],[role=menu],[role=listbox]`
  and, when `covered`, hides the view and shows the snapshot until the
  overlay goes. Load errors show today's "Nothing is answering at {host}."
  notice and retry every 2 s while visible; there is no "won't load here"
  case, since nothing here is a frame.
- [ ] Extend the smoke test: open a Preview pane at a `data:` page; bounds
  equal the placeholder's within 1 px on first show; open a menu over it and
  the view is hidden, close it and the view is back; a page calling
  `window.open('app://deck/')` or `top.location = ...` doesn't change the UI;
  `typeof window.apexDeck` in the page is `"undefined"`; a cookie set by the
  page survives a restart of the app.
- [ ] Commit `feat: a real Chromium browser docked in the Preview pane`.

### Task 8: package, document, verify

**Files:** Create `electron-builder.yml`, `docs/desktop.md`. Modify
`package.json` (`desktop:package`: `cargo build --release -p apex-daemon`,
`vite build`, `electron-builder --mac --dir`), `SPEC.md` §8, the design spec,
`README.md` (how to run the Electron app).

- [ ] `electron-builder.yml`: appId `dev.apexdeck.app`, productName "Apex
  Deck", the existing icons, `extraResources` `target/release/apex-daemon` →
  `bin/apex-daemon`, unsigned (ad-hoc on arm64). The packaged app launches,
  connects to its own sidecar, and Codex's hook runs the bundled
  `apex-daemon` (`current_exe`).
- [ ] `docs/desktop.md`: running in dev, building the `.app`, adding an SSH
  host (run `ssh vps` once in Terminal first so the host key is known; the
  daemon must run there per `docs/daemon-ubuntu.md`), what works differently
  on a remote host, and that the Tauri app and the Electron app can't be open
  at the same time.
- [ ] Spec and SPEC.md: the decisions below, the roadmap row set to "built",
  and agent control of the docked browser as phase 3b.
- [ ] Full verification: `cargo test --workspace`, `npm test`,
  `npm run test:e2e`, `npm run desktop:smoke`, `scripts/linux-test.sh`, the
  SSH run in task 6, the packaged app opened once. Then a whole-branch review.
- [ ] Commit `docs: running and building the Electron app, and phase 3 in the spec`.

## Decisions taken here
- The local host is an `apex-daemon serve` that Electron starts with
  `--exit-on-stdin-close`, not an in-process `--stdio`: reloading the window
  must not stop agents, and a crashed Electron must not leave agents running.
  If a daemon already runs on the data folder (the user's own), Electron uses
  it and leaves it running on quit.
- The protocol client lives in the renderer, so main is a byte pipe and the
  phone app can reuse `src/daemon/client.ts`.
- Commands made while disconnected fail at once rather than queue; an
  approval clicked during a drop must not land minutes later.
- Files the person saves or opens land on the machine with the screen.
- On a remote host, folders are typed (checked on the host) rather than
  picked; a remote file browser is later.
- The docked browser replaces the Preview iframe only in Electron. It loads
  pages here, so `localhost` on a remote host isn't reachable from it yet.
- `src-tauri` stays until the user has used the Electron app; removing it is
  its own change.

## Out of scope
Agents driving the docked browser over CDP (phase 3b: a Deck MCP server that
reaches the browser through the daemon, with approvals); forwarding a remote
host's `localhost` ports for the browser; several windows or hosts at once;
signing and notarization; auto-update; Windows and Linux desktop builds;
removing `src-tauri`.
