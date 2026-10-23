import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const FILES = ['assistant-workspace.css', 'assistant-tasks.css', 'assistant-projects.css', 'assistant-editor.css', 'personal-panels.css'];
const COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/gi;

test('assistant CSS uses theme tokens only', () => {
  for (const file of FILES) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(css.match(COLOR) ?? [], [], file);
  }
});

test('assistant-active defines aliases from theme tokens, never a palette', () => {
  const block = read('assistant-workspace.css').match(/\.app\.assistant-active\{([^}]*)\}/)[1];
  for (const name of ['--bg', '--panel', '--panel-2', '--line', '--text', '--muted', '--accent']) assert.doesNotMatch(block, new RegExp(`(^|;)${name}:`), name);
  assert.match(block, /--mint:var\(--accent\)/);
  assert.match(block, /--amber:var\(--warn\)/);
  assert.match(block, /--shell:var\(--bg\)/);
});

test('glass and clay treat the assistant workspace as a surface', () => {
  assert.match(read('glass-theme.css'), /\.assistant-workspace/);
  assert.match(read('clay-theme.css'), /\.assistant-workspace/);
});
