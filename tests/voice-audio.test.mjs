import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PCMFramer,
  encodeAudio,
  decodeAudio,
} from "../src/voice/audioProtocol.ts";
import { SpeechText } from "../src/voice/speechText.ts";
test("48/44.1 kHz continuous resampling produces 512-sample frames", () => {
  for (const rate of [48000, 44100]) {
    let frames = [];
    const f = new PCMFramer(rate, (x) => frames.push(x));
    for (let i = 0; i < rate; i += 128)
      f.push(new Float32Array(Math.min(128, rate - i)).fill(0.25));
    assert.equal(frames.length, 31);
    assert.equal(frames[0].length, 512);
    assert.ok(Math.abs(frames[0][0] - 8192) < 2);
  }
});
test("tagged audio rejects bad lengths and roundtrips generation", () => {
  const b = encodeAudio(2, 9, new Int16Array(512));
  assert.equal(decodeAudio(b).generation, 2);
  assert.equal(decodeAudio(b).sequence, 9);
  assert.throws(() => decodeAudio(new ArrayBuffer(3)));
});
test("streamed prose skips split fences and inline code and bounds chunks", () => {
  const s = new SpeechText();
  let out = [];
  for (const delta of [
    "Hello. Here is `se",
    "cret` code.\n`",
    "``ts\nconst x=1;\n``",
    "`\nAll done.",
  ])
    out.push(...s.push(delta));
  out.push(...s.push("", true));
  assert.ok(out.join(" ").includes("All done"));
  assert.ok(!out.join(" ").includes("const"));
  assert.ok(!out.join(" ").includes("secret"));
  const long = new SpeechText().push(Array(80).fill("hello").join(" "), true);
  assert.ok(long.every((x) => x.split(/\s+/).length <= 22));
});
test("code-only fallback once", () => {
  const s = new SpeechText();
  assert.deepEqual(s.push("```js\nx()\n```", true), [
    "The result is in the thread.",
  ]);
  assert.deepEqual(s.push("", true), []);
});
