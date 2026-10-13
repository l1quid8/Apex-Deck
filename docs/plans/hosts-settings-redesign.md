# Settings › Hosts redesign

Branch: `design/hosts-settings` (in `~/Downloads/apex-deck`, no worktree folder).
Mockup: `mockups/hosts-settings.html` — sections 1–3 are the spec; copy every visible piece.
Builder: Thadious. Reviewer: Jigga.

## Why

The page today (screenshot from 2026-10-12) has four problems:

1. **The add form is the loudest thing on the page.** Three full-width inputs and a green button take two thirds of the card, so the page reads as "fill in this form" instead of "here are your machines".
2. **Status is a word glued to the name** (`Apex-Terminal · connected`), with no dot or colour. A host that isn't connected yet shows `· idle`, a word nobody uses. The sidebar already has a dot and plain words for every state; this page ignores them.
3. **Every host shows Retry, even when connected,** and Remove sits beside it with no confirmation. Paired devices asks before Revoke; Hosts should ask before Remove.
4. **The address line is the raw command** (`ssh me@host /usr/local/bin/apex-daemon --stdio --attach`), wrapping onto two lines. People need the SSH destination; the full command belongs in Edit…, which already shows it.

Errors also land at the bottom of the form, far from the host they belong to.

## What changes

Use what already exists. Nothing new on the daemon or in `desktop/`.

| Piece | Today | New |
|---|---|---|
| Add a host | Inline form at the bottom | `+ Add host` button in a `settings-actions` row at the top (same pattern as Paired devices' `Pair phone`), opening the existing `ConnectionDialog` in `add` mode |
| Status | `· connected` text | Sidebar's `.hdot` dot (`dotState`) + a state line |
| Address | Full ssh command, mono, wraps | `host.ssh` only, mono, one line, ellipsis; full command in `title` |
| Retry | Always | Only when the host isn't connected (`Connect` for idle, `Retry` for unreachable) |
| Remove | Instant | `ConfirmDialog` first; a refusal shows on that host's line |
| Test connection | Edit only | Edit **and** Add |

## Task 1 — one helper for a host's line (`src/hostFacts.ts`)

Add a pure function next to `dotState` / `reachNotice` so the page has no status logic of its own:

```ts
export interface HostLine {
  dot: DotState;
  /** "Connected · apex-daemon 0.7.0", or reachNotice's words. */
  text: string;
  tone: "plain" | "warn" | "bad";
  /** The raw reason from the connection, when it has one (reconnecting/failed). */
  why: string | null;
  /** A second warn line when connected to a mismatched helper or build. */
  notice: string | null;
  action: "connect" | "retry" | null;
}
export function hostLine(name: string, state: HostConnection | null, app: { version: string; build: Build }, time: (at: number) => string): HostLine
```

Rules (all from existing helpers, so words match the sidebar and hover card):

- `dot` = `dotState(state.status)`; no store → `"idle"`. **Never fall back to "connected"** (today's `?? "connected"` lies).
- Connected: `text` = `Connected` + (`· apex-daemon ${helper}` when `helper` is a string), `tone: "plain"`, `action: null`, `notice` = `buildNotice(...) ?? helperNotice(...)`.
- Not connected: `text`/`action` from `reachNotice(name, status, seenAt, time)`; `tone` = its tone (`warn` → warn, `bad` → bad). `why` = `status.reason` for `reconnecting` and `failed`, else null.

Tests in `tests/host-facts.test.mjs`, same style as the file: one test per state (idle, connecting, resync, reconnecting with reason, failed with reason, connected with/without helper, connected with old helper), plus "no store is idle, not connected".

## Task 2 — rebuild `src/HostsSettings.tsx`

Layout, top to bottom (the header and lead stay as `SettingsPage` draws them):

1. `div.settings-actions`: `<button>+ Add host</button>` and `<span>Deck reaches other machines over SSH. It never asks for a password.</span>`. Disabled in demo (`backend.demo`).
2. `div.settings-card.hosts` with one `div.hosts-item` per host, This Mac first (list order already does this — check).
3. When there are no remote hosts, a final `div.hosts-empty`: **No other machines yet** / *Add a Linux server or another Mac that runs apex-daemon.* / `+ Add host` (small).

Each `hosts-item`:

```
[.hdot]  [.hosts-text                                   ]  [.hosts-buttons]
         .hosts-name       Apex-Terminal
         .hosts-addr       me@apex-terminal.xyz          (remote only; title = full command)
         .hosts-state      Connected · apex-daemon 0.7.0 (class warn/bad from tone)
         .hosts-why        raw reason, mono              (only when why)
         .hosts-state.warn notice                        (only when notice)
         .hosts-problem    remove refusal / other error  (only after a failed action, role="alert")
```

- This Mac: no address line. No buttons when connected; `Retry` if not.
- Remote: buttons are `[Connect | Retry]` (from `action`) + `Edit…` (only when `hosts.update` exists) + `Remove` (`ghost`). Use small buttons (`padding: 5px 10px; font-size: 12px`, see mockup).
- `Connect` and `Retry` do what Retry does today: `backend.machines?.get(host.id); store?.retryNow();`.
- Dot gets `role="img"` and `aria-label` with the same words the sidebar uses (`DOT_WORDS` in `Sidebar.tsx` — export it or move it to `hostFacts.ts` beside `DotState`; don't copy it).

Add host: `setDialog({ kind: "add" })` → `<ConnectionDialog mode={{ kind: "add" }} hosts={list} api={hosts} onClose onSaved={(next) => { setList(next); close(); }} />`. One dialog state handles both add and edit (`ConnectionMode | null`).

Remove: `setAsking({ title: \`Remove ${host.name}?\`, body: "Deck stops connecting to it. Nothing on that machine is deleted, and you can add it again later.", action: "Remove", onConfirm })`, rendered with the existing `ConfirmDialog`. On rejection, store `{ hostId, words }` and draw it as that host's `.hosts-problem`; clear it on the next action on any host.

Delete the inline `<form className="host-add">` and its state (`name`, `ssh`, `command`) entirely.

## Task 3 — Test connection when adding (`src/ConnectionDialog.tsx`)

Change `{!add && api.check && …}` to `{api.check && …}` for the Test connection button. `classifyIdentity(hosts, null, id)` already returns `known` or `new`, and `runTest` already has words for both. Check that "known" in add mode reads well (`me@x is Apex-Terminal, which Deck already has.`) — it does without the edit sentence.

## Task 4 — CSS (`src/styles.css`)

- Remove `.host-add` and `.host-add label` (lines ~264–265). **Keep `.host-actions`** — Paired devices uses it.
- Add the `.hosts-*` rules from the mockup's `<style>` (search "NEW: one host per line"), but use the real `.hdot` from styles.css (~line 3160) — add only `margin-top: 7px` for it inside `.hosts-item`.
- Do **not** use `.host-tag` / `.host-name`; the sidebar owns those names.
- Check the glass skin: `.settings-card` is restyled in `glass-theme.css` (~272–278); look at the page in Glass and one other skin.

## Checks before handing back

1. `npx tsc --noEmit` passes.
2. `TMPDIR=/tmp npm test` passes (TMPDIR avoids the 3 known socket-path failures inside Deck panes).
3. Run the dev build per AGENTS.md: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`. Screenshot Settings › Hosts with This Mac + one remote host, and the Add and Remove windows. Compare against the mockup side by side.
4. Try: add a host with a bad address → Test connection says it can't reach it; Remove a host that has projects → refusal shows on its line; Esc closes each window.
5. Don't install, merge or push. Commit on `design/hosts-settings` and tell Jigga the commit hash for review.

## Out of scope

- Moving or deleting threads when a host is removed (the daemon side refuses; keep that).
- Changing the dot colours or the sidebar's words.
- The `docs/daemon-ubuntu.md` mention in the Add window stays as text for now.
