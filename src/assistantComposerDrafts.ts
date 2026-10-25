import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** Session-only UI drafts. Keys are durable host+assistant identities supplied by
 * the collection; records, credentials and browser storage are never touched. */
type Draft = { fields: Map<string, unknown>; listeners: Map<string, Set<() => void>> };
const drafts = new Map<string, Draft>();
export function assistantComposerDraftFor(key: string | undefined): Draft | null {
  if (key === undefined) return null;
  let draft = drafts.get(key);
  if (!draft) { draft = { fields: new Map(), listeners: new Map() }; drafts.set(key, draft); }
  return draft;
}

/** Put text in a teammate's composer, addressed to that teammate. Nothing is sent. */
export function prefillAssistantComposer(key: string, text: string): void {
  const draft = assistantComposerDraftFor(key)!;
  for (const [field, value] of [['text', text], ['draftFallback', key]] as const) {
    draft.fields.set(field, value);
    draft.listeners.get(field)?.forEach(update => update());
  }
}

export function useAssistantComposerDraftState<T>(key: string | undefined, field: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const draft = assistantComposerDraftFor(key);
  if (draft && !draft.fields.has(field)) draft.fields.set(field, initial);
  const [value, setValue] = useState(draft ? draft.fields.get(field) as T : initial);
  useEffect(() => {
    if (!draft) return;
    const update = () => setValue(draft.fields.get(field) as T);
    const listeners = draft.listeners.get(field) ?? new Set();
    draft.listeners.set(field, listeners); listeners.add(update); update();
    return () => { listeners.delete(update); };
  }, [draft, field]);
  const set: Dispatch<SetStateAction<T>> = (next) => {
    if (!draft) { setValue(next); return; }
    const current = draft.fields.get(field) as T;
    const result = typeof next === 'function' ? (next as (value: T) => T)(current) : next;
    draft.fields.set(field, result);
    draft.listeners.get(field)?.forEach(update => update());
  };
  return [draft ? draft.fields.get(field) as T : value, set];
}

