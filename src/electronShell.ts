// The Electron app: the window talks to apex-daemon through the preload
// bridge (desktop/preload.cjs), which relays protocol lines to and from
// Electron's main process. Commands go over that link with DaemonClient; the
// shell's own jobs go to main through the bridge.

import type { Backend } from "./backend";
import { commandBackend, type Shell, type Transport } from "./commandBackend.ts";
import { connection } from "./connection.ts";
import { DaemonClient, type Connect, type Link } from "./daemon/client.ts";

/** What desktop/preload.cjs puts on `window.apexDeck`. */
export interface DeckBridge {
  daemon: {
    connect(): Promise<number>;
    send(gen: number, line: string): void;
    close(gen: number): void;
    onLine(cb: (gen: number, line: string) => void): void;
    onClose(cb: (gen: number, reason: string) => void): void;
  };
  connection: {
    current(): Promise<{ id: string; name: string; remote: boolean; owned: boolean }>;
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
export function bridgeConnect(bridge: Pick<DeckBridge, "daemon">): Connect {
  let current: { gen: number; line?: (line: string) => void; close?: (reason: string) => void; closed?: string } | null = null;
  // A close can come before the link is handed over; it's kept for then.
  let early: { gen: number; reason: string } | null = null;
  bridge.daemon.onLine((gen, line) => {
    if (current?.gen === gen) current.line?.(line);
  });
  bridge.daemon.onClose((gen, reason) => {
    if (current?.gen === gen) {
      if (current.close) current.close(reason);
      else current.closed = reason;
    } else if (!current || gen > current.gen) {
      early = { gen, reason };
    }
  });
  return async () => {
    const gen = await bridge.daemon.connect();
    const me: NonNullable<typeof current> = { gen };
    current = me;
    if (early?.gen === gen) me.closed = early.reason;
    early = null;
    const link: Link = {
      send: (line) => bridge.daemon.send(gen, line),
      close: () => bridge.daemon.close(gen),
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

function electronShell(transport: Transport, owned: boolean): Shell {
  const call = transport.call.bind(transport);
  return {
    quitStopsWork: owned,
    startupFolders: async () => [],
    pickFolder: async () => null,
    pickPath: async () => null,
    artifactSave: async () => null,
    artifactOpenExternal: async (name, contents) => {
      const path = await call<string>("artifact_export", { name, contents, path: null });
      await call("open_target", { target: path, cwd: null, reveal: false });
    },
    exportThread: (fileName, contents) => call("export_thread", { fileName, contents }),
    openTarget: (target, cwd, reveal) => call("open_target", { target, cwd, reveal }),
    copyAttachment: (room, path) => call("copy_attachment", { room, path }),
    flagAttention: async () => {},
    requestCriticalAttention: async () => {},
    onFileDrop: async () => () => {},
    onQuitRequested: async () => () => {},
    quitHeard: async () => {},
    quitApp: async () => { window.close(); },
  };
}

/** Connect to the host and build the Backend on it. Resolves once connected. */
export async function electronBackend(bridge: DeckBridge): Promise<Backend> {
  const client = new DaemonClient(bridgeConnect(bridge));
  client.onStatus((status) => {
    connection.setStatus(status);
    // The events missed while away are gone; start over from the host's state.
    if (status.kind === "resync") location.reload();
  });
  await client.start();
  const current = await bridge.connection.current();
  connection.setHost(current.name);
  const transport = daemonTransport(client);
  const backend = commandBackend(transport, electronShell(transport, current.owned));
  if (bridge.smoke) window.__deck = { backend };
  return backend;
}
