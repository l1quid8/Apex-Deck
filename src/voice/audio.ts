export interface VoiceAudio {
  mute(value: boolean): void;
  /** Pauses playback where it is; `flush` also lets go. */
  hold?(value: boolean): void;
  play(pcm: Int16Array, generation: number): void;
  segmentEnd(id: number, generation: number): void;
  flush(generation: number): void;
  close(): void;
  echoCancellation: boolean;
}
export async function openVoiceAudio(
  onFrame: (pcm: Int16Array) => void,
  onDrain: (id: number) => void,
  onPlaying: () => void,
  onError: (error: Error) => void,
  onConsumed: (bytes: number) => void = () => {},
  onLevel: (level: number) => void = () => {},
): Promise<VoiceAudio> {
  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  };
  let stream = await navigator.mediaDevices.getUserMedia(constraints);
  let capture: AudioContext | undefined, playback: AudioContext | undefined;
  let closed = false;
  let removeListeners = () => {};
  let currentGeneration = 0;
  const note = (event: string, detail: Record<string, unknown> = {}) =>
    console.warn("[voice event] " + JSON.stringify({ ts: new Date().toISOString(), event, ...detail }));
  note("micOpen", { sampleRate: stream.getAudioTracks()[0].getSettings().sampleRate });
  let lastFrame = performance.now(), lastStats = lastFrame, frames = 0;
  try {
    capture = new AudioContext();
    playback = new AudioContext({ sampleRate: 24000 });
    if (!capture.audioWorklet || !playback.audioWorklet)
      throw Error("AudioWorklet is unavailable");
    await Promise.all([
      capture.audioWorklet.addModule(
        new URL("./capture-worklet.js", import.meta.url),
      ),
      playback.audioWorklet.addModule(
        new URL("./playback-worklet.js", import.meta.url),
      ),
    ]);
    const input = new AudioWorkletNode(capture, "deck-voice-capture");
    const output = new AudioWorkletNode(playback, "deck-voice-playback");
    let source = capture.createMediaStreamSource(stream);
    const silent = capture.createGain();
    silent.gain.value = 0;
    source.connect(input);
    input.connect(silent).connect(capture.destination);
    output.connect(playback.destination);
    input.port.onmessage = (e) => {
      if (closed) return;
      const now = performance.now();
      if (now - lastFrame > 200) note("micFrameGap", { gapMs: Math.round(now - lastFrame) });
      lastFrame = now;
      frames++;
      if (now - lastStats > 1000) {
        let sum = 0;
        for (const x of e.data) sum += (x / 32768) ** 2;
        note("audioChunk", { bytes: e.data.byteLength, rms: Math.sqrt(sum / Math.max(1, e.data.length)), frames });
        lastStats = now;
      }
      onFrame(e.data);
    };
    output.port.onmessage = (e) => {
      if (closed) return;
      if (e.data.type === "drained") {
        // Worklet consumption precedes physical device drain by outputLatency.
        const id = e.data.segmentId,
          gen = e.data.generation;
        setTimeout(
          () => {
            if (!closed && gen === currentGeneration) onDrain(id);
          },
          Math.ceil(
            ((playback?.outputLatency ?? 0) + (playback?.baseLatency ?? 0)) *
              1000,
          ),
        );
      } else if (
        e.data.type === "consumed" &&
        e.data.generation === currentGeneration
      )
        onConsumed(e.data.bytes);
      else if (e.data.type === "level" && e.data.generation === currentGeneration) onLevel(e.data.rms);
      else if (e.data.type === "playing" && e.data.generation === currentGeneration) onPlaying();
      else if (e.data.type === "error")
        onError(Error("Voice playback overloaded"));
    };
    let recovering = false;
    const recoverInput = async () => {
      if (closed || recovering) return;
      recovering = true;
      note("micRecoverStart");
      try {
        const replacement = await navigator.mediaDevices.getUserMedia(constraints);
        if (closed) { replacement.getTracks().forEach(t => t.stop()); return; }
        const nextSource = capture!.createMediaStreamSource(replacement);
        nextSource.connect(input);
        source.disconnect();
        for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
        source = nextSource;
        stream = replacement;
        stream.getAudioTracks()[0].onended = recoverInput;
        await Promise.all([capture!.resume(), playback!.resume()]);
        note("micRecoverComplete");
      } catch (e) {
        note("micRecoverFailed", { reason: String(e) });
        if (!closed) onError(Error("Microphone recovery failed: " + String(e)));
      } finally { recovering = false; }
    };
    const resumeContexts = () => {
      if (closed) return;
      for (const context of [capture!, playback!]) {
        if (context.state === "suspended" || String(context.state) === "interrupted")
          void context.resume().then(() => note("audioResume", { state: context.state })).catch(e => {
            if (!closed) onError(Error("Audio resume failed: " + String(e)));
          });
      }
    };
    stream.getAudioTracks()[0].onended = recoverInput;
    navigator.mediaDevices.addEventListener("devicechange", recoverInput);
    capture.onstatechange = resumeContexts;
    playback.onstatechange = resumeContexts;
    removeListeners = () => {
      navigator.mediaDevices.removeEventListener("devicechange", recoverInput);
      capture!.onstatechange = null;
      playback!.onstatechange = null;
    };
    await Promise.all([capture.resume(), playback.resume()]);
    return {
      echoCancellation:
        stream.getAudioTracks()[0].getSettings().echoCancellation === true,
      mute: (value) => { note("mute", { muted: value }); input.port.postMessage({ muted: value }); },
      hold: (value) => {
        note("playbackHold", { held: value });
        output.port.postMessage({ type: "hold", held: value });
      },
      play: (pcm, generation) => {
        note("ttsQueued", { bytes: pcm.byteLength, generation });
        output.port.postMessage({ type: "audio", pcm, generation }, [pcm.buffer]);
      },
      segmentEnd: (segmentId, generation) =>
        output.port.postMessage({ type: "end", segmentId, generation }),
      flush: (generation) => {
        note("playbackFlushed", { generation });
        onLevel(0);
        currentGeneration = generation;
        output.port.postMessage({ type: "flush", generation });
      },
      close: () => {
        closed = true;
        removeListeners();
        source.disconnect();
        note("micClose");
        onLevel(0);
        stream.getTracks().forEach((t) => t.stop());
        input.disconnect();
        output.disconnect();
        void capture?.close();
        void playback?.close();
      },
    };
  } catch (e) {
    closed = true;
    removeListeners();
    note("micClose", { reason: String(e) });
    stream.getTracks().forEach((t) => t.stop());
    void capture?.close();
    void playback?.close();
    throw e;
  }
}
/** Plays one finished voice sample through the speakers. Never opens the mic. */
export function playVoiceSample(pcm: Int16Array, sampleRate: number) {
  const context = new AudioContext({ sampleRate });
  let stopped = false;
  let source: AudioBufferSourceNode | undefined;
  let complete: () => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    // Promise construction also captures synchronous setup failures.
    const buffer = context.createBuffer(1, Math.max(1, pcm.length), sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => resolve();
    void context.resume().then(() => {
      if (!stopped) source!.start();
    }).catch(reject);
  }).finally(async () => {
    await context.close();
  });
  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        source?.stop();
      } catch {
        // Not started yet.
      }
      // Stopping before resume resolves need not emit an ended event.
      complete();
    },
  };
}
