// The Electron app: the window talks to apex-daemon through the preload
// bridge (desktop/preload.cjs), which relays protocol lines to and from
// Electron's main process. Commands go over that link with DaemonClient; the
// shell's own jobs go to main through the bridge.

import type { Backend, BrowserApi, HostEntry } from "./backend";
import { commandBackend, type Shell, type Transport } from "./commandBackend.ts";
import { createHostBackends } from "./hostBackends.ts";
import { hostConnectionStore } from "./hostConnections.ts";
import { connection } from "./connection.ts";
import { DaemonClient, type Connect, type Link } from "./daemon/client.ts";
import { pathPrompt, type PathRequest } from "./typedPath.ts";

/** What desktop/preload.cjs puts on `window.apexDeck`. */
export interface DeckBridge {
  daemon: {
    connect(hostId: string): Promise<number>;
    send(hostId: string, gen: number, line: string): void;
    close(hostId: string, gen: number): void;
    onLine(cb: (hostId: string, gen: number, line: string) => void): () => void;
    onClose(cb: (hostId: string, gen: number, reason: string) => void): () => void;
  };
  connection: {
    current(): Promise<HostEntry & { owned: boolean }>;
    list(): Promise<HostEntry[]>;
    add(host: { name: string; ssh: string; command?: string }): Promise<HostEntry[]>;
    remove(id: string): Promise<HostEntry[]>;
    references(hostIds: string[]): Promise<void>;
  };
  shell: {
    pickPath(kind: "directory" | "file", title: string): Promise<string | null>;
    /** Ask where, then write it there. Null when cancelled. */
    saveFile(name: string, contents: string): Promise<string | null>;
    /** Into Downloads under a name not yet taken. */
    exportFile(name: string, contents: string): Promise<string>;
    /** Render HTML to a PDF in Downloads. Null is not used; failure throws. */
    exportPdf(name: string, html: string): Promise<string>;
    /** Write to the exports folder and open in its default app. */
    openArtifact(name: string, contents: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    setBadge(count: number): Promise<void>;
    attention(critical: boolean): Promise<void>;
    startupFolders(): Promise<string[]>;
    /** A file on this Mac, to send to a host on another machine. */
    readLocalFile(hostId: string, path: string): Promise<Uint8Array>;
    onFileDrop(cb: (paths: string[], x: number, y: number) => void): () => void;
    onQuitRequested(cb: (request: number) => void): () => void;
    quitHeard(request: number): Promise<void>;
    quitApp(): Promise<void>;
    onMenu(cb: (action: string) => void): () => void;
  };
  browser: BrowserApi & {
    /** Key presses in a docked page that the deck owns (desktop/browser-keys.mjs). */
    onShortcut(cb: (press: KeyboardEventInit) => void): () => void;
  };
  smoke: boolean;
}

declare global {
  interface Window {
    apexDeck?: DeckBridge;
    /** Set for the smoke test (desktop/smoke.mjs) only. */
    __deck?: { backend: Backend };
  }
}

/** Each connect gets a new generation from main; lines and closes for older ones are ignored. */
export function bridgeConnect(bridge: Pick<DeckBridge, "daemon">, hostId = "local"): Connect & { dispose(): void } {
  let current: { gen: number; line?: (line: string) => void; close?: (reason: string) => void; closed?: string } | null = null;
  // A close can come before the link is handed over; it's kept for then.
  let early: { gen: number; reason: string } | null = null;
  const offLine = bridge.daemon.onLine((incomingHost, gen, line) => {
    if (incomingHost !== hostId) return;
    if (current?.gen === gen) current.line?.(line);
  });
  const offClose = bridge.daemon.onClose((incomingHost, gen, reason) => {
    if (incomingHost !== hostId) return;
    if (current?.gen === gen) {
      if (current.close) current.close(reason);
      else current.closed = reason;
    } else if (!current || gen > current.gen) {
      early = { gen, reason };
    }
  });
  const connect: Connect = async () => {
    const gen = await bridge.daemon.connect(hostId).catch((error: unknown) => { throw new Error(ipcWords(error)); });
    const me: NonNullable<typeof current> = { gen };
    current = me;
    if (early?.gen === gen) me.closed = early.reason;
    early = null;
    const link: Link = {
      send: (line) => bridge.daemon.send(hostId, gen, line),
      close: () => bridge.daemon.close(hostId, gen),
      onLine: (cb) => { me.line = cb; },
      onClose: (cb) => {
        me.close = cb;
        if (me.closed !== undefined) {
          const reason = me.closed;
          queueMicrotask(() => cb(reason));
        }
      },
    };
    return link;
  };
  return Object.assign(connect, { dispose: () => { offLine(); offClose(); current = null; } });
}

/** An error from main, without the "Error invoking remote method …" Electron puts in front. */
export function ipcWords(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** `api` with each function's rejections in plain words (`ipcWords`). */
function plainErrors<T extends object>(api: T): T {
  return Object.fromEntries(Object.entries(api).map(([key, value]) => [key, typeof value !== "function" ? value
    : (...args: unknown[]) => {
      const result = value(...args);
      return result instanceof Promise ? result.catch((error: unknown) => { throw new Error(ipcWords(error)); }) : result;
    }])) as T;
}

/** Commands and events over the daemon's protocol; files as base64. */
export function daemonTransport(client: Pick<DaemonClient, "call" | "on">): Transport {
  return {
    call: (cmd, args) => client.call(cmd, args),
    listen: async (event, cb) => client.on(event, cb),
    saveAttachment: (room, name, bytes) => client.call<string>("save_attachment", { room, name, data: toBase64(bytes) }),
    readAttachment: async (path) => {
      const bytes = fromBase64(await client.call<string>("read_attachment", { path }));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

/**
 * The shell's jobs: what the person saves or opens lands on this machine.
 * On a host on another machine, paths there are picked from its folders (`ask`), its files
 * aren't opened here, and dropped files are sent there.
 */
export function electronShell(
  bridge: Pick<DeckBridge, "shell">,
  transport: Pick<Transport, "call" | "saveAttachment">,
  host: { id?: string; owned: boolean; remote: boolean; name: string },
  ask: (request: PathRequest) => Promise<string | null>,
): Shell & Pick<Backend, "onMenu"> {
  const call = transport.call.bind(transport);
  const shell = plainErrors(bridge.shell);
  if (host.remote) {
    return {
      ...electronShell(bridge, transport, { ...host, remote: false }, ask),
      // The work is on the other machine and goes on after this app quits.
      quitStopsWork: false,
      startupFolders: async () => [],
      pickFolder: () => ask({ hostId: host.id ?? "local", kind: "directory", title: "Add a workspace folder" }),
      pickPath: (kind, title) => ask({ hostId: host.id ?? "local", kind, title }),
      openTarget: async (target) => {
        if (/^https?:\/\//i.test(target)) return shell.openExternal(target);
        throw new Error(`That file is on ${host.name}; Deck can't open it on this Mac.`);
      },
      copyAttachment: async (room, path) => {
        const bytes = await shell.readLocalFile(host.id ?? "local", path);
        return transport.saveAttachment(room, path.split("/").pop() || "file", bytes);
      },
    };
  }
  return {
    quitStopsWork: host.owned,
    startupFolders: () => shell.startupFolders(),
    pickFolder: () => shell.pickPath("directory", "Add a workspace folder"),
    pickPath: (kind, title) => shell.pickPath(kind, title),
    artifactSave: (name, contents) => shell.saveFile(name, contents),
    artifactOpenExternal: (name, contents) => shell.openArtifact(name, contents),
    exportThread: (fileName, contents) => shell.exportFile(fileName, contents),
    exportPdf: (fileName, html) => shell.exportPdf(fileName, html),
    // The host opens files on this Mac, as it always has.
    openTarget: (target, cwd, reveal) => call("open_target", { target, cwd, reveal }),
    copyAttachment: (room, path) => call("copy_attachment", { room, path }),
    flagAttention: async (count, nudge) => {
      await shell.setBadge(count);
      if (nudge) await shell.attention(false);
    },
    requestCriticalAttention: () => shell.attention(true),
    onFileDrop: async (cb) => shell.onFileDrop(cb),
    onQuitRequested: async (cb) => shell.onQuitRequested(cb),
    quitHeard: (request) => shell.quitHeard(request),
    quitApp: () => shell.quitApp(),
    onMenu: async (cb) => shell.onMenu(cb),
  };
}

/** Connect to the host and build the Backend on it. Resolves once connected. */
export async function electronBackend(bridge: DeckBridge): Promise<Backend> {
  const client = new DaemonClient(bridgeConnect(bridge));
  client.onStatus((status) => {
    connection.setStatus(status);

  });
  // Named before connecting, so a host that can't be reached is called by its own name.
  const current = await bridge.connection.current();
  connection.setHost(current.name);
  await client.start();
  connection.setRetry(() => client.retryNow());
  const transport = daemonTransport(client);
  const { onMenu, ...shell } = electronShell(bridge, transport, current, (request) => pathPrompt.ask(request));
  const hosts = {
    current: () => bridge.connection.current(),
    list: () => bridge.connection.list(),
    add: (host: { name: string; ssh: string; command?: string }) => bridge.connection.add(host),
    remove: (id: string) => bridge.connection.remove(id),
    references: (hostIds: string[]) => bridge.connection.references(hostIds),
  };
  // A deck shortcut pressed in a docked page reaches the deck as if pressed here.
  bridge.browser.onShortcut((press) => window.dispatchEvent(new KeyboardEvent("keydown", { ...press, bubbles: true, cancelable: true })));
  const { onShortcut: _keys, ...browser } = bridge.browser;
  const localConnection = hostConnectionStore("local", "This Mac");
  localConnection.setRetry(() => client.retryNow());
  client.onStatus(status => localConnection.setStatus(status));
  localConnection.setFinishResync(() => client.finishResync());
  const backend: Backend = { ...commandBackend(transport, shell), onMenu, hosts, browser,
    host: { id: "local", name: "This Mac", connection: localConnection } };
  const machines = createHostBackends({ local: backend, hosts: await hosts.list(), make: (host, state) => {
    const connect = bridgeConnect(bridge, host.id);
    const remoteClient = new DaemonClient(connect);
    state.setRetry(() => remoteClient.retryNow());
    remoteClient.onStatus(status => {
      state.setStatus(status);
      if (status.kind === "connected") void machines.discover(host.id).catch(() => {});
    });
    state.setFinishResync(() => remoteClient.finishResync());
    const remoteTransport = daemonTransport(remoteClient);
    const remoteShell = electronShell(bridge, remoteTransport, { ...host, owned: false }, request => pathPrompt.ask(request));
    return { backend: commandBackend(remoteTransport, remoteShell), connection: state,
      start: () => remoteClient.start(), close: () => { remoteClient.close(); connect.dispose(); } };
  } });
  backend.machines = machines;
  const oldAdd = hosts.add;
  hosts.add = async host => { const list = await oldAdd(host); machines.setHosts(list); return list; };
  const oldRemove = hosts.remove;
  hosts.remove = async id => { const list = await oldRemove(id); machines.dispose(id); machines.setHosts(list); return list; };
  if (bridge.smoke) window.__deck = { backend };
  return backend;
}
