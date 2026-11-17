import type { RoomEvent, TurnOutcome } from './types.ts';
import { applyStepEvent, emptyTurnSteps, restoreTurnSteps, type TurnSteps } from './workSteps.ts';

export type TurnProgress = Record<string, TurnSteps>;

/** Rehydrate in-flight and terminal records without treating ended work as busy. */
export function restoreProgress(records: Record<string, unknown> = {}, active: readonly string[] = []): TurnProgress {
  const next: TurnProgress = Object.fromEntries(active.map(id => [id, emptyTurnSteps]));
  for (const [id, raw] of Object.entries(records)) {
    const turn = restoreTurnSteps(raw);
    if (turn.outcome || active.includes(id)) next[id] = turn;
  }
  return next;
}

/** Keep an interrupted turn visible until the next turn or a history cut. */
export function applyProgressEvent(progress: TurnProgress, event: RoomEvent): TurnProgress {
  const remove = (id: string) => {
    if (!(id in progress)) return progress;
    const { [id]: _old, ...rest } = progress;
    return rest;
  };
  if (event.type === 'turn_started') return { ...progress, [event.id]: emptyTurnSteps };
  if (event.type === 'message_added') return event.message.speaker.kind === 'bot' ? remove(event.message.speaker.id) : progress;
  // A saved summary completes the turn without adding a bot message.
  if (event.type === 'compacted') return remove(event.id);
  const finish = (id: string, outcome: TurnOutcome): TurnProgress => {
    const turn = progress[id];
    if (!turn || turn.outcome) return progress;
    return { ...progress, [id]: { ...turn, outcome, steps: turn.steps.map(step => step.status === 'running' ? { ...step, status: 'stopped' } : step) } };
  };
  if (event.type === 'failed' || event.type === 'passed' || event.type === 'participant_idle') return finish(event.id, event.type === 'failed' ? 'failed' : event.type === 'passed' ? 'passed' : 'stopped');
  if (event.type === 'stopped' || event.type === 'idle') {
    let next = progress;
    for (const id of Object.keys(progress)) next = applyProgressEvent(next, { type: 'participant_idle', id });
    return next;
  }
  if (event.type !== 'delta' && event.type !== 'work_step' && event.type !== 'todo') return progress;
  const turn = progress[event.id];
  if (!turn || turn.outcome) return progress;
  const next = applyStepEvent(turn, event);
  return next === turn ? progress : { ...progress, [event.id]: next };
}
