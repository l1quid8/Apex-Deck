import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';

// ConfirmDialog is drawn into document.body, so a window opened from inside a
// glass card isn't squeezed by the card's backdrop-filter.
const source = await fs.readFile(new URL('../src/ConfirmDialog.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace('export function ConfirmDialog', 'function ConfirmDialog'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;

const body = { tag: 'body' };
const portals = [];
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
const createPortal = (children, container) => { const portal = { portal: true, children, container }; portals.push(portal); return portal; };
const ConfirmDialog = new Function('React', 'useRef', 'useEffect', 'createPortal', 'document', `${code}; return ConfirmDialog;`)(
  React, (initial) => ({ current: initial }), () => {}, createPortal, { body },
);

test('a confirm window mounted inside a settings card is portaled straight to document.body', () => {
  const question = { title: 'Remove this server?', body: 'It stops being used.', action: 'Remove', onConfirm() {} };
  const card = React.createElement('section', { className: 'settings-card' }, ConfirmDialog({ question, onCancel() {} }));
  const [portal] = portals;
  assert.equal(card.children.length, 1);
  assert.equal(card.children[0], portal, 'the card holds only the portal, not the backdrop');
  assert.equal(portal.container, body);
  assert.equal(portal.children.props.className, 'confirm-backdrop');
});
