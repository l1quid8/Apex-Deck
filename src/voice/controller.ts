import type {
  BridgeEvent,
  CallScope,
  HelperEvent,
  ThreadVoiceBridge,
  VoiceCandidate,
  VoiceRuntime,
  VoiceState,
  VoiceTurn,
} from "./types.ts";
import type { VoiceAudio } from "./audio.ts";
import type { LocalVoiceClient } from "./localClient.ts";
import { resolveCallCommand } from "./routing.ts";
import { SpeechText } from "./speechText.ts";
export interface VoiceDependencies<R = VoiceRuntime> {
  runtime: {
    status(): Promise<{
      installed: boolean;
      supported: boolean;
      reason?: string;
    }>;
    start(): Promise<R>;
    stop(runtime?: R): Promise<unknown>;
  };
  openAudio(
    onFrame: (pcm: Int16Array) => void,
    onDrain: (id: number) => void,
    onPlaying: () => void,
    onError: (error: Error) => void,
    onConsumed?: (bytes: number) => void,
  ): Promise<VoiceAudio>;
  connect(
    runtime: R,
    event: (e: HelperEvent) => void,
    audio: (pcm: Int16Array, generation: number) => void,
    error: (e: Error) => void,
  ): Promise<LocalVoiceClient>;
  candidates(): VoiceCandidate[];
  bridge(scope: CallScope): ThreadVoiceBridge;
  voice(scope: CallScope): string;
  silence(): number;
  focus(scope: CallScope): void;
  /** Phone audio failures release capture while leaving the accepted agent turn running. */
  keepWorkOnError?: boolean;
}
const same = (a: CallScope, b: CallScope) =>
  a.hostId === b.hostId &&
  a.roomId === b.roomId &&
  a.participantId === b.participantId;
export function createVoiceController<R = VoiceRuntime>(
  deps: VoiceDependencies<R>,
) {
  let state: VoiceState = { status: "off", muted: false, voices: [] };
  const listeners = new Set<() => void>();
  let runtimeAcquired: R | undefined;
  let callId = "",
    generation = 0,
    epoch = 0,
    segment = 0,
    audio: VoiceAudio | undefined,
    client: LocalVoiceClient | undefined;
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
  let playbackRequest = "";
  const submittedAt = new Map<string, number>();
  const seenTiming = new Set<string>();
  const metric = (stage: string, ms: number, requestId?: string) => {
    if (typeof window !== "undefined" && Number.isFinite(ms) && ms >= 0)
      console.debug("[voice timing]", {
        callId,
        generation,
        requestId,
        stage,
        ms: Math.round(ms),
      });
  };
  const sinceSubmit = (stage: string, requestId: string) => {
    const key = requestId + ":" + stage,
      at = submittedAt.get(requestId);
    if (at !== undefined && !seenTiming.has(key)) {
      seenTiming.add(key);
      metric(stage, performance.now() - at, requestId);
    }
  };
  const set = (patch: Partial<VoiceState>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const control = (message: Record<string, unknown>) =>
    client?.send({ ...message, callId, generation });
  const stopAudio = (resetInput = false) => {
    generation++;
    audio?.flush(generation);
    control({ type: "cancel", resetInput });
  };
  const note = (event: string, detail: Record<string, unknown> = {}) =>
    console.warn(
      "[voice event] " + JSON.stringify({ callId, event, ...detail }),
    );
  let reconnecting = false;
  function error(e: Error) {
    if (state.status === "off" || state.status === "error") return;
    if (e.name === "VoiceDisconnected" && callId) {
      void reconnect(e);
      return;
    }
    const scope = state.scope;
    void end("error: " + e.message, { keepWork: deps.keepWorkOnError })
      .catch(() => {})
      .finally(() => set({ status: "error", scope, error: e.message }));
  }
  function detach() {
    active?.unlisten();
    active = undefined;
  }
  function cancel() {
    const a = active;
    detach();
    if (a) cleanup = cleanup.then(() => a.bridge.cancel(a.id));
    return cleanup;
  }
  async function end(
    reason = "ended by user",
    options?: { keepWork?: boolean },
  ) {
    // Every call end is logged with its reason so drops can be traced.
    if (callId || state.status !== "off")
      console.warn(
        "[voice end] " +
          JSON.stringify({ callId, reason, status: state.status }),
      );
    epoch++;
    const owned = runtimeAcquired;
    runtimeAcquired = undefined;
    callId = "";
    audio?.close();
    audio = undefined;
    client?.close(reason);
    client = undefined;
    generation++;
    const stopping = options?.keepWork ? (detach(), cleanup) : cancel();
    set({
      status: "off",
      scope: undefined,
      muted: false,
      candidates: undefined,
      error: undefined,
    });
    // Audio ends immediately. Cleanup remains awaited before a subsequent dispatch.
    try {
      await stopping;
    } finally {
      if (owned) await deps.runtime.stop(owned);
    }
  }
  // The helper dropped its connection: open a fresh one on the same call so the
  // thread, the bot's reply in progress and the mic keep going. Two tries, then end clearly.
  async function reconnect(cause: Error) {
    if (reconnecting) return;
    reconnecting = true;
    const myEpoch = epoch,
      scope = state.scope;
    note("helper disconnected", { reason: cause.message });
    client?.close(cause.message);
    client = undefined;
    generation++;
    audio?.flush(generation);
    set({ status: "warming" });
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
          sendStart(scope);
          note("helper reconnected", { attempt });
          return;
        } catch (e) {
          note("reconnect failed", {
            attempt,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (myEpoch === epoch && callId) {
        reconnecting = false;
        error(
          Error(
            "Voice helper stopped and could not restart. Start a new call.",
          ),
        );
      }
    } finally {
      reconnecting = false;
    }
  }
  function connectHelper(runtime: R) {
    return deps.connect(
      runtime,
      helper,
      (pcm, gen) => {
        if (callId && gen === generation) audio?.play(pcm, gen);
      },
      error,
    );
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
    control({
      type: "speak",
      text,
      requestId,
      segmentId: ++segment,
      voice: deps.voice(state.scope),
    });
  }
  function bridgeEvent(e: BridgeEvent) {
    const a = active;
    if (!a || a.id !== e.requestId || !same(a.scope, e.scope) || !callId)
      return;
    if (e.type === "started") sinceSubmit("queue-to-start", a.id);
    if (e.type === "text" && e.text) {
      sinceSubmit("agent-first-text", a.id);
      for (const part of a.speech.push(e.text)) say(part, a.id);
    } else if (e.type === "approval" || e.type === "question") {
      say(
        e.type === "approval"
          ? "Approval is needed in the thread."
          : "There is a question in the thread.",
        a.id,
      );
      deps.focus(a.scope);
      set({ status: "needs-attention" });
    } else if (e.type === "failed") {
      a.failed = true;
      error(Error(e.text ?? "Agent call failed"));
    } else if (e.type === "done" || e.type === "canceled") {
      if (e.type === "done" && !a.failed)
        for (const part of a.speech.push("", true)) say(part, a.id);
      detach();
      set({ status: "listening" });
    }
  }
  async function submit(text: string, utteranceId: string) {
    const currentEpoch = epoch,
      currentGeneration = generation,
      currentCall = callId;
    await cleanup;
    if (
      currentEpoch !== epoch ||
      currentGeneration !== generation ||
      currentCall !== callId ||
      !callId ||
      !state.scope ||
      state.muted
    )
      return;
    const parsed = resolveCallCommand(
      text,
      deps.candidates().filter((c) => c.hostId === state.scope!.hostId),
    );
    if (parsed.kind === "end") {
      await end("spoken stop phrase");
      return;
    }
    if (parsed.kind === "unknown") {
      set({
        status: "needs-attention",
        error: "No matching agent. Choose a recipient.",
      });
      return;
    }
    if (parsed.kind === "ambiguous") {
      pendingSwitchText = parsed.text;
      set({
        status: "needs-attention",
        candidates: parsed.candidates,
        error: "Choose which agent to call.",
      });
      return;
    }
    if (parsed.kind === "switch") {
      await switchAgent(parsed.candidate);
      text = parsed.text;
      if (!text) return;
    }
    if (!text.trim()) return;
    const scope = state.scope!;
    const bridge = deps.bridge(scope);
    const id = crypto.randomUUID();
    submittedAt.set(id, performance.now());
    if (submittedAt.size > 256)
      submittedAt.delete(submittedAt.keys().next().value!);
    const turn: VoiceTurn = {
      callId,
      generation,
      utteranceId,
      requestId: id,
      scope,
      text,
    };
    active = {
      id,
      scope,
      bridge,
      unlisten: bridge.subscribe(bridgeEvent),
      speech: new SpeechText(),
      failed: false,
    };
    set({ status: "waiting", error: undefined });
    try {
      await bridge.submit(turn);
    } catch (e) {
      if (currentEpoch === epoch && active?.id === id)
        error(e instanceof Error ? e : Error(String(e)));
    }
  }
  async function switchAgent(scope: CallScope) {
    if (!callId) return start(scope);
    stopAudio(true);
    await cancel();
    if (!callId) return;
    set({
      scope,
      status: "listening",
      candidates: undefined,
      error: undefined,
    });
    deps.focus(scope);
    if (pendingSwitchText) {
      const text = pendingSwitchText;
      pendingSwitchText = "";
      await submit(text, crypto.randomUUID());
    }
  }
  function helper(e: HelperEvent) {
    if (!callId || e.callId !== callId || e.generation !== generation) return;
    if (e.type === "audioStart") {
      playbackRequest = e.requestId ?? "";
    }
    if (e.type === "timing") {
      const timing = e as HelperEvent & {
        sttMs?: number;
        ttsMs?: number;
        ttsFirstMs?: number;
      };
      if (typeof timing.sttMs === "number") metric("stt-wait", timing.sttMs);
      if (typeof timing.ttsFirstMs === "number")
        metric("speech-first-audio", timing.ttsFirstMs, e.requestId);
      if (typeof timing.ttsMs === "number")
        metric("speech-generation-and-send", timing.ttsMs, e.requestId);
      return;
    }
    if (e.type === "ready") {
      const voices = e.voices ?? [];
      const valid = state.scope && voices.includes(deps.voice(state.scope));
      if (!valid) audio?.mute(true);
      set({
        status: valid ? "listening" : "needs-attention",
        voices,
        semantic: e.semantic === true,
        muted: !valid,
        error: valid
          ? undefined
          : "Choose an installed voice, then unmute the microphone.",
      });
    } else if (e.type === "speechStart" && !state.muted) {
      stopAudio();
      void cancel().catch((err) => error(Error(String(err))));
      set({ status: "hearing" });
    } else if (e.type === "transcript" && !state.muted) {
      const id = (e as HelperEvent & { utteranceId: string }).utteranceId;
      if (!id || utterances.has(id)) return;
      utterances.add(id);
      void submit(e.text ?? "", id).catch((err) => error(Error(String(err))));
    } else if (e.type === "audioEnd" && e.segmentId !== undefined)
      audio?.segmentEnd(e.segmentId, generation);
    else if (e.type === "error")
      error(Error(e.message ?? "Local voice failed"));
  }
  async function start(scope: CallScope) {
    await end("new call started");
    cleanup = Promise.resolve();
    const myEpoch = ++epoch;
    set({ status: "warming", scope, muted: false, error: undefined });
    try {
      const status = await deps.runtime.status();
      if (myEpoch !== epoch) return;
      if (!status.supported)
        throw Error(status.reason ?? "Local calls require Apple Silicon macOS");
      if (!status.installed) {
        set({ status: "setup" });
        return;
      }
      const runtime = await deps.runtime.start();
      if (myEpoch !== epoch) {
        await deps.runtime.stop(runtime);
        return;
      }
      runtimeAcquired = runtime;
      callId = crypto.randomUUID();
      generation = 0;
      segment = 0;
      utterances.clear();
      const opened = await deps.openAudio(
        (pcm) => {
          if (!state.muted && callId) client?.audio(pcm, generation);
        },
        (id) => {
          control({ type: "playbackComplete", segmentId: id });
          if (callId && !active) set({ status: "listening" });
        },
        () => {
          if (callId) {
            if (playbackRequest) sinceSubmit("playback-start", playbackRequest);
            set({ status: "speaking" });
          }
        },
        error,
        (bytes) => control({ type: "playbackProgress", bytes }),
      );
      if (myEpoch !== epoch) {
        opened.close();
        return;
      }
      audio = opened;
      audio.flush(generation);
      // Track settings do not establish acoustic AEC. Speaker mode is verified separately.
      if (!audio.echoCancellation)
        throw Error(
          "Echo cancellation unavailable. Use a supported audio device before calling.",
        );
      const connected = await connectHelper(runtime);
      if (myEpoch !== epoch) {
        connected.close();
        return;
      }
      client = connected;
      sendStart(scope);
      deps.focus(scope);
    } catch (e) {
      if (myEpoch === epoch) error(e instanceof Error ? e : Error(String(e)));
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
      // Muting only stops the mic; the agent keeps working and speaking.
      audio?.mute(value);
    },
    preview(voice: string) {
      if (!callId || !state.voices.includes(voice)) return;
      stopAudio();
      control({
        type: "speak",
        requestId: "preview",
        segmentId: ++segment,
        text: "Hello. This is the voice for this agent.",
        voice,
      });
    },
  };
}

export type VoiceController<R = VoiceRuntime> = ReturnType<
  typeof createVoiceController<R>
>;
