// Commands and events over apex-daemon's protocol. No Electron and no DOM:
// the desktop bridge and the phone's WebSocket both use this.

import type { Transport } from "../commandBackend.ts";
import type { DaemonClient } from "./client.ts";

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
export function daemonTransport(client: Pick<DaemonClient, "call" | "on"> & Partial<Pick<DaemonClient, "requireCapability">>): Transport {
  return {
    call: (cmd, args) => {
      if (cmd.startsWith("assistant_")) client.requireCapability?.("assistant_delegation", "ApexAgent delegation");
      if (cmd.startsWith("assistant_") && args?.mode === "isolated") client.requireCapability?.("assistant_isolation", "ApexAgent isolated worktrees");
      if (cmd === "monitor_profile_update") client.requireCapability?.("monitor_profile_update", "Changing the ApexAgent profile");
      return client.call(cmd, args);
    },
    listen: async (event, cb) => client.on(event, cb),
    saveAttachment: (room, name, bytes) => client.call<string>("save_attachment", { room, name, data: toBase64(bytes) }),
    readAttachment: async (path) => {
      const bytes = fromBase64(await client.call<string>("read_attachment", { path }));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}
