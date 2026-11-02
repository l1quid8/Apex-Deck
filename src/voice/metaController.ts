/**
 * Meta Voice Transcribe controller – cloud STT via api.meta.ai + local Kokoro TTS via sidecar.
 * Mirrors controller.ts structure but delegates transcription to Meta ASR websocket.
 * TTS reuses the local helper's speak path so voice replies are still spoken via Kokoro.
 */
import type { CallScope, VoiceCandidate, VoiceState, VoiceSettings, ThreadVoiceBridge, VoiceRuntime, HelperEvent, VoiceTurn } from "./types.ts";
import type { VoiceAudio } from "./audio.ts";
import type { LocalVoiceClient } from "./localClient.ts";
import { resolveCallCommand } from "./routing.ts";
import { SpeechText } from "./speechText.ts";
import { connectMetaAsr, type MetaDependencies } from "./metaClient.ts";
import { DEFAULT_META_MODEL } from "./settings.ts";

export interface MetaControllerDeps {
  runtime: {
    status(): Promise<{ installed: boolean; supported: boolean; reason?: string }>;
    start(): Promise<VoiceRuntime>;
    stop(runtime?: VoiceRuntime): Promise<unknown>;
  };
  openAudio(
    onFrame: (pcm: Int16Array) => void,
    onDrain: (id: number) => void,
    onPlaying: () => void,
    onError: (error: Error) => void,
    onConsumed?: (bytes: number) => void,
  ): Promise<VoiceAudio>;
  connect(
    runtime: VoiceRuntime,
    event: (e: HelperEvent) => void,
    audio: (pcm: Int16Array, generation: number) => void,
    error: (e: Error) => void,
  ): Promise<LocalVoiceClient>;
  playSample?(pcm: Int16Array, sampleRate: number): { done: Promise<void>; stop(): void };
  candidates(): VoiceCandidate[];
  bridge(scope: CallScope): ThreadVoiceBridge;
  voice(scope: CallScope): string;
  silence(): number;
  voiceSettings(): VoiceSettings;
  mintSession(args: { hostId: string; room: string; participant?: string; model?: string }): Promise<{ token: string; model: string }>;
  focus(scope: CallScope): void;
}

const same = (a: CallScope, b: CallScope) =>
  a.hostId === b.hostId && a.roomId === b.roomId && a.participantId === b.participantId;

export function createMetaVoiceController(deps: MetaControllerDeps) {
  let state: VoiceState = { status: "off", muted: false, voices: [] };
  const listeners = new Set<() => void>();
  let runtimeAcquired: VoiceRuntime | undefined;
  let callId = "";
  let generation = 0;
  let epoch = 0;
  let segment = 0;
  let audio: VoiceAudio | undefined;
  let client: LocalVoiceClient | undefined;
  let metaAsr: import("./metaClient.ts").MetaClient | undefined;
  let metaAbort: AbortController | undefined;
  let active:
    | {
        id: string;
        scope: CallScope;
        bridge: ThreadVoiceBridge;
        unlisten: () => void;
        speech: SpeechText;
        failed: boolean;
      }
    | undefined;
  let cleanup: Promise<unknown> = Promise.resolve();
  const utterances = new Set<string>();
  let pendingSwitchText = "";
  const submittedAt = new Map<string, number>();
  const seenTiming = new Set<string>();
  const metric = (stage: string, ms: number, requestId?: string) => {
    if (typeof window !== "undefined" && Number.isFinite(ms) && ms >= 0)
      console.debug("[voice meta timing]", { callId, generation, requestId, stage, ms: Math.round(ms) });
  };
  const sinceSubmit = (stage: string, requestId: string) => {
    const key = requestId + ":" + stage;
    const at = submittedAt.get(requestId);
    if (at !== undefined && !seenTiming.has(key)) {
      seenTiming.add(key);
      metric(stage, performance.now() - at, requestId);
    }
  };
  const set = (patch: Partial<VoiceState>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const control = (message: Record<string, unknown>) => client?.send({ ...message, callId, generation });
  const stopAudio = (resetInput = false) => {
    generation++;
    audio?.flush(generation);
    control({ type: "cancel", resetInput });
  };
  const note = (event: string, detail: Record<string, unknown> = {}) =>
    console.warn("[voice meta event] " + JSON.stringify({ callId, event, ...detail }));

  let reconnecting = false;
  function error(e: Error) {
    if (state.status === "off" || state.status === "error") return;
    if (e.name === "VoiceDisconnected" && callId) {
      void reconnect(e);
      return;
    }
    const scope = state.scope;
    void end("error: " + e.message)
      .catch(() => {})
      .finally(() => set({ status: "error", scope, error: e.message }));
  }

  function detach() {
    active?.unlisten();
    active = undefined;
  }
  let interrupted: typeof active;
  function cancel() {
    const a = active ?? interrupted;
    detach();
    interrupted = undefined;
    if (a) cleanup = cleanup.then(() => a.bridge.cancel(a.id));
    return cleanup;
  }
  function interrupt() {
    if (active) interrupted = active;
    detach();
  }
  function release() {
    detach();
    interrupted = undefined;
  }

  async function end(reason = "ended by user") {
    if (callId || state.status !== "off")
      console.warn("[voice meta end] " + JSON.stringify({ callId, reason, status: state.status }));
    epoch++;
    try { metaAbort?.abort(); } catch {}
    metaAbort = undefined;
    metaAsr?.close(reason);
    metaAsr = undefined;
    const owned = runtimeAcquired;
    runtimeAcquired = undefined;
    callId = "";
    audio?.close();
    audio = undefined;
    client?.close(reason);
    client = undefined;
    generation++;
    pendingSwitchText = "";
    release();
    const stopping = cleanup;
    set({
      status: "off",
      scope: undefined,
      startedAt: undefined,
      reconnecting: false,
      muted: false,
      candidates: undefined,
      threadQuery: undefined,
      error: undefined,
    });
    try {
      await stopping;
    } finally {
      if (owned) await deps.runtime.stop(owned);
    }
  }

  async function reconnect(cause: Error) {
    if (reconnecting) return;
    reconnecting = true;
    const myEpoch = epoch, scope = state.scope;
    note("helper disconnected", { reason: cause.message });
    client?.close(cause.message);
    client = undefined;
    metaAsr?.close(cause.message);
    metaAsr = undefined;
    try { metaAbort?.abort(); } catch {}
    metaAbort = undefined;
    generation++;
    audio?.flush(generation);
    set({ status: "warming", reconnecting: true });
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const runtime = await deps.runtime.start();
          if (myEpoch !== epoch || !callId || !scope) {
            await deps.runtime.stop(runtime);
            return;
          }
          runtimeAcquired = runtime;
          const connected = await connectHelper(runtime);
          if (myEpoch !== epoch || !callId) {
            connected.close();
            return;
          }
          client = connected;
          const meta = await connectMeta(scope);
          if (myEpoch !== epoch || !callId) {
            meta.close();
            return;
          }
          metaAsr = meta;
          sendStart(scope);
          set({ reconnecting: false });
          note("helper reconnected", { attempt });
          return;
        } catch (e) {
          note("reconnect failed", { attempt, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      if (myEpoch === epoch && callId) {
        reconnecting = false;
        error(Error("Voice helper stopped and could not restart. Start a new call."));
      }
    } finally {
      reconnecting = false;
      if (state.reconnecting) set({ reconnecting: false });
    }
  }

  function connectHelper(runtime: VoiceRuntime) {
    return deps.connect(
      runtime,
      helper,
      (pcm, gen) => {
        if (callId && gen === generation) audio?.play(pcm, gen);
      },
      error,
    );
  }

  async function connectMeta(scope: CallScope) {
    const abort = new AbortController();
    metaAbort = abort;
    const vs = deps.voiceSettings();
    const wantedModel = vs.metaModel ?? DEFAULT_META_MODEL;
    const metaDeps: MetaDependencies = {
      mintSession: (args) => deps.mintSession({ ...args, model: wantedModel }),
    };

    const client = await connectMetaAsr(
      metaDeps,
      scope,
      {
        onEvent: () => {
          // ignore for now, but could emit debug
        },
        onTranscript: (transcript, _turnId, _isFinal, _utteranceId) => {
          if (state.muted) return;
          // Partial feedback – show hearing state
          if (transcript && transcript.trim()) set({ status: "hearing" });
        },
        onSpeechStart: () => {
          if (!state.muted) {
            stopAudio();
            interrupt();
            set({ status: "hearing" });
          }
        },
        onSpeechEnd: () => {
          if (!state.muted) set({ status: "waiting" });
        },
        onSpeechComplete: (transcript, _turnId, utteranceId) => {
          if (state.muted) return;
          if (!transcript || !transcript.trim()) return;
          if (utterances.has(utteranceId)) return;
          utterances.add(utteranceId);
          void submit(transcript, utteranceId).catch((err) => error(Error(String(err))));
        },
        onError: (err) => error(err),
        onClose: (reason) => {
          if (callId && !state.muted && state.status !== "off") {
            // Meta closed – try to reconnect via helper reconnect path if still active
            if (reason.includes("1000") || reason.includes("closed 1000")) return; // normal after endStream
          }
        },
      },
      { signal: abort.signal },
    );

    // Attach audio feeding – we need to feed PCM continuously
    // This will be handled by the outer audio frame callback forwarding to metaAsr.sendPcm
    return client;
  }

  function sendStart(scope: CallScope) {
    control({
      type: "start",
      voice: deps.voice(scope),
      silenceMs: deps.silence(),
      nameHints: deps
        .candidates()
        .filter((c) => c.hostId === scope.hostId)
        .map((c) => c.name)
        .slice(0, 64),
    });
  }

  function say(text: string, requestId: string) {
    sinceSubmit("first-speech-submit", requestId);
    if (!client || !state.scope) return;
    control({ type: "speak", text, requestId, segmentId: ++segment, voice: deps.voice(state.scope) });
  }

  function bridgeEvent(e: import("./types.ts").BridgeEvent) {
    const a = active;
    if (!a || a.id !== e.requestId || !same(a.scope, e.scope) || !callId) return;
    if (e.type === "started") sinceSubmit("queue-to-start", a.id);
    if (e.type === "text" && e.text) {
      sinceSubmit("agent-first-text", a.id);
      for (const part of a.speech.push(e.text)) say(part, a.id);
    } else if (e.type === "approval" || e.type === "question") {
      say(e.type === "approval" ? "Approval is needed in the thread." : "There is a question in the thread.", a.id);
      deps.focus(a.scope);
      set({ status: "needs-attention" });
    } else if (e.type === "failed") {
      a.failed = true;
      error(Error(e.text ?? "Agent call failed"));
    } else if (e.type === "done" || e.type === "canceled") {
      if (e.type === "done" && !a.failed) for (const part of a.speech.push("", true)) say(part, a.id);
      detach();
      set({ status: "listening" });
    }
  }

  async function submit(text: string, utteranceId: string, route = true) {
    const currentEpoch = epoch, currentGeneration = generation, currentCall = callId;
    await cleanup;
    if (
      currentEpoch !== epoch ||
      currentGeneration !== generation ||
      currentCall !== callId ||
      !callId ||
      !state.scope ||
      (route && state.muted)
    )
      return;
    const choices = state.candidates;
    const heldText = pendingSwitchText;
    let parsed = route
      ? resolveCallCommand(
          text,
          deps.candidates().filter((c) => c.hostId === state.scope!.hostId),
          state.scope,
        )
      : { kind: "text" as const, text };
    if (choices?.length && parsed.kind === "text") {
      const answer = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (["cancel", "never mind", "nevermind", "no"].includes(answer)) {
        pendingSwitchText = "";
        stopAudio(true);
        set({ status: "listening", candidates: undefined, threadQuery: undefined, error: undefined });
        return;
      }
      const matching = choices.filter(
        (c) => c.roomTitle?.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === answer,
      );
      const pick = answer === "yes" && choices.length === 1 ? choices : matching;
      if (pick.length === 1 && deps.candidates().some((c) => same(c, pick[0]))) {
        parsed = { kind: "switch", candidate: pick[0], text: "" };
      } else {
        set({ status: "needs-attention" });
        say("Say a thread name from the list, or say cancel.", crypto.randomUUID());
        return;
      }
    }
    if (parsed.kind === "end") {
      await end("spoken stop phrase");
      return;
    }
    if (parsed.kind === "unknown") {
      pendingSwitchText = "";
      set({ status: "needs-attention", candidates: undefined, threadQuery: undefined, error: "No matching agent. Choose a recipient." });
      return;
    }
    if (parsed.kind === "ambiguous") {
      pendingSwitchText = parsed.text;
      const titles = [...new Set(parsed.candidates.map((c) => c.roomTitle?.trim() || "Untitled thread"))];
      const single = parsed.candidates.length === 1;
      const question = parsed.threadQuery !== undefined ? (single ? `Did you mean “${titles[0]}”?` : "Which thread did you mean?") : "Choose which agent to call.";
      set({ status: "needs-attention", candidates: parsed.candidates, threadQuery: parsed.threadQuery, error: question });
      if (parsed.threadQuery !== undefined) {
        const options = !single ? titles.slice(0, 3).join(", ") + ". " : "";
        const instructions = !single && titles.length === 1 ? "Several open threads share that title. Choose one from the list, or say cancel." : `Say ${single ? "yes or " : ""}the thread name, or say cancel.`;
        say(`${question} ${options}${instructions}`, crypto.randomUUID());
      }
      return;
    }
    if (parsed.kind === "switch") {
      const held = choices?.some((c) => same(c, parsed.candidate)) ? heldText : "";
      pendingSwitchText = "";
      await switchAgent(parsed.candidate);
      text = parsed.text || held;
      if (!text) return;
    }
    if (!text.trim()) return;
    if (interrupted) {
      const g = generation;
      await cancel();
      if (g !== generation || currentCall !== callId || !callId) return;
    }
    const scope = state.scope!;
    const bridge = deps.bridge(scope);
    const id = crypto.randomUUID();
    submittedAt.set(id, performance.now());
    if (submittedAt.size > 256) submittedAt.delete(submittedAt.keys().next().value!);
    const turn: VoiceTurn = { callId, generation, utteranceId, requestId: id, scope, text };
    active = {
      id, scope, bridge, unlisten: bridge.subscribe(bridgeEvent), speech: new SpeechText(), failed: false,
    };
    set({ status: "waiting", error: undefined });
    try {
      await bridge.submit(turn);
    } catch (e) {
      if (currentEpoch === epoch && active?.id === id) error(e instanceof Error ? e : Error(String(e)));
    }
  }

  async function switchAgent(scope: CallScope) {
    if (!callId) return start(scope);
    if (state.candidates?.some((c) => same(c, scope)) && !deps.candidates().some((c) => same(c, scope))) {
      set({ status: "needs-attention", error: "That thread is no longer available. Choose another thread." });
      return;
    }
    const pending = state.candidates?.some((c) => same(c, scope)) ? pendingSwitchText : "";
    pendingSwitchText = "";
    stopAudio(true);
    release();
    if (!callId) return;
    set({ scope, status: "listening", candidates: undefined, threadQuery: undefined, error: undefined });
    deps.focus(scope);
    // Reconnect Meta to new scope's participant context if needed
    try { metaAbort?.abort(); } catch {}
    metaAsr?.close("switch");
    try {
      const newMeta = await connectMeta(scope);
      metaAsr = newMeta;
    } catch {}
    if (pending) await submit(pending, crypto.randomUUID(), false);
  }

  function helper(e: HelperEvent) {
    if (!callId || e.callId !== callId || e.generation !== generation) return;
    if (e.type === "timing") {
      const timing = e as HelperEvent & { sttMs?: number; ttsMs?: number; ttsFirstMs?: number };
      if (typeof timing.sttMs === "number") metric("stt-wait", timing.sttMs);
      if (typeof timing.ttsFirstMs === "number") metric("speech-first-audio", timing.ttsFirstMs, e.requestId);
      if (typeof timing.ttsMs === "number") metric("speech-generation-and-send", timing.ttsMs, e.requestId);
      return;
    }
    if (e.type === "ready") {
      const voices = e.voices ?? [];
      const valid = state.scope && voices.includes(deps.voice(state.scope));
      const muted = state.muted || !valid;
      set({
        status: valid ? "listening" : "needs-attention",
        voices,
        semantic: e.semantic === true,
        muted,
        error: valid ? undefined : "Choose an installed voice, then unmute the microphone.",
      });
    } else if (e.type === "error") {
      error(Error(e.message ?? "Local voice failed"));
    } else if (e.type === "audioEnd" && e.segmentId !== undefined) {
      audio?.segmentEnd(e.segmentId, generation);
    }
    // Note: we intentionally ignore helper's transcript/speechStart events – Meta ASR is STT source.
  }

  let sampling: { stop(): Promise<void> } | undefined;
  const stopSample = () => sampling?.stop() ?? Promise.resolve();
  async function sample(voice: string, onPlay?: () => void): Promise<void> {
    if (state.status !== "off" && state.status !== "error") throw Error("Use the call’s preview button while a call is active.");
    const previous = sampling;
    const play = deps.playSample;
    if (!play) throw Error("Voice samples not available.");
    await previous?.stop();
    return new Promise<void>((resolve, reject) => {
      let runtime: VoiceRuntime | undefined;
      let helperClient: LocalVoiceClient | undefined;
      let audioSample: VoiceAudio | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        sampling = undefined;
        void (async () => {
          audioSample?.close();
          helperClient?.close("sample done");
          if (runtime) await deps.runtime.stop(runtime);
        })();
        resolve();
      };
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        sampling = undefined;
        void (async () => {
          audioSample?.close();
          helperClient?.close("sample failed");
          if (runtime) await deps.runtime.stop(runtime);
        })();
        reject(e);
      };
      sampling = {
        stop: async () => {
          finish();
        },
      };
      void (async () => {
        try {
          runtime = await deps.runtime.start();
          helperClient = await deps.connect(
            runtime,
            (ev) => {
              if (ev.type === "audio" && ev.text) {} // ignore
            },
            (_pcm) => {
              // For sample, playback via dedicated sample player? Use openAudio path
            },
            fail,
          );
          // Use playSample path for meta (same as local preview)
          const { openVoiceAudio } = await import("./audio.ts");
          const audioTmp = await openVoiceAudio(() => {}, () => {}, () => {}, fail);
          audioSample = audioTmp;
          // Request sample speak via helper
          const ctrl = (message: Record<string, unknown>) => helperClient?.send({ ...message, callId: "sample", generation: 0 });
          ctrl({ type: "start", voice, silenceMs: 100, nameHints: [] });
          ctrl({ type: "speak", text: "Hi there. This is how I'll sound on a call.", requestId: "sample", segmentId: 1, voice });
          onPlay?.();
          setTimeout(finish, 4000);
        } catch (e) {
          fail(e instanceof Error ? e : Error(String(e)));
        }
      })();
    });
  }

  async function start(scope: CallScope) {
    const prev = end("new call started");
    const myEpoch = ++epoch;
    await prev;
    if (myEpoch !== epoch) return;
    callId = crypto.randomUUID();
    generation = 0;
    segment = 0;
    utterances.clear();
    pendingSwitchText = "";
    set({ status: "setup", scope, startedAt: Date.now(), muted: false, error: undefined, candidates: undefined, threadQuery: undefined });

    try {
      const runtime = await deps.runtime.start();
      if (myEpoch !== epoch) {
        await deps.runtime.stop(runtime);
        return;
      }
      runtimeAcquired = runtime;
      set({ status: "warming", scope, startedAt: Date.now() });

      const audioInstance = await deps.openAudio(
        (pcm) => {
          // Feed PCM to both local helper (for silence detection? we still need to send to local for completeness? No, local helper mic handling not needed for TTS)
          // Send audio to helper as well? Helper expects audio via its own websocket audio path, not via control.
          // For meta engine, we send PCM directly to Meta ASR as raw bytes, and also send to helper via its audio path if needed for future? We use client.audio for helper uploads still via helper's audio channel?
          // Actually controller's audio handling: audio frames go via client.audio() call, not via openAudio directly.
          // openAudio's onFrame is for mic PCM to send to backend (we handle meta forwarding here).
          if (myEpoch !== epoch || !callId) return;
          // Meta ends a live stream that falls behind real time, so muting sends silence.
          // Convert Int16Array to bytes for Meta (little-endian already)
          const bytes = state.muted ? new Uint8Array(pcm.byteLength) : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          metaAsr?.sendPcm(bytes);
          // Also feed to local helper for its internal VAD? We skip helper audio upload for meta path to avoid duplicate STT triggering.
          // But we still need to keep helper alive – its audio path not used for STT in meta mode.
        },
        (_id) => {
          // drain
        },
        () => {
          set({ status: "speaking" });
        },
        (e) => error(e),
        () => {},
      );
      if (myEpoch !== epoch) {
        audioInstance.close();
        await deps.runtime.stop(runtime);
        return;
      }
      audio = audioInstance;

      const connected = await connectHelper(runtime);
      if (myEpoch !== epoch) {
        connected.close();
        audioInstance.close();
        await deps.runtime.stop(runtime);
        return;
      }
      client = connected;

      const meta = await connectMeta(scope);
      if (myEpoch !== epoch) {
        meta.close();
        connected.close();
        audioInstance.close();
        await deps.runtime.stop(runtime);
        return;
      }
      metaAsr = meta;

      sendStart(scope);
      set({ status: "listening", scope, startedAt: Date.now(), muted: false, error: undefined });
      deps.focus(scope);
    } catch (e) {
      if (myEpoch !== epoch) return;
      await end("start failed");
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", scope, error: msg });
    }
  }

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
    },
    preview(voice: string) {
      void sample(voice).catch(() => {});
    },
    sample,
    stopSample,
  };
}

export type MetaVoiceController = ReturnType<typeof createMetaVoiceController>;
