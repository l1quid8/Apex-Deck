import type { PersonalAssistantRecord } from '../personalAssistant.ts';
import type { BridgeEvent, CallScope, ThreadVoiceBridge, VoiceTurn } from './types.ts';

/** The personal host accepts a human event immediately and commits its reply
 * later. Correlate by that durable event, never by "the next message". */
export function createPersonalVoiceBridge(deps: {
  scope: CallScope;
  send(text: string, requestId: string): Promise<{ eventId: string }>;
  stop(eventId: string): Promise<void>;
  read(): Promise<PersonalAssistantRecord>;
  schedule?(poll: () => Promise<void>): () => void;
}): ThreadVoiceBridge & { dispose(): void; update(record: PersonalAssistantRecord): void } {
  type Request = { eventId?: string; accepting: Promise<unknown>; done: boolean; canceled: boolean; seen: Set<string> };
  const requests = new Map<string, Request>();
  const listeners = new Set<(event: BridgeEvent) => void>();
  let disposed = false, reading = false, unschedule: (() => void) | undefined;
  const emit = (requestId: string, type: BridgeEvent['type'], text?: string) => {
    for (const fn of listeners) fn({ requestId, scope: deps.scope, type, text });
  };
  const idle = () => { if ([...requests.values()].every(r => r.done)) { unschedule?.(); unschedule = undefined; } };
  const update = (record: PersonalAssistantRecord) => {
    if (record.id !== deps.scope.participantId || record.hostId !== deps.scope.hostId) throw Error('Assistant voice identity changed');
    for (const [id, r] of requests) {
      if (r.done || r.canceled || !r.eventId) continue;
      for (const m of record.messages) {
        if (m.eventId !== r.eventId || r.seen.has(m.id)) continue;
        r.seen.add(m.id);
        if (m.kind === 'approval') emit(id, 'approval');
        else if (m.role === 'assistant' && ['chat', 'result', 'helper'].includes(m.kind)) emit(id, 'text', m.text);
      }
      const event = record.events?.find(e => e.id === r.eventId);
      if (event?.state === 'held') { if (!r.seen.has('held')) { r.seen.add('held'); emit(id, 'approval'); } }
      else if (event?.state === 'done' || event?.state === 'failed') {
        r.done = true;
        if (event.state === 'failed') emit(id, 'failed', event.error ?? 'Assistant reply failed');
        emit(id, 'done');
      }
    }
    idle();
  };
  const poll = async () => {
    if (reading || disposed) return;
    reading = true;
    try { update(await deps.read()); }
    catch (error) { for (const [id, r] of requests) if (!r.done) { r.done = true; emit(id, 'failed', String(error)); } idle(); }
    finally { reading = false; }
  };
  const watch = () => {
    if (unschedule) return;
    unschedule = deps.schedule ? deps.schedule(poll) : (() => { const timer = setInterval(() => void poll(), 500); return () => clearInterval(timer); })();
  };
  return {
    async submit(turn: VoiceTurn) {
      if (disposed) throw Error('Assistant call is closed');
      if (turn.scope.hostId !== deps.scope.hostId || turn.scope.roomId !== deps.scope.roomId || turn.scope.participantId !== deps.scope.participantId) throw Error('Voice recipient changed');
      const old = requests.get(turn.requestId);
      if (old) { await old.accepting; return { requestId: turn.requestId }; }
      const r: Request = { accepting: Promise.resolve(), done: false, canceled: false, seen: new Set() };
      requests.set(turn.requestId, r);
      r.accepting = deps.send(turn.text, turn.requestId).then(result => { if (!result.eventId) throw Error('Host did not correlate the assistant reply'); r.eventId = result.eventId; emit(turn.requestId, 'started'); });
      try { await r.accepting; watch(); void poll(); }
      catch (error) { r.done = true; throw error; }
      return { requestId: turn.requestId };
    },
    async cancel(id) {
      const r = requests.get(id);
      if (!r || r.done) return;
      // Prevent speech immediately, but do not report cancellation until the
      // host has durably prevented this exact event from committing work.
      r.canceled = true;
      await r.accepting;
      if (r.eventId) await deps.stop(r.eventId);
      r.done = true;
      emit(id, 'canceled'); idle();
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    update,
    dispose() { disposed = true; unschedule?.(); unschedule = undefined; listeners.clear(); },
  };
}
