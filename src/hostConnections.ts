import type { AgentInfo } from "./types";
import type { Status } from "./daemon/client";

export interface HostConnection {
  hostId: string; name: string; status: Status | { kind: "idle" }; revision: number;
  agents: AgentInfo[]; discovery: "idle" | "loading" | "ready" | "failed";
  /** The helper's apex-daemon version: null when it is too old to say, missing until it answers. */
  helper?: string | null;
  /** When it was last connected, in ms since the epoch; missing until it first connects. */
  seenAt?: number;
}
export interface HostConnectionStore {
  get(): HostConnection;
  subscribe(listener: () => void): () => void;
  retryNow(): void;
  recover?(callback: () => Promise<void>, pending?: () => boolean): () => void;
}
export function hostConnectionStore(hostId: string, name: string) {
  let current: HostConnection = { hostId, name, status: { kind: "idle" }, revision: 0, agents: [], discovery: "idle" };
  const listeners = new Set<() => void>(); const recovery = new Map<() => Promise<void>, () => boolean>();
  let retry = () => {}; let finish = () => {}; let generation = 0;
  const change = (next: HostConnection) => { current = next; listeners.forEach(fn => fn()); };
  return {
    get: () => current,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    retryNow: () => retry(), setRetry(fn: () => void) { retry = fn; },
    setFinishResync(fn: () => void) { finish = fn; },
    recover(fn: () => Promise<void>, pending = () => false) { recovery.set(fn, pending); return () => { recovery.delete(fn); }; },
    setStatus(status: HostConnection["status"]) {
      const refresh = (status.kind === "connected" && current.revision === 0) || status.kind === "resync";
      const resumed = status.kind === "connected" && current.status.kind !== "connected" && current.status.kind !== "resync";
      const ticket = ++generation;
      change({ ...current, status, revision: current.revision + (refresh ? 1 : 0), ...(status.kind === "connected" ? { seenAt: Date.now() } : {}) });
      if (refresh || resumed) queueMicrotask(async () => {
        if (generation !== ticket) return;
        await Promise.allSettled([...recovery].filter(([, pending]) => refresh || pending()).map(([fn]) => fn()));
        if (generation === ticket && current.status.kind === "resync") finish();
      });
    },
    setDiscovery(discovery: HostConnection["discovery"], agents = current.agents) { change({ ...current, discovery, agents }); },
    setHelper(helper: string | null | undefined) { if (helper !== current.helper) change({ ...current, helper }); },
    rename(name: string) { if (name !== current.name) change({ ...current, name }); },
  };
}
