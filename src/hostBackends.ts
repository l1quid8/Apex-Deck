import type { Backend, HostEntry } from "./backend";
import { hostConnectionStore, type HostConnectionStore } from "./hostConnections.ts";
import type { AgentInfo } from "./types";

export interface HostBackends {
  get(hostId?: string): Backend;
  connection(hostId?: string): HostConnectionStore;
  discover(hostId?: string): Promise<AgentInfo[]>;
  legacySession(hostId: string): Promise<unknown>;
  legacySettings(hostId: string): Promise<unknown>;
  setHosts(hosts: HostEntry[]): void;
  dispose(hostId: string): void;
}
interface HostRuntime { backend: Backend; connection: HostConnectionStore; start(): Promise<unknown>; close(): void }
const appMethods = new Set([
  "sessionLoad", "sessionSave", "settingsLoad", "settingsSave", "decisionKeySave",
  "flagAttention", "requestCriticalAttention", "onQuitRequested", "quitHeard", "quitApp",
  "exportThread", "exportPdf", "artifactSave", "artifactOpenExternal", "onMenu", "startupFolders",
]);
const writes = new Set([
  "roomPost", "roomPostTo", "roomTurn", "roomDecide", "roomSetOptions", "roomForgetAllowed", "roomAddParticipant",
  "roomUpdateParticipant", "roomRemoveParticipant", "roomClear", "roomRewind", "roomRevert", "roomPin", "roomUnpin",
  "roomFork", "roomCompact", "roomDelete", "ptySpawn", "ptyWrite", "ptyResize", "saveAttachment", "copyAttachment",
  "generateImage", "importReplyImage", "artifactsSave",
]);
const rawWrites = new Set([...writes].map(key => key.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase())));
/** Reject unavailable execution; recovery reads and harmless PTY probes remain available. */
export function guardHostWrites(backend: Backend, connection: HostConnectionStore): Backend {
  return new Proxy(backend, { get(target, key: string) {
    const value = target[key as keyof Backend];
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      const status = connection.get().status.kind;
      const resize = key === "ptyResize" || (key === "call" && args[0] === "pty_resize");
      if ((writes.has(key) || (key === "call" && rawWrites.has(String(args[0])))) && status !== "connected" && !(resize && status === "resync"))
        return Promise.reject(new Error("Not connected to the host; nothing was queued."));
      return (value as (...values: unknown[]) => unknown).apply(target, args);
    };
  } });
}
export function createHostBackends({ local, hosts, make }: { local: Backend; hosts: HostEntry[]; make(host: HostEntry, connection: ReturnType<typeof hostConnectionStore>): HostRuntime }): HostBackends {
  let known = new Map(hosts.filter(h => h.id !== "local").map(h => [h.id, h]));
  const runtimes = new Map<string, HostRuntime>(); const backends = new Map<string, Backend>();
  const idle = new Map<string, ReturnType<typeof hostConnectionStore>>();
  const localStore = local.host?.connection ?? hostConnectionStore("local", "This Mac");
  if (!local.host) (localStore as ReturnType<typeof hostConnectionStore>).setStatus({ kind: "connected", hostId: "local" });
  function runtime(hostId: string) {
    const host = known.get(hostId); if (!host) throw new Error("This host is unavailable or was removed.");
    let r = runtimes.get(hostId);
    if (!r) {
      if (!idle.has(hostId)) idle.set(hostId, hostConnectionStore(hostId, host.name));
      r = make(host, idle.get(hostId)!); runtimes.set(hostId, r);
      // Startup is independent; commands reject while offline rather than waiting in a queue.
      void r.start().catch(() => {});
    }
    return r;
  }
  async function connected(hostId: string) {
    const r = runtime(hostId);
    if (r.connection.get().status.kind === "connected") return r;
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error("The host is unavailable; migration will retry at next launch.")); }, 20000);
      const check = () => {
        const status = r.connection.get().status;
        if (status.kind === "connected") { clearTimeout(timer); off(); resolve(); }
        else if (status.kind === "failed" || status.kind === "reconnecting") { clearTimeout(timer); off(); reject(new Error("The host is unavailable; migration will retry at next launch.")); }
      };
      off = r.connection.subscribe(check); check();
    });
    return r;
  }
  return {
    get(hostId = "local") {
      if (hostId === "local") return local;
      const r = runtime(hostId); let b = backends.get(hostId);
      if (!b) {
        const host = known.get(hostId)!;
        b = new Proxy(r.backend, {
          get(target, key: string) {
            if (key === "host") return { id: hostId, name: (known.get(hostId) ?? host).name, connection: r.connection };
            if (key === "browser") return local.browser;
            if (key === "quitStopsWork") return false;
            const source = appMethods.has(key) ? local : guardHostWrites(target, r.connection);
            const value = source[key as keyof Backend];
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (!known.has(hostId)) return Promise.reject(new Error("This host was removed."));
              if (key === "call" && ["session_save", "settings_save", "decision_key_save"].includes(String(args[0]))) return Promise.reject(new Error("App preferences are owned by This Mac."));
              return (value as (...args: unknown[]) => unknown).apply(source, args);
            };
          },
        });
        backends.set(hostId, b);
      }
      return b;
    },
    connection(hostId = "local") {
      if (hostId === "local") return localStore;
      if (!known.has(hostId)) throw new Error("There is no such host.");
      if (runtimes.has(hostId)) return runtimes.get(hostId)!.connection;
      if (!idle.has(hostId)) idle.set(hostId, hostConnectionStore(hostId, known.get(hostId)!.name));
      return idle.get(hostId)!;
    },
    async discover(hostId = "local") {
      const b = hostId === "local" ? local : runtime(hostId).backend;
      const c = (hostId === "local" ? localStore : runtimes.get(hostId)!.connection) as ReturnType<typeof hostConnectionStore>;
      c.setDiscovery?.("loading");
      try { const agents = await b.detectAgents(); c.setDiscovery?.("ready", agents); return agents; }
      catch (e) { c.setDiscovery?.("failed", []); throw e; }
    },
    async legacySession(hostId) { return (await connected(hostId)).backend.sessionLoad(); },
    async legacySettings(hostId) { return (await connected(hostId)).backend.settingsLoad(); },
    setHosts(list) {
      known = new Map(list.filter(h => h.id !== "local").map(h => [h.id, h]));
      // A renamed server keeps its connection; only the name it shows changes.
      for (const [id, h] of known) {
        (runtimes.get(id)?.connection as { rename?(name: string): void } | undefined)?.rename?.(h.name);
        idle.get(id)?.rename(h.name);
      }
    },
    dispose(hostId) { known.delete(hostId); runtimes.get(hostId)?.close(); runtimes.delete(hostId); backends.delete(hostId); idle.delete(hostId); },
  };
}
