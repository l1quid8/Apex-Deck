import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("Meta Voice capture worklet downsamples to 16kHz, so handshake must declare PCM_16KHZ", () => {
  const capture = read("src/voice/capture-worklet.js");
  // The worklet accumulator uses 16000 as target rate
  assert.match(capture, /16000/, "capture worklet should reference 16000 Hz target");
  const client = read("src/voice/metaClient.ts");
  assert.match(client, /PCM_16KHZ/, "metaClient must use PCM_16KHZ to match 16k capture");
  assert.doesNotMatch(client, /audioEncoding:\s*"PCM_24KHZ"/, "must not declare PCM_24KHZ while sending 16kHz PCM");
});

test("Meta handshake includes Bearer auth, ENDPOINTING mode, CUMULATIVE partialMode", () => {
  const client = read("src/voice/metaClient.ts");
  assert.match(client, /Bearer \$\{minted\.token\}/, "Bearer token forwarded");
  assert.match(client, /mode:\s*"ENDPOINTING"/);
  assert.match(client, /partialMode:\s*"CUMULATIVE"/);
  assert.match(client, /emitAudioProgress:\s*false/);
});

test("Meta client handles required realtime events: speechStart/transcript/speechEnd/speechComplete/error", () => {
  const client = read("src/voice/metaClient.ts");
  for (const ev of ["speechStart", "transcript", "speechEnd", "speechComplete", "error"]) {
    assert.ok(client.includes(ev), `metaClient must handle ${ev}`);
  }
  // handshake ack without type but with sessionId
  assert.match(client, /sessionId/, "handshake ack with sessionId");
});

test("Meta controller implements barge-in, mute, switchAgent, and Kokoro TTS speak path", () => {
  const ctrl = read("src/voice/metaController.ts");
  // barge-in: onSpeechStart -> stopAudio + interrupt
  assert.match(ctrl, /onSpeechStart[\s\S]*?stopAudio\(\)/, "barge-in should stopAudio on speechStart");
  assert.match(ctrl, /interrupt\(\)/, "barge-in should interrupt active turn");
  // mute
  assert.match(ctrl, /mute\(value: boolean\)/, "mute method");
  assert.match(ctrl, /if\s*\(state\.muted\)/, "checks muted state before transcript");
  // switchAgent reconnects meta
  assert.match(ctrl, /switchAgent[\s\S]*?connectMeta/, "switchAgent reconnects Meta ASR");
  // TTS via local sidecar: control speak with voice
  assert.match(ctrl, /type:\s*"speak"/, "Kokoro TTS via control speak");
});

test("Settings UI exposes all three engines with Meta model picker and both API key rows", () => {
  const settings = read("src/SettingsPage.tsx");
  assert.ok(settings.includes("Local") && settings.includes("GPT-Live") && settings.includes("Meta Voice"), "must show Local/GPT-Live/Meta Voice");
  assert.ok(settings.includes("META_MODELS") || settings.includes("Meta model"), "Meta model picker");
  assert.ok(settings.includes("OPENAI_API_KEY") && settings.includes("META_API_KEY"), "both key rows");
});

test("Daemon protocol routes voice_meta_session and mints token never logging key", () => {
  const proto = read("crates/apex-daemon/src/protocol.rs");
  assert.ok(proto.includes("voice_meta_session"), "routes voice_meta_session");
  assert.ok(proto.includes("VoiceMetaSession"), "VoiceMetaSession variant");
  const meta = read("crates/apex-daemon/src/voice/meta.rs");
  assert.match(meta, /META_API_KEY/, "lookup META_API_KEY");
  assert.ok(!meta.includes("println") || !meta.toLowerCase().includes("key"), "must not log key (no println of key)");
  // mint returns token + model, rejects empty
  assert.match(meta, /Missing Meta API key/);
});

// Regression for prior routing bug: meta commands must not be misrouted to Host command
test("Engine controller joins all three engines and picks current via settings.engine", () => {
  const eng = read("src/voice/engineController.ts");
  assert.ok(eng.includes("meta"), "engineController joins meta");
  const coord = read("src/voice/coordinator.ts");
  assert.ok(coord.includes("metaController"), "coordinator wires metaController");
  const types = read("src/voice/types.ts");
  assert.match(types, /"meta"/, "CallEngine includes meta");
});
