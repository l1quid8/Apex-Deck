import type { CallScope, VoiceCandidate, VoiceState, VoiceSettings, ThreadVoiceBridge } from "./types.ts";
import { connectRealtime, buildRealtimeInstructions, type RealtimeDependencies } from "./realtimeClient.ts";

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
  let callGen = 0;
  let scope: CallScope | undefined;
  let pcClient: import("./realtimeClient.ts").RealtimeClient | undefined;
  let remoteAudio: HTMLAudioElement | undefined;
  let localStream: MediaStream | undefined;
  let startedAt: number | undefined;
  let abortController: AbortController | undefined;
  let pendingScope: CallScope | undefined;

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
    callGen++; // invalidate any pending startup
    try { abortController?.abort(); } catch {}
    abortController = undefined;
    pendingScope = undefined;
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
    const gen = ++callGen;
    abortController = new AbortController();
    const signal = abortController.signal;
    callId = crypto.randomUUID();
    scope = nextScope;
    startedAt = Date.now();
    set({ status: "warming", scope: nextScope, startedAt, muted: false, error: undefined });

    let micStream: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (gen !== callGen || signal.aborted) {
        for (const t of stream.getTracks()) try { t.stop(); } catch {}
        return;
      }
      micStream = stream;
      localStream = stream;

      const audioEl = new Audio();
      audioEl.autoplay = true;
      remoteAudio = audioEl;

      const rDeps: RealtimeDependencies = {
        candidates: deps.candidates,
        bridge: deps.bridge,
        voiceSettings: deps.voiceSettings,
        mintSession: deps.mintSession,
      };

      // Capture THIS call's mic stream – prevents stale A attaching B's mic.
      const thisMicStream = micStream;
      const client = await connectRealtime(
        rDeps,
        nextScope,
        {
          onEvent: (e) => {
            if (gen !== callGen) return;
            const type = e.type as string;
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
            if (gen !== callGen) return;
            if (remoteAudio) {
              remoteAudio.srcObject = stream;
              remoteAudio.play().catch(() => {});
              set({ status: "speaking" });
            }
          },
          onError: (error) => {
            if (gen !== callGen) return;
            if (state.status !== "off") {
              const failed = scope;
              void end("error: " + error.message).finally(() => set({ status: "error", scope: failed, error: error.message }));
            }
          },
          onClose: () => {
            if (gen !== callGen) return;
            if (callId && state.status !== "off") {
              void end("realtime closed");
            }
          },
        },
        {
          muted: () => state.muted,
          stream: () => thisMicStream,
        },
        { signal }
      );

      if (gen !== callGen || signal.aborted) {
        try { client.close("superseded"); } catch {}
        if (micStream) {
          for (const t of micStream.getTracks()) try { t.stop(); } catch {}
          if (localStream === micStream) localStream = undefined;
        }
        return;
      }

      pcClient = client;
      // If a switch happened during startup, apply latest default.
      // Client onopen already uses liveScope for opening instructions,
      // and queued sends are drained there. We still setDefault now and
      // re-send if channel already open (send queues otherwise).
      if (pendingScope) {
        const ps = pendingScope;
        pendingScope = undefined;
        scope = ps;
        set({ scope: ps });
        try { pcClient.setDefault(ps); } catch {}
        try {
          const allCands = deps.candidates().filter(c => c.hostId === ps.hostId && c.roomId === ps.roomId);
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: buildRealtimeInstructions(allCands, ps) } } as any);
        } catch {}
      } else if (scope && (scope.participantId !== nextScope.participantId || scope.roomId !== nextScope.roomId)) {
        const latestScope = scope;
        try {
          pcClient.setDefault(latestScope);
          const allCands = deps.candidates().filter(c => c.hostId === latestScope.hostId && c.roomId === latestScope.roomId);
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: buildRealtimeInstructions(allCands, latestScope) } } as any);
        } catch {}
      }
      set({ status: "listening", voices: [] });
      deps.focus(scope ?? nextScope);
    } catch (e) {
      if (gen !== callGen) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (micStream) {
        for (const t of micStream.getTracks()) try { t.stop(); } catch {}
      }
      await end("start failed");
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", scope: nextScope, error: msg });
    }
  };

  const switchAgent = async (next: CallScope) => {
    if (!callId) return start(next);
    const prevScope = scope;
    if (prevScope && prevScope.hostId === next.hostId && prevScope.roomId === next.roomId) {
      const allCands = deps.candidates().filter(c => c.hostId === next.hostId && c.roomId === next.roomId);
      const fullInstructions = buildRealtimeInstructions(allCands, next);
      scope = next;
      set({ scope: next });
      deps.focus(next);
      if (pcClient) {
        try { pcClient.setDefault(next); } catch {}
        try {
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: fullInstructions } } as any);
        } catch {}
      } else {
        // Still in startup – queue scope, client onopen will use liveScope
        pendingScope = next;
      }
      return;
    }
    await end("switch");
    await start(next);
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
      // Realtime voices preview via a short sample? For now no-op
    },
    sample: (_voice: string) => Promise.reject(new Error("Samples use local voices. Switch engine to Local.")),
    stopSample: () => Promise.resolve(),
  };
}

export type RealtimeVoiceController = ReturnType<typeof createRealtimeVoiceController>;
