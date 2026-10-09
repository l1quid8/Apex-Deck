import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Backend } from "./backend";
import type { AgentInfo } from "./types";
import type { ProjectMonitor } from "./apexAgentModel";
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

/** Discovery-only context for menus; it does not register room/PTY hubs. */
export function HostAgents({ backend, agents, children }: { backend: Backend; agents: AgentInfo[]; children(found: AgentInfo[]): ReactNode }) {
  const store = backend.host?.connection ?? demo;
  const state = useSyncExternalStore(store.subscribe, store.get);
  return children(backend.host?.id === "local" || !backend.host ? agents : state.agents);
}

/** App-wide monitor discovery, scoped to one host and independent of pane/menu mounts. */
export function HostMonitors({ backend, hostId, onMonitors, getVersion }: {
  backend: Backend;
  hostId: string;
  onMonitors(hostId: string, monitors: ProjectMonitor[]): void;
  /** App-owned epoch for this host; a changed epoch invalidates an in-flight snapshot. */
  getVersion?: (hostId: string) => number;
}) {
  const store = backend.host?.connection ?? demo;
  const state = useSyncExternalStore(store.subscribe, store.get);
  const onMonitorsRef = useRef(onMonitors);
  const getVersionRef = useRef(getVersion);
  onMonitorsRef.current = onMonitors;
  getVersionRef.current = getVersion;

  useEffect(() => {
    // A missing or mismatched remote backend must never be treated as This Mac.
    if (hostId !== "local" && (backend.host?.id !== hostId || state.status.kind !== "connected")) return;
    if (hostId === "local" && backend.host && (backend.host.id !== "local" || state.status.kind !== "connected")) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const revision = state.revision;
    const connectionStatus = state.status;
    const current = () => {
      const latest = store.get();
      if (!alive || latest.revision !== revision || latest.status !== connectionStatus) return false;
      if (hostId === "local") return !backend.host || (backend.host.id === "local" && latest.status.kind === "connected");
      return backend.host?.id === hostId && latest.status.kind === "connected";
    };
    const poll = async () => {
      if (!current() || pending) return;
      pending = true;
      const version = getVersionRef.current?.(hostId) ?? 0;
      try {
        const monitors = await backend.call<ProjectMonitor[]>("monitor_list");
        if (Array.isArray(monitors) && current() && (getVersionRef.current?.(hostId) ?? 0) === version) {
          onMonitorsRef.current(hostId, monitors);
        }
      } catch {
        // Preserve the last successful snapshot while the host is offline or unreadable.
      } finally {
        pending = false;
        if (current()) timer = setTimeout(() => { void poll(); }, 15_000);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [backend, hostId, state.status, state.revision, store]);

  return null;
}
