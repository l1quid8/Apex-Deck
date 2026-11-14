import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as settings from '../src/voice/settings.ts';

const { transform } = createRequire(import.meta.url)('sucrase');

test('Read aloud reads the current Settings voice on every click, with Adam as default', async () => {
  // Keep registration and selection real; replace the audio engines at their boundary.
  const voices = [];
  const engine = { getState: () => ({ status: 'off' }), stopSample() {}, readAloud: async (_text, voice) => voices.push(voice) };
  const dependencies = {
    ...settings,
    createVoiceController: () => engine,
    createRealtimeVoiceController: () => engine,
    createMetaVoiceController: () => engine,
    joinVoiceEngines: () => ({ controller: engine }),
    openVoiceAudio() {}, playVoiceSample() {}, connectLocalVoice() {},
    publishPlaybackLevel() {}, mintForScope() {}, mintMetaForScope() {},
  };
  const source = readFileSync(new URL('../src/voice/coordinator.ts', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  const compiled = transform(source, { transforms: ['typescript'] }).code;
  const { registerVoiceThread, unregisterVoiceThread, readResponseAloud, voiceRegistration } = new Function(
    ...Object.keys(dependencies),
    `${compiled}\nreturn { registerVoiceThread, unregisterVoiceThread, readResponseAloud, voiceRegistration };`,
  )(...Object.values(dependencies));
  await readResponseAloud('No selection yet.').done;
  const scope = { hostId: 'h', roomId: 'r' };
  const key = JSON.stringify(['h', 'r']);
  const entry = { candidates: [], settings: settings.readVoiceSettings({ defaultVoice: 'af_heart' }), save() {}, focus() {}, bridge() {} };
  registerVoiceThread(key, entry);
  await readResponseAloud('First selection.').done;
  voiceRegistration(scope).save(settings.readVoiceSettings({ defaultVoice: 'bm_george' }));
  await readResponseAloud('Changed selection.').done;
  // Settings updates also arrive by re-registering the rendered thread.
  registerVoiceThread(key, { ...entry, settings: settings.readVoiceSettings({ defaultVoice: 'am_michael' }) });
  await readResponseAloud('Saved selection.').done;
  unregisterVoiceThread(key);
  assert.deepEqual(voices, ['am_adam', 'af_heart', 'bm_george', 'am_michael']);
});
