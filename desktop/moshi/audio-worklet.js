// Real-time capture/resampling and bounded playback, independent of UI timing.
class VoiceAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.input = []; this.readAt = 0; this.output = []; this.offset = 0; this.queued = 0; this.muted = false;
    this.port.onmessage = ({ data }) => {
      if (data.mute !== undefined) this.muted = data.mute;
      if (data.audio) {
        // Drop old audio rather than letting lag grow without bound (> 1 second).
        if (this.queued > 24000) { this.output = []; this.offset = 0; this.queued = 0; }
        this.output.push(data.audio); this.queued += data.audio.length;
      }
    };
    this.playbackPosition = 0; this.capture = new Float32Array(1920); this.captureAt = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0], out = outputs[0]?.[0];
    if (!out) return true;
    // Stream linear resampling: real device rates may differ from 24 kHz.
    if (input) {
      for (const sample of input) this.input.push(this.muted ? 0 : sample);
      const step = sampleRate / 24000;
      while (this.readAt + 1 < this.input.length) {
        const i = Math.floor(this.readAt), f = this.readAt - i;
        this.capture[this.captureAt++] = this.input[i] * (1 - f) + this.input[i + 1] * f;
        this.readAt += step;
        if (this.captureAt === 1920) { this.port.postMessage({ audio: this.capture }, [this.capture.buffer]); this.capture = new Float32Array(1920); this.captureAt = 0; }
      }
      const used = Math.floor(this.readAt); this.input.splice(0, used); this.readAt -= used;
    }
    for (let i = 0; i < out.length; i++) {
      const first = this.output[0];
      out[i] = first ? first[this.offset] : 0;
      if (first) {
        this.playbackPosition += 24000 / sampleRate;
        while (this.playbackPosition >= 1 && this.output.length) {
          this.playbackPosition--; this.offset++; this.queued--;
          if (this.offset >= this.output[0].length) { this.output.shift(); this.offset = 0; }
        }
      } else this.playbackPosition = 0;
    }
    return true;
  }
}
registerProcessor('voice-audio', VoiceAudio);
