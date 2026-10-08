import test from 'node:test';
import assert from 'node:assert/strict';
import { dollars, mediaMenuLine, mediaSendsFor, pictureLine, priceSend, quoteFor, sourceKey, sumPrices } from '../src/mediaPrice.ts';
import { resolveMedia } from '../src/media.ts';

test('dollars read like the rest of the app', () => {
  assert.equal(dollars(0.03), '$0.03');
  assert.equal(dollars(0.075), '$0.075');
  assert.equal(dollars(1.44), '$1.44');
});

test('prices sum over the known ones only', () => {
  assert.equal(sumPrices([0.03, null, 1.41]), 1.44);
  assert.equal(sumPrices([null, undefined]), null);
  assert.equal(sumPrices([]), null);
});

test('menu lines say what a picture costs and what a video needs', () => {
  assert.equal(mediaMenuLine({ id: 'p', kind: 'image', media: { prices: { '1K': 0.03 }, resolutions: ['1K'], price: null } }), '$0.03 per picture');
  assert.equal(mediaMenuLine({ id: 'p', kind: 'image' }), 'Price on send');
  assert.equal(mediaMenuLine({ id: 'v', kind: 'video' }), 'Price on send');
  assert.equal(mediaMenuLine({ id: 'v', kind: 'video', media: { needs_image: true } }), 'Price on send · Needs a picture');
  assert.equal(mediaMenuLine({ id: 't' }), '');
});

test('the settings price line notes an edit model', () => {
  const spec = { price: 0.04, edit_model: 'edit-1' };
  assert.equal(pictureLine(spec, resolveMedia('image', spec, null)), '$0.04 per picture · edits an attached picture');
  assert.equal(pictureLine({}, resolveMedia('image', {}, null)), 'Price on send');
});

test('quotes are asked once per model and settings, and failures are not kept', async () => {
  let calls = 0;
  const source = { apiQuote: async (_b, _k, _m, media) => { calls += 1; return media.duration === '5s' ? 0.72 : null; } };
  const media = (duration) => resolveMedia('video', { durations: ['5s', '10s'] }, { duration });
  assert.equal(await quoteFor(source, 'https://x', null, 'vid', media('5s')), 0.72);
  assert.equal(await quoteFor(source, 'https://x', null, 'vid', media('5s')), 0.72);
  assert.equal(calls, 1);
  assert.equal(await quoteFor(source, 'https://x', null, 'vid', media('10s')), null);
  assert.equal(calls, 2);
  let fails = 0;
  const flaky = { apiQuote: async () => { fails += 1; if (fails === 1) throw new Error('down'); return 0.5; } };
  await assert.rejects(quoteFor(flaky, 'https://y', null, 'vid', media('5s')));
  assert.equal(await quoteFor(flaky, 'https://y', null, 'vid', media('5s')), 0.5);
});

test('a send picks up its picture and video bots and what each will make', () => {
  const api = (id, model) => ({ id, display_name: id, backend: { kind: 'open_ai_compatible', base_url: 'https://p', model, api_key_env: 'K' }, persona: '', access: 'read', effort: null, media: { resolution: '2K' } });
  const participants = [api('text', 'chat'), api('pic', 'pic-1'), api('vid', 'vid-1'), { ...api('agent', ''), backend: { kind: 'agent', tool: 'codex', model: null } }];
  const lists = { [sourceKey('https://p', 'K')]: [
    { id: 'chat' },
    { id: 'pic-1', kind: 'image', media: { resolutions: ['1K', '2K'], prices: { '1K': 0.03, '2K': 0.06 }, edit_model: 'pic-edit', edit_price: 0.1 } },
    { id: 'vid-1', kind: 'video', media: { needs_image: true } },
  ] };
  const sends = mediaSendsFor(['text', 'pic', 'vid', 'agent'], participants, lists, false);
  assert.deepEqual(sends.map(s => [s.name, s.kind]), [['pic', 'image'], ['vid', 'video']]);
  assert.equal(sends[0].resolved.resolution, '2K');
  assert.equal(sends[0].editing, false);
  assert.equal(mediaSendsFor(['pic'], participants, lists, true)[0].editing, true);
});

test('a total includes pictures and video quotes, and flags a video with no picture', async () => {
  const source = { apiQuote: async () => 1.44 };
  const sends = mediaSendsFor(['pic', 'vid'], [
    { id: 'pic', display_name: 'Pic', backend: { kind: 'open_ai_compatible', base_url: 'https://p', model: 'pic-1', api_key_env: null }, persona: '', access: 'read', effort: null },
    { id: 'vid', display_name: 'Vid', backend: { kind: 'open_ai_compatible', base_url: 'https://p', model: 'vid-1', api_key_env: null }, persona: '', access: 'read', effort: null },
  ], { [sourceKey('https://p', null)]: [
    { id: 'pic-1', kind: 'image', media: { price: 0.03 } },
    { id: 'vid-1', kind: 'video', media: { needs_image: true } },
  ] }, false);
  const priced = await priceSend(sends, source);
  assert.equal(priced.usd, 1.47);
  assert.equal(priced.missing?.name, 'Vid');
  const withPicture = await priceSend(mediaSendsFor(['pic', 'vid'], [], {}, true), source);
  assert.equal(withPicture.usd, null);
});
