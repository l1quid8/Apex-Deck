import type { ProjectMonitor, MonitorFinding } from './apexAgentModel.ts';
import type { Workspace } from './types.ts';

export const ASSISTANT_SOURCE_MIME = 'application/x-apex-agent-source';
export type AssistantSourceDrop = {
  workspaceId: string;
  hostId: string;
  cwd: string;
  kind: 'file' | 'thread';
  sourceId: string;
};

export type WidgetPosition = { edge: 'left' | 'right'; y: number };
export type WidgetStatus = 'offline' | 'failed' | 'paused' | 'complete' | 'checking' | 'needs-you' | 'watching' | 'off';
export const sameWidgetPosition = (a: WidgetPosition, b: WidgetPosition): boolean => a.edge === b.edge && a.y === b.y;
export const shouldShowFindingBubble = (hasFinding: boolean, dismissed: boolean, quietHours: boolean, panelOpen: boolean): boolean => hasFinding && !dismissed && !quietHours && !panelOpen;

export function assistantSourceOwnerKey(workspace: Pick<Workspace, 'id' | 'hostId' | 'path'>): string {
  return JSON.stringify([workspace.hostId ?? 'local', workspace.id, workspace.path]);
}

export function widgetSidePanelPosition(edge: 'left' | 'right', avatarLeft: number, viewportWidth: number, panelWidth: number, avatarSize = 56, gap = 12, margin = 12): { left: number } | { right: number } {
  const maxLeft = Math.max(margin, viewportWidth - panelWidth - margin);
  if (edge === 'left') return { left: Math.max(margin, Math.min(avatarLeft + avatarSize + gap, maxLeft)) };
  const maxRight = Math.max(margin, viewportWidth - panelWidth - margin);
  return { right: Math.max(margin, Math.min(viewportWidth - (avatarLeft - gap), maxRight)) };
}

function minutesOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** Check a local clock time against a daily interval, including intervals crossing midnight. */
export function isQuietHours(enabled: boolean, start: string, end: string, now: Date = new Date()): boolean {
  if (!enabled) return false;
  const startMinute = minutesOfDay(start);
  const endMinute = minutesOfDay(end);
  if (startMinute == null || endMinute == null || startMinute === endMinute) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return startMinute < endMinute ? current >= startMinute && current < endMinute : current >= startMinute || current < endMinute;
}

export function clampWidgetPosition(position: WidgetPosition, viewport: { width: number; height: number }, size = 56, margin = 16): WidgetPosition {
  const safeHeight = Math.max(size + margin * 2, viewport.height);
  return {
    edge: position.edge === 'left' ? 'left' : 'right',
    y: Math.max(margin, Math.min(Math.round(Number.isFinite(position.y) ? position.y : margin), safeHeight - size - margin)),
  };
}

export function widgetCoordinates(position: WidgetPosition, viewport: { width: number; height: number }, size = 56, margin = 16) {
  const clamped = clampWidgetPosition(position, viewport, size, margin);
  return { left: clamped.edge === 'left' ? margin : Math.max(margin, viewport.width - size - margin), top: clamped.y };
}

export function activeMonitorFindings(monitor: ProjectMonitor | undefined, now = Date.now()): MonitorFinding[] {
  return (monitor?.findings ?? []).filter((finding) => finding.status === 'open' && (finding.snoozedUntil == null || finding.snoozedUntil <= now));
}

export function aggregateFindingCount(monitors: ProjectMonitor[], workspaceIds: ReadonlySet<string>, now = Date.now()): number {
  return monitors.filter((monitor) => workspaceIds.has(monitor.workspaceId)).reduce((sum, monitor) => sum + activeMonitorFindings(monitor, now).length, 0);
}

export function widgetStatus(workspace: Workspace | undefined, monitor: ProjectMonitor | undefined, offlineWorkspaceIds: readonly string[] = []): WidgetStatus {
  if (!workspace || offlineWorkspaceIds.includes(workspace.id)) return 'offline';
  if (!monitor) return 'off';
  if (monitor.completed) return 'complete';
  if (monitor.paused) return 'paused';
  if (monitor.activeCheck) return 'checking';
  if (monitor.error) return 'failed';
  if (activeMonitorFindings(monitor).length) return 'needs-you';
  return 'watching';
}

/** What the status reads as. A failed check is not the machine being offline. */
export function widgetStatusLabel(status: WidgetStatus): string {
  return status === 'failed' ? 'Last check failed' : status.replace('-', ' ');
}

/** A failed check's error in a few words, for the line beside Retry. */
export function checkFailureReason(error: string): string {
  if (/\b402\b|insufficient|balance|credits?\b/i.test(error)) return 'out of credit';
  if (/api key is missing/i.test(error)) return 'API key missing';
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid api key/i.test(error)) return 'API key not accepted';
  if (/\b429\b|rate limit/i.test(error)) return 'rate limited';
  if (/timed? ?out/i.test(error)) return 'timed out';
  if (/invalid check JSON/i.test(error)) return "reply wasn't readable";
  if (/no saved profile/i.test(error)) return 'no profile';
  const line = error.replace(/^ApexAgent(?:'s)?\s*/i, '').split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'unknown error';
}

export function parseAssistantSourceDrop(raw: string, workspace: Workspace, monitor: ProjectMonitor | undefined): AssistantSourceDrop | null {
  try {
    const value = JSON.parse(raw) as Partial<AssistantSourceDrop>;
    const hostId = workspace.hostId ?? 'local';
    const cwd = workspace.path;
    if (!workspace.id || !cwd || !monitor || monitor.workspaceId !== workspace.id || monitor.hostId !== hostId || monitor.cwd !== cwd) return null;
    if (value.workspaceId !== workspace.id || value.hostId !== hostId || value.cwd !== cwd) return null;
    if ((value.kind !== 'file' && value.kind !== 'thread') || typeof value.sourceId !== 'string' || !value.sourceId.trim()) return null;
    const sourceId = value.sourceId.trim();
    const existing = value.kind === 'file' ? monitor.files : monitor.threads;
    if (existing.some((item) => item === sourceId || item.toLowerCase() === sourceId.toLowerCase())) return null;
    return { workspaceId: workspace.id, hostId, cwd, kind: value.kind, sourceId };
  } catch {
    return null;
  }
}

export function firstActiveFinding(monitors: ProjectMonitor[], workspaces: Workspace[], now = Date.now()) {
  const order = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const ordered = monitors.filter((monitor) => order.has(monitor.workspaceId)).slice().sort((a, b) => order.get(a.workspaceId)! - order.get(b.workspaceId)!);
  for (const monitor of ordered) {
    const finding = activeMonitorFindings(monitor, now)[0];
    if (finding) return { monitor, finding };
  }
  return null;
}
