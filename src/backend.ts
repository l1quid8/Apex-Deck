// Everything the UI needs from the desktop shell goes through this
// interface. Inside the desktop app it calls the Rust commands. In a plain
// browser (npm run dev without Tauri) it falls back to a small stand-in so
// the UI can be worked on without building the app.

import type { AgentInfo, AgentTool, AppSession, FileChange, ModelChoice, ParticipantConfig, ProposedAction, RoomEvent, RoomOptions, RoomSnapshot } from "./types";

type Unlisten = () => void;

export interface Backend {
  /** True when running in a browser with no desktop shell behind it. */
  demo: boolean;
  detectAgents(): Promise<AgentInfo[]>;
  pickFolder(): Promise<string | null>;
  /** Folders passed on the command line when the app was started. */
  startupFolders(): Promise<string[]>;
  sessionLoad(): Promise<AppSession | null>;
  sessionSave(session: AppSession): Promise<void>;

  ptySpawn(o: { id: string; agent?: string; cwd?: string; cols: number; rows: number }): Promise<void>;
  ptyWrite(id: string, data: string): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  ptyKill(id: string): Promise<void>;
  onPtyData(cb: (id: string, data: string) => void): Promise<Unlisten>;
  onPtyExit(cb: (id: string, code: number | null) => void): Promise<Unlisten>;

  /** `cwd` is the workspace folder; command-line participants run there. */
  roomCreate(id: string, participants: ParticipantConfig[], options: RoomOptions, cwd: string): Promise<RoomSnapshot>;
  /** Model names offered by an OpenAI-compatible server. */
  apiModels(baseUrl: string, apiKeyEnv: string | null): Promise<string[]>;
  /** Models a coding agent lists for the account it is signed in to. Empty if it keeps no list. */
  agentModels(tool: AgentTool): Promise<ModelChoice[]>;
  /** Open a file, folder or web address in its default app. Relative paths are
   *  taken from `cwd`. With `reveal`, show the file in its folder instead. */
  openTarget(target: string, cwd: string | null, reveal: boolean): Promise<void>;
  roomPost(id: string, text: string): Promise<void>;
  roomStop(id: string): Promise<void>;
  /** Answer an action a bot proposed, named by the `request` from its event. */
  roomDecide(id: string, request: string, approve: boolean): Promise<void>;
  roomSetOptions(id: string, options: RoomOptions): Promise<void>;
  roomAddParticipant(id: string, participant: ParticipantConfig): Promise<void>;
  /** Replace the settings of a participant that is already in the chat. */
  roomUpdateParticipant(id: string, participant: ParticipantConfig): Promise<void>;
  roomRemoveParticipant(id: string, participant: string): Promise<void>;
  /** Empty the transcript, which is all the models see, and keep the participants. */
  roomClear(id: string): Promise<void>;
  roomClose(id: string): Promise<void>;
  roomDelete(id: string): Promise<void>;
  onRoomEvent(cb: (room: string, event: RoomEvent) => void): Promise<Unlisten>;
  /** Show on the app's icon how many panes want attention. With `nudge`,
   *  also draw the eye to the icon once, for when the app is in the background. */
  flagAttention(count: number, nudge: boolean): Promise<void>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { open } = await import("@tauri-apps/plugin-dialog");

  return {
    demo: false,
    detectAgents: () => invoke<AgentInfo[]>("agents_detect"),
    startupFolders: () => invoke<string[]>("startup_folders"),
    sessionLoad: () => invoke<AppSession | null>("session_load"),
    sessionSave: (session) => invoke("session_save", { session }),
    pickFolder: async () => {
      const picked = await open({ directory: true, multiple: false, title: "Add a workspace folder" });
      return typeof picked === "string" ? picked : null;
    },

    ptySpawn: (o) => invoke("pty_spawn", { id: o.id, agent: o.agent ?? null, cwd: o.cwd ?? null, cols: o.cols, rows: o.rows }),
    ptyWrite: (id, data) => invoke("pty_write", { id, data }),
    ptyResize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
    ptyKill: (id) => invoke("pty_kill", { id }),
    onPtyData: (cb) => listen<{ id: string; data: string }>("pty-data", (e) => cb(e.payload.id, e.payload.data)),
    onPtyExit: (cb) => listen<{ id: string; code: number | null }>("pty-exit", (e) => cb(e.payload.id, e.payload.code)),

    roomCreate: (id, participants, options, cwd) => invoke("room_create", { id, participants, options, cwd: cwd || null }),
    apiModels: (baseUrl, apiKeyEnv) => invoke<string[]>("api_models", { baseUrl, apiKeyEnv }),
    agentModels: (tool) => invoke<ModelChoice[]>("agent_models", { tool }),
    openTarget: (target, cwd, reveal) => invoke("open_target", { target, cwd, reveal }),
    flagAttention: async (count, nudge) => {
      const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
      const main = getCurrentWindow();
      // Neither is available on every system; the app works without them.
      await main.setBadgeCount(count > 0 ? count : undefined).catch(() => {});
      if (nudge) await main.requestUserAttention(UserAttentionType.Informational).catch(() => {});
    },
    roomPost: (id, text) => invoke("room_post", { id, text }),
    roomStop: (id) => invoke("room_stop", { id }),
    roomDecide: (id, request, approve) => invoke("room_decide", { id, request, approve }),
    roomSetOptions: (id, options) => invoke("room_set_options", { id, options }),
    roomAddParticipant: (id, participant) => invoke("room_add_participant", { id, participant }),
    roomUpdateParticipant: (id, participant) => invoke("room_update_participant", { id, participant }),
    roomRemoveParticipant: (id, participant) => invoke("room_remove_participant", { id, participant }),
    roomClear: (id) => invoke("room_clear", { id }),
    roomClose: (id) => invoke("room_close", { id }),
    roomDelete: (id) => invoke("room_delete", { id }),
    onRoomEvent: (cb) => listen<{ room: string; event: RoomEvent }>("room-event", (e) => cb(e.payload.room, e.payload.event)),
  };
}

/** A stand-in for the desktop shell. Terminals echo what you type and chat
 *  participants answer with a canned line. Nothing here talks to a model. */
function demoBackend(): Backend {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const roomListeners = new Set<(room: string, event: RoomEvent) => void>();
  const rooms = new Map<string, { participants: ParticipantConfig[]; options: RoomOptions; transcript: RoomSnapshot["transcript"]; seq: number; stopped: boolean; last: string[] }>();
  const emitData = (id: string, data: string) => dataListeners.forEach((cb) => cb(id, data));
  const saveRoom = (id: string) => {
    const room = rooms.get(id);
    if (room) localStorage.setItem(`apex-deck.demo.room.${id}`, JSON.stringify(room));
  };
  const emitRoom = (id: string, event: RoomEvent) => {
    if (event.type === "message_added") {
      rooms.get(id)?.transcript.push(event.message);
      saveRoom(id);
    }
    roomListeners.forEach((cb) => cb(id, event));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const typedSoFar = new Map<string, string>();
  /** Proposals waiting for a yes or no, by request id. */
  const asks = new Map<string, (approve: boolean) => void>();
  let askCount = 0;

  return {
    demo: true,
    detectAgents: async () => [
      { key: "claude", label: "Claude Code", program: "claude", found: true },
      { key: "codex", label: "Codex", program: "codex", found: true },
      { key: "gemini", label: "Gemini CLI", program: "gemini", found: false },
    ],
    pickFolder: async () => null,
    startupFolders: async () => [],
    sessionLoad: async () => JSON.parse(localStorage.getItem("apex-deck.demo.session.v1") ?? "null"),
    sessionSave: async (session) => { localStorage.setItem("apex-deck.demo.session.v1", JSON.stringify(session)); },

    ptySpawn: async ({ id, agent }) => {
      const what = agent ? `${agent} (browser demo)` : "shell (browser demo)";
      setTimeout(() => emitData(id, `\x1b[2m${what}: keys are echoed, nothing runs.\x1b[0m\r\n$ `), 30);
    },
    ptyWrite: async (id, data) => {
      emitData(id, data.replace(/\r/g, "\r\n$ ").replace(/\x7f/g, "\b \b"));
      // Preview only: typing "ask" then Enter shows an approval prompt, and
      // "work" prints for a few seconds, so the attention states can be seen.
      typedSoFar.set(id, ((typedSoFar.get(id) ?? "") + data).slice(-12));
      const line = typedSoFar.get(id) ?? "";
      if (line.endsWith("ask\r")) setTimeout(() => emitData(id, "\r\n Do you want to create hello.txt?\r\n \u276f 1. Yes\r\n   2. No\r\n"), 300);
      if (line.endsWith("work\r")) {
        for (let i = 1; i <= 40; i++) setTimeout(() => emitData(id, `\r\ncompiling module ${i} of 40 ...`), 2000 + i * 100);
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 6200);
      }
    },
    ptyResize: async () => {},
    ptyKill: async () => {},
    onPtyData: async (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onPtyExit: async () => () => {},

    roomCreate: async (id, participants, options) => {
      const saved = JSON.parse(localStorage.getItem(`apex-deck.demo.room.${id}`) ?? "null");
      const room = saved ?? { participants: [...participants], options, transcript: [], seq: 0, stopped: false, last: [] };
      room.stopped = false;
      rooms.set(id, room);
      saveRoom(id);
      return { participants: [...room.participants], options: { ...room.options }, transcript: [...room.transcript] };
    },
    apiModels: async (baseUrl) => {
      if (baseUrl.includes("11434")) return ["llama3", "qwen2.5-coder"];
      throw new Error(`could not reach ${baseUrl}/models (browser demo)`);
    },
    agentModels: async () => [],
    flagAttention: async (count) => {
      document.title = count > 0 ? `(${count}) Apex Deck` : "Apex Deck";
    },
    openTarget: async (target) => {
      if (/^https?:/.test(target)) window.open(target, "_blank", "noopener");
      else throw new Error("files cannot be opened in the browser demo");
    },
    roomPost: async (id, text) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      room.stopped = false;
      emitRoom(id, { type: "message_added", message: { seq: room.seq++, speaker: { kind: "human" }, text } });

      const lower = text.toLowerCase();
      const all = room.participants.map((p) => p.id);
      const named = room.participants.filter((p) => lower.includes(`@${p.id.toLowerCase()}`)).map((p) => p.id);
      let targets: string[];
      if (/@(all|everyone)\b/.test(lower)) targets = all;
      else if (named.length) targets = named;
      else if (room.options.policy !== "mention") targets = all;
      else targets = room.last.length ? room.last : all.slice(0, 1);
      room.last = targets;

      for (const target of targets) {
        if (room.stopped) {
          emitRoom(id, { type: "stopped" });
          break;
        }
        const p = room.participants.find((x) => x.id === target);
        if (!p) continue;
        emitRoom(id, { type: "turn_started", id: p.id });
        if (p.backend.kind === "agent") {
          await sleep(600);
          for (const word of "I'll look at the project first.".split(" ")) {
            await sleep(25);
            emitRoom(id, { type: "delta", id: p.id, text: word + " " });
          }
          for (const step of ["Reading README.md", "Running: ls src", "Reading src/App.tsx"]) {
            emitRoom(id, { type: "activity", id: p.id, text: step });
            await sleep(600);
          }
          emitRoom(id, { type: "delta", id: p.id, text: "\n\n" });
          // Preview only: a bot set to ask first proposes one edit and one
          // command, so the approval cards and changes list can be seen.
          if (p.access === "ask") {
            const proposals: { action: ProposedAction; change?: FileChange }[] = [
              {
                action: { kind: "edit", title: "Edit README.md", detail: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n" },
                change: { path: "README.md", diff: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n", added: 2, removed: 1 },
              },
              { action: { kind: "command", title: "Run a command", detail: "npm run build" } },
            ];
            for (const { action, change } of proposals) {
              const request = `ask-${++askCount}`;
              emitRoom(id, { type: "activity", id: p.id, text: `Waiting for approval: ${action.title}` });
              emitRoom(id, { type: "approval_requested", id: p.id, request, action });
              const approved = await new Promise<boolean>((answer) => asks.set(request, answer));
              emitRoom(id, { type: "approval_resolved", id: p.id, request, approved });
              if (approved && change) emitRoom(id, { type: "changed", id: p.id, change });
              await sleep(300);
            }
          }
        }
        const reply = [
          `## Preview reply from ${p.display_name}`,
          "This is **preview mode**: the desktop app sends your message to the *real* model. See [README.md](README.md) or `npm run tauri dev`.",
          "1. Steps appear while a bot works\n2. Text is written live\n   - nested point with `code`\n3. The final reply replaces the draft",
          "| Tool | Live text |\n|---|---|\n| Claude Code | yes |\n| Codex | yes |",
          "```sh\ncd ~/Downloads/apex-deck\nnpm run tauri dev\n```",
        ].join("\n\n");
        for (const piece of reply.match(/\S+\s*/g) ?? []) {
          await sleep(25);
          emitRoom(id, { type: "delta", id: p.id, text: piece });
        }
        if (p.backend.kind === "agent") emitRoom(id, { type: "usage", id: p.id, input_tokens: 1840, output_tokens: 26 });
        emitRoom(id, { type: "message_added", message: { seq: room.seq++, speaker: { kind: "bot", id: p.id }, text: reply } });
      }
      emitRoom(id, { type: "idle" });
    },
    roomStop: async (id) => {
      const room = rooms.get(id);
      if (room) room.stopped = true;
      // Whatever is waiting on a yes or no is refused.
      for (const answer of asks.values()) answer(false);
      asks.clear();
    },
    roomDecide: async (_id, request, approve) => {
      const answer = asks.get(request);
      if (!answer) throw new Error("that request is no longer waiting for an answer");
      asks.delete(request);
      answer(approve);
    },
    roomSetOptions: async (id, options) => {
      const room = rooms.get(id);
      if (room) room.options = options;
      saveRoom(id);
    },
    roomAddParticipant: async (id, participant) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      if (room.participants.some((p) => p.id === participant.id)) {
        throw new Error(`a participant with the id \`${participant.id}\` is already in this chat`);
      }
      room.participants.push(participant);
      saveRoom(id);
    },
    roomUpdateParticipant: async (id, participant) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      if (!room.participants.some((p) => p.id === participant.id)) {
        throw new Error(`no participant with the id \`${participant.id}\` is in this chat`);
      }
      room.participants = room.participants.map((p) => (p.id === participant.id ? participant : p));
      saveRoom(id);
    },
    roomRemoveParticipant: async (id, participant) => {
      const room = rooms.get(id);
      if (room) room.participants = room.participants.filter((p) => p.id !== participant);
      saveRoom(id);
    },
    roomClear: async (id) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      room.transcript = [];
      room.seq = 0;
      room.last = [];
      saveRoom(id);
    },
    roomClose: async (id) => {
      rooms.delete(id);
    },
    roomDelete: async (id) => {
      rooms.delete(id);
      localStorage.removeItem(`apex-deck.demo.room.${id}`);
    },
    onRoomEvent: async (cb) => {
      roomListeners.add(cb);
      return () => roomListeners.delete(cb);
    },
  };
}

let cached: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  cached ??= inTauri ? tauriBackend() : Promise.resolve(demoBackend());
  return cached;
}
