import { createContext } from 'react';
import type { AssistantTask } from './assistantTaskModel.ts';
import type { PersonalTask } from './personalAssistant.ts';

/** Where a task belongs in the Tasks list. */
export type TaskGroup = 'needsYou' | 'active' | 'finished';

/**
 * One row in the Tasks list. Project delegations and personal jobs keep their own stores and IDs;
 * the key includes the host and store so the same id on two hosts never collides.
 */
export type TaskSummary = {
  key: string;
  source: 'project' | 'personal';
  hostId: string;
  /** Project id for delegations; empty for personal jobs. */
  workspaceId: string;
  id: string;
  title: string;
  /** Where it runs or which project it belongs to, e.g. "apex-deck" or "Apex-Terminal". */
  place: string;
  /** Who does the work: a worker name, "Assistant", or "Helper". */
  worker: string;
  status: string;
  statusLabel: string;
  group: TaskGroup;
  /** Short readable result or latest line, never raw protocol text. */
  result: string;
  updatedAt: number;
};

export const projectTaskKey = (hostId: string, workspaceId: string, id: string) => `project:${hostId}:${workspaceId}:${id}`;
export const personalTaskKey = (hostId: string, id: string) => `personal:${hostId}:${id}`;

export function projectTaskGroup(task: Pick<AssistantTask, 'status'>): TaskGroup {
  if (['proposed', 'needs_clarification', 'needs_you', 'ready_for_review', 'interrupted'].includes(task.status)) return 'needsYou';
  if (['queued', 'running', 'applying'].includes(task.status)) return 'active';
  return 'finished';
}

export function personalTaskGroup(task: Pick<PersonalTask, 'status' | 'decision'>): TaskGroup {
  if (task.status === 'needsYou' && task.decision?.status === 'open') return 'needsYou';
  if (['queued', 'running', 'waiting', 'blocked', 'needsYou'].includes(task.status)) return 'active';
  return 'finished';
}

/**
 * Shared between ApexAgentAll (which owns the view) and each project's ApexAgentTasks (which owns its store).
 * - `display: 'links'`: the conversation is showing. Render at most one short line per task that opens it in Tasks.
 * - `display: 'tasks'`: the Tasks view is showing. Render nothing unless `selectedKey` is one of yours; then render that task's details.
 * Opening, closing or browsing must never send a task action or bind the conversation's message box.
 */
export type TaskViewContextValue = {
  display: 'links' | 'tasks';
  selectedKey: string | null;
  openTask: (key: string) => void;
  /** Each store reports its current rows; `storeKey` identifies the store so rows are replaced, not appended. */
  report: (storeKey: string, rows: TaskSummary[]) => void;
};

export const TaskViewContext = createContext<TaskViewContextValue | null>(null);
