import { useSyncExternalStore } from "react";
import type { Backend } from "./backend";
import { hostConnectionStore } from "./hostConnections";
import { LOCAL_HOST_NAME } from "./hostFacts.ts";
const demo = hostConnectionStore("local", LOCAL_HOST_NAME);
demo.setStatus({ kind: "connected", hostId: "demo" });
export function useHostConnection(backend: Backend) {
  const store = backend.host?.connection ?? demo;
  return useSyncExternalStore(store.subscribe, store.get);
}
