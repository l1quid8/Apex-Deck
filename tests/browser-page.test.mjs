import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFailure } from '../src/browserPage.ts';

const page = (extra) => ({ url: 'http://localhost:3000/', title: '', loading: false, canGoBack: false, canGoForward: false, ...extra });
const refused = { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:3000/' };

test('a failed load is shown as soon as it is reported, loading or not', () => {
  assert.equal(loadFailure(null, page({ loading: true, error: refused })), refused);
  assert.equal(loadFailure(null, page({ error: refused })), refused);
});

test('the failure stays while the next try loads, so the pane does not flash blank', () => {
  assert.equal(loadFailure(refused, page({ loading: true })), refused);
});

test('the failure goes once a load ends without one', () => {
  assert.equal(loadFailure(refused, page({ title: 'My app' })), null);
  assert.equal(loadFailure(null, page({})), null);
});
