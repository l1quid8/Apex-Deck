import type { Backend } from '../backend.ts';
import type { PhoneHost } from '../phoneBackend.ts';
import type { AssistantRegistryState } from '../assistantRegistry.ts';
import type { PersonalAssistantSummary } from '../usePersonalAssistants.ts';
import type { Workspace } from '../types.ts';
import { collectWorkspaceTasks, workspaceTaskHostMatches, type WorkspaceTaskRow, type ProjectTaskSource, type PersonalTaskSource } from '../workspaceTasks.ts';

/** Token-paired legacy connections have full access; QR pairs require a verified welcome tier. */
export function phoneTaskFullAccess(host: PhoneHost): boolean {
  const access = host.access();
  return access?.tier === 'full' || access == null && !('transport' in host.machine);
}
export function phonePersonalTaskSources(assistants: readonly PersonalAssistantSummary[], hosts: readonly PhoneHost[]): PersonalTaskSource[] {
  return assistants.map(assistant => {
    const host = hosts.find(host => { const status = host.connection.get().status; return status.kind === 'connected' && status.hostId === assistant.ref.hostId; });
    const route = host;
    return { assistant: assistant.ref, name: assistant.name, hostName: host?.machine.name ?? assistant.hostName, tasks: assistant.personalTasks, todos: assistant.taskManagerTodos, schedules: assistant.schedules, revision: assistant.revision,
      offline: assistant.offline || !host || !phoneTaskFullAccess(host), observedAt: assistant.lastSeen, routeHostId: route?.machine.id ?? assistant.ref.hostId };
  });
}
export function collectPhoneTasks({ assistants, registry, projects, hosts, problems = {} }: {
  assistants: readonly PersonalAssistantSummary[];
  registry: AssistantRegistryState;
  projects: readonly { workspace: Workspace; allowed: boolean }[];
  hosts: readonly PhoneHost[];
  problems?: Record<string, string>;
}): WorkspaceTaskRow[] {
  const personal = phonePersonalTaskSources(assistants, hosts);
  const projectSources: ProjectTaskSource[] = [];
  for (const entry of Object.values(registry.owners)) {
    const project = projects.find(({ workspace }) => workspace.id === entry.owner.workspaceId && workspace.path === entry.owner.cwd && (workspace.hostId ?? 'local') === entry.owner.hostId);
    if (!project || !entry.snapshot) continue;
    const host = hosts.find(host => host.machine.id === entry.owner.hostId);
    const status = host?.connection.get().status;
    projectSources.push({ owner: entry.owner,
      project: { hostId: entry.authenticatedHostId ?? entry.owner.hostId, workspaceId: entry.owner.workspaceId, cwd: entry.owner.cwd },
      name: project.workspace.name, hostName: host?.machine.name, snapshot: entry.snapshot, observedAt: entry.observedAt ?? 0,
      authenticatedHostId: entry.authenticatedHostId,
      offline: !host || !phoneTaskFullAccess(host) || !project.allowed || !!problems[entry.owner.workspaceId] || status?.kind !== 'connected' || !entry.authenticatedHostId || status.hostId !== entry.authenticatedHostId,
    });
  }
  return collectWorkspaceTasks(personal, projectSources);
}
export function phoneTasksNeedAttention(rows: readonly WorkspaceTaskRow[]): boolean { return rows.some(row => row.group === 'waiting'); }

/** Read access changes again at invocation, including callbacks retained by an open detail or dialog. */
const taskBackendCache = new WeakMap<() => readonly PhoneHost[], WeakMap<Backend, Map<string, Backend>>>();
export function phoneTaskBackend(row: Pick<WorkspaceTaskRow, 'routeHostId' | 'verifiedHostId' | 'offline'>, hosts: () => readonly PhoneHost[]): Backend | null {
  const find = () => hosts().find(host => host.machine.id === row.routeHostId);
  const allowed = (host: PhoneHost | undefined) => !!host && phoneTaskFullAccess(host) && workspaceTaskHostMatches(row, host.connection.get().status);
  const host = find();
  if (row.offline || !allowed(host)) return null;
  const backend = host!.backend;
  let backends = taskBackendCache.get(hosts);
  if (!backends) { backends = new WeakMap(); taskBackendCache.set(hosts, backends); }
  let owners = backends.get(backend);
  if (!owners) { owners = new Map(); backends.set(backend, owners); }
  const cacheKey = JSON.stringify([row.routeHostId, row.verifiedHostId]);
  const cached = owners.get(cacheKey);
  if (cached) return cached;
  const methods = new Map<PropertyKey, unknown>();
  const guarded = new Proxy(backend, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function' || key === 'supports') return value;
    if (!methods.has(key)) methods.set(key, async (...args: unknown[]) => {
      const need = () => { const current = find(); if (!allowed(current) || current!.backend !== backend) throw new Error('Reconnect the owning machine with Full access to use task actions.'); };
      need(); const result = await Reflect.apply(value, target, args); need(); return result;
    });
    return methods.get(key);
  } });
  owners.set(cacheKey, guarded);
  return guarded;
}
