import type { Backend } from '../backend.ts';
import { parseRunnerCommand } from './commands.ts';
import { validateLimits, type RunnerSnapshot, type RunnerKind, type RunnerLimits, type RunnerActionTag, type RunnerConfig } from './types.ts';

type Transport = Pick<Backend, 'roomRunnerState' | 'roomRunnerStart' | 'roomRunnerAction'> & Partial<Pick<Backend,'roomState'>>;
export async function mutateRunner(backend: Transport, room: string, snapshot: RunnerSnapshot, action: RunnerActionTag, limits?: RunnerLimits): Promise<RunnerSnapshot | null> {
  if (!backend.roomRunnerAction) throw Error('This host does not support goals and loops. Update the host.');
  const result = await backend.roomRunnerAction(room, snapshot.id, snapshot.revision, crypto.randomUUID(), {action, limits});
  return result.applied ?? result.conflict ?? null;
}
export async function runnerCommand(backend: Transport, room: string, kind: RunnerKind, arg: string, workers: string[], limits: RunnerLimits, config: RunnerConfig = {}) {
  if ((backend as Backend).supports?.('room_runner_v1')===false || !backend.roomRunnerState) throw Error('This host does not support goals and loops. Update the host.');
  const command = parseRunnerCommand(kind, arg);
  if (command.kind === 'error') throw Error(command.message);
  const snapshot = await backend.roomRunnerState(room);
  if (command.kind === 'start') {
    if (snapshot && !['completed','ended'].includes(snapshot.phase)) throw Error(`A ${snapshot.kind} already owns this thread. End it first.`);
    if (!backend.roomRunnerStart) throw Error('This host does not support goals and loops.');
    validateLimits(limits);
    workers=config.workers??workers;
    if (!workers.length) throw Error('Select at least one worker.');
    const roomRevision=backend.roomState?(await backend.roomState(room)).roomRevision:0;
    const result = await backend.roomRunnerStart(room, '', roomRevision??0, crypto.randomUUID(), {schemaVersion:1, kind, objective:command.objective, prompt:command.prompt, intervalSeconds:command.intervalSeconds, workers, limits, checker:config.checker, checks:config.checks});
    if (!result.applied) throw Error('Another client changed this thread. Review the current runner before starting.');
    return {snapshot:result.applied as RunnerSnapshot};
  }
  if (snapshot && snapshot.kind !== kind) throw Error(`This thread has a ${snapshot.kind}. Use /${snapshot.kind} controls.`);
  if (command.kind === 'show') return {snapshot, show:true, message: snapshot ? undefined : `Use /${kind} ${kind === 'goal' ? '<objective>' : '10m <prompt>'} to start.`};
  if (!snapshot) throw Error(`There is no ${kind} in this thread.`);
  if (command.kind === 'clear') return ['completed','ended'].includes(snapshot.phase)?{snapshot:await mutateRunner(backend,room,snapshot,'dismiss')}:{snapshot, confirmEnd:true};
  return {snapshot:await mutateRunner(backend,room,snapshot,command.kind)};
}

export async function runnerAction(backend:Transport,room:string,snapshot:RunnerSnapshot,action:RunnerActionTag,limits?:RunnerLimits,dismissAfterEnd=false){
 let next=await mutateRunner(backend,room,snapshot,action,limits);
 if(next&&action==='end'&&dismissAfterEnd&&next.id===snapshot.id&&next.phase==='ended')next=await mutateRunner(backend,room,next,'dismiss');
 if(next&&action==='update_limits'&&snapshot.phase==='paused'&&snapshot.reason==='limit'&&next.id===snapshot.id)next=await mutateRunner(backend,room,next,'resume');
 return next;
}
