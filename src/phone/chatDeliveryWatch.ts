import type { Backend } from "../backend.ts";
import type { HostConnectionStore } from "../hostConnections.ts";
import type { RoomEvent } from "../types.ts";
import type { ChatDeliveryController } from "../chatDelivery.ts";

export interface ChatDeliveryWatchHost {
  machine: { id: string };
  backend: Pick<Backend, "onRoomEvent">;
  connection: HostConnectionStore;
}

/** Task3 mounts this once for its current host objects, with the same controller
 * that handles Send. Reconnect recovers the journal, source answers and cache.
 * Completed messages trigger a refresh; streaming tokens never cause disk/RPC churn. */
export function watchChatDelivery(
  controller: Pick<ChatDeliveryController, "reconnect">,
  hosts: readonly ChatDeliveryWatchHost[],
  onError: (error: unknown) => void,
): { ready: Promise<void>; stop(): void } {
  let closed = false;
  const cleanup: (() => void)[] = [];
  const starts: Promise<unknown>[] = [];
  const report = (error: unknown) => { if (!closed) onError(error); };
  for (const host of hosts) {
    let dirty = false;
    let running: Promise<void> | null = null;
    const online = () => ["connected", "resync"].includes(host.connection.get().status.kind);
    const refresh = (): Promise<void> => {
      if (closed || !online()) return Promise.resolve();
      dirty = true;
      if (running) return running;
      running = Promise.resolve().then(async () => {
        while (dirty && !closed && online()) {
          dirty = false;
          await controller.reconnect(host.machine.id);
        }
      }).catch(report).finally(() => { running = null; });
      return running;
    };
    let status = host.connection.get().status.kind;
    cleanup.push(host.connection.subscribe(() => {
      const next = host.connection.get().status.kind;
      if (next === status) return;
      const previous = status;
      status = next;
      // Stores with recovery barriers invoke refresh for both connected and
      // resync. Subscribing as well would run every recovery twice.
      if (!host.connection.recover && (next === "connected" || next === "resync")) void refresh();
      // Writes are held during resync. The barrier's read phase must be
      // followed by a writable pass once connected, even on recovery stores.
      else if (next === "connected" && previous === "resync") void refresh();
    }));
    const recovered = host.connection.recover?.(refresh, () => true);
    if (recovered) cleanup.push(recovered);
    const listen = host.backend.onRoomEvent((_room, raw) => {
      const event: RoomEvent = raw.type === "voice_event" ? raw.event : raw;
      if (["message_added", "idle", "failed"].includes(event.type)) void refresh();
    }).then(unlisten => {
      if (closed) unlisten();
      else cleanup.push(unlisten);
    }).catch(report);
    starts.push(listen);
    if (online()) starts.push(refresh());
  }
  return {
    ready: Promise.all(starts).then(() => {}),
    stop() {
      if (closed) return;
      closed = true;
      cleanup.splice(0).forEach(unlisten => unlisten());
    },
  };
}
