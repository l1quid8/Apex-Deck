// The Backend as commands to a host plus a shell. The host (Tauri's Rust, or
// apex-daemon) runs the commands; the shell does what belongs to the machine
// with the screen: dialogs, saved files, the dock, file drops and quitting.

import type { Backend } from "./backend";
import type { AgentInfo, AppSession, ModelChoice, PreviewProbe, RevertPlan, RoomEvent, RoomSnapshot, ThreadDiff, ToolServer } from "./types";

/** How commands reach the host and its events come back. */
export interface Transport {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  /** Raw bytes over Tauri, base64 over the daemon. */
  saveAttachment(room: string, name: string, bytes: Uint8Array): Promise<string>;
  readAttachment(path: string): Promise<ArrayBuffer>;
}

export type Shell = Pick<Backend, "pickFolder" | "pickPath" | "startupFolders" | "artifactSave"
  | "artifactOpenExternal" | "exportThread" | "openTarget" | "copyAttachment" | "flagAttention"
  | "requestCriticalAttention" | "onFileDrop" | "onQuitRequested" | "quitHeard" | "quitApp"
  | "quitStopsWork">;

export function commandBackend(transport: Transport, shell: Shell): Backend {
  const call = transport.call.bind(transport);
  return {
    demo: false,
    ...shell,
    call,
    listToolServers: (room, agent) => call<ToolServer[]>("list_tool_servers", { room, agent }),
    detectAgents: () => call<AgentInfo[]>("agents_detect"),
    sessionLoad: () => call<AppSession | null>("session_load"),
    sessionSave: (session) => call("session_save", { session }),
    settingsLoad: () => call<unknown>("settings_load"),
    settingsSave: (settings) => call("settings_save", { settings }),
    artifactsLoad: (room) => call<unknown>("artifacts_load", { room }),
    artifactsSave: (room, artifacts) => call("artifacts_save", { room, artifacts }),
    dataFolder: () => call<string>("data_folder"),
    envPresent: (names) => call<boolean[]>("env_present", { names }),
    previewProbe: (address) => call<PreviewProbe>("preview_probe", { address }),

    ptySpawn: (o) => call("pty_spawn", { id: o.id, agent: o.agent ?? null, cwd: o.cwd ?? null, cols: o.cols, rows: o.rows }),
    ptyWrite: (id, data) => call("pty_write", { id, data }),
    ptyResize: (id, cols, rows) => call("pty_resize", { id, cols, rows }),
    ptyKill: (id) => call("pty_kill", { id }),
    onPtyData: (cb) => transport.listen<{ id: string; data: string }>("pty-data", (p) => cb(p.id, p.data)),
    onPtyExit: (cb) => transport.listen<{ id: string; code: number | null }>("pty-exit", (p) => cb(p.id, p.code)),

    roomCreate: (id, participants, options, cwd) => call<RoomSnapshot>("room_create", { id, participants, options, cwd: cwd || null }),
    apiModels: (baseUrl, apiKeyEnv) => call<string[]>("api_models", { baseUrl, apiKeyEnv }),
    agentModels: (tool) => call<ModelChoice[]>("agent_models", { tool }),
    workspaceRead: (target, cwd) => call<string | null>("workspace_read", { target, cwd }),
    pathsExist: (targets, cwd) => call<boolean[]>("paths_exist", { targets, cwd }),
    roomPost: (id, text) => call("room_post", { id, text }),
    roomTargets: (id, text) => call<string[]>("room_targets", { id, text }),
    roomPostTo: (id, text, targets) => call("room_post_to", { id, text, targets }),
    roomTurn: (id, participants, hops) => call("room_turn", { id, participants, hops }),
    roomStop: (id, participant) => call("room_stop", { id, participant: participant ?? null }),
    roomDecide: (id, request, approve, always = false) => call("room_decide", { id, request, approve, always }),
    roomSetOptions: (id, options) => call("room_set_options", { id, options }),
    roomForgetAllowed: (id, rule) => call("room_forget_allowed", { id, rule }),
    roomAddParticipant: (id, participant) => call("room_add_participant", { id, participant }),
    roomUpdateParticipant: (id, participant) => call("room_update_participant", { id, participant }),
    roomRemoveParticipant: (id, participant) => call("room_remove_participant", { id, participant }),
    roomClear: (id) => call("room_clear", { id }),
    roomRewind: (id, upto) => call("room_rewind", { id, upto }),
    roomRevertPlan: (id, at, bot) => call<RevertPlan>("room_revert_plan", { id, at, bot }),
    roomRevert: (id, at, bot, chat, files) => call<string[]>("room_revert", { id, at, bot, chat, files }),
    roomDiff: (id) => call<ThreadDiff>("room_diff", { id }),
    saveAttachment: (room, name, bytes) => transport.saveAttachment(room, name, bytes),
    generateImage: (room, provider, prompt) => call<string>("generate_image", { room, provider, prompt }),
    importReplyImage: (room, path) => call<string>("import_reply_image", { room, path }),
    readAttachment: (path) => transport.readAttachment(path),
    roomPin: (id, fact) => call<string[]>("room_pin", { id, fact }),
    roomUnpin: (id, index) => call<string[]>("room_unpin", { id, index }),
    roomFork: (source, target, upto) => call("room_fork", { source, target, upto }),
    roomCompact: (id) => call("room_compact", { id }),
    roomClose: (id) => call("room_close", { id }),
    roomDelete: (id) => call("room_delete", { id }),
    onRoomEvent: (cb) => transport.listen<{ room: string; event: RoomEvent }>("room-event", (p) => cb(p.room, p.event)),
  };
}
