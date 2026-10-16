import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const start = source.indexOf('entries.flatMap((entry) => {');
const expression = source.slice(source.lastIndexOf('{', start) + 1, source.indexOf('\n        })}', start) + '\n        })'.length);
const compiled = transform(`return (${expression});`, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const render = new Function('transcriptMounted', 'entries', 'React', compiled);
test('unvisited saved chats defer transcript rows; hydrated panes keep their DOM', () => {
  let rows = 0;
  const entries = { flatMap: () => { rows++; return 'rendered'; } };
  render({ current: false }, entries, {});
  assert.equal(rows, 0, 'hidden chats must not construct Markdown and attachment rows at startup');
  assert.equal(render({ current: true }, entries, {}), 'rendered');
  assert.equal(rows, 1);
});
