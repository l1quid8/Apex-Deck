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
  let callGen = 0;
  let scope: CallScope | undefined;
  let pcClient: import("./realtimeClient.ts").RealtimeClient | undefined;
  let remoteAudio: HTMLAudioElement | undefined;
  let localStream: MediaStream | undefined;
  let startedAt: number | undefined;
  let abortController: AbortController | undefined;
  let pendingInstructions: string | undefined;

  const buildRealtimeInstructions = (forScope: CallScope): string => {
    const all = deps.candidates();
    const filtered = all.filter(c => c.hostId === forScope.hostId && c.roomId === forScope.roomId);
    const agentList = filtered.map(c => `- ${c.name} (id ${c.participantId})`).slice(0, 32).join("\n");
    const defaultTarget = filtered.find(c => c.participantId === forScope.participantId)?.name ?? filtered[0]?.name ?? "agent";
    return `You are GPT-Live inside Apex Deck, a voice interface for coding agents.
Default agent is "${defaultTarget}". Agents available in THIS thread only:
${agentList || "- none listed"}

Rules:
- Chat naturally. When the user asks to do work (code, search, file edit, research, questions about project), call ask_agent with the right agent and their request.
- To pick a different agent by voice, parse "ask <Name> to ..." or "call <Name>".
- If the user mentions an agent not in this thread's list, say that agent is not in this thread and ask who to use from the list.
- Keep your own small talk brief. Do not invent file contents.
- When an agent is working, say once that it's working, then stay quiet until the result arrives. Do not spam "On it."
- Speak the agent's final result closely, not adding extra facts.
- If you need to stop an agent's current reply, call stop_agent.
- Ending or muting the call never cancels agent work.
`;
  };

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
    pendingInstructions = undefined;
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
              void end("error: " + error.message).finally(() => set({ status: "error", scope, error: error.message }));
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
      // If a switch happened during startup, apply latest full instructions now.
      if (pendingInstructions) {
        const instr = pendingInstructions;
        pendingInstructions = undefined;
        try {
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: instr } } as any);
        } catch {}
      } else if (scope && (scope.participantId !== nextScope.participantId || scope.roomId !== nextScope.roomId)) {
        // scope was updated mid-startup via switchAgent
        const latestScope = scope;
        try {
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: buildRealtimeInstructions(latestScope) } } as any);
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
    const prevCall = callId;
    const prevScope = scope;
    if (prevScope && prevScope.hostId === next.hostId && prevScope.roomId === next.roomId) {
      scope = next;
      set({ scope: next });
      deps.focus(next);
      const fullInstructions = buildRealtimeInstructions(next);
      if (pcClient) {
        try {
          pcClient.send({ type: "session.update", session: { type: "realtime", instructions: fullInstructions } } as any);
        } catch {}
      } else {
        // Still in startup (pcClient undefined) – queue for after connect
        pendingInstructions = fullInstructions;
      }
      return;
    }
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
