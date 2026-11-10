// The threads this phone has open.
//
// The Mac keeps several threads on screen at once, so "open" there means "a pane exists". A phone fits
// one, and swiping through every thread in the Threads list would mean passing threads you never asked
// for. So the phone keeps its own small set: opening a thread adds it, ⋯ → Close thread takes it out,
// and a swipe only ever moves between the threads in it. Closing one shows a neighbour from the same
// set; closing the last goes back to the list. The conversation still lives in the Threads list
// afterwards — closing is not deleting.
//
// iOS shuts apps down in the background without warning, so the set is saved on the phone and read
// back at launch. That has a cost: a thread in the saved set can be deleted, archived or moved while
// the app is closed, so the set is trimmed against what the machines still have, and a machine whose
// list this phone hasn't loaded yet (or that is offline) keeps its threads because they come back.
//
// These are plain functions so they can be tested without a screen.

/** A thread named by machine and id, as `threadKey` in chatRoutes.ts names it. */
export type OpenKey = string;

/** The machine and id inside a thread key, or null for a key this phone didn't write. */
export function openKeyParts(key: OpenKey): { hostId: string; id: string } | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [hostId, id] = parsed;
    if (typeof hostId !== "string" || typeof id !== "string" || !hostId || !id) return null;
    return { hostId, id };
  } catch { return null; }
}

/**
 * The open set as it was saved. Anything unreadable is dropped rather than guessed at, and a key that
 * isn't a thread key goes with it: a half-written list must not stop the app opening a thread.
 */
export function readOpenThreads(raw: string | null | undefined): OpenKey[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const keys: OpenKey[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || !openKeyParts(entry) || keys.includes(entry)) continue;
    keys.push(entry);
  }
  return keys;
}

/** The saved form of the open set. */
export function writeOpenThreads(keys: readonly OpenKey[]): string {
  return JSON.stringify(keys);
}

/**
 * The set with this thread open. Opening one that is already open leaves it where it is, so reaching
 * a thread from a notification, a search or the list focuses it without moving it away from the
 * threads beside it. Nothing is ever evicted to make room: opening a thread must not close one the
 * person opened on purpose — ⋯ → Close thread is the only way out.
 */
export function withOpenThread(keys: readonly OpenKey[], key: OpenKey): OpenKey[] {
  if (!openKeyParts(key)) return [...keys];
  if (keys.includes(key)) return [...keys];
  return [...keys, key];
}

/** The set without this thread. Closing one that isn't open changes nothing. */
export function withoutOpenThread(keys: readonly OpenKey[], key: OpenKey): OpenKey[] {
  return keys.filter((item) => item !== key);
}

/**
 * The set after a look at what the machines still have. `alive` says whether a key is still a thread
 * that can be opened: true keeps it, false drops it, null means "can't tell yet" — a machine this
 * phone hasn't loaded or that is away — and that thread stays, because it will be back.
 */
export function pruneOpenThreads(keys: readonly OpenKey[], alive: (key: OpenKey) => boolean | null): OpenKey[] {
  return keys.filter((key) => alive(key) !== false);
}

/**
 * The thread shown after `closing` leaves the set: the one that took its place, else the one before
 * it, else null — the last one closed, so the screen goes back to the Threads list.
 */
export function afterClose(keys: readonly OpenKey[], closing: OpenKey): OpenKey | null {
  const at = keys.indexOf(closing);
  if (at < 0) return keys[0] ?? null;
  const rest = keys.filter((key) => key !== closing);
  return rest[at] ?? rest[at - 1] ?? null;
}

/**
 * The open threads in the order they were opened, as the swipe strip. A key that can't be drawn yet —
 * the Mac's list hasn't loaded, so there is no title or machine to show for it — is left out of the
 * strip rather than swiped onto, and comes back as soon as its list does.
 */
export function openStrip(keys: readonly OpenKey[], drawable: (key: OpenKey) => boolean): OpenKey[] {
  return keys.filter(drawable);
}
