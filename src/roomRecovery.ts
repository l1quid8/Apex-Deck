import type { Backend } from "./backend";
import type { ParticipantConfig, RoomOptions, RoomSnapshot, RoomState } from "./types";

export async function loadRoomState(backend: Backend, id: string, participants: ParticipantConfig[], options: RoomOptions, cwd: string): Promise<RoomState> {
  const snapshot = await backend.roomCreate(id, participants, options, cwd);
  if (backend.roomState) {
    try { return { ...await backend.roomState(id), live: true }; }
    catch (error) { if (!/unknown variant [`'"]?room_state|unknown command.*room_state|unsupported.*room_state/i.test(String(error))) throw error; }
  }
  return { snapshot, active: [], approvals: [], live: false };
}

export function createRoomRecovery<T, E = never>({ load, apply, fail, event }: {
  load(): Promise<T>; apply(state: T): void; fail(error: unknown): void; event?(event: E): void;
}) {
  let generation = 0; let disposed = false; let loading = false; let buffered: E[] = [];
  return {
    capture(value: E): boolean { if (!loading) return false; buffered.push(value); return true; },
    async refresh(): Promise<void> {
      const ticket = ++generation; loading = true; buffered = [];
      try {
        const state = await load();
        if (disposed || ticket !== generation) return;
        apply(state); const events = buffered; buffered = []; loading = false; events.forEach(e => event?.(e));
      } catch (error) { if (!disposed && ticket === generation) { loading = false; buffered = []; fail(error); } }
    },
    dispose() { disposed = true; generation++; loading = false; buffered = []; },
  };
}

/** Message sequence is authoritative when snapshot and in-flight events overlap. */
export function containsMessage(snapshot: RoomSnapshot, seq: number): boolean { return snapshot.transcript.some(m => m.seq === seq); }
