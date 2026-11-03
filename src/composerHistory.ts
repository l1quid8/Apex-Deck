export type HistoryField = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: 'forward' | 'backward' | 'none';
};
type HistoryKey = {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** Inputs are already in transcript order. Keep exact text and duplicates. */
export function threadHistoryTexts(messages: readonly { speaker: { kind: string }; text: string }[]): string[] {
  return messages.filter(m => m.speaker.kind === 'human' && m.text.trim()).map(m => m.text);
}
export function assistantHistoryTexts(entries: readonly { workspaceId: string; message: { role: string; text: string } }[], lane: string | null): string[] {
  return entries.filter(e => e.workspaceId === lane && e.message.role === 'human' && e.message.text.trim()).map(e => e.message.text);
}

export function createComposerHistory() {
  let browsing: { scope: string; history: string[]; index: number; draft: HistoryField; recalled: string } | null = null;
  const reset = () => { browsing = null; };
  return {
    reset,
    navigate(scope: string, history: readonly string[], field: HistoryField, event: HistoryKey): HistoryField | null {
      if (browsing && (browsing.scope !== scope || browsing.recalled !== field.value)) reset();
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.keyCode === 229 || field.selectionStart !== field.selectionEnd) return null;
      const up = event.key === 'ArrowUp';
      if (!up && event.key !== 'ArrowDown') return null;
      const caret = field.selectionStart;
      if (up ? field.value.slice(0, caret).includes('\n') : field.value.slice(caret).includes('\n')) return null;
      if (!browsing) {
        if (!up) return null;
        const snapshot = history.filter(text => text.trim());
        if (!snapshot.length) return null;
        browsing = { scope, history: snapshot, index: snapshot.length, draft: { ...field }, recalled: field.value };
      }
      const next = browsing.index + (up ? -1 : 1);
      if (next >= browsing.history.length) {
        const draft = browsing.draft;
        reset();
        return draft;
      }
      browsing.index = Math.max(0, next);
      const value = browsing.history[browsing.index];
      browsing.recalled = value;
      return { value, selectionStart: value.length, selectionEnd: value.length, selectionDirection: 'none' };
    },
  };
}
