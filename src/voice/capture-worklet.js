class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.frame = new Int16Array(512);
    this.used = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      this.muted = e.data.muted === true;
      this.used = 0;
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.muted) return true;
    for (const x of input) {
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.frame[this.used++] = Math.round(
          Math.max(-1, Math.min(1, x)) * 32767,
        );
        if (this.used === 512) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Int16Array(512);
          this.used = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("deck-voice-capture", VoiceCapture);
