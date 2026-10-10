import type { ParticipantConfig } from './types';
import { assistantProfileChoices } from './assistantTaskModel.ts';

export interface MonitorEvidence {
  sourceId: string;
  label: string;
  observedAt: number;
  excerpt: string;
}
export interface MonitorMessage {
  id: string;
  role: 'human' | 'assistant';
  text: string;
  at: number;
  evidence: MonitorEvidence[];
}
export interface MonitorFinding {
  id: string;
  summary: string;
  reason: string;
  confidence: 'observed' | 'inferred' | 'unknown';
  nextStep: string;
  evidence: MonitorEvidence[];
  status: 'open' | 'resolved' | 'dismissed' | 'snoozed';
  firstSeenAt: number;
  lastSeenAt: number;
  lastNotifiedAt: number;
  snoozedUntil: number | null;
}
export interface ProjectMonitor {
  workspaceId: string;
  conversationId: string;
  cwd: string;
  hostId: string;
  profileId: string;
  responsibility: string;
  nextStep: string;
  decisions: string[];
  preferences: string[];
  files: string[];
  threads: string[];
  paused: boolean;
  completed: boolean;
  revision: number;
  /** Ordered host state within this assignment; absent on older helpers. */
  snapshotVersion?: number;
  messages: MonitorMessage[];
  findings: MonitorFinding[];
  activity: { at: number; kind: string; summary: string }[];
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  wakeReason: string | null;
  evidenceFingerprint: string | null;
  activeCheck: { id: string; revision: number; startedAt: number } | null;
  error: string | null;
}

export function compatibleMonitorProfiles(profiles: ParticipantConfig[]): ParticipantConfig[] {
  return assistantProfileChoices(profiles);
}

/** Prefer the last profile chosen for ApexAgent, falling back to the first compatible text profile. */
export function defaultMonitorProfileId(profiles: ParticipantConfig[], storedId: string | null): string {
  const compatible = compatibleMonitorProfiles(profiles);
  return compatible.some((profile) => profile.id === storedId) ? storedId! : compatible[0]?.id ?? '';
}

/** Keep the selected source list relative to the project folder and avoid duplicate paths. */
export function parseProjectFiles(value: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const path = line.trim().replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) continue;
    const parts = path.split('/');
    if (parts.some((part) => part === '..' || part === '' || part === '.')) continue;
    if (!seen.has(path)) { seen.add(path); files.push(path); }
  }
  return files;
}

export function monitorStatusLabel(monitor: ProjectMonitor | null): string {
  if (!monitor) return 'Not set up';
  if (monitor.completed) return 'Complete';
  return monitor.paused ? 'Paused' : 'Watching';
}

export interface AllProjectsEntry { workspaceId: string; project: string; message: MonitorMessage }

/** One timeline for every watched project, oldest first, each line tagged with its project. */
export function mergeProjectConversations(monitors: ProjectMonitor[], names: Record<string, string>): AllProjectsEntry[] {
  return monitors
    .flatMap((monitor) => monitor.messages.map((message) => ({ workspaceId: monitor.workspaceId, project: names[monitor.workspaceId] ?? 'Project', message })))
    .sort((a, b) => a.message.at - b.message.at || a.workspaceId.localeCompare(b.workspaceId));
}

/** A reply goes to the project it names as a whole word ("UI" never matches "Build"); otherwise it continues the last project talked about. */
export function replyTarget(text: string, projects: { id: string; name: string }[], fallback: string | null): string | null {
  const wholeWord = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  const named = projects
    .filter((project) => project.name.trim() && wholeWord(project.name).test(text))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return named?.id ?? (projects.some((project) => project.id === fallback) ? fallback : projects[0]?.id ?? null);
}
