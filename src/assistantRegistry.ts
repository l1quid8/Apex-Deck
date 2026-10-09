import { assistantTasksForOwner, type AssistantExecutionPane, type AssistantTaskOwner, type AssistantTaskSnapshot } from './assistantTaskModel.ts';
import type { Pane } from './types.ts';

export interface AssistantOwnerRegistry {
  owner: AssistantTaskOwner;
  revision: number;
  panes: Record<string, AssistantExecutionPane>;
  registeredChildIds: string[];
  tombstonedChildIds: string[];
}
export interface AssistantRegistryState { owners: Record<string, AssistantOwnerRegistry> }
export type AssistantVisiblePane = Pane & Partial<Pick<AssistantExecutionPane, 'participants' | 'options' | 'started' | 'assistantTaskId' | 'hostId' | 'executionPath'>>;

export function emptyAssistantRegistry(): AssistantRegistryState { return { owners: {} }; }

/** Limit the view to monitor assignments that are current for each project. */
export function currentAssistantRegistry(state: AssistantRegistryState, owners: Record<string, AssistantTaskOwner>): AssistantRegistryState {
  return {
    owners: Object.fromEntries(Object.entries(state.owners).filter(([, entry]) => {
      const owner = owners[entry.owner.workspaceId];
      return !!owner && entry.owner.workspaceId === owner.workspaceId && entry.owner.cwd === owner.cwd
        && entry.owner.hostId === owner.hostId && entry.owner.conversationId === owner.conversationId;
    })),
  };
}

/** Resolve a worker link only through its exact current project monitor owner. */
export function assistantPaneForOwner(state: AssistantRegistryState, paneId: string, owner: AssistantTaskOwner | undefined): AssistantExecutionPane | null {
  if (!owner) return null;
  const entry = state.owners[ownerKey(owner)];
  if (!entry || entry.owner.workspaceId !== owner.workspaceId || entry.owner.cwd !== owner.cwd
    || entry.owner.hostId !== owner.hostId || entry.owner.conversationId !== owner.conversationId) return null;
  return entry.panes[paneId] ?? null;
}

function ownerKey(owner: AssistantTaskOwner): string {
  return JSON.stringify([owner.workspaceId, owner.cwd, owner.hostId, owner.conversationId]);
}

function validPane(pane: AssistantExecutionPane | undefined, execution: AssistantTaskSnapshot['executions'][number], workspaceId: string): pane is AssistantExecutionPane {
  return !!pane && pane.kind === 'chat' && pane.started === true && pane.id === execution.threadId
    && pane.workspaceId === workspaceId && pane.assistantTaskId === execution.taskId
    && typeof pane.hostId === 'string' && pane.hostId.length > 0 && typeof pane.executionPath === 'string'
    && Array.isArray(pane.participants) && !!pane.options && typeof pane.options === 'object';
}

/** Keep the latest task registry per monitor owner; children disappear only after an owned tombstone. */
export function reduceAssistantSnapshot(
  state: AssistantRegistryState,
  owner: AssistantTaskOwner,
  snapshot: AssistantTaskSnapshot,
): AssistantRegistryState {
  assistantTasksForOwner(snapshot, owner);
  if (!Number.isFinite(snapshot.revision)) throw new Error('ApexAgent returned an invalid task registry revision.');
  const key = ownerKey(owner);
  const previous = state.owners[key];
  if (previous && snapshot.revision <= previous.revision) return state;

  const panes = { ...(previous?.panes ?? {}) };
  const registered = new Set(previous?.registeredChildIds ?? []);
  const tombstoned = new Set(previous?.tombstonedChildIds ?? []);
  for (const execution of snapshot.executions ?? []) {
    if (execution.workspaceId !== owner.workspaceId) throw new Error('ApexAgent returned a child thread for a different project.');
    const pane = execution.pane;
    if (pane) {
      if (!validPane(pane, execution, owner.workspaceId)) throw new Error('ApexAgent returned an invalid child thread descriptor.');
      registered.add(pane.id);
    }
    if (execution.tombstonedAtMs != null) {
      if (registered.has(execution.threadId)) {
        tombstoned.add(execution.threadId);
        delete panes[execution.threadId];
      }
      continue;
    }
    if (pane && !tombstoned.has(pane.id)) panes[pane.id] = pane;
  }

  return {
    owners: {
      ...state.owners,
      [key]: {
        owner, revision: snapshot.revision, panes,
        registeredChildIds: [...registered], tombstonedChildIds: [...tombstoned],
      },
    },
  };
}

/** Make a view-only pane list. It never mutates or persists the Mac-owned human session. */
export function mergeAssistantPanes(humanPanes: readonly Pane[], state: AssistantRegistryState): AssistantVisiblePane[] {
  const visible: AssistantVisiblePane[] = [...humanPanes];
  const humanIds = new Set(humanPanes.map((pane) => pane.id));
  const childIds = new Set<string>();
  for (const owner of Object.values(state.owners)) {
    for (const pane of Object.values(owner.panes)) {
      if (humanIds.has(pane.id) || childIds.has(pane.id)) continue;
      childIds.add(pane.id);
      visible.push(pane);
    }
  }
  return visible;
}
