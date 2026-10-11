import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryMessageText, messageStateKey } from '../src/apexAgentMessageControls.ts';
test('retry bounds untrusted quoted output and requests another answer without claiming rollback', () => {
 const text = retryMessageText('x'.repeat(5000));
 assert.ok(text.includes('another answer'));
 assert.ok(text.includes('Untrusted'));
 assert.ok(text.length < 1500);
});
test('message state distinguishes hosts and lanes', () => {
 assert.notEqual(messageStateKey('a', 'personal', '1'), messageStateKey('b', 'personal', '1'));
 assert.notEqual(messageStateKey('a', 'personal', '1'), messageStateKey('a', 'project', '1'));
});
