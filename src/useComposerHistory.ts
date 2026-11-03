import { useLayoutEffect, useRef } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { createComposerHistory } from './composerHistory.ts';
import type { assistantComposerDraftFor } from './assistantComposerDrafts.ts';
import type { HistoryField } from './composerHistory.ts';

/** Every ordinary write (typing, voice, restore, send) ends history browsing. */
export function useComposerHistory(scope: string, text: string, write: Dispatch<SetStateAction<string>>, history: () => readonly string[], draft?: ReturnType<typeof assistantComposerDraftFor>) {
  const navigation = useRef(createComposerHistory());
  const pending = useRef<{ scope: string; field: HistoryField; input: HTMLTextAreaElement } | null>(null);
  const writing = useRef(false);
  useLayoutEffect(() => {
    if (!draft) return;
    const reset = () => {
      if (writing.current) return;
      navigation.current.reset();
      pending.current = null;
    };
    const listeners = draft.listeners.get('text') ?? new Set<() => void>();
    draft.listeners.set('text', listeners);
    listeners.add(reset);
    return () => { listeners.delete(reset); };
  }, [draft]);
  const previous = useRef({ scope, text });
  useLayoutEffect(() => {
    if (previous.current.scope !== scope || (previous.current.text !== text && pending.current?.field.value !== text)) {
      navigation.current.reset();
      pending.current = null;
    }
    previous.current = { scope, text };
    const update = pending.current;
    pending.current = null;
    if (update && update.scope === scope && update.field.value === text) {
      update.input.setSelectionRange(update.field.selectionStart, update.field.selectionEnd, update.field.selectionDirection);
    }
  });
  const setText: Dispatch<SetStateAction<string>> = value => {
    navigation.current.reset();
    pending.current = null;
    write(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const input = event.currentTarget;
    const field = navigation.current.navigate(scope, history(), {
      value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, selectionDirection: input.selectionDirection,
    }, { ...event, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode });
    if (!field) return false;
    event.preventDefault();
    pending.current = { scope, field, input };
    writing.current = true;
    try { write(field.value); } finally { writing.current = false; }
    // React may bail out when two neighboring history entries have equal text.
    input.setSelectionRange(field.selectionStart, field.selectionEnd, field.selectionDirection);
    return true;
  };
  return { setText, onKeyDown };
}
