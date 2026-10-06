import type { AgentInfo } from "./types";
import type { Status } from "./daemon/client";

export interface HostConnection {
  hostId: string; name: string; status: Status | { kind: "idle" }; revision: number;
  agents: AgentInfo[]; discovery: "idle" | "loading" | "ready" | "failed";
}
export interface HostConnectionStore {
  get(): HostConnection;
  subscribe(listener: () => void): () => void;
  retryNow(): void;
  recover?(callback: () => Promise<void>): () => void;
}
export function hostConnectionStore(hostId: string, name: string) {
  let current: HostConnection = { hostId, name, status: { kind: "idle" }, revision: 0, agents: [], discovery: "idle" };
  const listeners = new Set<() => void>(); const recovery = new Set<() => Promise<void>>();
  let retry = () => {}; let finish = () => {}; let generation = 0;
  const change = (next: HostConnection) => { current = next; listeners.forEach(fn => fn()); };
  return {
    get: () => current,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    retryNow: () => retry(), setRetry(fn: () => void) { retry = fn; },
    setFinishResync(fn: () => void) { finish = fn; },
    recover(fn: () => Promise<void>) { recovery.add(fn); return () => { recovery.delete(fn); }; },
    setStatus(status: HostConnection["status"]) {
      const refresh = (status.kind === "connected" && current.revision === 0) || status.kind === "resync";
      const ticket = ++generation;
      change({ ...current, status, revision: current.revision + (refresh ? 1 : 0) });
      if (refresh) queueMicrotask(async () => {
        await Promise.allSettled([...recovery].map(fn => fn()));
        if (generation === ticket && current.status.kind === "resync") finish();
      });
    },
    setDiscovery(discovery: HostConnection["discovery"], agents = current.agents) { change({ ...current, discovery, agents }); },
  };
}
