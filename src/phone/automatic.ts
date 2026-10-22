// The phone always connects Automatic: direct when it can, the relay when it
// can't. A saved Direct only choice is deleted on launch and never read back.

import { FinalError } from "../daemon/client.ts";

/** The old Direct only setting. Deleted, never read, so it can't come back. */
export const REMOTE_MODE_KEY = "apex-deck.phone.remote-mode.v1";

export function clearRemoteMode(storage: { removeItem(key: string): void }): void {
  storage.removeItem(REMOTE_MODE_KEY);
}

/** Shown when Automatic setup fails, instead of dialing in an unknown mode. */
export function phoneConnectionsMessage(error: unknown): string {
  const reason = String(error).replace(/^Error: /, "");
  return `Couldn't set up phone connections: ${reason}`;
}

/**
 * One `setMode("automatic")`. No plugin means there is nothing to set up.
 * A rejection is observed here, so a launch where nothing connects yet does
 * not raise an unhandled rejection. Anyone who waits on the returned promise
 * still sees that same rejection.
 */
export function startAutomatic(plugin: { setMode(mode: "automatic"): Promise<unknown> } | null): Promise<void> {
  if (!plugin) return Promise.resolve();
  const ready = plugin.setMode("automatic").then(
    () => undefined,
    (error: unknown) => Promise.reject(new FinalError(phoneConnectionsMessage(error))),
  );
  void ready.catch(() => {});
  return ready;
}

/** QR pairing when the native plugin is there; an address and token otherwise. */
export function defaultAddHow(pairing: boolean): "qr" | "address" {
  return pairing ? "qr" : "address";
}

export const PAIR_MACHINE_HINT = "On the machine, open Settings → Phones → Pair phone.";

/**
 * Connect or pair only after Automatic setup has finished. A failed setup
 * rejects with the message for the person, and `go` never runs.
 */
export async function whenAutomatic<T>(ready: Promise<void>, go: () => Promise<T> | T): Promise<T> {
  try {
    await ready;
  } catch (error) {
    const message = error instanceof FinalError ? error.message : phoneConnectionsMessage(error);
    throw new FinalError(message);
  }
  return go();
}
