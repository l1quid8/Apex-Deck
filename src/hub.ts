// One listener per event type for the whole app, fanned out by id. Panes
// register here instead of each adding its own global listener.

import { recordApproval } from "./approvals";
import type { Backend } from "./backend";
import { recordPlan } from "./plans";
import { modHost } from "./mods/host";
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
    // So are open approval cards, and the store hears first, so a thread
    // reading it while handling this event sees the card already.
    recordApproval(room, event);
    rooms.get(room)?.(event);
    modHost.roomEvent(room, event);
    // A mod allowed to see the session may refuse a call waiting on approval.
    if (event.type === "approval_requested") {
      void modHost.toolCall(room, event.id, event.action).then((deny) => {
        if (deny) return backend.roomDecide(room, event.request, false).then(() => modHost.notice(deny));
      }).catch(() => {});
    }
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
