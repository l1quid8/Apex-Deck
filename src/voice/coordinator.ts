import { createVoiceController, type VoiceController } from "./controller.ts";
import { openVoiceAudio, playVoiceSample } from "./audio.ts";
import { connectLocalVoice } from "./localClient.ts";
import { readVoiceSettings, voiceFor } from "./settings.ts";
import type {
  CallEngine,
  CallScope,
  ThreadVoiceBridge,
  VoiceCandidate,
  VoiceSettings,
} from "./types.ts";
import { createRealtimeVoiceController } from "./realtimeController.ts";
import { joinVoiceEngines } from "./engineController.ts";

export interface VoiceRegistration {
  candidates: VoiceCandidate[];
  bridge(id: string): ThreadVoiceBridge;
  settings: VoiceSettings;
  save(settings: VoiceSettings): void;
  focus(): void;
  /** Mint a realtime session (ephemeral token) via daemon. */
  realtimeSession?(args: {
    room: string;
    participant?: string;
    model?: string;
    voice?: string;
    instructions?: string;
    tools?: unknown[];
  }): Promise<{ client_secret: string; expires_at?: number; model: string; voice: string }>;
}

const registry = new Map<string, VoiceRegistration>();
export const scopeKey = (scope: Pick<CallScope, "hostId" | "roomId">) =>
  JSON.stringify([scope.hostId, scope.roomId]);
const lookup = (scope: CallScope) => {
  const entry = registry.get(scopeKey(scope));
  if (!entry) throw Error("The call thread is no longer open");
  return entry;
};
const runtime = () => {
  const r = window.apexDeck?.voice;
  // For realtime engine, local runtime may be absent – allow calls to proceed without it.
  // Local engine will still error if missing when used.
  if (!r) throw Error("Open the desktop app to use local calls");
  return r;
};
// Mic hover: start loading Whisper + Kokoro so the call opens without the warm-up wait.
let lastWarm = 0;
export function warmVoice() {
  const now = Date.now();
  if (now - lastWarm < 30000) return;
  lastWarm = now;
  void window.apexDeck?.voice?.warm?.().catch(() => {});
}

/* ---- local engine ---- */
let localController: ReturnType<typeof createVoiceController>;
localController = createVoiceController({
  runtime: {
    status: () => runtime().status(),
    start: () => runtime().start(),
    stop: () => runtime().stop(),
  },
  openAudio: openVoiceAudio,
  playSample: playVoiceSample,
  connect: connectLocalVoice,
  candidates: () => [...registry.values()].flatMap((r) => r.candidates),
  bridge: (scope: CallScope) => lookup(scope).bridge(scope.participantId),
  voice: (scope: CallScope) => {
    const e = lookup(scope),
      c = e.candidates.find((c) => c.participantId === scope.participantId);
    return voiceFor(
      e.settings,
      scope.hostId,
      c?.profileId ?? scope.participantId,
      scope.roomId,
      scope.participantId,
      c?.agentVoice,
    );
  },
  silence: (): number => {
    const s = localController?.getState().scope;
    return s ? lookup(s).settings.silenceMs : 100;
  },
  focus: (scope: CallScope) => lookup(scope).focus(),
} as any);

/* ---- realtime engine ---- */
const realtimeController = createRealtimeVoiceController({
  candidates: () => [...registry.values()].flatMap((r) => r.candidates),
  bridge: (scope) => lookup(scope).bridge(scope.participantId),
  voiceSettings: () => {
    const scope = realtimeController.getState().scope ?? localController.getState().scope;
    if (scope) {
      try {
        return lookup(scope).settings;
      } catch {}
    }
    // Fallback to any registered settings, or defaults
    const any = [...registry.values()][0]?.settings;
    return any ?? readVoiceSettings(undefined);
  },
  mintSession: async (args) => {
    const entry = args.room
      ? registry.get(scopeKey({ hostId: "local", roomId: args.room } as any)) ??
        [...registry.values()].find(r => r.candidates.some(c => c.roomId === args.room))
      : [...registry.values()][0];
    if (!entry?.realtimeSession) throw new Error("Realtime not available for this thread – update Deck and ensure OPENAI_API_KEY is set.");
    return entry.realtimeSession(args);
  },
  focus: (scope) => lookup(scope).focus(),
});

/* ---- unified controller that picks engine based on settings ---- */
function currentEngineFor(scope: CallScope): CallEngine {
  try {
    return lookup(scope).settings.engine ?? "local";
  } catch {
    return "local";
  }
}

const joined = joinVoiceEngines(localController as VoiceController, realtimeController, currentEngineFor);
export const voiceController: VoiceController = joined.controller;
export const callEngine = joined.engine;

// A thread view that only reloads (reconnect, new backend) registers again at
// once; the call ends only if its thread stays gone past this grace period.
const CLOSE_GRACE_MS = 3000;
const closing = new Map<string, ReturnType<typeof setTimeout>>();
export function registerVoiceThread(key: string, entry: VoiceRegistration) {
  const timer = closing.get(key);
  if (timer !== undefined) clearTimeout(timer);
  closing.delete(key);
  const registration: VoiceRegistration = {
    ...entry,
    save(settings) {
      for (const current of registry.values()) current.settings = settings;
      registration.settings = settings;
      entry.save(settings);
    },
    realtimeSession: entry.realtimeSession,
  };
  registry.set(key, registration);
}
export function unregisterVoiceThread(key: string) {
  registry.delete(key);
  const scope = voiceController.getState().scope;
  if (!scope || scopeKey(scope) !== key || closing.has(key)) return;
  closing.set(
    key,
    setTimeout(() => {
      closing.delete(key);
      const now = voiceController.getState().scope;
      if (!registry.has(key) && now && scopeKey(now) === key)
        void voiceController.end("thread closed");
    }, CLOSE_GRACE_MS),
  );
}
export function voiceRegistration(scope: CallScope) {
  return lookup(scope);
}
export const defaultVoiceSettings = () => readVoiceSettings(undefined);
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void voiceController.end("window closed"));
  window.apexDeck?.voice?.onSuspend(() => void voiceController.end("Mac went to sleep"));
}
