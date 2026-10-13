import type { AnswerSaveResult } from "./interactiveAnswers/contract.ts";
// The Backend as commands to a host plus a shell. The host (apex-daemon)
// runs the commands; the shell does what belongs to the machine
// with the screen: dialogs, saved files, the dock, file drops and quitting.

import type { Backend, KeyState, LibraryItem } from "./backend";
import { apiModelList } from "./models.ts";
import type { AgentInfo, AppSession, FilePreview, FileSearchResult, FolderListing, ModelChoice, PersonaDraftResult, PreviewProbe, RevertPlan, RoomEvent, RoomSnapshot, ThreadDiff, ToolServer, WorktreeList, Worktree } from "./types";

/** How commands reach the host and its events come back. */
export interface Transport {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
  saveAttachment(room: string, name: string, bytes: Uint8Array): Promise<string>;
  readAttachment(path: string): Promise<ArrayBuffer>;
}

export type Shell = Pick<Backend, "pickFolder" | "pickPath" | "startupFolders" | "artifactSave"
  | "artifactOpenExternal" | "exportThread" | "exportPdf" | "openTarget" | "copyAttachment" | "flagAttention"
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
    onAssistantTasksChanged: (cb) => transport.listen("assistant-tasks-changed", cb),
    onSessionChanged: (cb) => transport.listen<AppSession>("session-changed", cb),
    decisionKeyStatus: () => call<boolean>("decision_key_status", {}),
    settingsLoad: () => call<unknown>("settings_load"),
    decisionKeySave: (provider, key) => call("decision_key_save", { provider, key }),
    settingsSave: (settings) => call("settings_save", { settings }),
    artifactsLoad: (room) => call<unknown>("artifacts_load", { room }),
    artifactsSave: (room, artifacts) => call("artifacts_save", { room, artifacts }),
    answersLoad: (room) => call<unknown>("answers_load", { room }),
    answerSave: (room, key, fingerprint, inputs, revision) => call<AnswerSaveResult>("answer_save", { room, key, fingerprint, inputs, revision }),
    dataFolder: () => call<string>("data_folder"),
    envPresent: (names) => call<boolean[]>("env_present", { names }),
    apiKeyStatus: (names) => call<KeyState[]>("api_key_status", { names }),
    apiKeySave: (name, key) => call("api_key_save", { name, key }),
    apiKeyRemove: (name) => call("api_key_remove", { name }),
    previewProbe: (address) => call<PreviewProbe>("preview_probe", { address }),

    ptySpawn: (o) => call("pty_spawn", { id: o.id, agent: o.agent ?? null, cwd: o.cwd ?? null, name: o.name ?? null, cols: o.cols, rows: o.rows }),
    ptyList: (query) => call("pty_list", { query: query ?? null }),
    ptyRename: (id, name) => call("pty_rename", { id, name }),
    ptyAttach: (id) => call("pty_attach", { id }),
    ptyWrite: (id, data) => call("pty_write", { id, data }),
    ptyResize: (id, cols, rows) => call("pty_resize", { id, cols, rows }),
    ptyKill: (id) => call("pty_kill", { id }),
    onPtyData: (cb) => transport.listen<{ id: string; data: string; cursor: number }>("pty-data", (p) => cb(p.id, p.data, p.cursor)),
    onPtyExit: (cb) => transport.listen<{ id: string; code: number | null }>("pty-exit", (p) => cb(p.id, p.code)),
    onPtyRenamed: (cb) => transport.listen<{ id: string; name: string }>("pty-renamed", (p) => cb(p.id, p.name)),

    roomCreate: (id, participants, options, cwd) => call<RoomSnapshot>("room_create", { id, participants, options, cwd: cwd || null }),
    roomState: (id) => call("room_state", { id }),
    apiModels: async (baseUrl, apiKeyEnv) => apiModelList(await call<unknown>("api_models", { baseUrl, apiKeyEnv })),
    apiBalance: async (baseUrl, apiKeyEnv) => {
      const amount = await call<unknown>("api_balance", { baseUrl, apiKeyEnv });
      return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    },
    apiQuote: async (baseUrl, apiKeyEnv, model, media) => {
      const amount = await call<unknown>("api_quote", { baseUrl, apiKeyEnv, model, media });
      return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    },
    agentModels: (tool) => call<ModelChoice[]>("agent_models", { tool }),
    personaDraft: (writer, idea, taken) => call<PersonaDraftResult>("persona_draft", { writer, idea, taken }),
    workspaceRead: (target, cwd) => call<string | null>("workspace_read", { target, cwd }),
    pathsExist: (targets, cwd) => call<boolean[]>("paths_exist", { targets, cwd }),
    listFolder: (path) => call<FolderListing>("folder_list", { path }),
    fileRead: (root, path) => call<FilePreview>("file_read", { root, path }),
    fileFind: (root, query) => call<string[]>("file_find", { root, query }),
    fileSearch: (root, query, caseSensitive, folder) => call<FileSearchResult>("file_search", { root, query, case_sensitive: caseSensitive, folder }),
    fileCreate: (root, parent, name, folder) => call<string>("file_create", { root, parent, name, folder }),
    fileRename: (root, path, name) => call<string>("file_rename", { root, path, name }),
    fileDuplicate: (root, path) => call<string>("file_duplicate", { root, path }),
    fileTrash: (root, path) => call<void>("file_trash", { root, path }),
    worktreeList: (path) => call<WorktreeList>("worktree_list", { path }),
    worktreeAdd: (path, request) => call<Worktree>("worktree_add", { path, ...request }),
    worktreeRemove: (path, worktree, force) => call("worktree_remove", { path, worktree, force }),
    worktreeForget: (path, worktree, force) => call("worktree_forget", { path, worktree, force }),
    worktreePrune: (path) => call("worktree_prune", { path }),
    roomPost: (id, text, interactiveAnswers) => call("room_post", { id, text, ...(interactiveAnswers === undefined ? {} : { interactive_answers: interactiveAnswers }) }),
    roomTargets: (id, text) => call<string[]>("room_targets", { id, text }),
    roomPostTo: (id, text, targets, routed = false, interactiveAnswers) => call("room_post_to", { id, text, targets, routed, ...(interactiveAnswers === undefined ? {} : { interactive_answers: interactiveAnswers }) }),
    roomTurn: (id, participants, hops, interactiveAnswers) => call("room_turn", { id, participants, hops, ...(interactiveAnswers === undefined ? {} : { interactive_answers: interactiveAnswers }) }),
    roomStop: (id, participant) => call("room_stop", { id, participant: participant ?? null }),
    roomDecide: (id, request, approve, always = false) => call("room_decide", { id, request, approve, always }),
    roomAnswer: (id, request, answers) => call("room_answer", { id, request, answers }),
    roomSetPlan: (id, on) => call("room_set_plan", { id, on }),
    roomSetOptions: (id, options) => call("room_set_options", { id, options }),
    roomForgetAllowed: (id, rule) => call("room_forget_allowed", { id, rule }),
    roomAddParticipant: (id, participant) => call("room_add_participant", { id, participant }),
    roomUpdateParticipant: (id, participant, base) => call("room_update_participant", { id, participant, ...(base ? { base } : {}) }),
    roomRemoveParticipant: (id, participant) => call("room_remove_participant", { id, participant }),
    roomClear: (id) => call("room_clear", { id }),
    roomRewind: (id, upto) => call("room_rewind", { id, upto }),
    roomRevertPlan: (id, at, bot) => call<RevertPlan>("room_revert_plan", { id, at, bot }),
    roomRevert: (id, at, bot, chat, files) => call<string[]>("room_revert", { id, at, bot, chat, files }),
    roomDiff: (id) => call<ThreadDiff>("room_diff", { id }),
    saveAttachment: (room, name, bytes) => transport.saveAttachment(room, name, bytes),
    generateImage: (room, provider, prompt) => call<string>("generate_image", { room, provider, prompt }),
    importReplyImage: (room, path, by) => call<string>("import_reply_image", { room, path, by }),
    libraryList: () => call<LibraryItem[]>("library_list", {}),
    libraryRemove: (file) => call<void>("library_remove", { file }),
    libraryRename: (file, name) => call<void>("library_rename", { file, name }),
    readAttachment: (path) => transport.readAttachment(path),
    roomPin: (id, fact) => call<string[]>("room_pin", { id, fact }),
    roomUnpin: (id, index) => call<string[]>("room_unpin", { id, index }),
    roomFork: (source, target, upto) => call("room_fork", { source, target, upto }),
    roomImport: (id, snapshot, cwd, replace = false) => call("room_import", { id, snapshot, cwd: cwd || null, replace }),
    roomCompact: (id) => call("room_compact", { id }),
    roomClose: (id) => call("room_close", { id }),
    roomDelete: (id) => call("room_delete", { id }),
    onRoomEvent: (cb) => transport.listen<{ room: string; event: RoomEvent; recovery_seq?: number }>("room-event", (p) => cb(p.room, p.recovery_seq == null ? p.event : { ...p.event, recovery_seq: p.recovery_seq })),
  };
}
