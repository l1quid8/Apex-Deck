# Pick the Machine — Stage 1: Multi-host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Null implements in this checkout; Jigga reviews the plan and the completed stage. Steps use checkbox syntax for tracking.

**Goal:** Run a Mac thread and an Apex-Terminal thread beside each other in one Deck window, with independent connections, correct command destinations, and no delayed sending after a disconnect.

**Architecture:** The Mac owns the app session, project list, profiles, preferences, mods, and canvas. Each workspace identifies its execution host; a stable backend and one lazy daemon client per host supply its rooms, terminals, files, and artifacts. Electron routes bytes by window, host, and connection generation, while the renderer recovers only the affected host.

**Tech Stack:** Existing React 19 / TypeScript, Electron, Node's test runner with type stripping, and the Rust apex-core / apex-host / apex-daemon workspace. No new runtime dependencies.

**Spec:** [Approved v8 mockup](../../mockups/pick-the-machine-v8.html), especially captions 4, 8, 12, 15–18; Jigga's Stage 1 handoff in the group chat on October 6, 2026. The acceptance matrix below assigns all 18 captions to stages.

## Global Constraints

- Work only in `~/Downloads/apex-deck`. Do not create another checkout or an `apex-deck-*` directory.
- Use `TMPDIR=/tmp npm test`. Clipboard checks use a stub.
- No push or installer unless the human asks.
- Preserve the existing uncommitted `mockups/ios/` → `ios/` move and `docs/mockups/` artifacts. Stage only this plan and files belonging to this implementation.
- Keep today's Deck styling and sidebar for this stage. Remove HostSwitcher only after the replacement path works.
- Every window is a This Mac window. Never switch a whole window's execution host.
- Missing `Workspace.hostId` means `local` / This Mac. `family` links copies of a project and defaults to the folder basename, not its editable display name.
- A started thread's workspace, host, and working directory do not change. A same-host fork continues to work. Cross-host forks belong to Stage 3.
- Servers are selected in Work in in Stage 3; this is the human's decision. Do not remove that choice.
- A server's old session is read once for migration. Its settings, profiles, layout, and active selection do not replace the Mac's.
- Never write a server's `session.json` or app preferences from this UI.
- Menus above the composer stay above it. Do not redesign the composer in Stage 1.
- A disconnected host rejects new sends. Nothing is automatically queued or replayed when it reconnects.
- Approval cards and the attention menu name the exact host and cannot answer a disconnected host's request.
- Quit confirmation lists only work that quitting the Mac-owned daemon would end.
- Do not build a server updater. Keep room_state optional: use its live state when supported, otherwise use the room_create snapshot without locking Send; Stage 2 may display version information, but no fake Restart now button.

## Review Focus

1. An SSH drop with an approval open: retain the host label, disable all answer surfaces, recover live requests, and never approve an expired request or one on another host.
2. Two copies of one project on one server: retain separate workspace IDs and exact paths; family membership never selects the first matching folder implicitly.
3. Attachments and future cross-host forks: upload Mac drops to the selected host; do not interpret a server attachment path on the Mac or promise cross-host forking before byte transfer exists.
4. Removing or editing a server with saved/open threads: retain their destination; refuse removal while referenced and refuse a changed daemon identity.
5. ID clashes and interrupted migration: remap conflicting workspace IDs and skip conflicting pane IDs without attaching remote threads to a local workspace; persist imported records and the migration marker together.

## Current evidence and scope

- Base: `86dedbf` on `main`. Read this again before implementing because other chat participants may be working.
- Baseline on October 6: `TMPDIR=/tmp npm test` passes 491/491; `node_modules/.bin/tsc --noEmit` exits 0.
- `desktop/main.mjs` has one link per webContents and selects its host from the window. `src/electronShell.ts` builds one backend and calls `location.reload()` on resync.
- `src/hub.ts` starts once globally and indexes handlers by room/PTY ID alone. `src/plans.ts` merges plan usage across a provider without distinguishing accounts on different machines.
- `src/App.tsx` filters the canvas by active workspace and uses the same backend for every pane, forks, deletes, and attention-menu answers.
- `src/closing.ts` rejects the empty workspace part of `:threads` / `:code`. Shared canvas and migration must therefore ship in Stage 1, not be deferred.
- Rust session documents preserve unknown fields. Workspace metadata needs no schema rewrite in Rust.
- Welcome's `host_id` identifies the daemon data folder, not a cryptographic identity of a physical machine. A rebuilt or copied data folder is not automatically a safe retarget.
- Current room snapshots do not contain live approval proposals or active participants. Recovery requires a small read-only runtime-state command; remounting ChatPane would otherwise close rooms and discard drafts.

Stage 1 has one primary Deck window at launch. Removing host-specific windows must not replace them with several unsynchronized writers of the same Mac session. Keep the existing ordinary activation behavior; do not add a generic New Window feature in this stage. The link registry remains window-scoped so it is ready for a future coordinated multi-window session.

### v8 acceptance matrix

| Caption | Behavior | Stage |
| --- | --- | --- |
| 1 | Pinned / Projects / Recents, tinted globes, dots | 2; Stage 1 shows server names in the existing workspace rail |
| 2 | Project hover card, path, helper version | 2; helper updater excluded |
| 3 | Project context menu | 2 |
| 4 | Preserve daemon command; verify address edits against saved identity | 2 API, race tests and project-menu editor; 1 binds identity on connect |
| 5 | + New uses last focused project; composer toolbar | 1 focus semantics; 3 toolbar |
| 6 | Searchable project picker and creation actions | 3 |
| 7 | Work in lists every exact folder, Add server | 3; 1 supplies stable host/workspace APIs |
| 8 | Host-specific folder picker, separate-copy explanation | 1 picker routing; 3 Work in entry point |
| 9 | Draft survives a destination choice | 3 destination choices; 1 preserves drafts during connection recovery |
| 10 | Recent Files, search and uploads | 3 recent-files UI; 1 upload routing |
| 11 | Tools of the selected host's participants | 1 backend routing; 3 toolbar |
| 12 | Exact host on approvals; started destination fixed | 1 |
| 13 | Thread hover card | 2 |
| 14 | Thread menu, Copy submenu | 2; existing PDF / Fork / Export / Delete must keep working in 1 |
| 15 | New thread / Fork prompt instead of relocation | 3; 1 offers no relocation action |
| 16 | Fork preserves history and waits for Send | 1 existing same-host fork; 3 cross-host import |
| 17 | Only the disconnected server pauses; Retry is independent | 1 |
| 18 | Mixed projects/hosts beside each other; bounded header labels | 1 canvas and basic labels; 3 final toolbar/header refinement |

## File boundaries and shared interfaces

Create focused, non-React modules where behavior needs unit tests. Do not extract unrelated App logic.

| File | Responsibility |
| --- | --- |
| `src/hostSession.ts` | Workspace host/family normalization; one-time remote-session merge; shared-layout migration |
| `desktop/hostLinks.mjs` | Byte links scoped by window, host, and generation; teardown |
| `desktop/hostIdentity.mjs` | Inspect hello replies, bind identities, probe candidate SSH settings |
| `src/hostConnections.ts` | Stable host connection snapshots, retry, recovery revision and per-host discovery |
| `src/hostBackends.ts` | Stable lazy backend registry; separation of Mac app methods from host operations |
| `src/eventHub.ts` | Testable per-host event subscriptions and handler dispatch; injected app hooks |
| `src/paneHost.ts` | Pure lookup of a pane's fixed workspace/host; no fallback for missing references |
| `src/hostAvailability.ts` | Mutation gates used by Send, approval answers, terminal input and queues |
| `desktop/multi-host-smoke.mjs` | Real Electron UI regression run using isolated daemon data |

The implementation exports these contracts; later tasks consume exactly these names:

```ts
// types.ts
interface Workspace {
  id: string; name: string; path: string; hidden?: boolean;
  hostId?: string; family?: string;
}
// AppSession: add these optional fields, retain version: 1.
// importedHostSessions?: string[]  (saved HostEntry IDs, never boot IDs)
// canvasVersion?: 1

// hostSession.ts
export declare function workspaceHost(workspace: Workspace): string;
export declare function workspaceFamily(workspace: Workspace): string;
export declare function normalizeWorkspaces(value: unknown): Workspace[];
export declare function mergeHostSession(local: AppSession, hostId: string, remote: unknown):
  { session: AppSession; conflicts: string[] };
export declare function migrateCanvasLayouts(session: AppSession): AppSession;

// paneHost.ts
export declare function paneDestination(pane: Pane, workspaces: readonly Workspace[]):
  { workspace: Workspace; hostId: string };

// hostConnections.ts
interface HostConnection {
  hostId: string; name: string;
  status: Status | { kind: "idle" };
  revision: number;
  agents: AgentInfo[];
  discovery: "idle" | "loading" | "ready" | "failed";
}
interface HostConnectionStore {
  get(): HostConnection;
  subscribe(listener: () => void): () => void;
  retryNow(): void;
}

// backend.ts additions
// Backend.host?: { id: string; name: string; connection: HostConnectionStore }
// Backend.machines?: HostBackends  (root backend only)
interface HostBackends {
  get(hostId?: string): Backend; // missing means local, stable object, lazy connect
  connection(hostId?: string): HostConnectionStore;
  discover(hostId?: string): Promise<AgentInfo[]>;
  legacySession(hostId: string): Promise<unknown>; // remote read only, explicit
  dispose(hostId: string): void;
}

// eventHub.ts / hub.ts
export declare function startHub(backend: Backend, hostId?: string): Promise<() => void>;
export declare function registerRoom(id: string, handler: (event: RoomEvent) => void,
  hostId?: string): () => void;
export declare function registerPty(id: string, handlers: PtyHandlers, hostId?: string): () => void;

// backend.ts / types.ts: read-only recovery, never starts participants
interface RoomState {
  snapshot: RoomSnapshot;
  active: string[];
  approvals: { id: string; request: string; action: ProposedAction }[];
}
// Backend.roomState(id: string): Promise<RoomState>
// DaemonClient.finishResync(): void

// typedPath.ts: add hostId: string to PathRequest;
// pathPrompt.startAt(hostId: string): string | null
// hostAvailability.ts
export declare function hostCanMutate(status: HostConnection["status"]): boolean;
```

Saved host IDs (such as `h-abc`) and daemon welcome IDs are distinct. Use `HostEntry.daemonHostId?: string` for the persisted welcome identity. Do not write that identity into Workspace.hostId.

## Execution procedure

Null works inline using TDD. After Jigga's plan review, create `feat/pick-the-machine-stage-1` in this same checkout if that branch does not exist; do not use a worktree. Record the base commit and task status in this plan's ignored execution ledger under `.superpowers/`; do not touch another plan's ledger. Each checkpoint stages only the named implementation files, and each test must be observed failing before production changes.

### Task 1: Host-aware session migration and shared layouts

**Files:** Create `src/hostSession.ts`, `src/paneHost.ts`, `tests/host-session.test.mjs`, `tests/pane-host.test.mjs`; modify `src/types.ts`, `src/workspaces.ts`, `src/closing.ts`, `tests/workspaces.test.mjs`, `tests/closing.test.mjs`.

**Consumes:** Existing AppSession, Workspace, Pane, loadedPanes and layout tree functions.

**Produces:** The hostSession/paneHost contracts above. `addFolders(..., hostId = "local", family?)` deduplicates by host ID plus exact nonempty path. `savedLayouts` / `restoredLayouts` accept both legacy workspace keys and shared section keys during migration.

- [ ] **Step 1 — Write failing migration and identity tests.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHost, mergeHostSession, migrateCanvasLayouts } from '../src/hostSession.ts';
const base = () => ({
  version: 1, workspaces: [{ id: 'mac', name: 'Deck', path: '/code/deck' }],
  panes: [{ id: 'm', workspaceId: 'mac', kind: 'chat', title: 'Mac' }],
  profiles: [], activeWorkspace: 'mac', focusedPane: 'm',
  section: 'threads', layout: 'left',
  layouts: { 'mac:threads': { kind: 'leaf', id: 'm' } },
});
test('import is host-tagged, closed, idempotent, and keeps Mac selection', () => {
  const remote = {
    ...base(), workspaces: [{ id: 'vps', name: 'Deck', path: '/srv/deck' }],
    panes: [{ id: 'r', workspaceId: 'vps', kind: 'chat', title: 'Server', pinned: true }],
  };
  const first = mergeHostSession(base(), 'h-at', remote).session;
  assert.equal(workspaceHost(first.workspaces[0]), 'local');
  assert.equal(workspaceHost(first.workspaces[1]), 'h-at');
  assert.equal(first.workspaces[1].family, 'deck');
  assert.equal(first.panes[1].closed, true);
  assert.equal(first.panes[1].pinned, true);
  assert.equal(first.focusedPane, 'm');
  assert.deepEqual(mergeHostSession(first, 'h-at', remote).session, first);
});
test('shared canvas migration keeps open panes from both projects', () => {
  const session = base();
  session.workspaces.push({ id: 'other', name: 'API', path: '/code/api', hostId: 'h-at' });
  session.panes.push({ id: 'r', workspaceId: 'other', kind: 'chat', title: 'Server' });
  session.layouts['other:threads'] = { kind: 'leaf', id: 'r' };
  const migrated = migrateCanvasLayouts(session);
  assert.equal(migrated.canvasVersion, 1);
  assert.ok(migrated.layouts[':threads']);
  assert.deepEqual(migrateCanvasLayouts(migrated), migrated);
});
```

Also add tests for: same path on two hosts remains distinct; two paths with the same basename on one host remain distinct; renamed workspaces keep family; missing host references throw instead of using local; malformed remote data leaves the import marker unset; null remote session marks a successful empty import; workspace-ID conflicts allocate a new workspace ID and remap its threads; pane-ID conflicts skip the pane; importing terminal descriptors never starts a terminal; remote profiles/settings/layout/active selection never replace local values; shared keys round-trip; closed panes/hidden workspaces do not enter the visible tree.

- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/host-session.test.mjs tests/pane-host.test.mjs tests/workspaces.test.mjs tests/closing.test.mjs`.
  Expected: new behavior fails; existing behavior remains intelligible.
- [ ] **Step 3 — Implement normalization and atomic merge.**

```ts
export function workspaceHost(workspace: Workspace): string {
  return workspace.hostId ?? "local";
}
export function workspaceFamily(workspace: Workspace): string {
  return workspace.family ?? (workspace.path.replace(/\/+$/, "").split("/").pop() || workspace.name);
}
// addFolders lookup:
const existing = path ? next.find(w =>
  w.path === path && workspaceHost(w) === hostId) : undefined;
```

Merge through a pure function. Import only workspaces and supported descriptors, tag every imported workspace with the saved host ID, close imported chats, and preserve pins. Remap colliding workspace IDs to fresh local IDs; skip globally duplicated pane IDs (room identities); never connect a remote pane to a preexisting workspace merely because its ID matches. Report conflicts by ID. Append `importedHostSessions` in the same session result as the records. Do not mark an unreadable/failed server session as imported.

For layout migration, retain the focused workspace's valid tree first and insert the other open panes deterministically with existing layout helpers. Produce `:threads` and `:code`, set canvasVersion, retain legacy layout values only until a verified save. Empty-workspace keys must pass savedLayouts/restoredLayouts; legacy keys remain readable for old sessions.
- [ ] **Step 4 — Run GREEN** with Step 2's command and `node_modules/.bin/tsc --noEmit`. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Stage the files named in this task and commit `feat: add host-aware session and canvas migration`.

### Task 2: Multiplex Electron links and bind daemon identities

**Files:** Create `desktop/hostLinks.mjs`, `desktop/hostIdentity.mjs`, `tests/desktop-host-links.test.mjs`, `tests/desktop-host-identity.test.mjs`; modify `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/hosts.mjs`, `tests/desktop-hosts.test.mjs`, `src/electronShell.ts`, `tests/electron-shell.test.mjs`.

**Consumes:** Saved HostEntry IDs, validHost, socketLink / sshLink, protocol-1 hello.

**Produces:** `daemon.connect(hostId)`, `send(hostId, gen, line)`, `close(hostId, gen)`; incoming events `(hostId, gen, payload)`. Listener methods return unsubscribe functions. `createHostLinks({ open, emit })` exposes `connect(windowId, hostId)`, `send(windowId, hostId, gen, line)`, `close(windowId, hostId, gen)`, `destroy(windowId)`. `open(hostId, handlers)` returns a link; `emit(windowId, hostId, gen, channel, value)` forwards it.

- [ ] **Step 1 — Write failing multiplex tests.**

```js
import { createHostLinks } from '../desktop/hostLinks.mjs';
test('reconnecting one host leaves other hosts and windows untouched', async () => {
  const links = []; const events = [];
  const pool = createHostLinks({
    open: async (hostId, handlers) => {
      const link = { hostId, handlers, sent: [], closed: false,
        send(line) { this.sent.push(line); },
        close() { this.closed = true; } };
      links.push(link); return link;
    },
    emit: (...args) => events.push(args),
  });
  const m = await pool.connect(1, 'local');
  const r = await pool.connect(1, 'h-at');
  await pool.connect(2, 'h-at');
  await pool.connect(1, 'h-at');
  assert.equal(links[0].closed, false);
  assert.equal(links[1].closed, true);
  assert.equal(links[2].closed, false);
  pool.send(1, 'h-at', r, 'stale');
  pool.send(1, 'local', m, 'local call');
  assert.deepEqual(links[1].sent, []);
  assert.deepEqual(links[0].sent, ['local call']);
  pool.destroy(1);
  assert.equal(links[2].closed, false);
});
```

Test late socket completion after replacement/destruction, early close before connect resolves, same generation number on two hosts, cleanup on window destruction/reload, unknown host IDs, non-Deck frames, and all incoming bridge listeners unsubscribing.

For identity, expose `checkWelcome(expectedId, welcome): string` (returns validated identity; rejects empty ID/protocol mismatch/changed ID). Tests must observe that no ordinary command is forwarded before the main process has inspected that link's hello. Add tests for first bind/save failure, identity change on reconnect, duplicate saved daemon identity, invalid hello/protocol, first-bind persistence failure and reconnect mismatch. Candidate edit/probe and race tests belong to Stage 2.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/desktop-host-links.test.mjs tests/desktop-host-identity.test.mjs tests/desktop-hosts.test.mjs tests/electron-shell.test.mjs`.
  Expected: multiplex and binding tests fail before implementation.
- [ ] **Step 3 — Implement scoped links and first-connect identity binding.**

```js
// Every webContents owns a Map of host IDs, each with its own generation.
const windows = new Map();
// Bridge listeners must match BOTH dimensions, including early closes:
if (incomingHostId === hostId && current?.gen === gen) current.line?.(line);
```

Keep the UI-origin checks. Closing/replacing one link cannot increment another host's generation. Main observes the actual hello exchange and persists daemonHostId before making its accepted welcome visible. Never trust a renderer-supplied physical identity. Suppress old-generation close/events, including closures caused by replacement.

Defer connection.check/update, candidate probes, daemon-command editing and async name/revision race tests to Stage 2 beside Edit connection. Stage 1 only binds the first welcome and refuses changed or duplicate identities on later connects.

Add optional daemonHostId to saved-host types without discarding older metadata. Reject duplicate saved host IDs when reading hosts.json. Old unbound hosts bind at first successful hello; a bound host never silently rebinds.

When another saved host already has the same daemonHostId, report that the machine is already saved and offer the existing entry; do not create a second alias with independent room ownership. Test two aliases reaching the same daemon and a duplicate identity found during concurrent connects.
- [ ] **Step 4 — Run GREEN** with Step 2's command and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit only this task's files as `feat: multiplex daemon links and verify host identity`.

### Task 3: Stable per-host backends and connection stores

**Files:** Create `src/hostConnections.ts`, `src/hostBackends.ts`, `tests/host-backends.test.mjs`; modify `src/backend.ts`, `src/electronShell.ts`, `src/connection.ts`, `tests/connection.test.mjs`, `tests/electron-shell.test.mjs`.

**Consumes:** Task 2 host-tagged bridge and Task 1 host IDs.

**Produces:** HostBackends, HostConnectionStore and Backend.host/machines above. Root getBackend resolves after the local daemon is ready; no remote connection is awaited by startup. Registry get returns immediately and always returns the same object for that host.

- [ ] **Step 1 — Write failing registry and ownership tests.** Export `createHostBackends({ local, hosts, make })`, with `make(host)` returning `{ backend, connection, start, close }`; inject it in unit tests rather than importing Electron.

```js
import { createHostBackends } from '../src/hostBackends.ts';
test('a remote operation uses its host while app saves use the Mac', async () => {
  const seen = [];
  const local = {
    sessionSave: async value => seen.push(['local-session', value]),
    settingsSave: async value => seen.push(['local-settings', value]),
  };
  const registry = createHostBackends({
    local, hosts: [{ id: 'h-at', name: 'Apex-Terminal', remote: true }],
    make: host => ({
      backend: {
        roomPost: async (id, text) => seen.push([host.id, id, text]),
        sessionLoad: async () => ({ legacy: true }),
      },
      connection: { get: () => ({ status: { kind: 'connected' } }) },
      start: async () => {}, close: () => {},
    }),
  });
  const remote = registry.get('h-at');
  assert.equal(remote, registry.get('h-at'));
  await remote.roomPost('r', 'hello');
  await remote.sessionSave({ version: 1 });
  await remote.settingsSave({ version: 1 });
  assert.deepEqual(seen.map(row => row[0]), ['h-at', 'local-session', 'local-settings']);
  assert.deepEqual(await registry.legacySession('h-at'), { legacy: true });
  assert.throws(() => registry.get('missing'), /host/i);
});
```

Add tests for lazy single startup, registry alone starts no remote clients; launch imports then start saved hosts in the background, independent retries/status, permanent first-connect refusal returning a failed status instead of freezing the app, unknown/deleted host refusing operations, discovery unavailable on one host without replacing another host's agents, remote dataFolder/artifacts/attachments using the server, exports/badge/mod commands using the Mac, and disposing only one host.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/host-backends.test.mjs tests/connection.test.mjs tests/electron-shell.test.mjs`.
  Expected: registry/ownership tests fail.
- [ ] **Step 3 — Implement lazy stable backends.**

```ts
// Explicit app-wide methods forwarded to local, even on a remote pane backend:
const appMethods = [
  "sessionLoad", "sessionSave", "settingsLoad", "settingsSave",
  "decisionKeySave", "flagAttention", "requestCriticalAttention",
  "onQuitRequested", "quitHeard", "quitApp",
] as const;
```

Build each host's commandBackend from its own transport and shell. Override the explicit appMethods and expose the same local browser API; root mod invocation stays local. File/folder operations, env checks, models and tool-server discovery are host-specific. Do not spread a whole local backend over a remote backend: that would overwrite room methods. Only legacySession may call a remote session_load directly. Reject remote session_save/settings_save/decision_key_save through the raw renderer call path as well, so mods cannot bypass ownership.

Use immutable connection snapshots with per-host listeners and retries. Preserve statusWords as a pure function, replace the singleton store's consumers incrementally, and set an idle state for unrequested hosts. Do not call location.reload for remote or local resync. Surface first-connect failure and allow a later retry; do not await DaemonClient.start forever in a component.

Discovery uses the corresponding backend and remains unknown/loading until it succeeds. A server missing Codex must not inherit the Mac's installed flag. App preferences stay on the Mac; do not broadcast observer/API keys or synchronize login credentials to servers. Existing server daemon configuration is not erased by migration.
- [ ] **Step 4 — Run GREEN** with Step 2's command and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit `feat: add lazy per-host backend registry`.

### Task 4: Host-scoped events, approval routing, and account usage

**Files:** Create `src/eventHub.ts`, `tests/event-hub.test.mjs`; modify `src/hub.ts`, `src/ChatPane.tsx`, `src/TerminalPane.tsx`, `src/plans.ts`, `tests/plans.test.mjs`, `src/approvals.ts`, `tests/approvals.test.mjs`.

**Consumes:** Task 3 stable backends. Task 1 globally unique imported pane IDs.

**Produces:** Per-host hub contracts above; `recordPlan(provider, windows, partial, hostId = "local")` and `usePlans(hostId = "local")`. OpenCard adds optional hostId for compatibility.

- [ ] **Step 1 — Write failing dispatch tests.** `createEventHub(hooks)` takes callbacks `approval(hostId, room, event)`, `plan(hostId, event)`, `roomEvent(hostId, room, event)`, `toolCall(hostId, room, event)`. It has start/register/stop methods matching the public hub signatures.

```js
import { createEventHub } from '../src/eventHub.ts';
test('identical room IDs on two hosts do not cross-deliver', async () => {
  const callbacks = new Map(); const heard = [];
  const backend = hostId => ({
    onPtyData: async () => () => {}, onPtyExit: async () => () => {},
    onRoomEvent: async cb => { callbacks.set(hostId, cb); return () => callbacks.delete(hostId); },
    roomDecide: async (...args) => heard.push([hostId, 'decide', ...args]),
  });
  const hub = createEventHub({});
  await hub.start(backend('local'), 'local');
  await hub.start(backend('h-at'), 'h-at');
  hub.registerRoom('r', event => heard.push(['local', event.type]), 'local');
  hub.registerRoom('r', event => heard.push(['h-at', event.type]), 'h-at');
  callbacks.get('h-at')('r', { type: 'idle' });
  assert.deepEqual(heard, [['h-at', 'idle']]);
});
```

Test start twice on one host subscribes only once; different hosts subscribe independently; cleanup and partial subscription failure unwind listeners; PTY IDs cannot cross-deliver; mod denial calls the source host's backend; an unregistered conflicting room event cannot alter a different pane's global approval state; plans from separate machines do not merge; attention-menu answers use OpenCard.hostId and refuse unknown bindings.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/event-hub.test.mjs tests/plans.test.mjs tests/approvals.test.mjs`.
  Expected: host isolation tests fail.
- [ ] **Step 3 — Implement source-host dispatch.**

```ts
const handlerKey = (hostId: string, id: string) => JSON.stringify([hostId, id]);
// startHub stores one subscription promise per host, cleans up on failure,
// and uses the source backend for every automatic denial.
// Every pane registers with backend.host?.id ?? "local".
```

The outer hub supplies React/mod/approval hooks; eventHub stays DOM-free and injectable for tests. Public defaults preserve browser demo behavior. Annotate source host before recording approval state. App-wide approvals may retain pane-ID indexing because imports enforce unique IDs, but must check the host binding before publishing an event or answering it. Keep source host in cards so an expired/deleted pane cannot accidentally resolve another server's request.

Namespace plan usage by host plus provider, including timers and stable snapshots. ChatPane reads its host's plans; profiles remain shared on the Mac. This avoids treating two different signed-in Claude accounts as one quota.
- [ ] **Step 4 — Run GREEN** with Step 2's command and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit `feat: scope event hubs and provider usage by host`.

### Task 5: Read-only room recovery without closing sessions

**Files:** Modify `crates/apex-host/src/host.rs`, `crates/apex-host/src/command.rs`, `crates/apex-host/tests/host.rs`, `src/backend.ts`, `src/commandBackend.ts`, `src/types.ts`, `src/daemon/client.ts`, `tests/command-backend.test.mjs`, `tests/daemon-client.test.mjs`, `src/ChatPane.tsx`, `src/hostConnections.ts`; create `src/roomRecovery.ts`, `tests/room-recovery.test.mjs`.

**Consumes:** Per-host connection revisions, current checkpoint snapshots and runtime room events.

**Produces:** `room_state { id }` → RoomState when supported; `Backend.roomState(id)` is optional/compatibility-aware; `DaemonClient.finishResync()` sets connected only after host recovery. `createRoomRecovery({ load, apply, fail })` exposes `refresh(): Promise<void>` and `dispose()`; each refresh generation discards older responses.

- [ ] **Step 1 — Write failing Rust and renderer recovery tests.**

```js
import { createRoomRecovery } from '../src/roomRecovery.ts';
test('late snapshot cannot overwrite newer recovery', async () => {
  const waiting = []; const applied = [];
  const recovery = createRoomRecovery({
    load: () => new Promise(resolve => waiting.push(resolve)),
    apply: state => applied.push(state),
    fail: error => { throw error; },
  });
  const first = recovery.refresh();
  const second = recovery.refresh();
  waiting[1]({ snapshot: { transcript: ['new'] }, active: [], approvals: [] });
  await second;
  waiting[0]({ snapshot: { transcript: ['old'] }, active: [], approvals: [] });
  await first;
  assert.deepEqual(applied.map(state => state.snapshot.transcript), [['new']]);
});
```

In Rust, create a host with a deterministic participant blocked on approval, then call `host.call(json!({"cmd":"room_state","args":{"id":"r"}}))` while its turn is running. Assert it returns promptly with the checkpoint transcript, active participant and exact pending request/action; resolving/withdrawing removes the request. Restarting a daemon restores the saved transcript but has no active participants or old requests. Test that reading state never runs a participant, unknown rooms return an error, and concurrent event/state races converge.

In renderer tests, cover replay success requiring no reset; resync affecting only one host; a disposed/closed pane ignoring late responses; failed reload leaving mutation disabled; current drafts, attachments, quotes and local notices surviving; old approval state replaced from runtime state; snapshot + buffered event reconciliation by message seq and request ID without duplication.
- [ ] **Step 2 — Run RED.**
  `cargo test -p apex-host room_state`
  `TMPDIR=/tmp node --experimental-strip-types --test tests/room-recovery.test.mjs tests/daemon-client.test.mjs tests/command-backend.test.mjs`
  Expected: room_state and recovery assertions fail before production changes.
- [ ] **Step 3 — Implement live state and scoped recovery.**

```rust
// command.rs enum and dispatch:
RoomState { id: String },
// RoomState { id } => reply(self.room_state(id)?),
```

Store a small runtime event state beside each RoomHandle: active participant IDs and pending proposals with their full action. Update it at the common room-event path before publishing events; remove requests on resolution, withdrawal, idle, participant failure/stop and deletion. Read checkpoint and runtime state without acquiring the room mutex held by a running model. Do not persist live requests across boots. Rust serialization produces the RoomState shape above.

Register event listeners before initial roomCreate/recovery. Capture events arriving during a state request and apply them after the returned snapshot, deduplicating seq/request IDs. Extract the snapshot-application path from ChatPane's mount effect so retry does not execute the cleanup that calls roomClose. Preserve input state and only replace server-derived transcript/participants/options/pins/usage/live state.

After a connection resumes with a lost event history, increment only that host's revision, reload its mounted chats/artifacts and discovery, and acknowledge resync when they finish. A failing pane remains visibly unavailable. Do not restart terminals on resync; mark their run unavailable/stopped with an explicit Start action because their missed output cannot be reconstructed. Ordinary successful replay must not interrupt a surviving terminal.

Treat the first successful host connection as revision 1. ChatPane registers handlers on mount but waits for that revision before roomCreate; subsequent recovery does not call roomClose or remount. Probe room_state when available and fall back only on an unsupported-command response to room_create's snapshot. Existing Apex-Terminal helpers must remain usable without deploying/restarting a daemon. Ordinary SSH reconnect uses replay and retains live state. A lost-history resync with an old helper refreshes the transcript from room_create, clears stale live approvals and explains that live approval recovery needs a newer helper; it must not falsely lock every server thread. Provide compatible demo behavior.

- [ ] **Step 4 — Run GREEN** with Step 2's commands and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit `feat: recover host rooms without reloading the canvas`.

### Task 6: Wire pane destinations and the shared canvas

**Files:** Modify `src/App.tsx`, `src/ChatPane.tsx`, `src/TerminalPane.tsx`, `src/PreviewPane.tsx`, `src/closing.ts`, `src/attention.ts`; create `src/canvasPanes.ts`, `tests/canvas-panes.test.mjs`; extend `tests/pane-host.test.mjs`, `tests/closing.test.mjs`.

**Consumes:** Task 1 session migration and paneDestination, Task 3 registry, Task 5 recovery.

**Produces:** `canvasPanes(panes, workspaces, deleting, section): Pane[]` and source-host routing for all pane actions. Canvas layouts are keyed only by section, using `:threads` / `:code`; activeWorkspace becomes the default project for new work.

- [ ] **Step 1 — Write failing mixed-canvas tests.**

```js
import { canvasPanes } from '../src/canvasPanes.ts';
test('open chats from two projects stay visible together', () => {
  const workspaces = [
    { id: 'm', name: 'Deck', path: '/code/deck' },
    { id: 'r', name: 'API', path: '/srv/api', hostId: 'h-at' },
  ];
  const panes = [
    { id: 'a', workspaceId: 'm', kind: 'chat', title: 'Mac' },
    { id: 'b', workspaceId: 'r', kind: 'chat', title: 'Server' },
    { id: 'c', workspaceId: 'm', kind: 'chat', title: 'Closed', closed: true },
  ];
  assert.deepEqual(canvasPanes(panes, workspaces, new Set(), 'threads').map(p => p.id), ['a', 'b']);
});
```

Test workspace click/focus preserves other open panes; hidden/removed/deleting panes stay out; focus and + New use the last clicked pane's workspace; previews inherit their source workspace/host; rearrange/maximize/close do not change destination; same-host fork/export/delete/undo use the source backend; quitting ignores remote busy panes; missing host retains an unavailable pane instead of using local.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/canvas-panes.test.mjs tests/pane-host.test.mjs tests/closing.test.mjs`.
  Expected: mixed canvas and local-only quit assertions fail.
- [ ] **Step 3 — Route panes and actions before changing presentation.**

```ts
const destination = paneDestination(pane, workspaces);
const paneBackend = backend.machines
  ? backend.machines.get(destination.hostId)
  : destination.hostId === "local" ? backend : null;
// null renders an unavailable pane; it never falls back to the Mac.
// ChatPane/TerminalPane/PreviewPane receive paneBackend.
// forkThread uses the SOURCE pane's backend, not the focused pane's backend.
// attention onDecide resolves by card.hostId and validates room membership.
const key = layoutKey(null, section);
```

Use a single session restore path that normalizes workspaces and migrates layouts before state is exposed. Import legacy sessions asynchronously only after that local restore, serializing merges through the latest app state and save queue. Remote imports must not overwrite user changes made while they load; do not persist the import marker separately. Unreachable hosts do not block launch and remain eligible for migration on a later successful use. Automatically attempt each saved host's one-time legacy-session import in the background at launch, after Mac restore. Offline failures leave the marker unset and retry at the next launch. Closed imported chats stay mounted and open their rooms just as server windows do today; no zero-remote-startups claim applies to App launch. Read remote observer settings during import and warn if enabled; Settings labels its observer control “This Mac’s threads”.

Keep existing mounted pane instances and stable backend objects. Use per-host discovered agents in pane menus, terminal startup and bot forms; the Agents/profile section remains Mac-owned. Route workspace reveal, diff/artifacts/attachment reads, thread controls, PDF export snapshots, deletion and undo to the target pane's backend, even when a different pane is focused.

Preview probes for a remote workspace run on that host, but the embedded browser is still on the Mac. Do not pretend that remote 127.0.0.1 is the Mac's server: report that such URLs need an existing reachable address or tunnel; do not add automatic tunneling.

Before quitQuestion, filter terminal/thread busy state to local destinations and respect local quitStopsWork. Remote work continues when the SSH link closes; local owned-daemon cleanup remains unchanged.
- [ ] **Step 4 — Run GREEN** with Step 2's command and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit `feat: run fixed-destination panes on one shared canvas`.

### Task 7: Offline mutation gates, uploads, and folder prompts

**Files:** Create `src/hostAvailability.ts`, `tests/host-availability.test.mjs`; modify `src/ConnectionBanner.tsx`, `src/ChatPane.tsx`, `src/TerminalPane.tsx`, `src/ApprovalCard.tsx`, `src/AttentionMenu.tsx`, `src/turnQueue.ts`, `src/typedPath.ts`, `src/PathPrompt.tsx`, `src/electronShell.ts`, `desktop/main.mjs`, `src/styles.css`; extend `tests/turn-queue.test.mjs`, `tests/path-prompt.test.mjs`, `tests/electron-shell.test.mjs`, `tests/approval-choices.test.mjs`.

**Consumes:** HostConnectionStore, per-pane backend binding, source-host approvals.

**Produces:** One host availability gate and host-specific PathRequest/startAt. The existing file-drop size/type checks now take the destination host explicitly.

- [ ] **Step 1 — Write failing availability and queue race tests.**

```js
import { hostCanMutate } from '../src/hostAvailability.ts';
test('only a connected host accepts new work', () => {
  assert.equal(hostCanMutate({ kind: 'connected', hostId: 'daemon-at' }), true);
  for (const kind of ['idle', 'connecting', 'reconnecting', 'resync', 'failed']) {
    assert.equal(hostCanMutate({ kind }), false);
  }
});
```

Add ParticipantQueues tests with an injected availability callback: offline Send does not call targets/post or add an item; a drop while targets is awaiting prevents acceptance; queued work accepted while connected pauses on disconnect and requires explicit user resumption after recovery; no automatic resumption from participant_idle replay. Draft text/files remain editable. An in-flight post rejected with LOST is never silently retried because it may already have been accepted.

Add tests for the picker remembering paths separately per host, late list/exists replies after prompt replacement, cancellation while disconnected, two requests to different hosts, and file-drop reads carrying the selected host ID with the 20 MB/directory checks preserved.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/host-availability.test.mjs tests/turn-queue.test.mjs tests/path-prompt.test.mjs tests/electron-shell.test.mjs tests/approval-choices.test.mjs`.
  Expected: offline and host-prompt assertions fail.
- [ ] **Step 3 — Apply gates at UI and dispatch boundaries.**

```ts
export function hostCanMutate(status: HostConnection["status"]): boolean {
  return status.kind === "connected";
}
// Guard again after every async target/preflight result and before queue acceptance.
// Keep new offline text in the draft; never clear it before acceptance.
// shell.readLocalFile(host.id, localPath) reads Mac bytes for upload to that host.
// ask({ hostId: host.id, kind, title }) picks on that host.
```

ConnectionBanner receives the pane's HostConnectionStore instead of the singleton and lives inside the affected pane. Display connecting and reconnecting failures there, with Retry for that host. Remove “Use This Mac”: it would imply moving an existing thread. Keep the Mac loading screen's own retry if the Mac session cannot start.

Disable Send, enter-to-send, reply/retry/steer, run-model, compact/rewind/revert, generated images, participant-changing actions and approval answers while the required host is unavailable. Preserve read-only transcript/export using already loaded data. Disable terminal write/start/resize attempts during downtime. Guard all mutating backend calls too; selected/grey controls alone are not proof of isolation.

Do not purge connected-host queues during unrelated outages. A queue that was accepted before its own outage stays visibly paused and needs explicit Resume; no new item is accepted during outage. A queued send started before the drop but whose outcome is unknown gets the existing LOST notice, never a speculative replay.

ApprovalCard receives hostName and availability, prints “Runs on <exact host>”, and disables every answer. AttentionMenu applies the same gate. Do not mark a card answered permanently before an awaited roomDecide succeeds; rejection leaves a recoverable error.

PathPrompt resolves the request's backend and host name. Increment the request generation on replacement/cancel, so a previous host's folder cannot appear or be submitted. A remote picker selection is a path on that server; a Finder drop is a path on the Mac. Keep those separate.

Use existing responsive layout tokens; approval details wrap/scroll within their pane and never expand the grid width.
- [ ] **Step 4 — Run GREEN** with Step 2's command and tsc. Expected: all pass.
- [ ] **Step 5 — Checkpoint.** Commit `feat: isolate offline controls and host file routing`.

### Task 8: Replace whole-window host controls and expose Stage 1 entry points

**Files:** Create `src/WorkspaceHostMenu.tsx`; modify `src/App.tsx`, `src/HostsSettings.tsx`, `src/backend.ts`, `src/electronShell.ts`, `src/styles.css`, `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/hosts.mjs`, `tests/desktop-hosts.test.mjs`, `desktop/smoke.mjs`, `desktop/run-smoke.mjs`; remove `src/HostSwitcher.tsx` after its consumers are gone.

**Consumes:** Working per-host pane routing and availability from Tasks 1–7.

**Produces:** The rail's + chooses a machine then that machine's folder. Server workspace rows and pane headers show a readable host label. No connection.use/openWindow/moveWindow or per-host windowsAtLaunch remain.

- [ ] **Step 1 — Add failing behavior checks to the Electron smoke harness.**

```js
// WorkspaceHostMenu supplies these testable DOM hooks.
const before = await page('return [...document.querySelectorAll(".pane")].map(p => p.dataset.paneId)');
await page('window.__hostMenuSentinel = "kept"; document.querySelector("[data-add-workspace]").click(); return true;');
assert.equal(await page('return Boolean(document.querySelector("[data-machine-menu]"))'), true);
assert.equal(await page('return Boolean(document.querySelector("[data-machine-menu] [data-host-id=local]"))'), true);
await page('document.querySelector("[data-machine-menu]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;');
assert.equal(await page('return Boolean(document.querySelector("[data-machine-menu]"))'), false);
assert.equal(await page('return window.__hostMenuSentinel'), 'kept');
assert.deepEqual(await page('return [...document.querySelectorAll(".pane")].map(p => p.dataset.paneId)'), before);
```

Extend host tests for legacy saved last/windows values opening exactly one Mac-owned primary window, no host switching menu, protected removal of a referenced host, and 40-character labels fitting three panes. The smoke script uses explicit selectors and fails on missing controls; it must not use optional chaining that silently skips a click.
- [ ] **Step 2 — Run RED.** `TMPDIR=/tmp node --experimental-strip-types --test tests/desktop-hosts.test.mjs` and the local Electron smoke run after adding its assertions.
  Expected: legacy launch and replacement-entry assertions fail until wired.
- [ ] **Step 3 — Replace the entry points, then delete the switcher.**

```tsx
// Existing workspace row:
<span className="workspace-host" title={host.name}>{host.name}</span>
// Pane header retains the project and bounded server name:
<span className="pane-project" title={workspace.path}>{workspace.name}</span>
<span className="pane-machine" title={host.name}>{host.name}</span>
```

The machine chooser lists This Mac and saved hosts, plus Add/manage servers. Choosing a server requests its exact folder through Task 7; creating a workspace calls addFolders with that saved host ID. Choosing an existing folder reopens its workspace instead of creating a duplicate. Include the separate-copy sentence, without implying file sync.

Automatically import unimported saved hosts at launch and report remapped/skipped IDs. Settings host rows show per-host connection state and a Retry action, never Connect/Show window that moves the app. Connection check/update and the editor remain Stage 2 work.

Refuse Remove while any Mac session workspace, including hidden ones, references the host. Check latest saved Mac session and active renderer references in main, not only a stale Settings list. If reference state is unreadable, refuse with a clear error. Removing an unused host disposes its clients and links without affecting other hosts. No automatic replacement with local.

Bound long host/project labels with ellipsis and full-name/path tooltips, preserving maximize/menu/close and the host identity in a three-pane layout. The checkmark for a selected offline destination belongs to Stage 3; do not encode selection solely as connection color.

Remove per-host window title, launch, remembered-window and app-menu behavior, including all preload and HostsApi use/openWindow functions. Main launches one Mac-owned window regardless of old last/windows values. Update existing remote smoke setup to select a remote pane/backend within that same Mac window.
- [ ] **Step 4 — Run GREEN.** `TMPDIR=/tmp npm test`, `npm run build`, and `npm run desktop:smoke`. Expected: unit suite, type/build and existing local native flows pass; smoke must include the replacement rail behavior.
- [ ] **Step 5 — Checkpoint.** Commit `feat: replace window host switching with workspace destinations`.

### Task 9: Real multi-host verification, compatibility docs and stage review

**Files:** Create `tests/e2e/multi-host.e2e.mjs`, `desktop/multi-host-smoke.mjs`; modify `desktop/run-smoke.mjs`, `package.json`, `docs/daemon-ubuntu.md`, `README.md` and this plan's execution checkboxes.

**Consumes:** Full Stage 1 implementation.

**Produces:** Reproducible native proof, `npm run desktop:smoke:multi-host`, documented migration/recovery behavior and a review handoff to Jigga.

- [ ] **Step 1 — Add failing integration scenarios before any fixes.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DaemonClient } from '../../src/daemon/client.ts';
import { daemonTransport } from '../../src/electronShell.ts';
import { commandBackend } from '../../src/commandBackend.ts';
import { createHostBackends } from '../../src/hostBackends.ts';
import { createEventHub } from '../../src/eventHub.ts';
import { socketLink } from './link.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error('timed out');
}
async function daemon(t) {
  const data = fs.mkdtempSync('/tmp/adm-');
  const binary = path.resolve('target/debug/apex-daemon');
  const child = spawn(binary, ['serve', '--exit-on-stdin-close', '--data-dir', data],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  let exit = null; let error = ''; let spawnError = ''; let link; let client;
  child.once('error', e => { spawnError = e.message; });
  child.once('exit', code => { exit = code; });
  child.stderr.on('data', bytes => { error += bytes; });
  t.after(async () => {
    client?.close();
    if (exit === null && !spawnError) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const finished = await Promise.race([stopped.then(() => true), pause(5000).then(() => false)]);
      if (!finished) { child.kill('SIGKILL'); await Promise.race([stopped, pause(1000)]); }
    }
    fs.rmSync(data, { recursive: true, force: true });
  });
  await until(() => {
    if (spawnError || exit !== null) throw new Error(spawnError || error || 'daemon exited');
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  let status = { kind: 'connecting' };
  const listeners = new Set();
  client = new DaemonClient(async () =>
    (link = await socketLink(path.join(data, 'daemon.sock'))), { delay: () => 60000 });
  client.onStatus(next => { status = next; listeners.forEach(cb => cb()); });
  const connection = {
    get: () => ({ status }),
    subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    retryNow: () => client.retryNow(),
  };
  const welcome = await client.start();
  const backend = commandBackend(daemonTransport(client), { quitStopsWork: false });
  return { data, welcome, client, backend, connection, breakLink: () => link.socket.destroy() };
}
const options = { policy: 'mention', max_bot_hops: 0 };
const bot = label => ({
  id: 'bot', display_name: label,
  backend: { kind: 'cli', program: 'sh', args: ['-c', 'echo ' + label] },
});
test('real host backends isolate a drop and do not replay rejected text', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t);
  assert.notEqual(mac.welcome.host_id, server.welcome.host_id);
  const registry = createHostBackends({
    local: mac.backend,
    hosts: [{ id: 'h-at', name: 'Apex-Terminal', remote: true }],
    make: () => ({
      backend: server.backend, connection: server.connection,
      start: () => server.client.start(), close: () => server.client.close(),
    }),
  });
  const remote = registry.get('h-at');
  const heard = [];
  const hub = createEventHub({});
  t.after(() => registry.dispose('h-at'));
  const offMac = await hub.start(mac.backend, 'local');
  const offServer = await hub.start(remote, 'h-at');
  t.after(() => { offMac(); offServer(); });
  hub.registerRoom('same-id', e => heard.push(['local', e]), 'local');
  hub.registerRoom('same-id', e => heard.push(['h-at', e]), 'h-at');
  await mac.backend.roomCreate('same-id', [bot('mac-reply')], options, '');
  await remote.roomCreate('same-id', [bot('server-reply')], options, '');
  await Promise.all([
    mac.backend.roomPost('same-id', '@bot first'),
    remote.roomPost('same-id', '@bot first'),
  ]);
  await until(() => heard.some(([host, e]) => host === 'local' && e.type === 'message_added' && e.message.text === 'mac-reply'));
  await until(() => heard.some(([host, e]) => host === 'h-at' && e.type === 'message_added' && e.message.text === 'server-reply'));
  server.breakLink();
  await until(() => server.connection.get().status.kind === 'reconnecting');
  await assert.rejects(remote.roomPost('same-id', '@bot offline-draft'));
  await mac.backend.roomPost('same-id', '@bot second');
  assert.equal(mac.connection.get().status.kind, 'connected');
  server.connection.retryNow();
  await until(() => server.connection.get().status.kind === 'connected');
  const state = await remote.roomState('same-id');
  assert.equal(state.snapshot.transcript.some(m => m.text.includes('offline-draft')), false);
  assert.equal(heard.some(([host, e]) => host === 'local' &&
    e.type === 'message_added' && e.message.text === 'server-reply'), false);
  assert.equal(heard.some(([host, e]) => host === 'h-at' &&
    e.type === 'message_added' && e.message.text === 'mac-reply'), false);
});
```

The fixture registers cleanup before startup completes, bounds exit waits and closes both clients. This unit/e2e fixture represents two execution hosts; it is not evidence of a real SSH connection.

Native smoke additionally opens two actual ChatPanes in one Electron window with a test Mac workspace and a test remote workspace. Type distinct drafts through their textareas, send both using deterministic shell participants, show an approval with the remote name, disconnect only its byte link, verify local Send continues, remote Send/Enter/approval fail, and Retry reconnects without clearing or sending the draft. Restart the remote helper while the Mac pane works to exercise a lost-history resync. Save/relaunch to verify canvas, pins, host/family and importedHostSessions; remote session.json hash must remain unchanged.

Defer identity-edit/duplicate-name-race scenarios to Stage 2; add identity-connect mismatch, same-server-two-folders, removal-in-use, remote drop upload, expired approval and long-header scenarios. Stub the clipboard if any existing Copy path is exercised.
- [ ] **Step 2 — Run RED scenarios** and fix only failures demonstrated by assertions. Expected: regressions are reproducible and associated with their owning task.
- [ ] **Step 3 — Run the final gates.**

```sh
TMPDIR=/tmp npm test
npm run build
cargo test --workspace
npm run test:e2e
npm run desktop:smoke
npm run desktop:smoke:multi-host
git diff --check
```

Expected: all checks exit 0; no installer or push runs. Redirect verbose output to this plan's ignored ledger workspace and record counts/paths, not assumptions.

For real SSH acceptance, use an existing configured Apex-Terminal test room and known folder; do not create another project checkout, reinstall its helper automatically, or kill its daemon/other users' SSH processes. Close only Deck's own test SSH link. Prove that the Mac thread can still complete a fresh message while the server pane is paused, then reconnect and verify the typed remote draft has not been sent. If a usable compatible test host is unavailable, keep “real SSH acceptance” explicitly pending; do not call Stage 1 fully accepted based on the local two-daemon fixture.

- [ ] **Step 4 — Document behavior and inspect visuals.** Document one-time read-only imports, collision reporting, separate project copies, local preferences/credentials, offline draft/queue behavior, daemon identity reset recovery, helper compatibility, and remote Preview URL limitations. Inspect real Deck at normal width and three-pane width with long names, an open approval and an offline server. Keep screenshots in this plan's ignored workspace.
- [ ] **Step 5 — Review and checkpoint.** Ask Jigga to review the source diff, test results and screenshots against the Review Focus list. Fix demonstrated blocking findings with RED → GREEN, then rerun the affected checks. Commit `test: verify multi-host canvas and recovery` with only the intended stage files. No merge, push, packaging or release action is implied by this plan.

## Stage 1 completion contract

- [ ] A Mac thread and an Apex-Terminal thread have produced fresh replies in the same native window.
- [ ] Different projects remain side by side; every pane displays its project and server when remote.
- [ ] All room/terminal/file/approval actions target the bound host, including actions invoked from the sidebar or attention menu.
- [ ] A real Deck SSH-link drop pauses only that host; another host still completes a new message.
- [ ] Remote drafts survive drop/retry/resync and are never sent automatically.
- [ ] Live approvals recover correctly and are disabled while unavailable, including outside their thread.
- [ ] Remote imports are closed, idempotent, collision-safe and saved atomically on the Mac; no remote session write occurs.
- [ ] Session restore preserves the shared layouts and metadata; terminals never auto-start after restoration.
- [ ] First-connect identities persist and later mismatched/duplicate daemon identities are refused; address/command edits and race validation belong to Stage 2.
- [ ] Referenced hosts cannot be removed or silently substituted.
- [ ] Quit asks only about work it would end on the Mac.
- [ ] Unit, Rust, e2e, native smoke, build and diff checks pass; real-server acceptance has an explicit result.
- [ ] Jigga has reviewed this stage. Stages 2 and 3 remain separate plans.

## Plan self-review

The acceptance matrix covers every v8 caption and preserves the human's Work in decision. Tasks 2/7/9 cover approval/drop behavior; Tasks 1/8/9 cover exact folder identity; Tasks 3/7/9 cover upload routing; Tasks 2/8/9 cover connection edits/removal; Tasks 1/6/9 cover import collisions and interrupted saves. The two necessary additions to the original handoff are shared-canvas migration in Stage 1 and a read-only live room-state API for recovery. Neither adds a new product surface; both are needed for the stated Stage 1 acceptance.

## Reviewed corrections (Jigga, October 6)

Accepted all seven corrections: optional room_state compatibility; initial connected revision before room loading; background launch imports; workspace collision remapping; edit/probe APIs deferred to Stage 2; Mac-only observer label with remote-enabled import warning; isolation checks await both positive replies.
