import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFirstBrief } from '../src/assistantWorkspaceModel.ts';
import { assistantComposerDraftFor, prefillAssistantComposer } from '../src/assistantComposerDrafts.ts';

test('the host create request never carries the first brief', () => {
  const { request, brief } = splitFirstBrief({ workspaceVersion: 4, name: 'Fidelity QA', firstBrief: 'Keep the tests green.' });
  assert.deepEqual(request, { workspaceVersion: 4, name: 'Fidelity QA' });
  assert.equal('firstBrief' in request, false);
  assert.equal(brief, 'Keep the tests green.');
  assert.equal(splitFirstBrief({ name: 'A' }).brief, undefined);
});

test('the brief lands in the new teammate composer, addressed to it, and listeners hear it', () => {
  const key = 'host/new-teammate';
  const draft = assistantComposerDraftFor(key);
  let heard = 0;
  draft.listeners.set('text', new Set([() => { heard++; }]));
  prefillAssistantComposer(key, 'Keep the tests green.');
  assert.equal(draft.fields.get('text'), 'Keep the tests green.');
  assert.equal(draft.fields.get('draftFallback'), key);
  assert.equal(heard, 1);
});
