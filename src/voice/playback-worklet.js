class VoicePlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.count = 0;
    this.generation = 0;
    this.tail = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "flush") {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.count = 0;
        this.generation = m.generation;
        this.tail = 0;
        this.port.postMessage({ type: "flushed" });
      } else if (m.generation === this.generation) {
        if (m.type === "end") this.queue.push({ end: m.segmentId });
        else if (m.type === "audio") {
          if (this.count + m.pcm.length > 120000) {
            this.port.postMessage({ type: "error" });
            return;
          }
          this.count += m.pcm.length;
          this.queue.push({ pcm: m.pcm });
        }
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      while (!this.current && this.queue.length) {
        const item = this.queue.shift();
        if (item.end !== undefined)
          this.port.postMessage({
            type: "drained",
            segmentId: item.end,
            generation: this.generation,
          });
        else {
          this.current = item.pcm;
          this.offset = 0;
          this.port.postMessage({
            type: "playing",
            generation: this.generation,
          });
        }
      }
      if (this.current) {
        out[i] = this.current[this.offset++] / 32768;
        this.count--;
        if (this.offset >= this.current.length) {
          this.port.postMessage({
            type: "consumed",
            bytes: this.current.length * 2,
            generation: this.generation,
          });
          this.current = null;
        }
      } else out[i] = 0;
    }
    return true;
  }
}
registerProcessor("deck-voice-playback", VoicePlayback);
