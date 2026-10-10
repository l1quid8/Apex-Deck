import type { AllProjectsEntry, MonitorEvidence, ProjectMonitor } from './apexAgentModel.ts';
import type { AssistantTask, AssistantTaskOwner } from './assistantTaskModel.ts';

export interface OverviewEntry extends AllProjectsEntry {
  owners: AssistantTaskOwner[];
  citations?: { workspaceId: string; evidence: MonitorEvidence }[];
}
export const overviewOwner = (monitor: ProjectMonitor): AssistantTaskOwner => ({ workspaceId: monitor.workspaceId, hostId: monitor.hostId, cwd: monitor.cwd, conversationId: monitor.conversationId });
export const overviewOwnerKey = (owner: AssistantTaskOwner) => JSON.stringify([owner.workspaceId, owner.hostId, owner.cwd, owner.conversationId]);

/** Never send profile credentials or arbitrary host-storage fields to another project's model. */
export function overviewProject(monitor: ProjectMonitor, name: string, offline: boolean, tasks?: AssistantTask[]) {
  return {
    ...overviewOwner(monitor), name, revision: monitor.revision,
    delegatedWork: tasks?.map(({ id, originalRequest, brief, status, result, reviewCriteria, evidence, updatedAtMs }) => ({ id, originalRequest, brief, status, result, reviewCriteria, evidence, updatedAtMs })),
    delegatedWorkAvailability: tasks ? 'available' : 'unknown', availability: offline ? 'offline' : 'online',
    snapshot: {
      responsibility: monitor.responsibility, decisions: monitor.decisions, preferences: monitor.preferences,
      nextStep: monitor.nextStep, paused: monitor.paused, completed: monitor.completed,
      lastCheckedAt: monitor.lastCheckedAt, activeCheck: monitor.activeCheck, error: monitor.error,
      messages: monitor.messages.slice(-12).map(({ id, role, text, evidence, at }) => ({ id, role, text, evidence, at })),
      findings: monitor.findings.slice(-30),
    },
  };
}

/** An answer involving a removed, hidden, moved or reassigned project is no longer in scope. */
export function visibleOverviewEntries(entries: OverviewEntry[], monitors: ProjectMonitor[]): OverviewEntry[] {
  const keys = new Set(monitors.map((monitor) => overviewOwnerKey(overviewOwner(monitor))));
  return entries.filter((entry) => entry.owners.length > 0 && entry.owners.every((owner) => keys.has(overviewOwnerKey(owner))));
}
export function loadOverviewEntries(storage: Pick<Storage, 'getItem'>): OverviewEntry[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem('apex-agent-overview-history') ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((entry): entry is OverviewEntry => entry?.workspaceId === '*' && Array.isArray(entry.owners) && entry.owners.every((owner: AssistantTaskOwner) => ['workspaceId', 'hostId', 'cwd', 'conversationId'].every((key) => typeof owner?.[key as keyof AssistantTaskOwner] === 'string')) && typeof entry.message?.text === 'string' && typeof entry.message?.id === 'string' && typeof entry.message?.at === 'number' && ['human', 'assistant'].includes(entry.message?.role) && Array.isArray(entry.message?.evidence) && (!entry.citations || (Array.isArray(entry.citations) && entry.citations.every((cite: { workspaceId: string; evidence: MonitorEvidence }) => typeof cite.workspaceId === 'string' && typeof cite.evidence?.sourceId === 'string' && typeof cite.evidence?.excerpt === 'string')))).slice(-100);
  } catch { return []; }
}

export interface HandoffAssignment {
  owner: AssistantTaskOwner;
  revision: number;
  brief: string;
  destination: import('./assistantTaskModel.ts').AssistantTaskDestination;
  mode?: 'isolated' | 'read_only';
  reviewCriteria?: string[];
}
export function overviewRouting(snapshot?: import('./assistantTaskModel.ts').AssistantTaskSnapshot) {
  return (snapshot?.routingThreads ?? []).slice(0, 60).map((thread) => ({ id: thread.id,
    workers: thread.workers.filter((worker) => !worker.media).slice(0, 20).map(({ id, display_name }) => ({ id, display_name })),
  }));
}
export function handoffBatch(id: string, originalRequest: string, assignments: HandoffAssignment[], projects: (ReturnType<typeof overviewProject> & { routingThreads?: ReturnType<typeof overviewRouting> })[]): import('./assistantTaskModel.ts').HandoffBatch {
  if (!id || !originalRequest.trim() || !Array.isArray(assignments) || assignments.length > 20) throw new Error('Invalid handoff plan.');
  const children = assignments.map((assignment, index) => {
    const project = projects.find((item) => overviewOwnerKey(item) === overviewOwnerKey(assignment.owner));
    const destination = assignment.destination;
    const thread = project?.routingThreads?.find((item) => item.id === destination?.threadId);
    if (!project || project.availability !== 'online' || project.revision !== assignment.revision
      || !Number.isSafeInteger(assignment.revision) || !assignment.brief?.trim() || assignment.brief.length > 16000
      || !destination || destination.newThread || !thread || !destination.workers.length || destination.workers.length > 10
      || new Set(destination.workers).size !== destination.workers.length || !destination.workers.every((id) => thread.workers.some((worker) => worker.id === id))
      || (assignment.mode !== undefined && assignment.mode !== 'isolated' && assignment.mode !== 'read_only')
      || (assignment.reviewCriteria !== undefined && (!Array.isArray(assignment.reviewCriteria) || assignment.reviewCriteria.length > 20 || assignment.reviewCriteria.some((item) => typeof item !== 'string' || item.length > 2000)))) {
      throw new Error('A handoff target is offline, changed, or has no eligible saved worker. Ask again with the project and bot.');
    }
    return { project: project.name, status: 'pending' as const, payload: { batchId: id, requestId: `${id}:${index}`, originalRequest,
      owner: { ...assignment.owner }, revision: assignment.revision, brief: assignment.brief, destination: { ...destination, workers: [...destination.workers] },
      mode: assignment.mode ?? 'isolated', reviewCriteria: [...(assignment.reviewCriteria ?? [])],
    } };
  });
  return { id, originalRequest, createdAt: Date.now(), children };
}
const BATCH_KEY = 'apex-agent-handoff-batches';
export function saveHandoffBatches(storage: Pick<Storage, 'setItem'>, batches: import('./assistantTaskModel.ts').HandoffBatch[]) {
  storage.setItem(BATCH_KEY, JSON.stringify(batches));
}
export function loadHandoffBatches(storage: Pick<Storage, 'getItem'>, monitors?: ProjectMonitor[]): import('./assistantTaskModel.ts').HandoffBatch[] {
  try {
    const saved = JSON.parse(storage.getItem(BATCH_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    const keys = monitors && new Set(monitors.map((monitor) => overviewOwnerKey(overviewOwner(monitor))));
    return saved.filter((batch) => typeof batch?.id === 'string' && typeof batch.originalRequest === 'string' && typeof batch.createdAt === 'number'
      && Array.isArray(batch.children) && batch.children.length > 0 && batch.children.length <= 20
      && batch.children.every((child: import('./assistantTaskModel.ts').HandoffChild, index: number) => {
        const p = child?.payload;
        return p && p.batchId === batch.id && p.requestId === `${batch.id}:${index}` && p.originalRequest === batch.originalRequest
          && p.owner && [p.owner.workspaceId, p.owner.hostId, p.owner.cwd, p.owner.conversationId].every((field) => typeof field === 'string' && field.length > 0) && (!keys || keys.has(overviewOwnerKey(p.owner))) && Number.isSafeInteger(p.revision) && typeof p.brief === 'string' && p.brief.length > 0
          && ['isolated', 'read_only'].includes(p.mode) && Array.isArray(p.reviewCriteria) && p.reviewCriteria.every((item) => typeof item === 'string')
          && p.destination && p.destination.newThread === false && typeof p.destination.threadId === 'string'
          && Array.isArray(p.destination.workers) && p.destination.workers.length > 0 && p.destination.workers.every((id) => typeof id === 'string')
          && ['pending', 'proposed', 'offline', 'uncertain', 'failed'].includes(child.status);
      }));
  } catch { return []; }
}

/** A removed child never makes a still-owned sibling's saved retry disappear. */
export function visibleHandoffChildren(batch: import('./assistantTaskModel.ts').HandoffBatch, monitors: ProjectMonitor[]) {
  const keys = new Set(monitors.map((monitor) => overviewOwnerKey(overviewOwner(monitor))));
  return batch.children.filter((child) => keys.has(overviewOwnerKey(child.payload.owner)));
}
