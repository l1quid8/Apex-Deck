/**
 * Task 7: Slim handoff pill + view-model derivation
 * Pure functions only — no React, no side effects.
 * Consumes AssistantTask snapshots + optional progress projection.
 * Implements product contract from 2026-11-03 plan.
 */

import type { AssistantTask } from './assistantTaskModel';

export type HandoffPillState =
  | 'waiting_to_start'
  | 'needs_ok'
  | 'running'
  | 'needs_you'
  | 'stopping'
  | 'stopped'
  | 'couldnt_start'
  | 'ready_for_review'
  | 'done'
  | 'failed'
  | 'offline';

export interface TaskConversationProgress {
  taskId: string;
  runId?: string;
  participantId?: string;
  observedAtMs?: number;
  /** Optional reported todo list from worker */
  todos?: { text: string; status: 'open' | 'running' | 'done' | 'cancelled'; atMs?: number }[];
  latestActivity?: string; // e.g. "ran tools/step.sh 21"
}

export interface TaskConversationEvent {
  id: string;
  taskId: string;
  runId?: string;
  workerId?: string;
  atMs: number;
  kind: 'milestone' | 'question' | 'watchdog' | 'result';
  text: string;
}

export interface HandoffPill {
  taskId: string;
  revision: number;
  status: HandoffPillState;
  /** Short human sentence: "Handing this to Hyke in Watchdog QA, I'll tell you when it's done." */
  sentence: string;
  /** Progress label inside pill, e.g. "Hyke · step 20/40" or "Hyke · working · ran tools/step.sh" */
  label: string;
  /** Ordered workers, first is lead */
  workers: string[];
  leadWorkerId: string | null;
  leadDisplayName: string;
  teamPreview: string; // "Muck + Null · Muck leads" or "Hyke"
  totalCount?: number;
  doneCount?: number;
  latestActivity?: string;
  /** What Stop should announce for a11y */
  stopA11yLabel: string;
  availableActions: ('stop' | 'retry' | 'handover' | 'open')[];
  threadLabel?: string;
}

function workerDisplay(id: string): string {
  // Show saved display name when possible; fallback to id
  return id;
}

function deriveProgressLabel(progress?: TaskConversationProgress): { label: string; done?: number; total?: number; activity?: string } {
  const todos = progress?.todos;
  if (todos && todos.length) {
    const done = todos.filter(t => t.status === 'done').length;
    const total = todos.length;
    // Do NOT include brief; only use latestActivity for separate activity field, not for count label
    return { label: `step ${done}/${total}`, done, total, activity: progress?.latestActivity };
  }
  const activity = progress?.latestActivity;
  if (activity) return { label: `working · ${activity}`, activity };
  return { label: 'working' };
}

function toPillState(task: AssistantTask): HandoffPillState {
  if (task.desiredState === 'paused' && task.status === 'running') return 'stopping';
  const s = task.status;
  if (s === 'proposed') return 'needs_ok';
  if (s === 'queued') return 'waiting_to_start';
  if (s === 'needs_you') return 'needs_you';
  if (s === 'running') return 'running';
  if (s === 'ready_for_review') return 'ready_for_review';
  if (s === 'done') return 'done';
  if (s === 'cancelled') return 'stopped';
  if (s === 'failed' || s === 'interrupted') return 'couldnt_start';
  // offline/detached handled via owner checks elsewhere -> map to failed for now
  return s as HandoffPillState;
}

export function deriveHandoffPill(task: AssistantTask, progress?: TaskConversationProgress, threadLabel?: string): HandoffPill {
  const workers = task.workers?.length ? task.workers : (task.destination?.workers ?? []);
  const distinct = [...new Set(workers)];
  const lead = distinct[0] ?? null;
  const leadName = lead ? workerDisplay(lead) : 'Worker';
  const teamPreview = distinct.length === 0
    ? ''
    : distinct.length === 1
      ? `${workerDisplay(distinct[0])}`
      : `${distinct.map(workerDisplay).join(' + ')} · ${workerDisplay(distinct[0])} leads`;

  const sentence = `Handing this to ${teamPreview || leadName}${threadLabel ? ` in ${threadLabel}` : ''}, I'll tell you when it's done.`;
  const state = toPillState(task);
  const prog = deriveProgressLabel(progress);
  const firstWorker = distinct[0] ?? 'Hyke';

  // Contract from browser tests:
  // running -> "Hyke · step 20/40"
  // team -> "Muck + Null · 20/40" and "Muck + Null · Muck leads" preview
  // no_total -> "Hyke · working · ran tools/step.sh 21"
  // status overrides: "needs your OK", "Hyke · needs you", "Hyke · couldn't start", "Hyke · queued", "Hyke · stopping"
  let label = '';
  if (state === 'needs_ok') {
    label = 'needs your OK';
  } else if (state === 'waiting_to_start') {
    label = `${firstWorker} · queued`;
  } else if (state === 'needs_you') {
    label = `${firstWorker} · needs you`;
  } else if (state === 'stopping') {
    label = `${firstWorker} · stopping`;
  } else if (state === 'stopped') {
    label = `${firstWorker} · stopped`;
  } else if (state === 'couldnt_start') {
    label = `${firstWorker} · couldn't start`;
  } else if (state === 'ready_for_review') {
    label = `${firstWorker} · ready for review`;
  } else if (state === 'done') {
    label = `${firstWorker} · done`;
  } else {
    // running default
    if (prog.total != null && prog.done != null) {
      if (distinct.length > 1) {
        label = `${distinct.map(workerDisplay).join(' + ')} · ${prog.done}/${prog.total}`;
      } else {
        label = `${firstWorker} · step ${prog.done}/${prog.total}`;
      }
    } else if (prog.activity) {
      label = `${firstWorker} · ${prog.label}`;
    } else {
      label = `${firstWorker} · ${prog.label}`;
    }
  }

  if (state === 'running' || state === 'waiting_to_start' || state === 'needs_you' || state === 'stopping') {
    return {
      taskId: task.id,
      revision: task.revision,
      status: state,
      sentence,
      label,
      workers: distinct,
      leadWorkerId: lead,
      leadDisplayName: leadName,
      teamPreview,
      totalCount: prog.total,
      doneCount: prog.done,
      latestActivity: prog.activity,
      stopA11yLabel: `Stop ${teamPreview || leadName}`,
      availableActions: state === 'waiting_to_start' || state === 'running' || state === 'needs_you' || state === 'stopping' ? ['stop', 'open'] : ['open'],
      threadLabel,
    };
  }
  if (state === 'stopped' || state === 'failed' || state === 'couldnt_start') {
    return {
      taskId: task.id,
      revision: task.revision,
      status: state,
      sentence,
      label,
      workers: distinct,
      leadWorkerId: lead,
      leadDisplayName: leadName,
      teamPreview,
      totalCount: prog.total,
      doneCount: prog.done,
      latestActivity: prog.activity,
      stopA11yLabel: `Stop ${teamPreview || leadName}`,
      availableActions: ['retry', 'open'],
      threadLabel,
    };
  }
  return {
    taskId: task.id,
    revision: task.revision,
    status: state,
    sentence,
    label,
    workers: distinct,
    leadWorkerId: lead,
    leadDisplayName: leadName,
    teamPreview,
    totalCount: prog.total,
    doneCount: prog.done,
    latestActivity: prog.activity,
    stopA11yLabel: `Stop ${teamPreview || leadName}`,
    availableActions: ['open'],
    threadLabel,
  };
}

export interface HandoffPopoverModel {
  taskId: string;
  revision: number;
  steps: { index: number; state: 'done' | 'active' | 'future' | 'stall'; atMs?: number; text?: string }[];
  currentIndex: number; // 1-based
  artifactTail?: string[]; // last few lines of progress.txt
  canHandover: boolean; // false in Round 1
  canRetry: boolean;
}

export function deriveHandoffPopover(task: AssistantTask, progress: TaskConversationProgress | undefined, events: TaskConversationEvent[]): HandoffPopoverModel {
  const todos = progress?.todos ?? [];
  const total = todos.length || 0;
  const done = todos.filter(t => t.status === 'done').length;
  const current = done + 1;
  const steps = total
    ? todos.map((t, i) => ({
        index: i + 1,
        state: (t.status === 'done' ? 'done' : i + 1 === current ? 'active' : 'future') as HandoffPopoverModel['steps'][number]['state'],
        text: t.text,
        atMs: t.atMs,
      }))
    : [];

  // If no todos, synthesize view-only list from events for inspection only
  const viewSteps = steps.length ? steps : events
    .filter(e => e.kind === 'milestone')
    .slice(0, 40)
    .map((e, i) => ({ index: i + 1, state: 'done' as const, text: e.text, atMs: e.atMs }));

  return {
    taskId: task.id,
    revision: task.revision,
    steps: viewSteps,
    currentIndex: Math.min(current, total || viewSteps.length || 1),
    artifactTail: undefined, // wired by host file read when available
    canHandover: false, // Round 1: only Try again
    canRetry: task.status === 'cancelled' || task.status === 'failed' || task.status === 'interrupted',
  };
}

// Plain control boundary — deterministic whole-message classification (host-owned)
// Client mirrors it but host is authority.
export type PlainHandoffReply = 'stop' | 'continue' | 'other';
const STOP_SET = new Set(['stop', 'stop here', 'cancel', 'cancel that', 'no stop here']);
const CONTINUE_SET = new Set(['yes', 'yes please', 'keep going', 'carry on', 'continue', 'go ahead']);

export function classifyPlainHandoffReply(text: string): PlainHandoffReply {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!\u2026]+$/g, '')
    .trim();
  if (!normalized) return 'other';
  if (STOP_SET.has(normalized)) return 'stop';
  if (CONTINUE_SET.has(normalized)) return 'continue';
  return 'other';
}

// Agent selection ordering: preserve typed order, extract matches left-to-right
export function preserveTypedAgentOrder(input: string, allAgents: string[]): string[] {
  const lower = input.toLowerCase();
  const matches: { id: string; index: number }[] = [];
  for (const agent of allAgents) {
    const idx = lower.indexOf(agent.toLowerCase());
    if (idx !== -1) matches.push({ id: agent, index: idx });
  }
  matches.sort((a, b) => a.index - b.index);
  // Deduplicate preserving first occurrence
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m.id)) { seen.add(m.id); out.push(m.id); }
  }
  // Also handle "Muck and Hyke" with explicit split by non-word
  if (out.length === 0) {
    const tokens = lower.split(/[^a-z0-9_-]+/i).filter(Boolean);
    for (const tok of tokens) {
      const hit = allAgents.find(a => a.toLowerCase() === tok);
      if (hit && !seen.has(hit)) { seen.add(hit); out.push(hit); }
    }
  }
  return out;
}
