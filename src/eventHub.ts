import type { Backend } from "./backend";
import type { RoomEvent } from "./types";
export type PtyHandlers = { onData: (data: string) => void; onExit: (code: number | null) => void };
interface Hooks {
  approval?(host: string, room: string, event: RoomEvent): void;
  plan?(host: string, event: RoomEvent): void;
  roomEvent?(host: string, room: string, event: RoomEvent): void;
  toolCall?(host: string, room: string, event: Extract<RoomEvent, { type: "approval_requested" }>): Promise<string | null>;
  notice?(message: string): void;
}
export function createEventHub(hooks: Hooks) {
  const rooms = new Map<string, (event: RoomEvent) => void>(); const ptys = new Map<string, PtyHandlers>();
  const subscriptions = new Map<string, { refs: number; promise: Promise<(() => void)[]> }>();
  const key = (host: string, id: string) => JSON.stringify([host, id]);
  return {
    async start(backend: Backend, host = "local"): Promise<() => void> {
      let state = subscriptions.get(host);
      if (!state) {
        const off: (() => void)[] = [];
        const promise = (async () => {
          try {
            off.push(await backend.onPtyData((id, data) => ptys.get(key(host, id))?.onData(data)));
            off.push(await backend.onPtyExit((id, code) => ptys.get(key(host, id))?.onExit(code)));
            off.push(await backend.onRoomEvent((room, event) => {
              if (event.type === "plan_usage") hooks.plan?.(host, event);
              const handler = rooms.get(key(host, room));
              if (!handler) return; // no global state may be changed by an unbound room
              hooks.approval?.(host, room, event); handler(event); hooks.roomEvent?.(host, room, event);
              if (event.type === "approval_requested" && hooks.toolCall) {
                void hooks.toolCall(host, room, event).then(deny => {
                  if (deny && rooms.get(key(host, room)) === handler) return backend.roomDecide(room, event.request, false).then(() => hooks.notice?.(deny));
                }).catch(() => {});
              }
            }));
            return off;
          } catch (e) { off.forEach(fn => fn()); subscriptions.delete(host); throw e; }
        })();
        state = { refs: 0, promise }; subscriptions.set(host, state);
      }
      state.refs++; const off = await state.promise; let active = true;
      return () => { if (!active) return; active = false; if (--state.refs === 0) { subscriptions.delete(host); off.forEach(fn => fn()); } };
    },
    registerRoom(id: string, handler: (event: RoomEvent) => void, host = "local") {
      const k = key(host, id); rooms.set(k, handler);
      return () => { if (rooms.get(k) === handler) rooms.delete(k); };
    },
    registerPty(id: string, handlers: PtyHandlers, host = "local") {
      const k = key(host, id); ptys.set(k, handlers);
      return () => { if (ptys.get(k) === handlers) ptys.delete(k); };
    },
  };
}
