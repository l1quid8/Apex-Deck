import type { VoiceController } from "./controller.ts";
import type { RealtimeVoiceController } from "./realtimeController.ts";
import type { CallEngine, CallScope } from "./types.ts";

/**
 * One call controller over both engines. A new call picks its engine with `engineFor`;
 * everything else goes to whichever engine is running the call.
 */
export function joinVoiceEngines<R>(
  local: VoiceController<R>,
  realtime: RealtimeVoiceController,
  engineFor: (scope: CallScope) => CallEngine,
) {
  const running = (): VoiceController<R> | RealtimeVoiceController => {
    if (local.getState().status !== "off") return local;
    return realtime.getState().status !== "off" ? realtime : local;
  };
  const controller = {
    ...local,
    getState: () => running().getState(),
    subscribe: (fn: () => void) => {
      const off1 = local.subscribe(fn);
      const off2 = realtime.subscribe(fn);
      return () => { off1(); off2(); };
    },
    start: async (scope: CallScope) => {
      if (engineFor(scope) === "realtime") {
        await local.end("switch to realtime");
        return realtime.start(scope);
      }
      await realtime.end("switch to local");
      return local.start(scope);
    },
    end: async (reason?: string) => {
      await Promise.all([local.end(reason), realtime.end(reason)]);
    },
    switchAgent: (scope: CallScope) => running().switchAgent(scope),
    mute: (value: boolean) => {
      // Both, so the engine that isn't running shows the same state.
      local.mute(value);
      realtime.mute(value);
    },
  } as VoiceController<R>;
  return {
    controller,
    /** Which engine the running call uses; "local" when no call is on. */
    engine: (): CallEngine => (running() === realtime ? "realtime" : "local"),
  };
}
