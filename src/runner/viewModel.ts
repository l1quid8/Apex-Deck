import type { RunnerSnapshot } from './types.ts';

export interface RunnerViewModel {
  id: string;
  kind: 'goal' | 'loop';
  phase: string;
  label: string;
  objective: string;
  metric: string;
  stateLabel: string;
  needsYou: boolean;
  limitHit: boolean;
  paused: boolean;
  running: boolean;
  intervalSeconds?: number;
  nextRunAt?: number | null;
  countdown?: string;
}

function formatCountdown(nextRunAt: number | null | undefined, nowMs: number): string {
  if (nextRunAt == null) return '';
  const diff = Math.max(0, nextRunAt - nowMs);
  const totalSec = Math.floor(diff / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function runnerView(snapshot: RunnerSnapshot | null, nowMs: number): RunnerViewModel | null {
  if (!snapshot) return null;
  const needsYou = snapshot.phase === 'waiting' && (snapshot.reason === 'approval' || snapshot.reason === 'question' || snapshot.reason === 'blocked');
  const limitHit = snapshot.reason === 'limit' || snapshot.reason === 'provider_usage';
  const obj = snapshot.objective ?? snapshot.prompt ?? '';
  const checklist = snapshot.checkpoint?.criteria;
  let metric = '';
  if (snapshot.kind === 'goal' && checklist) {
    const done = checklist.filter(c => c.status === 'done').length;
    metric = `✓ ${done}/${checklist.length}`;
  } else if (snapshot.kind === 'loop') {
    if (snapshot.phase === 'running') metric = 'Running';
    else if (snapshot.nextRunAt) metric = `Next in ${formatCountdown(snapshot.nextRunAt, nowMs)}`;
    else metric = `${snapshot.usage.turns}/${snapshot.limits.maxTurns ?? 30} runs`;
  }

  let stateLabel: string = snapshot.phase;
  if (snapshot.phase === 'waiting') stateLabel = 'Needs you';
  else if (snapshot.phase === 'paused') stateLabel = 'Paused';
  else if (snapshot.phase === 'running') stateLabel = 'Running';
  else if (snapshot.phase === 'scheduled') stateLabel = 'Scheduled';
  else if (snapshot.phase === 'completed') stateLabel = 'Finished';
  else if (snapshot.phase === 'ended') stateLabel = 'Ended';

  return {
    id: snapshot.id,
    kind: snapshot.kind,
    phase: snapshot.phase,
    label: stateLabel,
    objective: obj,
    metric,
    stateLabel,
    needsYou,
    limitHit,
    paused: snapshot.phase === 'paused',
    running: snapshot.phase === 'running' || snapshot.phase === 'scheduled',
    intervalSeconds: snapshot.intervalSeconds,
    nextRunAt: snapshot.nextRunAt ?? null,
    countdown: snapshot.nextRunAt ? formatCountdown(snapshot.nextRunAt, nowMs) : undefined,
  };
}
