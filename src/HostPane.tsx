import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { Backend } from "./backend";
import type { AgentInfo } from "./types";
import { startHub } from "./hub";
import { hostConnectionStore } from "./hostConnections";
const demo = hostConnectionStore("local", "This Mac");
demo.setStatus({ kind: "connected", hostId: "demo" });

/** Hooks stay outside the pane map; a host's discovery never inherits the Mac's. */
export function HostPane({ backend, agents, children }: { backend: Backend; agents: AgentInfo[]; children(found: AgentInfo[]): ReactNode }) {
  const store = backend.host?.connection ?? demo;
  const state = useSyncExternalStore(store.subscribe, store.get);
  useEffect(() => {
    let alive = true; let off = () => {};
    void startHub(backend, backend.host?.id).then(stop => { if (alive) off = stop; else stop(); });
    return () => { alive = false; off(); };
  }, [backend]);
  return children(backend.host?.id === "local" || !backend.host ? agents : state.agents);
}
