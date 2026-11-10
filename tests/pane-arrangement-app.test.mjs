import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const declaration = app.match(/const arrange = \([\s\S]*?\n  \};/)[0];
const code = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
function harness(initial) {
  let arrangement = initial;
  const calls = [];
  const bindings = {
    arrangement, focusedPane: 'c',
    setArrangement: value => { arrangement = value; },
    setMaximized: value => calls.push(value),
  };
  return { arrange: new Function(...Object.keys(bindings), `${code}; return arrange;`)(...Object.values(bindings)), get: () => arrangement, calls };
}

test('switching into a band or grid resets zoom while preserving pane order', () => {
  for (const mode of ['grid', 'horizontal', 'vertical']) {
    const h = harness({mode:'left',order:['a','b','c'],zoom:2,focusShare:.64});
    h.arrange(mode);
    assert.deepEqual(h.get(), {mode,order:['a','b','c'],zoom:1,focusShare:.64});
    assert.deepEqual(h.calls, [null]);
  }
});

test('switching Focus sides keeps zoom and share and makes the focused pane tall', () => {
  const h = harness({mode:'left',order:['a','b','c'],zoom:2,focusShare:.64});
  h.arrange('right');
  assert.deepEqual(h.get(), {mode:'right',order:['c','a','b'],zoom:2,focusShare:.64});
});
