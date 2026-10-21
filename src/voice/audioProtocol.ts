export const HEADER_SIZE = 12;
export function encodeAudio(
  generation: number,
  sequence: number,
  pcm: Int16Array,
): ArrayBuffer {
  const b = new ArrayBuffer(HEADER_SIZE + pcm.byteLength),
    v = new DataView(b);
  v.setUint8(0, 68);
  v.setUint8(1, 86);
  v.setUint16(2, 1, true);
  v.setUint32(4, generation, true);
  v.setUint32(8, sequence, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(12 + i * 2, pcm[i], true);
  return b;
}
export function decodeAudio(b: ArrayBuffer): {
  generation: number;
  sequence: number;
  pcm: Int16Array;
} {
  const v = new DataView(b);
  if (
    b.byteLength < 14 ||
    b.byteLength > 240012 ||
    b.byteLength % 2 ||
    v.getUint16(0, true) !== 22084 ||
    v.getUint16(2, true) !== 1
  )
    throw Error("Invalid voice audio");
  const pcm = new Int16Array((b.byteLength - 12) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(12 + i * 2, true);
  return {
    generation: v.getUint32(4, true),
    sequence: v.getUint32(8, true),
    pcm,
  };
}
/** Fractional position survives render quanta, including 44.1 kHz sources. */
export class PCMFramer {
  private phase = 0;
  private frame = new Int16Array(512);
  private used = 0;
  private rate: number;
  private emit: (pcm: Int16Array) => void;
  constructor(rate: number, emit: (pcm: Int16Array) => void) {
    this.rate = rate;
    this.emit = emit;
  }
  push(input: Float32Array) {
    for (const x of input) {
      this.phase += 16000;
      if (this.phase >= this.rate) {
        this.phase -= this.rate;
        this.frame[this.used++] = Math.round(
          Math.max(-1, Math.min(1, x)) * 32767,
        );
        if (this.used === 512) {
          this.emit(this.frame);
          this.frame = new Int16Array(512);
          this.used = 0;
        }
      }
    }
  }
}
