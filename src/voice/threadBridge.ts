import type { Backend, Unlisten } from "../backend.ts";
import type {
  BridgeEvent,
  CallScope,
  ThreadVoiceBridge,
  VoiceTurn,
} from "./types.ts";
export function createThreadVoiceBridge(deps: {
  backend: Backend;
  scope: CallScope;
  enqueue: (turn: VoiceTurn, isCanceled: () => boolean) => Promise<unknown>;
  remove: (requestId: string) => boolean;
}): ThreadVoiceBridge & {
  dispose(): void;
  fail(requestId: string, error: unknown): void;
} {
  const requests = new Map<
    string,
    {
      last: number;
      canceled: boolean;
      done: boolean;
      waiters: (() => void)[];
      accepting?: Promise<unknown>;
      accepted?: boolean;
    }
  >();
  const listeners = new Set<(e: BridgeEvent) => void>();
  let unlisten: Unlisten | undefined;
  let disposed = false;
  const emit = (
    requestId: string,
    type: BridgeEvent["type"],
    text?: string,
  ) => {
    for (const fn of listeners)
      fn({ requestId, scope: deps.scope, type, text });
  };
  const listening = deps.backend
    .onRoomEvent((room, event) => {
      if (
        room !== deps.scope.roomId ||
        event.type !== "voice_event" ||
        event.id !== deps.scope.participantId
      )
        return;
      const r = requests.get(event.client_turn_id);
      if (!r || r.done) return;
      if (event.recovery_seq !== undefined) {
        if (event.recovery_seq <= r.last) return;
        r.last = event.recovery_seq;
      }
      const e = event.event,
        id = event.client_turn_id;
      if (e.type === "participant_idle") {
        r.done = true;
        emit(id, r.canceled ? "canceled" : "done");
        r.waiters.splice(0).forEach((fn) => fn());
        if (disposed && [...requests.values()].every((r) => r.done))
          unlisten?.();
      } else if (!r.canceled) {
        if (e.type === "turn_started") emit(id, "started");
        else if (e.type === "delta") emit(id, "text", e.text);
        else if (e.type === "failed") {
          emit(id, "failed", e.error);
        } else if (e.type === "approval_requested") emit(id, "approval");
        else if (e.type === "question_requested") emit(id, "question");
      }
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
  return {
    async submit(turn) {
      if (disposed) throw Error("Voice thread closed");
      if (
        turn.scope.hostId !== deps.scope.hostId ||
        turn.scope.roomId !== deps.scope.roomId ||
        turn.scope.participantId !== deps.scope.participantId
      )
        throw Error("Voice recipient changed");
      if (requests.has(turn.requestId)) return { requestId: turn.requestId };
      const record = {
        last: 0,
        canceled: false,
        done: false,
        waiters: [] as (() => void)[],
        accepting: undefined as Promise<unknown> | undefined,
        accepted: false,
      };
      requests.set(turn.requestId, record);
      const canceled = () => record.canceled || disposed;
      record.accepting = (async () => {
        if (
          !deps.backend.voiceCapabilities ||
          !(await deps.backend.voiceCapabilities()).voice_turn_correlation_v1
        )
          throw Error("Update this host to call agents with voice");
        await listening;
        if (canceled()) return;
        await deps.enqueue(turn, canceled);
        record.accepted = true;
      })();
      try {
        await record.accepting;
      } catch (e) {
        record.done = true;
        if (!canceled()) throw e;
      }
      return { requestId: turn.requestId };
    },
    async cancel(id) {
      const r = requests.get(id);
      if (!r || r.done) return;
      r.canceled = true;
      await r.accepting?.catch(() => {});
      if (!r.accepted) {
        r.done = true;
        return;
      }
      if (deps.remove(id)) {
        r.done = true;
        emit(id, "canceled");
        return;
      }
      if (!deps.backend.roomStopRequest)
        throw Error("Host cannot cancel a voice request safely");
      const result = await deps.backend.roomStopRequest(
        deps.scope.roomId,
        deps.scope.participantId,
        id,
      );
      if (result === "already-ended") {
        r.done = true;
        return;
      }
      if (result !== "stopped")
        throw Error(
          "Voice request state uncertain; end this call before retrying",
        );
      if (r.done) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(Error("Agent cleanup timed out; no replacement was sent")),
          30000,
        );
        r.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fail: (id, error) => {
      const r = requests.get(id);
      if (r && !r.done) {
        r.done = true;
        r.waiters.splice(0).forEach((fn) => fn());
        emit(id, "failed", String(error));
      }
    },
    dispose: () => {
      disposed = true;
      // Keep listeners while a reply is in flight so a reloading thread view
      // still delivers it to the call.
      if ([...requests.values()].every((r) => r.done)) {
        unlisten?.();
        listeners.clear();
      } else
        setTimeout(() => {
          unlisten?.();
          listeners.clear();
        }, 30000);
    },
  };
}
