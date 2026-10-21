import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyPersona, defaultWriter, DraftRun } from '../src/personaDraft.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/PersonaDraft.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true,
}).code;
const PersonaDraft = new Function('require', 'useEffect', 'useRef', 'useState', 'useId', 'applyPersona', 'defaultWriter', 'DraftRun', `${code}; return PersonaDraft;`)(
  require, React.useEffect, React.useRef, React.useState, React.useId, applyPersona, defaultWriter, DraftRun,
);

test('manual persona entry remains available without a writer provider', () => {
  const html = renderToStaticMarkup(React.createElement(PersonaDraft, {
    writers: [], preset: 'ollama', taken: [], form: { name: 'Mine', persona: 'Keep my role' },
    onApply() {}, onIdea() {}, write() { throw new Error('No provider should be called'); },
  }));
  assert.match(html, /<textarea[^>]*>Keep my role<\/textarea>/);
  assert.match(html, /Install or turn on an AI in Providers/);
});
