// One listener per event type for the whole app, fanned out by id. Panes
// register here instead of each adding its own global listener.

import type { Backend } from "./backend";
import { recordPlan } from "./plans";
import type { RoomEvent } from "./types";

type PtyHandlers = { onData: (data: string) => void; onExit: (code: number | null) => void };

const ptys = new Map<string, PtyHandlers>();
const rooms = new Map<string, (event: RoomEvent) => void>();
let started = false;

export async function startHub(backend: Backend): Promise<void> {
  if (started) return;
  started = true;
  await backend.onPtyData((id, data) => ptys.get(id)?.onData(data));
  await backend.onPtyExit((id, code) => ptys.get(id)?.onExit(code));
  await backend.onRoomEvent((room, event) => {
    // A provider's plan is the same in every chat, so it is kept app-wide.
    if (event.type === "plan_usage") recordPlan(event.provider, event.windows, event.partial);
    rooms.get(room)?.(event);
  });
}

export function registerPty(id: string, handlers: PtyHandlers): () => void {
  ptys.set(id, handlers);
  return () => {
    if (ptys.get(id) === handlers) ptys.delete(id);
  };
}

export function registerRoom(id: string, handler: (event: RoomEvent) => void): () => void {
  rooms.set(id, handler);
  return () => {
    if (rooms.get(id) === handler) rooms.delete(id);
  };
}
