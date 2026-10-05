import test from 'node:test';
import assert from 'node:assert/strict';
import { appFile } from '../desktop/files.mjs';

test('app:// serves files inside dist and nothing outside it', () => {
  assert.equal(appFile('/d/dist', 'app://deck/'), '/d/dist/index.html');
  assert.equal(appFile('/d/dist', 'app://deck/assets/index-abc.js'), '/d/dist/assets/index-abc.js');
  assert.equal(appFile('/d/dist', 'app://deck/branding/mark%20one.svg?x=1#y'), '/d/dist/branding/mark one.svg');
  // The URL parser folds encoded dot segments, which keeps this one inside.
  assert.equal(appFile('/d/dist', 'app://deck/assets/%2E%2E/%2E%2E/secret'), '/d/dist/secret');
  assert.equal(appFile('/d/dist', 'app://deck/..%2Fsecret'), null);
  assert.equal(appFile('/d/dist', 'app://deck/a%00b'), null);
  assert.equal(appFile('/d/dist', 'app://other/index.html'), null);
  assert.equal(appFile('/d/dist', 'app://deck/%E0%A4%A'), null);
});
