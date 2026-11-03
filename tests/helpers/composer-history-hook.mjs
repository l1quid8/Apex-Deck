import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createComposerHistory } from '../../src/composerHistory.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../../src/useComposerHistory.ts', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript'] }).code;
export const historyHookFor = hooks => new Function('useRef', 'useLayoutEffect', 'createComposerHistory', `${compiled}; return useComposerHistory;`)(hooks.useRef, hooks.useLayoutEffect, createComposerHistory);
