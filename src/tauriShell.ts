// The Tauri desktop app: commands go to its Rust side with `invoke`, and
// its shell jobs use Tauri's window and dialog APIs. Kept working until the
// Electron app replaces it.

import type { Shell, Transport } from "./commandBackend";

export async function tauriTransport(): Promise<Transport> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    call: (cmd, args) => invoke(cmd, args),
    listen: (event, cb) => listen(event, (e) => cb(e.payload as never)),
    saveAttachment: (room, name, bytes) => invoke("save_attachment", bytes, { headers: { "x-room": room, "x-name": name } }),
    readAttachment: (path) => invoke<ArrayBuffer>("read_attachment", { path }),
  };
}

export function tauriShell(transport: Transport): Shell {
  const call = transport.call.bind(transport);
  return {
    quitStopsWork: true,
    startupFolders: () => call<string[]>("startup_folders"),
    artifactSave: async (name, contents) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: name });
      return path ? call<string>("artifact_export", { name, contents, path }) : null;
    },
    artifactOpenExternal: async (name, contents) => {
      const path = await call<string>("artifact_export", { name, contents, path: null });
      await call("open_target", { target: path, cwd: null, reveal: false });
    },
    pickFolder: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "Add a workspace folder" });
      return typeof picked === "string" ? picked : null;
    },
    pickPath: async (kind, title) => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: kind === "directory", multiple: false, title });
      return typeof picked === "string" ? picked : null;
    },
    openTarget: (target, cwd, reveal) => call("open_target", { target, cwd, reveal }),
    flagAttention: async (count, nudge) => {
      const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
      const main = getCurrentWindow();
      // Neither is available on every system; the app works without them.
      await main.setBadgeCount(count > 0 ? count : undefined).catch(() => {});
      if (nudge) await main.requestUserAttention(UserAttentionType.Informational).catch(() => {});
    },
    requestCriticalAttention: async () => {
      const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
      // Not available on every system; the app works without it.
      await getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
    },
    exportThread: (fileName, contents) => call("export_thread", { fileName, contents }),
    copyAttachment: (room, path) => call("copy_attachment", { room, path }),
    onFileDrop: async (cb) => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") cb(e.payload.paths, e.payload.position.x / devicePixelRatio, e.payload.position.y / devicePixelRatio);
      });
    },
    onQuitRequested: (cb) => transport.listen<number>("quit-requested", cb),
    quitHeard: (request) => call("quit_heard", { request }),
    quitApp: () => call("quit_app"),
  };
}
