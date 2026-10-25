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
export function daemonTransport(client: Pick<DaemonClient, "call" | "on"> & Partial<Pick<DaemonClient, "requireCapability" | "hasCapability">>): Transport {
  return {
    supports: capability => client.hasCapability?.(capability) === true,
    call: (cmd, args) => {
      if (cmd.startsWith("personal_avatar_") && client.hasCapability?.("assistant_avatar_generation_v1") !== true)
        throw new Error("This host does not support assistant avatar generation. Update the service, then reconnect.");
      if (cmd === "personal_project_delegate" && client.hasCapability?.("assistant_workspace_v4") !== true)
        throw new Error("This host does not support named assistant delegation. Update the owning host.");
      if (cmd === "personal_workspace_configure" && client.hasCapability?.("assistant_workspace_v4") !== true)
        throw new Error("This host’s Apex Deck service does not advertise assistant workspace settings support. Update the service on the assistant machine, then reconnect.");
      if (cmd === "personal_workspace_configure" && args?.folderGrant != null && client.hasCapability?.("assistant_project_folder_grant_v1") !== true)
        throw new Error("Update the assistant machine’s service, then reconnect to allow this project folder.");
      if (cmd.startsWith("assistant_")) client.requireCapability?.("assistant_delegation", "ApexAgent delegation");
      if (cmd.startsWith("assistant_") && args?.mode === "isolated") client.requireCapability?.("assistant_isolation", "ApexAgent isolated worktrees");
      const needsWorkspaceV3 = args?.mode === "read_only" || args?.spendLimitMicros != null
        || (Array.isArray(args?.workerProfiles) && args.workerProfiles.length > 0)
        || args?.action === "note" || args?.action === "set_budget" || args?.action === "resume_budget";
      if (cmd.startsWith("assistant_") && needsWorkspaceV3) client.requireCapability?.("assistant_workspace_v3", "ApexAgent read-only tasks, routing and spend controls");
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
