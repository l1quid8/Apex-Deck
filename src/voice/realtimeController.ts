import type { CallScope, VoiceCandidate, VoiceState, VoiceSettings, ThreadVoiceBridge } from "./types.ts";
import { connectRealtime, type RealtimeDependencies } from "./realtimeClient.ts";

export interface RealtimeControllerDeps {
  candidates(): VoiceCandidate[];
  bridge(scope: CallScope): ThreadVoiceBridge;
  voiceSettings(): VoiceSettings;
  mintSession(args: { room: string; participant?: string; model?: string; voice?: string; instructions?: string; tools?: unknown[] }): Promise<{ client_secret: string; expires_at?: number; model: string; voice: string }>;
  focus(scope: CallScope): void;
}

export function createRealtimeVoiceController(deps: RealtimeControllerDeps) {
  let state: VoiceState = { status: "off", muted: false, voices: [] };
  const listeners = new Set<() => void>();
  let callId = "";
  let scope: CallScope | undefined;
  let pcClient: import("./realtimeClient.ts").RealtimeClient | undefined;
  let remoteAudio: HTMLAudioElement | undefined;
  let localStream: MediaStream | undefined;
  let startedAt: number | undefined;

  const set = (patch: Partial<VoiceState>) => {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
  };

  const cleanupMedia = () => {
    try { remoteAudio?.pause(); } catch {}
    remoteAudio = undefined;
    if (localStream) {
      for (const t of localStream.getTracks()) try { t.stop(); } catch {}
      localStream = undefined;
    }
  };

  const end = async (reason = "ended by user") => {
    if (callId || state.status !== "off") console.warn("[voice realtime end] " + JSON.stringify({ callId, reason, status: state.status }));
    const wasCall = callId;
    callId = "";
    scope = undefined;
    startedAt = undefined;
    pcClient?.close(reason);
    pcClient = undefined;
    cleanupMedia();
    set({ status: "off", scope: undefined, startedAt: undefined, muted: false, candidates: undefined, threadQuery: undefined, error: undefined });
    return wasCall ? Promise.resolve() : Promise.resolve();
  };

  const start = async (nextScope: CallScope) => {
    await end("new call started");
    callId = crypto.randomUUID();
    scope = nextScope;
    startedAt = Date.now();
    set({ status: "warming", scope: nextScope, startedAt, muted: false, error: undefined });

    try {
      // Get mic stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      localStream = stream;

      // Prepare remote audio element
      const audioEl = new Audio();
      audioEl.autoplay = true;
      remoteAudio = audioEl;

      const rDeps: RealtimeDependencies = {
        candidates: deps.candidates,
        bridge: deps.bridge,
        voiceSettings: deps.voiceSettings,
        mintSession: deps.mintSession,
      };

      const client = await connectRealtime(
        rDeps,
        nextScope,
        {
          onEvent: (e) => {
            const type = e.type as string;
            // Map some realtime events to VoiceState
            if (type === "input_audio_buffer.speech_started") {
              set({ status: "hearing" });
            } else if (type === "input_audio_buffer.speech_stopped" || type === "input_audio_buffer.committed") {
              set({ status: "waiting" });
            } else if (type === "response.audio.delta" || type === "response.audio_transcript.delta" || type === "response.output_audio.delta") {
              set({ status: "speaking" });
            } else if (type === "response.done" || type === "response.audio.done" || type === "input_audio_buffer.cleared") {
              set({ status: "listening" });
            } else if (type === "error") {
              console.warn("[realtime error]", e);
            }
          },
          onAudio: (stream) => {
            if (remoteAudio) {
              remoteAudio.srcObject = stream;
              // Ensure playing
              remoteAudio.play().catch(() => {});
              set({ status: "speaking" });
            }
          },
          onError: (error) => {
            if (state.status !== "off") {
              void end("error: " + error.message).finally(() => set({ status: "error", scope, error: error.message }));
            }
          },
          onClose: () => {
            if (callId && state.status !== "off") {
              void end("realtime closed");
            }
          },
        },
        {
          muted: () => state.muted,
          stream: () => localStream ?? null,
        }
      );

      pcClient = client;
      set({ status: "listening", voices: [] });
      deps.focus(nextScope);
    } catch (e) {
      await end("start failed");
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", scope: nextScope, error: msg });
    }
  };

  const switchAgent = async (next: CallScope) => {
    if (!callId) return start(next);
    // Switching only moves the call – agent work keeps going (same as local).
    // For realtime, we need to update default agent in session but keep peer alive.
    // Simplest: restart realtime session with new default, without canceling prior agents.
    const prevCall = callId;
    const prevScope = scope;
    if (prevScope && prevScope.hostId === next.hostId && prevScope.roomId === next.roomId) {
      // Same thread, different agent – just update state, keep connection
      scope = next;
      set({ scope: next });
      deps.focus(next);
      // Tell realtime about switch via data channel message if possible
      pcClient?.send({ type: "session.update", session: { instructions: `Default agent now ${next.participantId}` } } as any);
      return;
    }
    // Cross-thread switch: end and start new realtime call
    await end("switch");
    if (prevCall) {
      await start(next);
    }
  };

  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
    end,
    switchAgent,
    mute(value: boolean) {
      set({ muted: value });
      if (localStream) {
        for (const t of localStream.getAudioTracks()) t.enabled = !value;
      }
    },
    preview(_voice: string) {
      // Realtime voices preview via a short sample? For now no-op: we could speak via TTS API separately.
      // Leave empty – UI disables preview when realtime engine selected.
    },
    sample: (_voice: string) => Promise.reject(new Error("Samples use local voices. Switch engine to Local.")),
    stopSample: () => Promise.resolve(),
  };
}

export type RealtimeVoiceController = ReturnType<typeof createRealtimeVoiceController>;
