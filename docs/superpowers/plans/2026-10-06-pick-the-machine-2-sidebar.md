# Pick the Machine — Stage 2: Codex-style Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Jigga implements inline in this checkout (the human asked for all stages without stopping); Null reviews the plan and the finished stage. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workspace rail with the v8 sidebar — Pinned, Projects and Recents, server names with connection dots and tinted globes, project and thread hover cards, Codex's ⋯/right-click menus with Copy ›, and an Edit connection… dialog that can never move a server's threads to a different machine.

**Architecture:** Pure modules decide everything that can be decided without a DOM (what each sidebar section lists, menu items and shortcuts, copy text, connection facts, identity classification); small React components draw them (`Sidebar`, `Menu`, `HoverCards`, `ConnectionDialog`). Electron's main process owns saved-host edits: it probes a candidate address with a hello-only link and commits against the latest saved state, so a slow probe can never overwrite a newer edit or save a duplicate name.

**Tech Stack:** React 19 / TypeScript, Electron 44, Node's test runner with `--experimental-strip-types`, Rust apex-daemon (one welcome field). No new dependencies.

**Spec:** [v8 mockup](../../mockups/pick-the-machine-v8.html), captions 1, 2, 3, 4, 13, 14 (Stage 2 rows of the acceptance matrix in [the Stage 1 plan](2026-10-06-pick-the-machine-1-multi-host.md)); Null's v8 review (names revalidated after the connection check; long server labels shortened with full-name tooltips; the ✓ of an offline destination stays visible — the last one is Stage 3's picker).

## Global Constraints

- Work only in `~/Downloads/apex-deck`, on `feat/pick-the-machine-stage-1` (Stage 2 builds on Stage 1's unmerged commits). No new checkout or `apex-deck-*` folder.
- `TMPDIR=/tmp npm test` for unit tests; stub the clipboard in every check — never write the real clipboard.
- No push, merge or installer unless the human asks. Leave the uncommitted `mockups/ios/` → `ios/` move and `docs/mockups/` out of commits.
- Every window is a This Mac window; a server's threads never change machine. Edit connection may change how Deck reaches a server, never which machine it is.
- No helper updater: show the out-of-date notice, never a Restart now button (decided in the Stage 1 handoff).
- Menus open where the mockup opens them; composer menus stay above the composer (unchanged in this stage).
- Keep today's Deck look: reuse `.pane-menu`, `.confirm`, `--panel-2`, `--line`, `--muted`, `--accent`; port the mockup's sidebar rules, not its demo scaffolding.
- Code section keeps terminals and previews under their projects; Recents is a Threads-only list.
- Left out on purpose (tell the human): Codex's “Open in new window” (needs coordinated multi-window sessions, deferred in Stage 1) and Project › (it opens Stage 3's New thread / Fork prompt, so it ships with Stage 3).

## Review Focus

1. **A server dropping while its project card or menu is open** — the card switches to “Can't reach …” with Retry; menu actions that need the server (none in Stage 2 except Edit connection's probe) report the failure instead of hanging.
2. **Two folders with one name on one machine** — both rows stay separate and each shows its path (`~/code/apex-deck`); a pin, archive or remove acts on exactly the row clicked.
3. **Edit connection races** — a rename to a taken name, a second edit, or a removal while a probe is pending must refuse at commit, and a probe that reaches another saved server or a new machine never saves the address.
4. **Copy when the clipboard is unavailable** — say nothing was copied; never claim success; tests stub `navigator.clipboard`.
5. **Archived or unread threads after a restart** — flags persist in the Mac session, archived threads stay out of Pinned/Projects/Recents and the badge, and restore puts them back closed in their own project.

Each line has a test in the task that owns it (Tasks 1, 1, 5, 3, 1 respectively), plus native smoke checks in Task 8.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/sidebarModel.ts` (new) | What Pinned / Projects / Recents / Archived list; project order; twin paths; host tints; ages; pane and project flag edits |
| `src/paneMenu.ts` | Thread, terminal and preview ⋯ items, now with shortcut labels, Mark as unread, Copy ›, Archive; project ⋯ items |
| `src/shortcuts.ts` | Thread shortcuts ⌥⌘R, ⌥⌘P, ⇧⌘U, ⇧⌘A; Apple modifier order in labels |
| `src/threadCopy.ts` (new) | Copy text (Markdown, last reply, folder path with server, thread ID) and the clipboard write that reports failure |
| `src/hostFacts.ts` (new) | Words for a host's dot, card notice and helper version; identity classification for the dialog |
| `src/hostConnections.ts`, `src/hostBackends.ts`, `src/daemon/client.ts`, `src/electronShell.ts` | Helper version and last-reached time per host; live renames; `hosts.check` / `hosts.update` |
| `crates/apex-daemon/src/protocol.rs` | Welcome reports `version` |
| `desktop/hostIdentity.mjs`, `desktop/main.mjs`, `desktop/preload.cjs` | Hello-only probe; atomic, race-checked host update |
| `src/Menu.tsx` (new) | Keyboard-driven menu list with shortcut labels, separators and a Copy › submenu |
| `src/HoverCards.tsx` (new) | Project and thread cards, hover timing, placement beside the rail |
| `src/Sidebar.tsx` (new) | The rail: sections, rows, host tags, row actions, context menus, Archived/Removed feet |
| `src/ConnectionDialog.tsx` (new) | Edit connection… / Add server dialog |
| `src/App.tsx`, `src/ChatPane.tsx`, `src/composerStatus.ts`, `src/HostsSettings.tsx`, `src/styles.css`, `src/types.ts`, `src/hostSession.ts` | Wiring, new pane/workspace fields, ThreadStatus additions, styles |
| `desktop/multi-host-smoke.mjs`, `desktop/run-multi-host-smoke.mjs` | Native checks for the sidebar, cards, menus, Copy (stubbed) and Edit connection (same / different machine) |

## Shared interfaces

```ts
// types.ts additions
interface Workspace { /* … */ pinned?: true; collapsed?: true }
interface Pane { /* … */ archived?: true; unread?: true; activeAt?: number }
interface ThreadStatus { /* … */ who?: string[]; hasReply?: boolean; lastAt?: number }

// sidebarModel.ts
export const RECENT_LIMIT = 5;
export interface ProjectBlock { workspace: Workspace; panes: Pane[] }
export interface SidebarSections { pinned: Pane[]; projects: ProjectBlock[]; recents: Pane[]; archived: Pane[] }
export function sidebarSections(panes: Pane[], workspaces: Workspace[], section: AppSection, deleting: ReadonlySet<string>): SidebarSections;
export function twinPath(workspace: Workspace, workspaces: Workspace[]): string;
export function homeShort(path: string): string;
export const HOST_TINTS: readonly string[];
export function hostTints(hostIds: string[]): Map<string, string>;
export function ageWords(ms: number): string;
export function archiveThreads(panes: Pane[], ids: string[]): Pane[];
export function unarchiveThreads(panes: Pane[], ids: string[]): Pane[];
export function setUnread(panes: Pane[], id: string, unread: boolean): Pane[];
export function noteActive(panes: Pane[], id: string, at: number): Pane[];
export function toggleProjectPin(list: Workspace[], id: string): Workspace[];
export function setCollapsed(list: Workspace[], id: string, collapsed: boolean): Workspace[];

// paneMenu.ts
export type PaneMenuAction = "rename" | "pin" | "mark_unread" | "share_pdf" | "copy" | "start" | "copy_path"
  | "copy_address" | "close" | "fork" | "export" | "archive" | "delete";
export interface PaneMenuItem { action: PaneMenuAction; label: string; disabled: boolean; reason: string;
  danger: boolean; separated: boolean; keys?: string; submenu?: boolean }
export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState, preview?: { address: string },
  options?: { pinned?: boolean; unread?: boolean; mac?: boolean }): PaneMenuItem[];
export type CopyKind = "markdown" | "reply" | "path" | "id";
export interface CopyItem { kind: CopyKind; label: string; side: string; disabled: boolean; reason: string }
export function copyMenuItems(context: { hasReply: boolean; path: string; id: string }): CopyItem[];
export type ProjectMenuAction = "pin" | "edit" | "connection" | "reveal" | "archive" | "remove";
export interface ProjectMenuItem { action: ProjectMenuAction; label: string; disabled: boolean; reason: string; danger: boolean; separated: boolean }
export function projectMenuItems(project: { pinned?: boolean; remote: boolean; path: string; threads: number }): ProjectMenuItem[];

// shortcuts.ts
// DeckAction adds { kind: "thread"; action: "rename" | "pin" | "mark_unread" | "archive" }
export function threadKeys(mac: boolean): Record<"rename" | "pin" | "mark_unread" | "archive", string>;

// threadCopy.ts
export function lastReply(transcript: Message[]): string;
export function folderCopyText(path: string, ssh?: string): string;
export const COPIED: Record<CopyKind, string>;
export async function writeClipboard(text: string, clipboard?: { writeText(text: string): Promise<void> }): Promise<boolean>;

// hostFacts.ts
export type DotState = "on" | "wait" | "off" | "idle";
export function dotState(status: HostConnection["status"]): DotState;
export function helperNotice(name: string, app: string, helper: string | null | undefined): string | null;
export function reachNotice(name: string, status: HostConnection["status"], seenAt: number | undefined,
  time: (at: number) => string): { tone: "warn" | "bad"; text: string; action: "retry" | "connect" | null } | null;
export type ProbeKind = "same" | "bind" | "different" | "known" | "new";
export function classifyIdentity(hosts: HostEntry[], hostId: string | null, daemonHostId: string): { kind: ProbeKind; name?: string };

// hostConnections.ts: HostConnection adds helper?: string | null; seenAt?: number;
//   store adds setHelper(version: string | null): void; rename(name: string): void
// backend.ts HostsApi adds
//   check?(fields: { ssh: string; command?: string }): Promise<{ daemonHostId: string; version: string | null }>;
//   update?(id: string, fields: { name: string; ssh: string; command?: string }): Promise<HostUpdateResult>;
// type HostUpdateResult = { ok: true; hosts: HostEntry[] }
//   | { ok: false; reason: "unreachable" | "different" | "known" | "changed" | "invalid"; words: string };

// desktop/hostIdentity.mjs additions
export function probeWelcome(open, options?: { timeoutMs?: number }): Promise<{ host_id: string; protocol: number; version?: string }>;
export function applyHostUpdate(state, hostId, fields, { before, probed }): state; // throws Error with .code
```

---

### Task 1: Sidebar model and persisted flags

**Files:** Create `src/sidebarModel.ts`, `tests/sidebar-model.test.mjs`; modify `src/types.ts`, `src/hostSession.ts` (normalizeWorkspaces keeps `pinned`/`collapsed`), `tests/host-session.test.mjs`.

**Interfaces:** Consumes `paneSection` (closing.ts) and `workspaceHost` (hostSession.ts). Produces every `sidebarModel.ts` export above.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sidebarSections, twinPath, homeShort, hostTints, HOST_TINTS, ageWords, archiveThreads, unarchiveThreads, setUnread, noteActive, toggleProjectPin, setCollapsed } from "../src/sidebarModel.ts";
import { normalizeWorkspaces } from "../src/hostSession.ts";

const ws = [
  { id: "deck", name: "apex-deck", path: "/Users/t/apex-deck" },
  { id: "deckAT", name: "apex-deck", path: "/home/l1/apex-deck", hostId: "at" },
  { id: "two", name: "apex-deck", path: "/home/l1/code/apex-deck", hostId: "at" },
  { id: "gone", name: "old", path: "/old", hidden: true },
];
const chat = (id, workspaceId, extra = {}) => ({ id, workspaceId, kind: "chat", title: id, ...extra });

test("Pinned, Projects and Recents list threads once each where Codex shows them", () => {
  const panes = [
    chat("a", "deck", { activeAt: 30 }), chat("b", "deckAT", { pinned: true, activeAt: 50 }),
    chat("c", "two", { archived: true, closed: true, activeAt: 90 }), chat("d", "gone", { activeAt: 99 }),
    { id: "t", workspaceId: "deck", kind: "terminal", title: "Codex" }, chat("e", "deck", { activeAt: 10 }),
  ];
  const s = sidebarSections(panes, ws, "threads", new Set(["e"]));
  assert.deepEqual(s.pinned.map((p) => p.id), ["b"]);
  assert.deepEqual(s.projects.map((b) => [b.workspace.id, b.panes.map((p) => p.id)]), [["deck", ["a"]], ["deckAT", []], ["two", []]]);
  assert.deepEqual(s.recents.map((p) => p.id), ["b", "a"]);
  assert.deepEqual(s.archived.map((p) => p.id), ["c"]);
  const code = sidebarSections(panes, ws, "code", new Set());
  assert.deepEqual(code.projects[0].panes.map((p) => p.id), ["t"]);
  assert.deepEqual(code.recents, []);
  assert.deepEqual(sidebarSections(panes, ws, "agents", new Set()).projects.map((b) => b.panes.length), [0, 0, 0]);
});

test("pinned projects lead the Projects list; the rest keep their order", () => {
  const list = toggleProjectPin(ws, "two");
  assert.deepEqual(sidebarSections([], list, "threads", new Set()).projects.map((b) => b.workspace.id), ["two", "deck", "deckAT"]);
  assert.equal(toggleProjectPin(list, "two").find((w) => w.id === "two").pinned, undefined);
});

test("Recents keeps the five most recently active threads and skips never-active ones", () => {
  const panes = Array.from({ length: 7 }, (_, i) => chat(`r${i}`, "deck", i === 6 ? {} : { activeAt: i }));
  assert.deepEqual(sidebarSections(panes, ws, "threads", new Set()).recents.map((p) => p.id), ["r5", "r4", "r3", "r2", "r1"]);
});

test("two folders with one name on one machine each show their path", () => {
  assert.equal(twinPath(ws[1], ws), "~/apex-deck");
  assert.equal(twinPath(ws[2], ws), "~/code/apex-deck");
  assert.equal(twinPath(ws[0], ws), "");
  assert.equal(homeShort("/root/apex-deck"), "~/apex-deck");
  assert.equal(homeShort("/Users/t/x"), "~/x");
  assert.equal(homeShort("/srv/api"), "/srv/api");
});

test("each server keeps a distinct tint, and earlier servers keep theirs when one is added", () => {
  const two = hostTints(["at", "hz"]);
  assert.notEqual(two.get("at"), two.get("hz"));
  const three = hostTints(["at", "hz", "lab"]);
  assert.equal(three.get("at"), two.get("at"));
  assert.equal(three.get("hz"), two.get("hz"));
  assert.ok(HOST_TINTS.includes(three.get("lab")));
});

test("ages read like Codex: now, minutes, hours, days, weeks", () => {
  assert.deepEqual([0, 59e3, 5 * 60e3, 3 * 3600e3, 2 * 86400e3, 15 * 86400e3].map(ageWords), ["now", "now", "5m", "3h", "2d", "2w"]);
});

test("archive closes threads and restore brings them back closed; unread and activity persist as fields", () => {
  const panes = [chat("a", "deck"), { id: "t", workspaceId: "deck", kind: "terminal", title: "T" }];
  const archived = archiveThreads(panes, ["a", "t"]);
  assert.deepEqual(archived[0], { ...panes[0], archived: true, closed: true });
  assert.equal(archived[1], panes[1]);
  assert.deepEqual(unarchiveThreads(archived, ["a"])[0], { ...panes[0], closed: true });
  assert.equal(setUnread(panes, "a", true)[0].unread, true);
  assert.equal("unread" in setUnread(setUnread(panes, "a", true), "a", false)[0], false);
  const active = noteActive(panes, "a", 100);
  assert.equal(active[0].activeAt, 100);
  assert.equal(noteActive(active, "a", 50), active);
  assert.equal(setCollapsed(ws, "deck", true)[0].collapsed, true);
  assert.equal("collapsed" in setCollapsed(setCollapsed(ws, "deck", true), "deck", false)[0], false);
});

test("saved project pins and collapsed state survive a restart", () => {
  const [w] = normalizeWorkspaces([{ id: "a", name: "A", path: "/a", pinned: true, collapsed: true, junk: 1 }]);
  assert.equal(w.pinned, true);
  assert.equal(w.collapsed, true);
  assert.equal("junk" in w, false);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `TMPDIR=/tmp node --experimental-strip-types --test tests/sidebar-model.test.mjs`
Expected: FAIL — `Cannot find module '../src/sidebarModel.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/sidebarModel.ts — what the sidebar lists. Plain functions, tested on their own.
import type { AppSection, Pane, Workspace } from "./types";
import { paneSection } from "./closing.ts";
import { workspaceHost } from "./hostSession.ts";

export const RECENT_LIMIT = 5;
export interface ProjectBlock { workspace: Workspace; panes: Pane[] }
export interface SidebarSections { pinned: Pane[]; projects: ProjectBlock[]; recents: Pane[]; archived: Pane[] }

const byActivity = (a: Pane, b: Pane) => (b.activeAt ?? 0) - (a.activeAt ?? 0);

export function sidebarSections(panes: Pane[], workspaces: Workspace[], section: AppSection, deleting: ReadonlySet<string>): SidebarSections {
  const shown = workspaces.filter((w) => !w.hidden);
  const listed = new Set(shown.map((w) => w.id));
  const live = panes.filter((p) => listed.has(p.workspaceId) && !deleting.has(p.id));
  const order = [...shown.filter((w) => w.pinned), ...shown.filter((w) => !w.pinned)];
  if (section === "agents") return { pinned: [], projects: order.map((workspace) => ({ workspace, panes: [] })), recents: [], archived: [] };
  const mine = live.filter((p) => paneSection(p) === section && !p.archived);
  const threads = live.filter((p) => p.kind === "chat");
  return {
    pinned: mine.filter((p) => p.pinned),
    projects: order.map((workspace) => ({ workspace, panes: mine.filter((p) => p.workspaceId === workspace.id && !p.pinned) })),
    recents: section === "threads" ? threads.filter((p) => !p.archived && (p.activeAt ?? 0) > 0).sort(byActivity).slice(0, RECENT_LIMIT) : [],
    archived: threads.filter((p) => p.archived).sort(byActivity),
  };
}

export function homeShort(path: string): string {
  return path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, "~");
}

/** The folder, when another listed project on the same machine has the same name. */
export function twinPath(workspace: Workspace, workspaces: Workspace[]): string {
  const host = workspaceHost(workspace);
  const twins = workspaces.filter((w) => !w.hidden && w.name === workspace.name && workspaceHost(w) === host);
  return twins.length > 1 ? homeShort(workspace.path) : "";
}

export const HOST_TINTS = ["#1ed7ee", "#a78bfa", "#f472b6", "#f2c14e", "#60a5fa", "#34d399", "#fb923c", "#e879f9"] as const;
const hash = (text: string) => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
/** In hosts-list order, each host takes its hashed colour, or the next free one. */
export function hostTints(hostIds: string[]): Map<string, string> {
  const used = new Set<string>(); const tints = new Map<string, string>();
  for (const id of hostIds) {
    const start = hash(id) % HOST_TINTS.length;
    let pick: string = HOST_TINTS[start];
    for (let i = 0; i < HOST_TINTS.length; i++) {
      const tint = HOST_TINTS[(start + i) % HOST_TINTS.length];
      if (!used.has(tint)) { pick = tint; break; }
    }
    used.add(pick); tints.set(id, pick);
  }
  return tints;
}

export function ageWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

const without = <T extends object, K extends keyof T>(value: T, key: K): T => { const { [key]: _drop, ...rest } = value; return rest as T; };
export function archiveThreads(panes: Pane[], ids: string[]): Pane[] {
  return panes.map((p) => (p.kind === "chat" && ids.includes(p.id) ? { ...p, archived: true, closed: true } : p));
}
export function unarchiveThreads(panes: Pane[], ids: string[]): Pane[] {
  return panes.map((p) => (ids.includes(p.id) && p.archived ? { ...without(p, "archived"), closed: true } : p));
}
export function setUnread(panes: Pane[], id: string, unread: boolean): Pane[] {
  return panes.map((p) => (p.id !== id || !!p.unread === unread ? p : unread ? { ...p, unread: true } : without(p, "unread")));
}
export function noteActive(panes: Pane[], id: string, at: number): Pane[] {
  return panes.some((p) => p.id === id && (p.activeAt ?? 0) < at) ? panes.map((p) => (p.id === id ? { ...p, activeAt: at } : p)) : panes;
}
export function toggleProjectPin(list: Workspace[], id: string): Workspace[] {
  return list.map((w) => (w.id !== id ? w : w.pinned ? without(w, "pinned") : { ...w, pinned: true }));
}
export function setCollapsed(list: Workspace[], id: string, collapsed: boolean): Workspace[] {
  return list.map((w) => (w.id !== id || !!w.collapsed === collapsed ? w : collapsed ? { ...w, collapsed: true } : without(w, "collapsed")));
}
```

In `src/types.ts` add `pinned?: true; collapsed?: true` to `Workspace` and `archived?: true; unread?: true; activeAt?: number` to `Pane`. In `normalizeWorkspaces` add `if (v.pinned === true) w.pinned = true; if (v.collapsed === true) w.collapsed = true;` (the casts inside stay as they are).

- [ ] **Step 4: Run to see it pass**

Run: `TMPDIR=/tmp node --experimental-strip-types --test tests/sidebar-model.test.mjs tests/host-session.test.mjs && node_modules/.bin/tsc --noEmit`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit** — `git add src/sidebarModel.ts tests/sidebar-model.test.mjs src/types.ts src/hostSession.ts && git commit -m "feat: sidebar model for pinned, projects, recents and archived threads"`

### Task 2: Menus and thread shortcuts

**Files:** Modify `src/paneMenu.ts`, `tests/pane-menu.test.mjs`, `src/shortcuts.ts`, `tests/shortcuts.test.mjs`.

**Interfaces:** Produces `paneMenuItems` (new chat list), `copyMenuItems`, `projectMenuItems`, `threadKeys`, the `thread` DeckAction.

- [ ] **Step 1: Write the failing tests** (replace the first test in `tests/pane-menu.test.mjs`; add the rest)

```js
import { paneMenuItems, copyMenuItems, projectMenuItems } from "../src/paneMenu.ts";
test("a thread's menu is Codex's, with Deck's Share as PDF, Copy ›, Fork, Export and Delete", () => {
  const items = paneMenuItems("chat", idle, { address: "" }, { mac: true });
  assert.deepEqual(summary(items), ["Rename", "Pin", "Mark as unread", "| Share as PDF", "Copy", "Fork", "Export", "| Archive", "Delete… (danger)"]);
  assert.deepEqual(items.map((i) => i.keys ?? ""), ["⌥⌘R", "⌥⌘P", "⇧⌘U", "", "", "", "", "⇧⌘A", ""]);
  assert.equal(items.find((i) => i.action === "copy").submenu, true);
  const marked = paneMenuItems("chat", idle, { address: "" }, { pinned: true, unread: true, mac: true });
  assert.equal(marked.find((i) => i.action === "pin").label, "Unpin");
  assert.equal(marked.find((i) => i.action === "mark_unread").label, "Mark as read");
  assert.equal(paneMenuItems("chat", idle).find((i) => i.action === "rename").keys, "Ctrl+Alt+Shift+R");
});
test("Copy › copies Markdown, the last reply, the folder with its server, and the thread ID", () => {
  const items = copyMenuItems({ hasReply: false, path: "root@hetzner-eu:/root/apex-deck", id: "pane-1" });
  assert.deepEqual(items.map((i) => [i.kind, i.label, i.side, i.disabled]), [
    ["markdown", "Copy as Markdown", "", false], ["reply", "Copy last reply", "", true],
    ["path", "Copy folder path", "root@hetzner-eu:/root/apex-deck", false], ["id", "Copy thread ID", "pane-1", false]]);
  assert.equal(items[1].reason, "No reply yet.");
  assert.equal(copyMenuItems({ hasReply: true, path: "", id: "x" })[2].disabled, true);
});
test("a project's menu: Pin, Edit…, then Edit connection… for a server or Reveal in Finder for the Mac", () => {
  const sum = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}`);
  assert.deepEqual(sum(projectMenuItems({ remote: true, path: "/root/x", threads: 2 })), ["Pin", "Edit…", "| Edit connection…", "| Archive threads", "| Remove project…"]);
  assert.deepEqual(sum(projectMenuItems({ remote: false, path: "", threads: 0, pinned: true })), ["Unpin", "Edit…", "| Reveal in Finder (off)", "| Archive threads (off)", "| Remove project…"]);
});
```

```js
// tests/shortcuts.test.mjs additions
test("thread shortcuts act on the focused thread", () => {
  const mac = (code, extra) => shortcutFor({ code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...extra }, true);
  assert.deepEqual(mac("KeyR", { altKey: true }), { kind: "thread", action: "rename" });
  assert.deepEqual(mac("KeyP", { altKey: true }), { kind: "thread", action: "pin" });
  assert.deepEqual(mac("KeyU", { shiftKey: true }), { kind: "thread", action: "mark_unread" });
  assert.deepEqual(mac("KeyA", { shiftKey: true }), { kind: "thread", action: "archive" });
  assert.equal(mac("KeyR", {}), null);
  assert.equal(mac("KeyT", { altKey: true }), null);
  assert.deepEqual(shortcutFor({ code: "KeyR", metaKey: false, ctrlKey: true, shiftKey: true, altKey: true }, false), { kind: "thread", action: "rename" });
});
```

Update the existing label assertion to Apple's modifier order: `keys: "⇧⌘↩"`.

- [ ] **Step 2: Run to see it fail** — `TMPDIR=/tmp node --experimental-strip-types --test tests/pane-menu.test.mjs tests/shortcuts.test.mjs` → FAIL (labels and exports missing).

- [ ] **Step 3: Implement**

```ts
// shortcuts.ts
| { kind: "thread"; action: "rename" | "pin" | "mark_unread" | "archive" }
// Binding gains macAlt?: boolean. New rows:
{ code: "KeyR", key: "R", label: "Rename thread", action: { kind: "thread", action: "rename" }, macAlt: true },
{ code: "KeyP", key: "P", label: "Pin or unpin thread", action: { kind: "thread", action: "pin" }, macAlt: true },
{ code: "KeyU", key: "U", label: "Mark thread unread", action: { kind: "thread", action: "mark_unread" }, macShift: true },
{ code: "KeyA", key: "A", label: "Archive thread", action: { kind: "thread", action: "archive" }, macShift: true },
export function shortcutFor(press: KeyPress, mac: boolean): DeckAction | null {
  const command = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && press.shiftKey && !press.metaKey;
  if (!command) return null;
  const binding = BINDINGS.find((b) => b.code === press.code);
  if (!binding || press.altKey !== !!binding.macAlt || (mac && press.shiftKey !== !!binding.macShift)) return null;
  return binding.action;
}
const label = (b: Binding, mac: boolean) => mac
  ? `${b.macAlt ? "⌥" : ""}${b.macShift ? "⇧" : ""}⌘${b.key}`
  : `Ctrl+${b.macAlt ? "Alt+" : ""}Shift+${b.key === "↩" ? "Enter" : b.key}`;
export function threadKeys(mac: boolean) { /* label() of the four thread bindings, keyed by action */ }
```

```ts
// paneMenu.ts — chat branch
const keys = threadKeys(options.mac ?? false);
return [
  item("rename", "Rename", { keys: keys.rename }),
  item("pin", options.pinned ? "Unpin" : "Pin", { keys: keys.pin }),
  item("mark_unread", options.unread ? "Mark as read" : "Mark as unread", { keys: keys.mark_unread }),
  item("share_pdf", "Share as PDF", { separated: true }),
  item("copy", "Copy", { submenu: true }),
  item("fork", "Fork"),
  item("export", "Export"),
  item("archive", "Archive", { separated: true, keys: keys.archive }),
  item("delete", "Delete…", { danger: true }),
];
export function copyMenuItems({ hasReply, path, id }: { hasReply: boolean; path: string; id: string }): CopyItem[] {
  return [
    { kind: "markdown", label: "Copy as Markdown", side: "", disabled: false, reason: "" },
    { kind: "reply", label: "Copy last reply", side: "", disabled: !hasReply, reason: hasReply ? "" : "No reply yet." },
    { kind: "path", label: "Copy folder path", side: path, disabled: !path, reason: path ? "" : "This project has no folder." },
    { kind: "id", label: "Copy thread ID", side: id, disabled: false, reason: "" },
  ];
}
export function projectMenuItems(p: { pinned?: boolean; remote: boolean; path: string; threads: number }): ProjectMenuItem[] {
  const row = (action: ProjectMenuAction, label: string, extra: Partial<ProjectMenuItem> = {}): ProjectMenuItem =>
    ({ action, label, disabled: false, reason: "", danger: false, separated: false, ...extra });
  return [
    row("pin", p.pinned ? "Unpin" : "Pin"),
    row("edit", "Edit…"),
    p.remote ? row("connection", "Edit connection…", { separated: true })
      : row("reveal", "Reveal in Finder", { separated: true, disabled: !p.path, reason: p.path ? "" : "This project has no folder." }),
    row("archive", "Archive threads", { separated: true, disabled: p.threads === 0, reason: p.threads ? "" : "No threads to archive." }),
    row("remove", "Remove project…", { separated: true, danger: true }),
  ];
}
```

- [ ] **Step 4: Run to see it pass** — same command plus `node_modules/.bin/tsc --noEmit` (App's head menu still compiles; the new actions are unhandled until Task 6 and fall through as no-ops).

- [ ] **Step 5: Commit** — `git commit -m "feat: Codex thread and project menus with shortcuts"` (the two source files and two tests).

### Task 3: Copy › text and a clipboard that admits failure

**Files:** Create `src/threadCopy.ts`, `tests/thread-copy.test.mjs`; modify `src/composerStatus.ts` (`threadStatusOf` adds `who`), `src/types.ts` (ThreadStatus), `src/ChatPane.tsx` (menu actions `copy_markdown`/`copy_reply`, `onCopy` prop, `hasReply`/`lastAt` in status), `tests/composer-status.test.mjs`.

**Interfaces:** Produces `lastReply`, `folderCopyText`, `COPIED`, `writeClipboard`; ChatPane prop `onCopy?: (text: string, kind: CopyKind) => void`; `menuRequest.action` adds `"copy_markdown" | "copy_reply"`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { lastReply, folderCopyText, writeClipboard, COPIED } from "../src/threadCopy.ts";
import { threadStatusOf } from "../src/composerStatus.ts";

const msg = (seq, speaker, text) => ({ seq, speaker, text });
test("the last reply is the newest bot message, not yours", () => {
  const t = [msg(1, { kind: "human" }, "hi"), msg(2, { kind: "bot", id: "a" }, "first"), msg(3, { kind: "bot", id: "b" }, "second"), msg(4, { kind: "human" }, "thanks")];
  assert.equal(lastReply(t), "second");
  assert.equal(lastReply([msg(1, { kind: "human" }, "hi")]), "");
});
test("a server folder copies with its SSH destination; a Mac folder copies as is", () => {
  assert.equal(folderCopyText("/root/apex-deck", "root@hetzner-eu"), "root@hetzner-eu:/root/apex-deck");
  assert.equal(folderCopyText("/Users/t/apex-deck"), "/Users/t/apex-deck");
  assert.equal(folderCopyText(""), "");
});
test("a clipboard that refuses, or none at all, means nothing was copied", async () => {
  const seen = [];
  assert.equal(await writeClipboard("x", { writeText: async (t) => { seen.push(t); } }), true);
  assert.deepEqual(seen, ["x"]);
  assert.equal(await writeClipboard("x", { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await writeClipboard("x", undefined), false);
  assert.equal(COPIED.markdown, "the thread as Markdown");
});
test("a thread's status names who is in it", () => {
  const s = threadStatusOf([{ id: "a", display_name: "Jigga" }, { id: "b", display_name: "Codex" }], [], []);
  assert.deepEqual(s.who, ["Jigga", "Codex"]);
});
```

- [ ] **Step 2: Run to see it fail** — `TMPDIR=/tmp node --experimental-strip-types --test tests/thread-copy.test.mjs tests/composer-status.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/threadCopy.ts — what Copy › puts on the clipboard.
import type { Message } from "./types";
import type { CopyKind } from "./paneMenu.ts";
export const COPIED: Record<CopyKind, string> = { markdown: "the thread as Markdown", reply: "the last reply", path: "the folder path", id: "the thread ID" };
export function lastReply(transcript: Message[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) if (transcript[i].speaker.kind === "bot") return transcript[i].text;
  return "";
}
export function folderCopyText(path: string, ssh?: string): string { return path && ssh ? `${ssh}:${path}` : path; }
/** True only when the clipboard took the text. Checks pass a stub; nothing here touches it otherwise. */
export async function writeClipboard(text: string, clipboard?: { writeText(text: string): Promise<void> }): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(text); return true; } catch { return false; }
}
```

`threadStatusOf` adds `who: bots.map((b) => b.display_name)`. In ChatPane's status add `hasReply` (any bot message in `messagesOf(entries)`) and `lastAt` (largest message `at`). In the menu-request effect add:

```ts
else if (menuRequest.action === "copy_markdown") onCopy?.(exportMarkdown(threadExport(), new Date()), "markdown");
else if (menuRequest.action === "copy_reply") onCopy?.(lastReply(messagesOf(entries)), "reply");
```

- [ ] **Step 4: Run to see it pass** — same command, then `TMPDIR=/tmp npm test` and tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: Copy › text, honest clipboard results and thread facts for the sidebar"`.

### Task 4: Helper version and connection facts

**Files:** Modify `crates/apex-daemon/src/protocol.rs` (welcome `version`; its two exact-JSON tests), `src/daemon/client.ts` (`Welcome.version?`, `helperVersion` getter), `tests/daemon-client.test.mjs`, `src/hostConnections.ts` (`helper`, `seenAt`, `setHelper`, `rename`), `src/electronShell.ts` (feed helper on connect), `tests/host-backends.test.mjs`; create `src/hostFacts.ts`, `tests/host-facts.test.mjs`.

**Interfaces:** Produces `dotState`, `helperNotice`, `reachNotice`, `classifyIdentity`; store fields above.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { dotState, helperNotice, reachNotice, classifyIdentity } from "../src/hostFacts.ts";
import { hostConnectionStore } from "../src/hostConnections.ts";

test("a server's dot: green connected, amber on its way, gray offline, hollow before first use", () => {
  assert.deepEqual([{ kind: "connected", hostId: "x" }, { kind: "connecting" }, { kind: "resync" }, { kind: "reconnecting", attempt: 1, reason: "", retryAt: 0 }, { kind: "failed", reason: "" }, { kind: "idle" }].map(dotState),
    ["on", "wait", "wait", "off", "off", "idle"]);
});
test("the card names an old helper without offering a restart", () => {
  assert.equal(helperNotice("AT", "0.5.1", "0.5.1"), null);
  assert.equal(helperNotice("AT", "0.5.1", undefined), null);
  assert.match(helperNotice("AT", "0.5.1", "0.5.0"), /AT runs apex-daemon 0\.5\.0; this app is 0\.5\.1/);
  assert.match(helperNotice("AT", "0.5.1", null), /older than this app \(0\.5\.1\)/);
  assert.doesNotMatch(helperNotice("AT", "0.5.1", null), /Restart/);
});
test("an unreachable server says when it was last reached, and offers Retry", () => {
  const time = () => "7:02 AM";
  assert.deepEqual(reachNotice("Staging", { kind: "failed", reason: "x" }, 1, time), { tone: "bad", text: "Can't reach Staging. Last reached at 7:02 AM.", action: "retry" });
  assert.deepEqual(reachNotice("Staging", { kind: "reconnecting", attempt: 2, reason: "x", retryAt: 0 }, undefined, time), { tone: "bad", text: "Can't reach Staging.", action: "retry" });
  assert.deepEqual(reachNotice("AT", { kind: "idle" }, undefined, time), { tone: "warn", text: "Not connected yet. Deck connects when one of its threads opens.", action: "connect" });
  assert.equal(reachNotice("AT", { kind: "connected", hostId: "d" }, 1, time), null);
});
test("a probed identity is the same machine, a new one, or one Deck already has", () => {
  const hosts = [{ id: "local", name: "This Mac", remote: false }, { id: "at", name: "AT", remote: true, daemonHostId: "d-at" }, { id: "hz", name: "HZ", remote: true }];
  assert.deepEqual(classifyIdentity(hosts, "at", "d-at"), { kind: "same" });
  assert.deepEqual(classifyIdentity(hosts, "at", "d-new"), { kind: "different" });
  assert.deepEqual(classifyIdentity(hosts, "hz", "d-new"), { kind: "bind" });
  assert.deepEqual(classifyIdentity(hosts, "hz", "d-at"), { kind: "known", name: "AT" });
  assert.deepEqual(classifyIdentity(hosts, null, "d-new"), { kind: "new" });
});
test("the store remembers the helper version and when the host was last reached", () => {
  const store = hostConnectionStore("at", "AT");
  store.setHelper("0.5.0");
  store.setStatus({ kind: "connected", hostId: "d" });
  assert.equal(store.get().helper, "0.5.0");
  assert.equal(typeof store.get().seenAt, "number");
  store.rename("Apex");
  assert.equal(store.get().name, "Apex");
});
```

In `tests/daemon-client.test.mjs`: a welcome with `version: "0.5.1"` sets `client.helperVersion` to `"0.5.1"`; a welcome without it gives `null`.

In Rust, update `protocol.rs`'s two `assert_eq!` welcome literals to include `"version": env!("CARGO_PKG_VERSION")`.

- [ ] **Step 2: Run to see it fail** — `TMPDIR=/tmp node --experimental-strip-types --test tests/host-facts.test.mjs tests/daemon-client.test.mjs` and `TMPDIR=/tmp cargo test -p apex-daemon protocol` → FAIL.

- [ ] **Step 3: Implement** — welcome gets `"version": env!("CARGO_PKG_VERSION")`; DaemonClient stores `typeof welcome.version === "string" ? welcome.version : null` in `welcomed()`; the store's `setStatus` stamps `seenAt: Date.now()` on `connected`; `setHelper`/`rename` replace the snapshot; electronShell's remote `onStatus` calls `state.setHelper(remoteClient.helperVersion)` before `state.setStatus(status)` when connected (the local store too). `hostFacts.ts`:

```ts
export function dotState(status: HostConnection["status"]): DotState {
  return status.kind === "connected" ? "on" : status.kind === "idle" ? "idle" : status.kind === "connecting" || status.kind === "resync" ? "wait" : "off";
}
export function helperNotice(name: string, app: string, helper: string | null | undefined): string | null {
  if (helper === undefined || helper === app) return null;
  return helper === null
    ? `Deck's helper on ${name} is older than this app (${app}). Update apex-daemon there to recover live approvals after a reconnect.`
    : `${name} runs apex-daemon ${helper}; this app is ${app}. Update it there (docs/daemon-ubuntu.md).`;
}
export function reachNotice(name, status, seenAt, time) {
  if (status.kind === "idle") return { tone: "warn", text: "Not connected yet. Deck connects when one of its threads opens.", action: "connect" };
  if (status.kind === "connecting") return { tone: "warn", text: `Connecting to ${name}…`, action: null };
  if (status.kind === "resync") return { tone: "warn", text: `Catching up with ${name}…`, action: null };
  if (status.kind === "reconnecting" || status.kind === "failed")
    return { tone: "bad", text: seenAt ? `Can't reach ${name}. Last reached at ${time(seenAt)}.` : `Can't reach ${name}.`, action: "retry" };
  return null;
}
export function classifyIdentity(hosts, hostId, daemonHostId) {
  const other = hosts.find((h) => h.id !== hostId && h.daemonHostId === daemonHostId);
  if (other) return { kind: "known", name: other.name };
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  if (!host) return { kind: "new" };
  return host.daemonHostId === daemonHostId ? { kind: "same" } : host.daemonHostId ? { kind: "different" } : { kind: "bind" };
}
```

- [ ] **Step 4: Run to see it pass** — the Step 2 commands, then `TMPDIR=/tmp npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat: report helper version and last-reached time per host"`.

### Task 5: Edit connection in the main process

**Files:** Modify `desktop/hostIdentity.mjs`, `tests/desktop-host-identity.test.mjs`, `desktop/main.mjs` (`connection:check`, `connection:update`), `desktop/preload.cjs`, `src/backend.ts` (HostsApi), `src/electronShell.ts` (wrap `update`), `src/hostBackends.ts` (`setHosts` renames live stores; `host.name` read live), `tests/host-backends.test.mjs`.

**Interfaces:** Produces `probeWelcome`, `applyHostUpdate`, the IPC channels and `HostsApi.check/update` above.

- [ ] **Step 1: Write the failing tests**

```js
import { probeWelcome, applyHostUpdate } from "../desktop/hostIdentity.mjs";
const state = () => ({ version: 1, hosts: [
  { id: "at", name: "AT", ssh: "l1@apex-terminal", command: "apex-daemon", daemonHostId: "d-at" },
  { id: "hz", name: "HZ", ssh: "root@hz", command: "/root/.cargo/bin/apex-daemon", daemonHostId: "d-hz" }] });
const before = (s, id) => { const h = s.hosts.find((x) => x.id === id); return { name: h.name, ssh: h.ssh, command: h.command }; };

test("a probe says hello only, returns the welcome and always closes", async () => {
  const sent = []; let closed = false;
  const welcome = await probeWelcome(async ({ onLine }) => ({
    send(line) { sent.push(JSON.parse(line)); onLine(JSON.stringify({ id: 0, ok: { host_id: "d-at", protocol: 1, version: "0.5.1" } })); },
    close() { closed = true; },
  }));
  assert.deepEqual(sent.map((f) => f.cmd), ["hello"]);
  assert.equal(welcome.host_id, "d-at");
  assert.equal(closed, true);
  await assert.rejects(probeWelcome(async ({ onClose }) => ({ send() { onClose("Permission denied (publickey)."); }, close() {} })), /Permission denied/);
  await assert.rejects(probeWelcome(async () => ({ send() {}, close() {} }), { timeoutMs: 20 }), /timed out/);
});
test("a new address saves only when it reaches the same machine", () => {
  const s = state();
  const next = applyHostUpdate(s, "at", { name: "AT", ssh: "l1@203.0.113.24", command: "apex-daemon" }, { before: before(s, "at"), probed: { host_id: "d-at" } });
  assert.equal(next.hosts[0].ssh, "l1@203.0.113.24");
  assert.equal(next.hosts[0].daemonHostId, "d-at");
  assert.throws(() => applyHostUpdate(s, "at", { name: "AT", ssh: "l1@other", command: "apex-daemon" }, { before: before(s, "at"), probed: { host_id: "d-new" } }), (e) => e.code === "different");
  assert.throws(() => applyHostUpdate(s, "at", { name: "AT", ssh: "root@hz", command: "apex-daemon" }, { before: before(s, "at"), probed: { host_id: "d-hz" } }), (e) => e.code === "known" && /HZ/.test(e.message));
});
test("Save keeps the daemon command, and a rename needs no probe", () => {
  const s = state();
  const next = applyHostUpdate(s, "hz", { name: "Hetzner-EU", ssh: "root@hz", command: "/root/.cargo/bin/apex-daemon" }, { before: before(s, "hz"), probed: null });
  assert.equal(next.hosts[1].command, "/root/.cargo/bin/apex-daemon");
  assert.equal(next.hosts[1].name, "Hetzner-EU");
  assert.throws(() => applyHostUpdate(s, "hz", { name: "HZ", ssh: "root@new", command: "apex-daemon" }, { before: before(s, "hz"), probed: null }), (e) => e.code === "unreachable");
});
test("a commit after a slow probe re-checks names, removal and concurrent edits", () => {
  const s = state(); const was = before(s, "at");
  const renamed = { ...s, hosts: s.hosts.map((h) => (h.id === "hz" ? { ...h, name: "Apex" } : h)) };
  assert.throws(() => applyHostUpdate(renamed, "at", { name: "Apex", ssh: "l1@203.0.113.24", command: "apex-daemon" }, { before: was, probed: { host_id: "d-at" } }), (e) => e.code === "invalid" && /already a host called Apex/.test(e.message));
  const removed = { ...s, hosts: s.hosts.filter((h) => h.id !== "at") };
  assert.throws(() => applyHostUpdate(removed, "at", { name: "AT", ssh: "l1@x", command: "apex-daemon" }, { before: was, probed: { host_id: "d-at" } }), (e) => e.code === "changed");
  const edited = { ...s, hosts: s.hosts.map((h) => (h.id === "at" ? { ...h, ssh: "l1@elsewhere" } : h)) };
  assert.throws(() => applyHostUpdate(edited, "at", { name: "AT", ssh: "l1@x", command: "apex-daemon" }, { before: was, probed: { host_id: "d-at" } }), (e) => e.code === "changed");
});
```

`tests/host-backends.test.mjs`: after `setHosts([{ id: "at", name: "Renamed", remote: true }])`, `registry.get("at").host.name` and `registry.connection("at").get().name` are `"Renamed"`.

- [ ] **Step 2: Run to see it fail** — `TMPDIR=/tmp node --experimental-strip-types --test tests/desktop-host-identity.test.mjs tests/host-backends.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

```js
// desktop/hostIdentity.mjs
import { validHost } from './hosts.mjs';
const failure = (code, message) => Object.assign(new Error(message), { code });
/** Hello only: nothing else is sent, and the link is always closed. */
export async function probeWelcome(open, { timeoutMs = 20000 } = {}) {
  let link; let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The connection timed out.')), timeoutMs);
      Promise.resolve(open({
        onLine: (line) => { let f; try { f = JSON.parse(line); } catch { return; }
          if (f.id !== 0) return; if (f.err) reject(new Error(f.err)); else resolve(f.ok); },
        onClose: (reason) => reject(new Error(reason || 'The connection closed.')),
      })).then((opened) => { link = opened; link.send(JSON.stringify({ id: 0, cmd: 'hello', args: { protocol: 1 } })); }, reject);
    });
  } finally { clearTimeout(timer); link?.close(); }
}
/** Commit an edit against the latest saved hosts, after any probe. */
export function applyHostUpdate(state, hostId, fields, { before, probed }) {
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host || host.name !== before.name || host.ssh !== before.ssh || host.command !== before.command)
    throw failure('changed', 'This server changed or was removed while Deck was checking it. Try again.');
  let valid;
  try { valid = validHost(fields, state.hosts.filter((h) => h.id !== hostId).map((h) => h.name)); }
  catch (e) { throw failure('invalid', e.message); }
  const moved = valid.ssh !== host.ssh || valid.command !== host.command;
  let daemonHostId = host.daemonHostId;
  if (moved) {
    if (!probed) throw failure('unreachable', 'Nothing is saved until Deck can check that it is the same machine.');
    checkWelcome(undefined, { protocol: 1, ...probed });
    const other = state.hosts.find((h) => h.id !== hostId && h.daemonHostId === probed.host_id);
    if (other) throw failure('known', `${valid.ssh} is ${other.name}, which Deck already has. ${host.name} keeps its own address.`);
    if (host.daemonHostId && host.daemonHostId !== probed.host_id)
      throw failure('different', `${valid.ssh} is a different machine: its apex-daemon reports another host ID. This address isn't saved.`);
    daemonHostId = probed.host_id;
  }
  return { ...state, hosts: state.hosts.map((h) => (h.id === hostId ? { ...h, ...valid, ...(daemonHostId ? { daemonHostId } : {}) } : h)) };
}
```

```js
// desktop/main.mjs
const probe = ({ ssh, command }) => probeWelcome((handlers) => sshLink({ ssh, command }, handlers));
handle('connection:check', async (_entry, fields) => {
  const valid = validHost({ name: 'check', ...fields }, []);
  const welcome = await probe(valid);
  return { daemonHostId: checkWelcome(undefined, { protocol: 1, ...welcome }), version: typeof welcome.version === 'string' ? welcome.version : null };
});
handle('connection:update', async (_entry, id, fields) => {
  const host = remoteHost(id);
  if (!host) return { ok: false, reason: 'changed', words: 'There is no such server.' };
  const before = { name: host.name, ssh: host.ssh, command: host.command };
  let valid;
  try { valid = validHost(fields ?? {}, hosts.hosts.filter((h) => h.id !== id).map((h) => h.name)); }
  catch (e) { return { ok: false, reason: 'invalid', words: e.message }; }
  let probed = null;
  if (valid.ssh !== host.ssh || valid.command !== host.command) {
    try { probed = await probe(valid); }
    catch (e) { return { ok: false, reason: 'unreachable', words: `Couldn't reach ${valid.ssh}: ${e.message} Nothing is saved until Deck can check that it is the same machine.` }; }
  }
  try {
    const next = applyHostUpdate(hosts, id, fields, { before, probed }); // reads the latest `hosts`
    saveHosts(hostsFile(), next); hosts = next; Menu.setApplicationMenu(menu());
    return { ok: true, hosts: hostList() };
  } catch (e) { return { ok: false, reason: e.code ?? 'invalid', words: e.message }; }
});
```

Preload exposes `check` and `update`; `HostsApi` gains them; electronShell wraps `update` so a successful result calls `machines.setHosts(result.hosts)`. In `createHostBackends`, `setHosts` also calls `rename(name)` on existing stores, and the proxy's `host` getter reads `known.get(hostId)?.name`.

- [ ] **Step 4: Run to see it pass** — Step 2 command, `TMPDIR=/tmp npm test`, tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: edit a server's connection without ever retargeting its threads"`.

### Task 6: The sidebar, menus and hover cards

**Files:** Create `src/Menu.tsx`, `src/HoverCards.tsx`, `src/Sidebar.tsx`; modify `src/App.tsx`, `src/styles.css`.

**Interfaces:** Consumes Tasks 1–5. Produces `<Sidebar>` (props are App callbacks, listed below) and `<MenuList>`.

- [ ] **Step 1: Write the failing native checks** in `desktop/multi-host-smoke.mjs`, right after “automatic remote import”:

```js
await until('codex sidebar',()=>page('return [...document.querySelectorAll(".rail-sec")].map(s=>s.dataset.sec).join()==="pinned,projects,recents"'));
assert.equal(await page('return document.querySelector(".ws-row[data-host-id=at] .host-name").textContent'),'Production-Frankfurt-Primary-01');
assert.equal(await page('return document.querySelector(".ws-row[data-host-id=at] .host-name").title'),'Production-Frankfurt-Primary-01');
assert.ok(await page('return Boolean(document.querySelector(".ws-row[data-host-id=at] .fold-globe"))'));
assert.ok(await page('return Boolean(document.querySelector("[data-sec=pinned] ~ .pane-row .globe-end, .pane-row.flat .globe-end"))'));
await page('document.querySelector(".ws-row[data-host-id=at] .ws-name").dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));return true;');
await until('project card',()=>page('return document.querySelector(".hover-card")?.innerText.includes(".")'));
assert.match(await page('return document.querySelector(".hover-card").innerText'),/Production-Frankfurt-Primary-01 · 1 thread/);
```

The thread ⋯ menu shows the nine items in order, Copy › opens a submenu, and right-click on a row opens the same menu at the pointer.

- [ ] **Step 2: Run to see it fail** — `npm run desktop:smoke:multi-host` → FAIL `timed out: codex sidebar`.

- [ ] **Step 3: Implement**

`MenuList` (Menu.tsx) draws `PaneMenuItem`/`ProjectMenuItem`-shaped rows with `role="menuitem"`, `.keys` labels, separators and an optional submenu (opened by click, hover, Enter or →; closed by ← or Escape), arrow-key focus moves and focus return to the opener — the same contract as App's `onMenuKey` today.

`HoverCards.tsx`: `useHoverCard()` opens after 450 ms over a row, stays while the pointer is over the card, closes 150 ms after leaving both, and never shows while a menu is open. Cards are `position: fixed` beside the rail (clamped to the window) with class `hover-card`:

- Project card: folder (with tinted globe for a server), name, Pin action; “This Mac · N threads” or tinted globe “<server> · N threads”; the reach notice with Retry/Connect (`machines.connection(id).retryNow()` / `machines.get(id)`); the helper notice; the full path in mono.
- Thread card: full title; the server's tinted globe and `ageWords(now - activeAt)`; project · machine (· twin path); “Threads · Jigga, Codex” from `ThreadStatus.who`.

`Sidebar.tsx` renders, for Threads/Code: `.rail-sec[data-sec=pinned]` (only when non-empty), `.rail-sec[data-sec=projects]` with the WorkspaceHostMenu `+`, each project (`.ws-row[data-host-id]`, `.fold` icon with `.fold-globe` tinted for servers, `.ws-label` and twin path, `.host-tag` = `.host-name` (max 14ch, full name tooltip) + `.hdot.on|.wait|.off|.idle`, hover `.row-acts`: ⋯ and “New thread in …”), its rows or “No threads”, then `.rail-sec[data-sec=recents]` (Threads only), then feet: “Archived (n) · Show” and today's “Removed (n) · Show”. Rows keep today's dot, rename, program title and flags; flat rows (Pinned/Recents) of server threads end with a tinted globe; rows add `.unread`, `.on-canvas`, hover `.row-acts` (⋯, pin) and a title marquee (`--shift` measured on hover). Clicking a project toggles `collapsed`; in Agents it opens the project as today. Right-click on any row opens its menu at the pointer.

App keeps state and actions; the rail block moves into `<Sidebar>`. App handles: thread actions `mark_unread` (`setUnread`), `archive` (`archiveThreads` + take off the canvas + Undo toast), `copy` kinds (`path`/`id` in App; `markdown`/`reply` through `menuRequest` without opening a closed thread), the thread shortcuts (focused chat only), project actions (pin, edit → inline rename, connection → dialog, reveal, archive threads + Undo, remove → always asks), clearing `unread` on `focusPane` and pane `mouseDown`, `noteActive` from `ThreadStatus.lastAt`, `hosts` state from `backend.hosts.list()` refreshed after edits, attention/badge skipping archived threads. A general `toasts` list replaces the two hard-coded toasts (keeps their Undo buttons). The pane head ⋯ for threads uses the same items through `MenuList`.

Port the mockup's sidebar CSS (`.rail-sec`, `.host-tag`, `.hdot`, `.row-acts`, `.act`, `.fold`, `.fold-globe`, `.globe-end`, `.no-threads`, `.hover-card` (= the mockup's `.card`), `.card-row`, `.pane-menu .keys`, `.pane-menu .sub`, marquee), with `.hdot.wait` amber and `.hdot.idle` hollow.

- [ ] **Step 4: Run to see it pass** — `TMPDIR=/tmp npm test`, `npm run build`, `npm run desktop:smoke`, `npm run desktop:smoke:multi-host`.
- [ ] **Step 5: Commit** — `git commit -m "feat: Codex-style sidebar with host dots, hover cards and thread menus"`.

### Task 7: Edit connection… dialog

**Files:** Create `src/ConnectionDialog.tsx`; modify `src/App.tsx` (project menu → dialog), `src/HostsSettings.tsx` (Edit… per server), `src/styles.css`.

**Interfaces:** `<ConnectionDialog mode={{ kind: "edit"; host: HostEntry } | { kind: "add"; fill?: Partial<HostEntry> }} hosts={HostsApi} list={HostEntry[]} onDone(list, words) onCancel()>`.

- [ ] **Step 1: Write the failing native checks** (multi-host smoke; the fixture `ssh` shim attaches to the Mac daemon when the destination is `other-fixture`, so it is a different machine):

```js
await openProjectMenu('at'); await clickItem('Edit connection…');
assert.equal(await page('return document.querySelector(".connection-dialog [data-field=command]").value'), BIN);
await setField('ssh','fixture-alias'); await click('[data-act=test]');
await until('same machine',()=>page('return document.querySelector(".connection-dialog .conn-test.ok")?.textContent.includes("same machine")'));
await setField('ssh','other-fixture'); await click('[data-act=save]');
await until('different machine refused',()=>page('return Boolean(document.querySelector(".connection-dialog [data-act=instead]"))'));
assert.equal(JSON.parse(fs.readFileSync(hostsFile,'utf8')).hosts[0].ssh,'fixture');
await setField('ssh','fixture-alias'); await setField('name','This Mac'); assert.ok(await page('return document.querySelector(".connection-dialog [data-act=save]").disabled'));
await setField('name','Frankfurt'); await click('[data-act=save]');
await until('saved',()=>JSON.parse(fs.readFileSync(hostsFile,'utf8')).hosts[0].ssh==='fixture-alias');
```

- [ ] **Step 2: Run to see it fail** — `npm run desktop:smoke:multi-host` → FAIL (no dialog).

- [ ] **Step 3: Implement** — the mockup's `connView`: title “Edit connection · <name>” / “Add a server”; the lead sentence; Name (live “Another server is already called …” against the current list, re-checked by main at Save), SSH destination, Daemon command, the `ssh … --stdio --attach` preview line; when the address or command changed and nothing was tested, the lock note “Save checks that this still reaches the same machine. A different machine can be added as a new server instead, so no thread moves.”; Test connection → `hosts.check` → `classifyIdentity` words (same / bind / different / known / unreachable); Save → `hosts.update` (`different` swaps the primary button to “Add as a new server”, which reopens the dialog in add mode with the address and command filled in; `known`/`unreachable`/`changed`/`invalid` show their words). After a successful edit of a server that is not connected, call its `retryNow()`. Settings → Hosts rows gain “Edit…”, opening the same dialog.

- [ ] **Step 4: Run to see it pass** — `TMPDIR=/tmp npm test`, `npm run build`, `npm run desktop:smoke:multi-host`.
- [ ] **Step 5: Commit** — `git commit -m "feat: Edit connection dialog from the project menu and Settings"`.

### Task 8: Stage verification

**Files:** Modify `desktop/multi-host-smoke.mjs`, `desktop/run-multi-host-smoke.mjs`, `README.md` (sidebar section), this plan's checkboxes.

- [ ] **Step 1: Native checks** for the rest of the Review Focus: Copy as Markdown / folder path with a stubbed `navigator.clipboard` (and a refusing stub showing “nothing was copied”); Mark as unread persists across a reload and clears on click; Archive removes the thread from Pinned/Projects/Recents and the badge, and Archived › Show restores it closed; the project card turns to “Can't reach …” with Retry while the fixture is offline; two same-named projects on the fixture server show their paths; screenshots of the sidebar, both cards, both menus and the dialog in `.superpowers/smoke/multi-host*/`.
- [ ] **Step 2: Final gates**

```sh
TMPDIR=/tmp npm test
npm run build
TMPDIR=/tmp cargo test --workspace
TMPDIR=/tmp npm run test:e2e
npm run desktop:smoke
npm run desktop:smoke:multi-host
APEX_DECK_SMOKE_OLD_HELPER=1 npm run desktop:smoke:multi-host
git diff --check
```

Expected: every command exits 0.
- [ ] **Step 3: Review and commit** — hand the diff, results and screenshots to Null; fix blocking findings test-first; `git commit -m "test: verify the Codex sidebar natively"`.

## Stage 2 completion contract

- [ ] Captions 1, 2, 3, 4, 13 and 14 behave as in v8, except the deliberately omitted Open in new window, Restart now and (Stage 3) Project ›.
- [ ] A server's threads cannot be moved by Edit connection; names are validated at commit.
- [ ] Copy never claims success it didn't have, and checks never touch the real clipboard.
- [ ] Unit, Rust, e2e, both native smokes, build and diff checks pass.
- [ ] Null has reviewed the stage.

## Plan self-review

- Spec coverage: caption 1 → Tasks 1, 6; caption 2 → Tasks 4, 6; caption 3 → Tasks 2, 6, 7; caption 4 → Tasks 5, 7; caption 13 → Tasks 1, 3, 6; caption 14 → Tasks 2, 3, 6. Null's v8 notes → Task 5 (names at commit) and Task 6 (14ch labels with tooltips).
- Placeholders: none; UI tasks are specified by their DOM contract and native checks rather than full JSX, because their behavior is pinned by the smoke assertions.
- Types: `CopyKind`, `ProjectMenuAction`, `HostUpdateResult`, `DotState` and the store fields are used with the same names in every task.

## Execution record (Jigga, October 6)

Built inline on `feat/pick-the-machine-stage-1` after `5c770b4`, test-first, without the plan-review pause (the human asked for all stages without stopping); Null reviews the plan and the finished stage together.

Rulings made while building:
- Shortcut labels use Apple's modifier order everywhere (⇧⌘↩, ⌥⌘R, ⇧⌘U).
- Thread shortcuts are not forwarded from a docked browser page: a page lives in a Preview pane, never a thread.
- The component is `ProjectSidebar`; `src/sidebars.ts` already exports a `Sidebar` type.
- Remove project… always asks (`removeProjectQuestion`); other removals still ask only while something runs.
- Copy and Export hold finished messages only; a reply still streaming is not part of the copy. The native check waits for the finished reply.
- `main`'s `connection:check` / `connection:update` handlers are covered by the native smoke; their rules live in the unit-tested `probeWelcome` / `applyHostUpdate`.
- Left out on purpose: Open in new window (needs coordinated multi-window sessions) and the Restart now button (no updater). Project › ships with Stage 3's New thread / Fork prompt.

Verification:
- `TMPDIR=/tmp npm test`: 560 passed.
- `npm run build`, `TMPDIR=/tmp cargo test --workspace` (408 passed), `TMPDIR=/tmp npm run test:e2e` (4 passed), `git diff --check`: all exit 0.
- `npm run desktop:smoke` and `npm run desktop:smoke:multi-host` (current helper, three consecutive passes, and `APEX_DECK_SMOKE_OLD_HELPER=1`): exit 0. New native checks: sections, server name and dot, tinted globes, project and thread cards, offline card with Retry, nine-item thread menu with shortcuts, Copy › with a stand-in clipboard (Markdown, folder with server, last reply, refused copy), project menu, Edit connection (same machine saves; a different machine is refused and offered as a new server; a taken name blocks Save), Mark as unread across a reload, Archive and restore, two same-named folders on one server.
- Screenshots: `.superpowers/smoke/multi-host/sidebar-*.png`, `edit-connection-*.png`.
