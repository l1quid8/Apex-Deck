import fs from 'node:fs';
import { createRequire } from 'node:module';
import { assistantComposerDraftFor } from '../../src/assistantComposerDrafts.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
// Run the production hook with the same hook harness as the component. The
// actual module's store is shared across separately mounted test components.
const source = fs.readFileSync(new URL('../../src/assistantComposerDrafts.ts', import.meta.url), 'utf8');
const hook = source.slice(source.indexOf('export function useAssistantComposerDraftState')).replace(/^export /, '');
const compiled = transform(hook, { transforms: ['typescript'] }).code;
export { assistantComposerDraftFor };
export const draftHookFor = hooks => new Function('useState', 'useEffect', 'assistantComposerDraftFor', `${compiled}\nreturn useAssistantComposerDraftState;`)(hooks.useState, hooks.useEffect, assistantComposerDraftFor);
