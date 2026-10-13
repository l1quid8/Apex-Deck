// Which windows hold unsaved file edits. Closing the side panel or a Files tab asks before it throws them away.
const open = new Map<symbol, string>();

/** Records the file with unsaved edits for `owner`, or clears it with null. */
export function setUnsavedEdit(owner: symbol, file: string | null) {
  if (file) open.set(owner, file); else open.delete(owner);
}

/** The name of a file with unsaved edits, or null when nothing is waiting to be saved. */
export function unsavedEditName(): string | null {
  return open.values().next().value ?? null;
}
