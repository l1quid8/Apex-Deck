import type { ParticipantConfig } from './types';
import { assistantProfileChoices } from './assistantTaskModel.ts';
import { mentionedWords } from './recipients.ts';
import { mentionFor, slug } from './slug.ts';

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
  /** 'update' when a background check posted it rather than a chat reply. */
  kind?: string;
  /** Reactions saved on the owning host and shared with paired devices. */
  reactions?: string[];
}

export type MessageReaction = '👍' | '❤️' | '😂' | '🎉' | '👀' | '🙏';
export interface MessageQuote { messageId: string; author: string; text: string }
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

/**
 * What each project answers to after @, by id: its name as a mention, or its
 * id when another project's name gives the same mention or the name means
 * everyone, so the @ list never offers one handle for two projects.
 */
export function laneMentions(projects: readonly { id: string; name: string }[]): Map<string, string> {
  const fromName = projects.map((project) => mentionFor({ id: project.id, display_name: project.name }));
  return new Map(projects.map((project, i) => {
    const shared = fromName.filter((mention) => mention === fromName[i]).length > 1;
    return [project.id, shared || fromName[i] === 'all' || fromName[i] === 'everyone' ? slug(project.id) : fromName[i]];
  }));
}

/** The project `text` @mentions first: by what laneMentions says it answers to, or by its id. Null when it names none. */
export function mentionedLane(text: string, projects: readonly { id: string; name: string }[]): string | null {
  const mentions = laneMentions(projects);
  for (const word of mentionedWords(text)) {
    const project = projects.find((p) => mentions.get(p.id) === word) ?? projects.find((p) => slug(p.id) === word);
    if (project) return project.id;
  }
  return null;
}

/** Whether the text means every project: a whole `@all`, never the start of a
 *  project handle. A project called "All Hands" answers to `@all-hands`, and
 *  naming it must not send to every project instead. */
export function mentionsAll(text: string): boolean {
  return mentionedWords(text).includes('all');
}

/** A reply goes to the project it names as a whole word ("UI" never matches "Build"); otherwise it continues the last project talked about. */
export function replyTarget(text: string, projects: { id: string; name: string }[], fallback: string | null): string | null {
  const wholeWord = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  const named = projects
    .filter((project) => project.name.trim() && wholeWord(project.name).test(text))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return named?.id ?? (projects.some((project) => project.id === fallback) ? fallback : projects[0]?.id ?? null);
}
