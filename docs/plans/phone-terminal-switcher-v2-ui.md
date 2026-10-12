# Phone terminal switcher v2: the rest of the mockup

Builds the iPhone Code tab from `docs/mockups/phone-terminal-switcher-v2.html` on top of what is
already on `main` (f1a5ac1, c177f1b, 3168b30): `pty_list`, `pty_attach`, per-terminal cursors and
256 KiB of recent output in `crates/apex-host/src/pty.rs`, and a plain list + `<pre>` + input line
in `PhoneTerminals` (`src/phone/PhoneApp.tsx`).

Owner: Luna builds. Jigga reviews each task's commit before the next one starts.
Branch: `feat/phone-terminal-switcher-ui` **inside `~/Downloads/apex-deck`** (no worktree, no
`/tmp` copy, no `apex-deck-*` folder). Other bots edit this folder too: `git add` only your own
files/hunks, run `git status` before each commit, never `git add -A`, never touch the untracked
`docs/mockups/*` or other `docs/plans/*` files.

Out of scope (do not build): the read-only view (mockup state 8; viewing stays Full access + every
thread, same as today), Workspace files, Changes to review, Browser, Latest build (these show as
"Later" rows only), Terminal.app/iTerm windows, the Hetzner server's daemon.

## What the human gets

Mockup state → what ships:

| # | Mockup state | Ships as |
|---|---|---|
| 1 | Code page | Eyebrow machine name, "Code", project line. Workspace files + Changes to review + Browser rows and Latest build card, each marked **Later** (no fake data). Terminals row: "N open · M running · K needs an answer", then the 3 most recent terminals of this project (dot, name, last line, age). Footnote "Hold the Code tab to jump to any terminal." |
| 2 | Terminal, full access | Header "‹ Code". Title "Terminal" + ＋. Title line "project · **name** ▾". Name strip with dots. Status bar. Output box rendered by xterm.js. Key row Esc Tab Ctrl ← ↓ ↑ →. Command field. |
| 3 | All terminals sheet | Every paired machine, grouped machine → project, current project first, search over names and recent output, "New shell in <project>", footnote about Terminal.app/iTerm. |
| 4 | Swipe | Drag the output left/right; neighbour's preview slides in with its name; strip highlights it; 25 % width commits. |
| 5 | Asking a question | Amber dot; status bar "Asking: <question>" with **No** / **Yes** buttons that send `n\r` / `y\r`. Amber dot on the Code tab. |
| 6 | Finished | Output dimmed, status "Finished <age> ago · exit <code>", buttons **Close** and **Start again**. |
| 7 | Hold a terminal | Sheet: dot + name + "project · machine · state", Rename, Copy last output, End terminal. |
| 8 | Read-only | Not built. Below Full access the Terminals row says "Needs Full access" as today. |

Two honest differences from the mockup (say these to the human, don't hide them):
- **Red dot** only means "ended with a non-zero exit code". The Mac can't see the exit code of a
  command inside a shell that's still open.
- **Start again** opens a fresh shell in the same folder with the same name (the Mac doesn't know
  which command the terminal last ran). The mockup's "Run again" label becomes "Start again".

## Task 1: daemon additions (Rust)

All in `crates/apex-host` + `crates/apex-daemon`; keep the existing commands wire-compatible
(new fields/params are optional with serde defaults).

1. `PtySummary` gains:
   - `cwd: Option<String>` – full folder (needed for Start again and New shell on another project).
   - `tail: String` – the last 4 KiB of history, cut on a char boundary (reuse the
     `skip_while(byte & 0xC0 == 0x80)` trick), raw (ANSI kept; the phone strips it).
   - `matched: Option<String>` – only set when `pty_list` got a query (below).
2. `pty_list { query?: string }`. With a non-empty query (trim, ≤ 100 chars), return only
   terminals whose name or ANSI-stripped history contains it, case-insensitive; `matched` is the
   last matching history line, trimmed to 160 chars. Add a small `strip_ansi(&str) -> String` in
   `pty.rs` (CSI `ESC [ … final 0x40–0x7E`, OSC `ESC ] … BEL | ESC \`, other `ESC x`, drop `\r`
   that isn't followed by `\n` by keeping only the text after the last `\r` on that line).
   Do the search with the records lock released (copy the bytes out first) – 30 terminals ×
   256 KiB must not block the reader threads.
3. `pty_spawn` gains optional `name: Option<String>` (passed to `SpawnOptions.name`, falling back
   to the agent label, then "shell"). Trim, ≤ 60 chars, strip control characters.
4. New `pty_rename { id, name }` → updates the record's name, errors "no retained terminal with id"
   if missing, then emits new `HostEvent::PtyRenamed { id, name }` (wire name `pty-renamed`).
5. `authority.rs`: `PtyRename` → `full(Global)`; `PtyRenamed` event → Full/global like
   `PtyData`. Add both to the existing table tests (command and event).
6. `protocol.rs`/`command.rs`: wire the new command + param; extend
   `tests/command-backend.test.mjs` if it lists commands.

Tests (in `pty.rs` tests module and `crates/apex-host/tests/host.rs`):
- list shows `cwd` and a `tail` ending with the latest output, ≤ 4096 bytes, valid UTF-8 after a
  4-byte emoji straddles the cut;
- query matches text that only appears in old output, is case-insensitive, ignores ANSI colour
  codes inside the word (`\x1b[31mfoo\x1b[0mbar` matches `foobar`), returns `matched`;
- spawn with a name lists that name; rename changes it and emits `PtyRenamed`; rename of an
  unknown id errors;
- authority table rows for `pty_rename` and `PtyRenamed`.

Commit: `feat: terminal names, folders, tails and search for the phone`.

## Task 2: desktop sends its pane names

The phone must show the names the human sees on the Mac ("dev server", "tests"), not "shell".

- `src/backend.ts`: `ptySpawn` options gain `name?: string`; add `ptyRename(id, name)`,
  `onPtyRenamed(cb)`; update `PtySummary` type (`cwd`, `tail`, `matched?`), `ptyList(query?)`.
  Demo backend: `ptyList` returns `[]`, `ptyRename` resolves, `onPtyRenamed` is a no-op listener.
- `src/commandBackend.ts`: map to `pty_spawn {…, name}`, `pty_rename`, `pty-renamed`,
  `pty_list { query }`.
- `src/TerminalPane.tsx`: pass the pane's shown name (the name on the pane head, `pane.title`)
  at `ptySpawn`, and call `ptyRename(currentPtyId, name)` when that name changes while running
  (ignore errors). Don't send the program's OSC title; send what the head shows.
- Desktop listens to `pty-renamed`: when the id is one of its panes' current pty ids
  (`ptyIdFor(pane.id, generation)`), set that pane's title through the same function the pane
  head's Rename uses. Guard against a loop (don't echo a rename that came from the event).
- Tests: a unit test that a rename from the event updates the pane title once and does not call
  `ptyRename` back.

Commit: `feat: Deck terminals share their names with the phone`.

## Task 3: phone terminal store

New file `src/phone/phoneTerminals.ts` (logic, no JSX) + `tests/phoneTerminals.test.mjs` (same style as
`tests/phoneThreadList.test.mjs`; run with `node --experimental-strip-types --test`).

One store at `PhoneApp` level, across **all** hosts, so the Code tab dot and the sheet work from
anywhere:

- Per host with Full access to every thread (same check the current `PhoneTerminals` error path
  uses): `ptyList()` on mount, on reconnect, on app foreground, on `pty-exit`, on `pty-renamed`,
  and when a `pty-data` arrives for an id not in the list (new terminal; debounce 300 ms).
  No polling timer.
- Hosts that fail with an unknown-command error ⇒ machine state `"old"` ("Update Apex Deck on
  <name> to see its terminals"). Access errors ⇒ `"needs-full"` / `"needs-all-threads"` with the
  existing wording. Offline ⇒ `"offline"`.
- Keep each terminal's `tail` live from `pty-data` (append, keep last 8 KiB) and `lastActivity`.
  Ignore events whose cursor ≤ the stored cursor.
- Pure helpers, all unit-tested:
  - `stripAnsi(text)` (same rules as the Rust one).
  - `lastLine(tail)` – last non-empty stripped line, ≤ 120 chars.
  - `dotState(t, now)` → `"ask" | "run" | "idle" | "fail" | "ended"`:
    exited ⇒ `exitCode === 0 || exitCode === null ? "ended" : "fail"`;
    running and quiet ≥ `QUIET_MS` (from `src/attention.ts`) and `waitingFor(stripAnsi(tail))`
    is non-null ⇒ `"ask"`; output in the last 5 s ⇒ `"run"`; else `"idle"`.
    Reuse `waitingFor` from `src/attention.ts`; do not write a second question detector.
  - `askLine(tail)` – the question line for the status bar ("Delete local test data? (y/N)").
  - `isYesNo(tail)` – only show the No/Yes buttons when the question is a yes/no
    (`waitingFor` returns "Waiting for a yes or no"); other questions show the amber bar
    without buttons ("Asking a question – answer below").
  - `fromPhone(id)` – `id.startsWith("phone-")`.
  - `age(ms, now)` – "now", "4m", "2h", "3d".
  - `groupForSheet(machines, terminals, current)` – machine → project groups, the current
    machine first, the current project first inside it; terminals by `lastActivity` desc.
  - `stripOrder(terminals, machineId, project)` – the strip's terminals for one machine+project,
    oldest-started first so names don't jump around while you watch (sort by first-seen time
    the store records, not `lastActivity`).
- Phone-local "closed" set (`localStorage`, per machine id) for ended terminals the human
  closed; hidden from the list until the daemon forgets them.

Commit: `feat: phone keeps every machine's terminals in one place`.

## Task 4: phone terminal screen

Replace `PhoneTerminals` in `PhoneApp.tsx` with `src/phone/PhoneTerminal.tsx` (+ CSS in
`phone.css`, class prefix `ph-term-`; don't reuse `.badge/.picker/.row` names). Match the mockup's
sizes: 29 px title, strip 13 px with 2 px mint underline on the selected tab, 7 px dots (pulse
on `run`, off under `prefers-reduced-motion`), status bar 11 px on `--panel2` 9 px radius, output
box 13 px radius, 44 px key buttons, 44 px input. Use the phone's existing colour variables, not
the mockup's literal hex values, so light mode works.

Code tab state: `codeView: { kind: "home" } | { kind: "terminal", machineId, id }`, plus
`lastTerminal` (remembered across tab switches, in memory only).

1. **Code page (home)**: as in the table above. Rows marked Later are not buttons (no chevron;
   tapping does nothing). Terminals row opens the sheet. A recent row opens that terminal.
   Below Full access the Terminals row reads "Needs Full access" (keep today's wording/logic).
2. **Terminal screen**:
   - Header back button "Code" → home.
   - Title row: "Terminal" + ＋ (aria-label "New shell in <project>").
   - Title line button "project · **name** ▾" → sheet.
   - Strip (role=tablist): `stripOrder(...)`, dot + name + small "phone" for `fromPhone`;
     tap = switch; hold (reuse the existing hold `bind` helper, 500 ms) = hold menu;
     selected tab scrolled into the middle.
   - Status bar: running "Full permission · input enabled"; ask (step 5 above); ended (step 6).
   - **Output: xterm.js** (`@xterm/xterm` is already a dependency; import its CSS). One
     `Terminal` instance for the current terminal, font 12 px mono, theme from phone colours,
     `cols` = what fits the box width (FitAddon), scrollback 5000, `disableStdin: true`.
     Attach exactly as today (listen first, buffer, `ptyAttach`, write snapshot, then events
     with cursor > snapshot cursor). On terminal switch: `term.reset()` and re-attach; don't
     create a new instance per switch.
     **Never `ptyResize` a terminal that isn't `fromPhone`** – the Mac pane owns its size. For
     phone shells, resize to the fitted cols/rows on attach and on box size change.
   - Key row: Esc `\x1b`, Tab `\t`, Ctrl (latches; highlighted while on), arrows
     (`\x1b[A/B/C/D`, or `\x1bOA…` when `term.modes.applicationCursorKeysMode`). With Ctrl on,
     the next character typed in the command field is sent as its control code
     (`a–z`/`@[\]^_` → `code & 0x1f`), the field stays empty, Ctrl turns off. Handle it in
     `beforeinput` (iOS soft keyboard doesn't give reliable `keydown`).
   - Command field: Enter sends `value + "\r"` (empty Enter sends `"\r"`). `enterkeyhint="send"`,
     `autocapitalize="off" autocorrect="off" spellcheck={false}`.
   - Keyboard: the key row + field must sit right above the iOS keyboard and the output box
     shrinks. Reuse the mechanism the thread composer uses (`PhoneApp.tsx` ~1888–1940, the
     self-shrink + pin from fb61b50); do not add a second keyboard listener style.
   - Ended: no key row/field; Close (adds to the closed set, moves to the neighbour or home)
     and Start again (`ptySpawn({ id: "phone-…", cwd: t.cwd, name: t.name })`, close the old
     one, open the new one).
   - ＋ / New shell: `ptySpawn({ id: "phone-<time>-<rand>", cwd, name: nextName })` where
     `nextName` = `nextTitle("shell", <names in that project>)` from `src/terminalTitle.ts` ("shell", "shell 2", …) and
     `cwd` = the current terminal's `cwd`, else the open workspace path; open it.
3. **Swipe** on the output box: pointer events on a wrapper with `touch-action: pan-y` so
   vertical scrolling inside xterm still works. Decide direction after 10 px: horizontal only if
   `|dx| > |dy| * 1.5`, else hand the gesture to scrolling. While dragging, translate a track
   holding [prev preview][live xterm][next preview]; previews are a plain `<pre>` with the
   neighbour's name row and the last ~40 stripped lines of its `tail` (not xterm instances).
   Rubber-band (÷4) past the ends. Release beyond 25 % of the width commits (200 ms slide, then
   switch); otherwise snap back. Strip tab of the target gets `.peek` while dragging.
   No animation under `prefers-reduced-motion`.
4. **Sheet** (use the existing `Sheet` component): title "Terminals", search field
   "Search names and output". Empty query: groups from the store. Query (debounced 250 ms):
   call `ptyList(query)` on every eligible host in parallel and show `matched` under the name
   with the hit wrapped in `<mark>`. Rows: dot, name (+ "· from this phone"), "state · line",
   age or ✓ for the current one. Machines that aren't eligible show one quiet line under their
   header (offline / needs Full access / needs an update). "＋ New shell in <project>" under the
   current project when the query is empty. Footnote: "Shows terminals opened in Apex Deck.
   Terminal.app and iTerm windows aren't listed." No-match text:
   "No terminal name or recent output matches “q”." Tapping a terminal on another machine opens
   it there (the terminal screen carries its own `machineId`, it does not change the app's open
   machine).
5. **Hold menu** (Sheet): header dot + name + "project · machine · state".
   - Rename → inline text field in the sheet (no `prompt()`), Save calls `ptyRename`.
   - Copy last output → the last 200 lines of the xterm buffer if it's the attached terminal,
     else the stripped `tail`; via the existing `writeClipboard` helper; notice "Copied".
   - End terminal (red) → `ptyKill`, notice "Ended <name>".
6. **Code tab**: hold (500 ms, existing `bind` helper) opens the sheet from any tab. Tap: when
   already on Code home and `lastTerminal` exists, open it; otherwise go to Code (home or the
   last terminal view, whichever it was showing). Amber dot on the tab when any eligible
   terminal's `dotState` is `ask`. aria-label "Code. Hold to switch terminals."

Tests: rendering-level tests in the repo's existing phone test style for: strip order and
selection, Ctrl latch producing `\x03` for "c", arrow codes in both cursor modes, the swipe
direction decision (pure function `swipeIntent(dx, dy)`), sheet grouping and no-match text,
Rename/End calling the backend, Copy using a **stubbed** clipboard (never the real one),
`ptyResize` never called for a non-phone terminal.

Commits: one per numbered part is fine, or one `feat: phone terminal switcher screens` if small.

## Task 5: look at it (required before handing back)

1. Throwaway daemon, never the real one: `target/debug/apex-daemon serve --data-dir
   /tmp/apex-term-ui/data --port 7499`. Start 5 terminals through `scripts/daemon-cli.mjs`
   `pty_spawn` with names: "dev server" running `while true; do date; sleep 1; done`,
   "tests" running `sh -c 'printf "\033[32m✓ ok\033[0m\n"; exit 1'`, "db reset" running
   `sh -c 'printf "Delete local test data? (y/N) "; read a; echo got $a; sleep 600'`,
   "shell 01" running a plain shell, and one `phone-` shell. All with cwd = a throwaway folder
   named `apex-deck`.
2. Serve the phone page as in the phone test-daemon check (vite on 5298, Playwright from
   `ios/node_modules`, 393×852, localStorage machine pointing at port 7499, **clipboard stubbed**).
3. Screenshot, dark and light: Code home; terminal (dev server); sheet; sheet with query "ok";
   mid-swipe; db reset asking (then tap Yes and screenshot the answer); tests ended (red);
   hold menu; Rename field; keyboard-up layout if Playwright can fake it (else note it).
4. Put the PNGs in `/tmp/apex-term-ui/shots/`, open each one, and compare with the mockup's
   states 1–7 (`LOOKS=dark,light node_modules/.bin/electron /tmp/tsw2/shot.js
   "$PWD/docs/mockups/phone-terminal-switcher-v2.html"`). Fix anything stretched, clipped,
   overlapping or missing before reporting.
5. Kill the daemon and vite.

## Task 6: checks before handing back

- `cargo test -p apex-host`, `cargo test -p apex-daemon` (in a Deck pane, prefix
  `TMPDIR=/tmp` – 3 codex_hook tests fail on the long socket path otherwise).
- `npm run build`, the phone/command-backend tests, and the full `npm test`; list any failure
  and say whether it also fails on `main` (it had 12 known failures in monitor-attention +
  one Library timeout).
- `git diff --check`.
- Do **not** install on the Mac, restart `dev.apexdeck.daemon`, sync the iPhone project, bump
  the build number, or upload to TestFlight. Jigga does the install and the TestFlight build
  after review, because restarting the Mac service ends both bots' sessions.

## Report back (in the chat)

Commits (hash + one line each), test results with counts, the screenshot folder, and anything
from this plan you changed or skipped and why. Keep it short.

## After Luna (Jigga)

1. Review each commit; fixes go back to Luna or in a separate commit.
2. Merge to `main` (fast-forward), not pushed until the human says so.
3. iPhone: `npm run iphone:sync`, build number 9, archive and upload to TestFlight the same way
   as 1.1 (8) (CLI `-exportArchive`, Homebrew stripped from `PATH`).
4. Mac: build + install the Developer ID app, restart the background service with a one-shot
   job that **retries `launchctl bootstrap` a few times** (the 08:05 install's first bootstrap
   failed with "Input/output error"; the service only came back at 08:12), then confirm the
   running daemon's sha matches.
5. Tell the human what to try on build 9.
