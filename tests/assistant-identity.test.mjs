import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantIdentityKey,
  projectIdentityKey,
  assistantAppearance,
  createAssistantAppearance,
} from '../src/assistantIdentity.ts';

const ref = { hostId: 'host-a', assistantId: 'asst-1' };
const image = { assetId: 'avatar-1', sha256: 'a'.repeat(64), mime: 'image/png', width: 512, height: 512 };

test('assistant identity includes its host and cannot collide through delimiters or display metadata', () => {
  assert.equal(assistantIdentityKey(ref), '["host-a","asst-1"]');
  assert.notEqual(assistantIdentityKey(ref), assistantIdentityKey({ ...ref, hostId: 'host-b' }));
  assert.notEqual(
    assistantIdentityKey({ hostId: 'a:b', assistantId: 'c' }),
    assistantIdentityKey({ hostId: 'a', assistantId: 'b:c' }),
  );
  assert.equal(assistantIdentityKey({ ...ref, name: 'Renamed', typeLabel: 'Legacy' }), '["host-a","asst-1"]');
});

test('project identity includes the exact owning host, workspace and host-canonical path', () => {
  const project = { hostId: 'host-a', workspaceId: 'ws-1', cwd: '/work/project' };
  assert.equal(projectIdentityKey(project), '["host-a","ws-1","/work/project"]');
  for (const different of [
    { ...project, hostId: 'host-b' },
    { ...project, workspaceId: 'ws-2' },
    { ...project, cwd: '/work/other' },
  ]) assert.notEqual(projectIdentityKey(project), projectIdentityKey(different));
  assert.equal(projectIdentityKey({ ...project, cwd: '/' }), '["host-a","ws-1","/"]');
});

test('malformed assistant refs fail instead of producing a routable key', () => {
  for (const invalid of [null, [], {}, { ...ref, hostId: '' }, { ...ref, hostId: ' host-a' },
    { ...ref, assistantId: ' ' }, { ...ref, assistantId: 1 }, { ...ref, assistantId: 'asst-1\0other' }]) {
    assert.throws(() => assistantIdentityKey(invalid), TypeError);
  }
});

test('malformed project refs cannot resolve a project', () => {
  const project = { hostId: 'host-a', workspaceId: 'ws-1', cwd: '/work/project' };
  for (const invalid of [null, {}, { ...project, hostId: '' }, { ...project, workspaceId: ' ' },
    { ...project, cwd: '' }, { ...project, cwd: 'relative/project' }, { ...project, cwd: '~/project' },
    { ...project, cwd: '/work/project\0other' }, { ...project, cwd: '/work/project\n' }]) {
    assert.throws(() => projectIdentityKey(invalid), TypeError);
  }
});

test('legacy appearance preserves saved color and shape and derives a host-qualified seed', () => {
  const look = { color: '#123456', shape: 'legacy-circle' };
  assert.deepEqual(assistantAppearance(ref, look), {
    seed: '["host-a","asst-1"]', color: '#123456', shape: 'legacy-circle', kind: 'pixel',
  });
  assert.notEqual(assistantAppearance(ref).seed, assistantAppearance({ ...ref, hostId: 'host-b' }).seed);
  assert.deepEqual(look, { color: '#123456', shape: 'legacy-circle' });
});

test('explicit save and reload retain appearance through a rename or color change', () => {
  const saved = { name: 'First', look: { seed: 'saved-pattern', color: '#123456', shape: 'legacy-square' } };
  const renamed = JSON.parse(JSON.stringify({ ...saved, name: 'Second', look: assistantAppearance(ref, saved.look) }));
  assert.deepEqual(renamed.look, { seed: 'saved-pattern', color: '#123456', shape: 'legacy-square', kind: 'pixel' });
  assert.deepEqual(assistantAppearance(ref, { ...renamed.look, color: '#abcdef' }), {
    seed: 'saved-pattern', color: '#abcdef', shape: 'legacy-square', kind: 'pixel',
  });
});

test('image selection keeps the saved pixel fallback and non-secret image reference', () => {
  const look = { seed: 'saved-pattern', color: '#123456', shape: 'legacy-square', kind: 'image', image };
  assert.deepEqual(assistantAppearance(ref, look), look);
  assert.deepEqual(assistantAppearance(ref, { kind: 'image', image, color: '#123456' }), {
    seed: '["host-a","asst-1"]', color: '#123456', kind: 'image', image,
  });
  assert.equal(assistantAppearance(ref, { image }).kind, 'pixel', 'missing kind remains legacy pixel');
});

test('a new appearance is created once and can be persisted without regeneration', () => {
  const first = createAssistantAppearance();
  assert.equal(first.kind, 'pixel');
  assert.ok(first.seed);
  assert.ok(first.color);
  const second = createAssistantAppearance([first]);
  assert.notEqual(second.seed, first.seed);
  assert.notEqual(second.color, first.color);
  assert.deepEqual(assistantAppearance(ref, JSON.parse(JSON.stringify(first))), first);
});
