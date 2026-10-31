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
  /** Runs before a call opens. Ending the call while this waits cancels the start. */
  prepare: (scope: CallScope) => Promise<void> = async () => {},
) {
  // Every start and end moves this on, so a start still waiting can see it was overtaken.
  let latest = 0;
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
      const mine = ++latest;
      await prepare(scope);
      if (mine !== latest) return;
      if (engineFor(scope) === "realtime") {
        await local.end("switch to realtime");
        if (mine !== latest) return;
        return realtime.start(scope);
      }
      await realtime.end("switch to local");
      if (mine !== latest) return;
      return local.start(scope);
    },
    end: async (reason?: string) => {
      latest++;
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
    /** For a wait before `start`: the check turns false once the call is ended or another starts. */
    startWanted: () => {
      const mine = latest;
      return () => mine === latest;
    },
  };
}
