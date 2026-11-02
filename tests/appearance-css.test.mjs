import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'lightningcss';

test('Appearance Studio compiles with the production CSS minifier', () => {
  const code = readFileSync(new URL('../src/appearance-studio.css', import.meta.url));
  const result = transform({ filename: 'appearance-studio.css', code, minify: true });
  assert.ok(result.code.length > 0);
});
