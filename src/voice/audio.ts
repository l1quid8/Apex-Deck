export interface VoiceAudio {
  mute(value: boolean): void;
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
): Promise<VoiceAudio> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
  let capture: AudioContext | undefined, playback: AudioContext | undefined;
  let closed = false;
  let currentGeneration = 0;
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
    const source = capture.createMediaStreamSource(stream);
    const silent = capture.createGain();
    silent.gain.value = 0;
    source.connect(input);
    input.connect(silent).connect(capture.destination);
    output.connect(playback.destination);
    input.port.onmessage = (e) => {
      if (!closed) onFrame(e.data);
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
      else if (e.data.type === "playing") onPlaying();
      else if (e.data.type === "error")
        onError(Error("Voice playback overloaded"));
    };
    stream.getAudioTracks()[0].onended = () => {
      if (!closed) onError(Error("Microphone disconnected"));
    };
    await Promise.all([capture.resume(), playback.resume()]);
    return {
      echoCancellation:
        stream.getAudioTracks()[0].getSettings().echoCancellation === true,
      mute: (value) => input.port.postMessage({ muted: value }),
      play: (pcm, generation) =>
        output.port.postMessage({ type: "audio", pcm, generation }, [
          pcm.buffer,
        ]),
      segmentEnd: (segmentId, generation) =>
        output.port.postMessage({ type: "end", segmentId, generation }),
      flush: (generation) => {
        currentGeneration = generation;
        output.port.postMessage({ type: "flush", generation });
      },
      close: () => {
        closed = true;
        stream.getTracks().forEach((t) => t.stop());
        input.disconnect();
        output.disconnect();
        void capture?.close();
        void playback?.close();
      },
    };
  } catch (e) {
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
