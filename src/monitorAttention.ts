import type { Signal } from './attention.ts';
import type { ProjectMonitor } from './apexAgentModel.ts';
import type { Workspace } from './types.ts';

/** Durable monitor attention, indexed by its host route, workspace, and folder. */
export type MonitorAttentionState = Record<string, {
  workspaceId: string;
  hostId: string;
  monitor: ProjectMonitor;
}>;

export interface MonitorAttentionEntry {
  key: string;
  workspaceId: string;
  hostId: string;
  monitor: ProjectMonitor;
  signal: Signal;
}

/** Requests can complete out of order; a resolved finding must not reappear from an older poll. */
function olderSnapshot(incoming: ProjectMonitor, saved: ProjectMonitor): boolean {
  return incoming.conversationId === saved.conversationId && (incoming.snapshotVersion ?? 0) < (saved.snapshotVersion ?? 0);
}

/** JSON tuple encoding keeps both parts of the durable identity unambiguous. */
export function monitorAttentionKey(workspaceId: string, hostId: string, cwd: string): string {
  return JSON.stringify([hostId, workspaceId, cwd]);
}

/** A monitor blocker is durable until its finding is resolved, dismissed, or snoozed. */
export function monitorAttentionSignal(monitor: ProjectMonitor | null, now: number): Signal | null {
  if (!monitor) return null;
  const active = monitor.findings.filter((finding) =>
    (finding.status === 'open' && (finding.snoozedUntil == null || finding.snoozedUntil <= now)) ||
    (finding.status === 'snoozed' && finding.snoozedUntil !== null && finding.snoozedUntil <= now),
  );
  if (active.length === 0) return null;
  const at = Math.min(...active.map((finding) =>
    Number.isFinite(finding.firstSeenAt) && finding.firstSeenAt > 0 ? finding.firstSeenAt : finding.lastSeenAt,
  ));
  const count = active.length;
  return {
    kind: 'needs_input',
    note: `ApexAgent has ${count} active blocker${count === 1 ? '' : 's'}`,
    at,
    blocking: true,
  };
}

/** Save or remove exactly one host/workspace snapshot. */
export function withMonitorSnapshot(
  state: MonitorAttentionState,
  workspaceId: string,
  hostId: string,
  monitor: ProjectMonitor | null,
  cwd: string,
): MonitorAttentionState {
  if (monitor && (monitor.workspaceId !== workspaceId || monitor.hostId !== hostId || monitor.cwd !== cwd)) {
    throw new Error('Monitor snapshot workspace, host, or folder does not match its owner key');
  }
  const key = monitorAttentionKey(workspaceId, hostId, cwd);
  if (monitor === null) {
    if (!(key in state)) return state;
    const { [key]: _removed, ...remaining } = state;
    return remaining;
  }
  const previous = state[key];
  if (previous && olderSnapshot(monitor, previous.monitor)) return state;
  if (previous?.monitor === monitor) return state;
  return { ...state, [key]: { workspaceId, hostId, monitor } };
}

/**
 * Replace one host's complete successful snapshot. Invalid or cross-owner
 * snapshots leave the prior state intact, so they cannot clear valid blockers.
 */
export function reconcileMonitorHost(
  state: MonitorAttentionState,
  hostId: string,
  monitors: ProjectMonitor[],
  workspaces: Workspace[],
): MonitorAttentionState {
  const ownedFolders = new Map(
    workspaces.filter((workspace) => (workspace.hostId ?? 'local') === hostId).map((workspace) => [workspace.id, workspace.path]),
  );
  const incoming = new Map<string, ProjectMonitor>();
  for (const monitor of monitors) {
    if (monitor.hostId !== hostId || !ownedFolders.has(monitor.workspaceId) || ownedFolders.get(monitor.workspaceId) !== monitor.cwd || incoming.has(monitor.workspaceId)) return state;
    incoming.set(monitor.workspaceId, monitor);
  }

  // A successful host snapshot also retires saved state for removed or moved
  // workspaces that used to belong to this host.
  const next: MonitorAttentionState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.hostId !== hostId) next[key] = entry;
  }
  for (const [workspaceId, monitor] of incoming) {
    const key = monitorAttentionKey(workspaceId, hostId, monitor.cwd);
    const previous = state[key];
    next[key] = previous && olderSnapshot(monitor, previous.monitor) ? previous : { workspaceId, hostId, monitor };
  }
  return next;
}

/** List current, visible workspace bindings that have active monitor blockers. */
export function monitorAttentionEntries(
  state: MonitorAttentionState,
  workspaces: Workspace[],
  now: number,
): MonitorAttentionEntry[] {
  const entries: MonitorAttentionEntry[] = [];
  for (const workspace of workspaces) {
    if (workspace.hidden) continue;
    const hostId = workspace.hostId ?? 'local';
    const key = monitorAttentionKey(workspace.id, hostId, workspace.path);
    const saved = state[key];
    if (
      !saved ||
      saved.workspaceId !== workspace.id ||
      saved.hostId !== hostId ||
      saved.monitor.workspaceId !== workspace.id ||
      saved.monitor.hostId !== hostId ||
      saved.monitor.cwd !== workspace.path
    ) continue;
    const signal = monitorAttentionSignal(saved.monitor, now);
    if (signal) entries.push({ key, workspaceId: workspace.id, hostId, monitor: saved.monitor, signal });
  }
  return entries;
}
