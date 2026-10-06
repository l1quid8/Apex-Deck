import { useSyncExternalStore } from "react";
import type { Backend } from "./backend";
import { hostConnectionStore } from "./hostConnections";
const demo = hostConnectionStore("local", "This Mac");
demo.setStatus({ kind: "connected", hostId: "demo" });
export function useHostConnection(backend: Backend) {
  const store = backend.host?.connection ?? demo;
  return useSyncExternalStore(store.subscribe, store.get);
}
