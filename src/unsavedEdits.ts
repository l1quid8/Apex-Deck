// Which windows hold unsaved file edits. Closing the side panel or a Files tab asks before it throws them away.
const open = new Map<symbol, string>();

/** Records the file with unsaved edits for `owner`, or clears it with null. */
export function setUnsavedEdit(owner: symbol, file: string | null) {
  if (file) open.set(owner, file); else open.delete(owner);
  report();
}

/** Tells the desktop app, which refuses Quit and "Restart to update" from another window while this one holds edits. */
function report() {
  if (typeof window !== "undefined") void window.apexDeck?.updates?.unsavedEdit(unsavedEditName()).catch(() => {});
}
// A window that has just loaded, or reloaded, holds none.
report();

/** The name of a file with unsaved edits, or null when nothing is waiting to be saved. */
export function unsavedEditName(): string | null {
  return open.values().next().value ?? null;
}

/** Asked before something drops the unsaved edits to `file`. */
export function discardQuestion(file: string): { title: string; body: string; action: string } {
  return { title: `Discard unsaved changes to ${file}?`, body: "Your edits to this file haven't been saved.", action: "Discard" };
}
