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
  /** Plays a finished voice sample through the speakers (no mic). */
  playSample?(pcm: Int16Array, sampleRate: number): { done: Promise<void>; stop(): void };
  candidates(): VoiceCandidate[];
  bridge(scope: CallScope): ThreadVoiceBridge;
  voice(scope: CallScope): string;
  silence(): number;
  focus(scope: CallScope): void;
}
/** What a voice sample says, outside a call. */
export const SAMPLE_TEXT = "Hi there. This is how I'll sound on a call.";
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
    void end("error: " + e.message)
      .catch(() => {})
      .finally(() => set({ status: "error", scope, error: e.message }));
  }
  function detach() {
    active?.unlisten();
    active = undefined;
  }
  // A reply you talked over. It is only cancelled once your next words turn
  // out to be a new message for the same agent; switching agents or ending
  // the call leaves it running.
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
    pendingSwitchText = "";
    // Ending a call only stops the audio. The agent keeps working and its
    // reply still lands in the thread.
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
          sendStart(scope);
          set({ reconnecting: false });
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
      if (state.reconnecting) set({ reconnecting: false });
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
  async function submit(text: string, utteranceId: string, route = true) {
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
      (route && state.muted)
    )
      return;
    const choices = state.candidates;
    const heldText = pendingSwitchText;
    let parsed = route ? resolveCallCommand(
      text,
      deps.candidates().filter((c) => c.hostId === state.scope!.hostId),
      state.scope,
    ) : { kind: "text" as const, text };
    if (choices?.length && parsed.kind === "text") {
      const answer = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (["cancel", "never mind", "nevermind", "no"].includes(answer)) {
        pendingSwitchText = "";
        stopAudio(true);
        set({ status: "listening", candidates: undefined, threadQuery: undefined, error: undefined });
        return;
      }
      const matching = choices.filter((c) =>
        c.roomTitle?.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === answer,
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
      set({
        status: "needs-attention",
        candidates: undefined,
        threadQuery: undefined,
        error: "No matching agent. Choose a recipient.",
      });
      return;
    }
    if (parsed.kind === "ambiguous") {
      pendingSwitchText = parsed.text;
      const titles = [...new Set(parsed.candidates.map((c) => c.roomTitle?.trim() || "Untitled thread"))];
      const single = parsed.candidates.length === 1;
      const question = parsed.threadQuery !== undefined
        ? single ? `Did you mean “${titles[0]}”?` : "Which thread did you mean?"
        : "Choose which agent to call.";
      set({
        status: "needs-attention",
        candidates: parsed.candidates,
        threadQuery: parsed.threadQuery,
        error: question,
      });
      if (parsed.threadQuery !== undefined) {
        const options = !single ? titles.slice(0, 3).join(", ") + ". " : "";
        const instructions = !single && titles.length === 1
          ? "Several open threads share that title. Choose one from the list, or say cancel."
          : `Say ${single ? "yes or " : ""}the thread name, or say cancel.`;
        say(`${question} ${options}${instructions}`, crypto.randomUUID());
      }
      return;
    }
    if (parsed.kind === "switch") {
      // A spoken choice consumes the held request exactly once. A replacement
      // command with its own message takes precedence over the previous request.
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
    if (state.candidates?.some((c) => same(c, scope)) && !deps.candidates().some((c) => same(c, scope))) {
      set({ status: "needs-attention", error: "That thread is no longer available. Choose another thread." });
      return;
    }
    const pending = state.candidates?.some((c) => same(c, scope)) ? pendingSwitchText : "";
    pendingSwitchText = "";
    stopAudio(true);
    // Switching only moves the call. The previous agent keeps working and its
    // reply still lands in the thread.
    release();
    if (!callId) return;
    set({
      scope,
      status: "listening",
      candidates: undefined,
      threadQuery: undefined,
      error: undefined,
    });
    deps.focus(scope);
    if (pending) {
      await submit(pending, crypto.randomUUID(), false);
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
      const muted = state.muted || !valid;
      audio?.mute(muted);
      set({
        status: valid ? "listening" : "needs-attention",
        voices,
        semantic: e.semantic === true,
        muted,
        error: valid
          ? undefined
          : "Choose an installed voice, then unmute the microphone.",
      });
    } else if (e.type === "speechStart" && !state.muted) {
      stopAudio();
      interrupt();
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
  // A voice sample outside a call borrows the helper for a few seconds. Only one
  // connection fits, so a call stops the sample before it takes the helper.
  let sampling: { stop(): Promise<void> } | undefined;
  const stopSample = () => sampling?.stop() ?? Promise.resolve();
  async function sample(voice: string, onPlay?: () => void): Promise<void> {
    if (state.status !== "off" && state.status !== "error") {
      throw Error("Use the call’s preview button while a call is active.");
    }
    const previous = sampling;
    const play = deps.playSample;
    if (!play) throw Error("Voice samples need the desktop app");
    let stopped = false,
      launching: Promise<R> | undefined,
      helperClient: LocalVoiceClient | undefined,
      player: { done: Promise<void>; stop(): void } | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      settle: (e?: Error) => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      settle = (e) => (e ? reject(e) : resolve());
    });
    let released: Promise<void> | undefined;
    const finish = (e?: Error) =>
      (released ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        helperClient?.close("sample done");
        player?.stop();
        try {
          // A stop mid-launch waits for it, so a call never inherits a helper this sample then lets go of.
          await previous?.stop();
          const runtime = await launching?.catch(() => undefined);
          if (runtime) await deps.runtime.stop(runtime);
        } finally {
          if (sampling === me) sampling = undefined;
          settle(e);
        }
      })());
    const me = { stop: () => finish() };
    sampling = me;
    const id = "sample-" + crypto.randomUUID();
    const pcm: Int16Array[] = [];
    const send = (m: Record<string, unknown>) =>
      helperClient?.send({ ...m, callId: id, generation: 0 });
    const fail = (e: Error) => void finish(e);
    try {
      await previous?.stop();
      if (stopped) return finished;
      if (state.status !== "off" && state.status !== "error")
        throw Error("Use the call’s preview button while a call is active.");
      const status = await deps.runtime.status();
      if (!status.supported)
        throw Error(status.reason ?? "Local calls require Apple Silicon macOS");
      if (!status.installed)
        throw Error("Set up calls first. Start a call once to download the voices.");
      if (stopped) return finished;
      launching = deps.runtime.start();
      const runtime = await launching;
      if (stopped) return finished;
      timer = setTimeout(() => fail(Error("The voice sample took too long")), 30000);
      helperClient = await deps.connect(
        runtime,
        (e) => {
          if (stopped || e.callId !== id) return;
          if (e.type === "ready") {
            if (!e.voices?.includes(voice)) fail(Error("That voice isn't installed"));
            else
              send({ type: "speak", requestId: "sample", segmentId: 1, text: SAMPLE_TEXT, voice });
          } else if (e.type === "audioEnd") {
            send({ type: "end" });
            helperClient?.close("sample done");
            helperClient = undefined;
            const all = new Int16Array(pcm.reduce((n, p) => n + p.length, 0));
            pcm.reduce((at, p) => (all.set(p, at), at + p.length), 0);
            player = play(all, 24000);
            onPlay?.();
            player.done.then(() => finish(), (err) => fail(err instanceof Error ? err : Error(String(err))));
          } else if (e.type === "error") fail(Error(e.message ?? "Local voice failed"));
        },
        (chunk) => {
          if (stopped) return;
          pcm.push(chunk);
          send({ type: "playbackProgress", bytes: chunk.byteLength });
        },
        fail,
      );
      if (stopped) {
        helperClient.close("sample stopped");
        return finished;
      }
      send({ type: "start", voice, silenceMs: 100, nameHints: [] });
    } catch (e) {
      fail(e instanceof Error ? e : Error(String(e)));
    }
    return finished;
  }
  function preview(voice: string) {
    if (!callId || !state.voices.includes(voice)) return;
    stopAudio();
    control({
      type: "speak",
      requestId: "preview",
      segmentId: ++segment,
      text: "Hello. This is the voice for this agent.",
      voice,
    });
  }
  async function start(scope: CallScope) {
    // Ending the last call moves the epoch at once, so this start owns the epoch before its first
    // wait: an End or newer start during that wait overtakes it.
    const previous = end("new call started");
    const myEpoch = epoch;
    await previous;
    if (myEpoch !== epoch) return;
    await stopSample();
    if (myEpoch !== epoch) return;
    cleanup = Promise.resolve();
    set({ status: "warming", scope, startedAt: Date.now(), muted: false, error: undefined });
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
          if (callId && !active) set({ status: state.candidates?.length ? "needs-attention" : "listening" });
        },
        () => {
          if (callId) {
            if (playbackRequest) sinceSubmit("playback-start", playbackRequest);
            set({ status: state.candidates?.length ? "needs-attention" : "speaking" });
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
      // A mute clicked while the runtime or microphone was opening must be
      // applied before the acquired input can feed the connected helper.
      audio.mute(state.muted);
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
    preview,
    sample,
    stopSample,
  };
}

export type VoiceController<R = VoiceRuntime> = ReturnType<
  typeof createVoiceController<R>
>;
