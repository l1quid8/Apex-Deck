import type { Backend } from "./backend";
import type { ParticipantConfig, RoomEvent, RoomOptions, RoomSnapshot, RoomState } from "./types";

export async function loadRoomState(backend: Backend, id: string, participants: ParticipantConfig[], options: RoomOptions, cwd: string): Promise<RoomState> {
  const unsupported = (error: unknown) => /unknown variant [`'"]?room_state|unknown command.*room_state|unsupported.*room_state/i.test(String(error));
  if (backend.roomState) {
    try { return { ...await backend.roomState(id), live: true }; }
    catch (error) {
      // Only a genuinely missing room can require creation. Authorization and
      // connection failures must reach the caller without attempting a write.
      if (!unsupported(error) && !/no group chat with id/i.test(String(error))) throw error;
      if (unsupported(error)) {
        const snapshot = await backend.roomCreate(id, participants, options, cwd);
        return { snapshot, active: [], approvals: [], live: false };
      }
    }
  }
  const snapshot = await backend.roomCreate(id, participants, options, cwd);
  if (backend.roomState) return { ...await backend.roomState(id), live: true };
  return { snapshot, active: [], approvals: [], live: false };
}

export const WAITING_FOR_OWNER = "Waiting for Deck…";

/** Structured check for the attach-mode waiting state. The component keys its
 *  retry loop on this boolean, never on display text. */
export function isWaitingForOwner(error: unknown): boolean {
  return String(error).includes("Waiting for Deck");
}

/** Read-only room read for pop-out windows: subscribe and read, never create. A
 *  missing room means the owner hasn't opened it (yet), so the view waits for
 *  the owner instead of resurrecting the room itself. Reconnect and the
 *  attach retry loop retry. */
export async function loadRoomAttach(backend: Backend, id: string): Promise<RoomState> {
  if (!backend.roomState) throw new Error(WAITING_FOR_OWNER);
  try {
    return { ...await backend.roomState(id), live: true };
  } catch (error) {
    if (/no group chat with id/i.test(String(error))) throw new Error(WAITING_FOR_OWNER);
    throw error;
  }
}

/** Attach mode's retry loop: while the owner hasn't opened the room, try again after 2s, 4s,
 *  then every 8s, until a read succeeds (reset) or the view goes away (dispose). Each try is the
 *  caller's read-only refresh, so the loop never creates the room. */
export function createAttachRetry(retry: () => void, delays: readonly number[] = [2000, 4000, 8000]) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let misses = 0; let disposed = false;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  return {
    missed() {
      stop();
      if (disposed) return;
      timer = setTimeout(() => { timer = null; retry(); }, delays[Math.min(misses++, delays.length - 1)]);
    },
    reset() { stop(); misses = 0; },
    dispose() { disposed = true; stop(); },
  };
}

/** Old helpers have no event boundary: reread durable totals instead of adding replayed deltas. The room is already open. */
export async function loadRoomTotals(backend: Backend, id: string): Promise<Pick<RoomSnapshot, "usage" | "changes">> {
  const snapshot = await backend.roomCreate(id, [], { policy: "mention", max_bot_hops: 0 }, "");
  return { usage: snapshot.usage ?? {}, changes: snapshot.changes ?? [] };
}

/** Cursorless helpers return full snapshots: allow one read, plus one pending reread for a burst. */
export function createRoomTotalsRefresh<T>({ load, apply, fail }: {
  load(): Promise<T>; apply(state: T): void; fail(error: unknown): void;
}) {
  let disposed = false; let dirty = false; let inFlight: Promise<void> | null = null;
  const drain = async () => {
    while (dirty && !disposed) {
      dirty = false;
      try { const state = await load(); if (!disposed) apply(state); }
      catch (error) { if (!disposed) fail(error); }
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    dirty = true;
    if (!inFlight) inFlight = drain().finally(() => {
      inFlight = null;
      if (dirty && !disposed) return refresh();
    });
    return inFlight;
  };
  return {
    refresh,
    dispose() { disposed = true; dirty = false; },
  };
}

export function createRoomRecovery<T, E = never>({ load, apply, fail, event, represented }: {
  load(): Promise<T>; apply(state: T): void; fail(error: unknown): void; event?(event: E): void;
  represented?(state: T, event: E): boolean;
}) {
  let generation = 0; let disposed = false; let loading = false; let complete = false; let buffered: E[] = [];
  return {
    pending: () => !complete,
    // Events may arrive after the listener is attached and before refresh starts.
    // Keep them until a successful snapshot establishes which ones it represents.
    capture(value: E): boolean { if (complete && !loading) return false; buffered.push(value); return true; },
    async refresh(): Promise<void> {
      const ticket = ++generation; loading = true; complete = false;
      try {
        const state = await load();
        if (disposed || ticket !== generation) return;
        apply(state); const events = buffered; buffered = []; loading = false;
        events.filter(e => !represented?.(state, e)).forEach(e => event?.(e)); complete = true;
      } catch (error) { if (!disposed && ticket === generation) { loading = false; buffered = []; fail(error); } }
    },
    dispose() { disposed = true; generation++; loading = false; buffered = []; },
  };
}

/** The snapshot covers durable events and live requests, but not streaming text. */
export function representedRoomEvent(state: RoomState, event: RoomEvent): boolean {
  if (state.recovery_seq == null || event.recovery_seq == null || event.recovery_seq > state.recovery_seq) return false;
  switch (event.type) {
    case "message_added": case "usage": case "changed": case "allowed_changed": case "compacted": case "curations_changed":
    case "turn_started": case "participant_idle": case "approval_requested": case "approval_resolved": case "idle": case "stopped":
    case "question_requested": case "question_resolved": case "next_steps": case "plan_changed": case "participant_changed": case "participants_changed":
      return true;
    case "delta": case "activity": return !state.active.includes(event.id);
    default: return false;
  }
}

export function messageDedup() {
  const seen = new Set<number>();
  return {
    restore(messages: readonly { seq: number }[]) { seen.clear(); messages.forEach(m => seen.add(m.seq)); },
    accept(seq: number) { if (seen.has(seq)) return false; seen.add(seq); return true; },
    truncate(from: number) { for (const seq of seen) if (seq >= from) seen.delete(seq); },
  };
}

/** Message sequence is authoritative when snapshot and in-flight events overlap. */
export function containsMessage(snapshot: RoomSnapshot, seq: number): boolean { return snapshot.transcript.some(m => m.seq === seq); }
