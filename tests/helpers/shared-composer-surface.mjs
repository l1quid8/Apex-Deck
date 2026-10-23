import fs from 'node:fs';
import { createRequire } from 'node:module';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../../src/ThreadComposer.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;

/** Render the real stateless composer components while retaining boundary
 * components as inspectable nodes in the surrounding hook harness. */
export function sharedComposerSurface() {
  const shared = new Set();
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity);
      if (shared.has(type)) return type({ ...(props ?? {}), children: flat });
      return { type, props: props ?? {}, children: flat };
    },
  };
  const components = new Function('React', `${compiled}; return {ThreadComposerBox, ComposerModeControls};`)(React);
  Object.values(components).forEach(component => shared.add(component));
  return { React, ...components };
}
