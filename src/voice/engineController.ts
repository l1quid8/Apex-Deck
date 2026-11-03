import type { VoiceController } from "./controller.ts";
import type { RealtimeVoiceController } from "./realtimeController.ts";
import type { CallEngine, CallScope } from "./types.ts";

type AnyEngineController = VoiceController<any> | RealtimeVoiceController | { getState(): any; subscribe(fn: () => void): () => void; start(scope: CallScope): Promise<void>; end(reason?: string): Promise<void>; switchAgent(scope: CallScope): Promise<void>; mute(value: boolean): void };

/**
 * One call controller over N engines. A new call picks its engine with `engineFor`;
 * everything else goes to whichever engine is running the call.
 */
export function joinVoiceEngines<R>(
  local: VoiceController<R>,
  realtime: RealtimeVoiceController,
  engineFor: (scope: CallScope) => CallEngine,
  /** Runs before a call opens. Ending the call while this waits cancels the start. */
  prepare: (scope: CallScope) => Promise<void> = async () => {},
  meta?: AnyEngineController,
) {
  const engines = { local, realtime, ...(meta ? { meta } : {}) } as Record<string, AnyEngineController>;
  // Every start and end moves this on, so a start still waiting can see it was overtaken.
  let latest = 0;
  const running = (): AnyEngineController => {
    if (local.getState().status !== "off") return local;
    if (realtime.getState().status !== "off") return realtime;
    if (meta && (meta as any).getState().status !== "off") return meta as any;
    return local;
  };
  const controller = {
    ...local,
    getState: () => running().getState(),
    subscribe: (fn: () => void) => {
      const off1 = local.subscribe(fn);
      const off2 = realtime.subscribe(fn);
      const off3 = meta ? (meta as any).subscribe(fn) : () => {};
      return () => { off1(); off2(); off3(); };
    },
    start: async (scope: CallScope) => {
      const mine = ++latest;
      await prepare(scope);
      if (mine !== latest) return;
      const target = engineFor(scope);
      // End others first
      const toEnd = Object.entries(engines).filter(([id]) => id !== target).map(([, c]) => c.end("switch engine"));
      await Promise.all(toEnd);
      if (mine !== latest) return;
      const engine = (engines as any)[target] ?? local;
      return engine.start(scope);
    },
    end: async (reason?: string) => {
      latest++;
      await Promise.all(Object.values(engines).map((c) => c.end(reason)));
    },
    switchAgent: (scope: CallScope) => running().switchAgent(scope),
    mute: (value: boolean) => {
      for (const c of Object.values(engines)) c.mute(value);
    },
  } as VoiceController<R>;
  return {
    controller,
    /** Which engine the running call uses; "local" when no call is on. */
    engine: (): CallEngine => {
      const r = running();
      if (r === realtime) return "realtime";
      if (meta && r === (meta as any)) return "meta";
      return "local";
    },
    /** For a wait before `start`: the check turns false once the call is ended or another starts. */
    startWanted: () => {
      const mine = latest;
      return () => mine === latest;
    },
  };
}
