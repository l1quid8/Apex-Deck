// Where the window's connection to its host stands, for the loading screen
// and the banner. Only the Electron app sets it.

import type { Status } from "./daemon/client";

export interface Connection {
  status: Status;
  /** The host's name as the person knows it: "This Mac", or a saved host's name. */
  host: string;
}

export function connectionStore() {
  let current: Connection = { status: { kind: "connecting" }, host: "This Mac" };
  const listeners = new Set<() => void>();
  const change = (next: Connection) => {
    current = next;
    listeners.forEach((cb) => cb());
  };
  return {
    get: () => current,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    setStatus: (status: Status) => change({ ...current, status }),
    setHost: (host: string) => change({ ...current, host }),
  };
}

/** The app's one connection. */
export const connection = connectionStore();

/** What to say about `status`; `now` counts down to the next try. */
export function statusWords(status: Status, host: string, now: number): string {
  switch (status.kind) {
    case "connecting": return `Connecting to ${host}…`;
    case "connected": return `Connected to ${host}.`;
    case "reconnecting": {
      const seconds = Math.ceil((status.retryAt - now) / 1000);
      return `Reconnecting to ${host}… ${seconds > 0 ? `next try in ${seconds} s` : "trying now"}`;
    }
    case "resync": return `Catching up with ${host}…`;
    case "failed": return `Can't connect to ${host}. ${status.reason}`;
  }
}
