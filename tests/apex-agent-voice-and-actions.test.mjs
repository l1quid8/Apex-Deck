import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bestVoice } from '../src/personalSpeech.ts';

test('bestVoice prefers a premium natural voice over compact and novelty ones', () => {
  const voices = [
    { name: 'Fred', lang: 'en-US' },
    { name: 'Samantha (Compact)', lang: 'en-US' },
    { name: 'Zoe (Premium)', lang: 'en-US' },
    { name: 'Ava (Enhanced)', lang: 'en-US' },
    { name: 'Amelie', lang: 'fr-CA' },
  ];
  assert.equal(bestVoice(voices)?.name, 'Zoe (Premium)');
  assert.equal(bestVoice([{ name: 'Amelie', lang: 'fr-CA' }]), undefined);
});

test('the action chevron reveals extra actions and never hides the message text', () => {
  const source = readFileSync(new URL('../src/ApexAgentMessageActions.tsx', import.meta.url), 'utf8');
  const readAloud = readFileSync(new URL('../src/ReadAloudAction.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /apex-agent-message-collapsed/);
  assert.match(source, /Show message actions/);
  assert.match(readAloud, /aria-label=\{speaking \? 'Stop reading aloud' : 'Read aloud'\}/);
});
