import test from 'node:test';
import assert from 'node:assert/strict';
import { responsePin, pinSource, pinText, pinsAfterClear } from '../src/messagePins.ts';

test('clear keeps full response text without linking to reused message numbers', () => {
  const text = 'A long response\n' + 'x'.repeat(800);
  const pins = pinsAfterClear([responsePin(2, text), 'existing fact']);
  assert.deepEqual(pins, [text, 'existing fact']);
  assert.equal(pinSource(pins[0]), null);
  assert.equal(pinText(pins[0]), text);
});
