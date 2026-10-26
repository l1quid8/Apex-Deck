// The app used to print a fixed product word ("ApexAgent") wherever it meant the
// personal assistant. People name their assistant, so the visible text asks this
// helper instead. Storage keys, monitor ids and the host's `apex-agent` folder keep
// the old spelling on purpose: renaming those would orphan saved data.

/** Shown while a name hasn't loaded, or when one was left blank. */
export const ASSISTANT_FALLBACK_NAME = 'Assistant';

/** One assistant's name for prose and labels, trimmed, never empty. */
export function assistantDisplayName(name?: string | null): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || ASSISTANT_FALLBACK_NAME;
}
