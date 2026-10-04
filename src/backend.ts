import type { ToolServer } from "./types";
// Everything the UI needs from the desktop shell goes through this
// interface. Inside the desktop app it calls the Rust commands. In a plain
// browser (npm run dev without Tauri) it falls back to a small stand-in so
// the UI can be worked on without building the app.

import { ruleFor, sameRule } from "./allowedRules";
import type { AgentInfo, AgentTool, AllowedRule, AppSession, FileChange, ModelChoice, ParticipantConfig, ProposedAction, RoomEvent, RoomOptions, RoomSnapshot, ThreadDiff } from "./types";

type Unlisten = () => void;

export interface Backend {
  /** True when running in a browser with no desktop shell behind it. */
  demo: boolean;
  listToolServers(room: string, agent: string): Promise<ToolServer[]>;
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
  roomTargets(id: string, text: string): Promise<string[]>;
  roomPostTo(id: string, text: string, targets: string[]): Promise<void>;
  /** Run participants on the transcript as it is, one after another, without
   *  posting anything. `hops` caps the rounds of bots answering bots that may
   *  follow: null keeps the room's limit, 0 buys exactly one reply each. */
  roomTurn(id: string, participants: string[], hops: number | null): Promise<void>;
  roomStop(id: string, participant?: string): Promise<void>;
  /** Answer an action a bot proposed, named by the `request` from its event. */
  /** `always` stops the same thing being asked again in this thread until the app quits. */
  roomDecide(id: string, request: string, approve: boolean, always?: boolean): Promise<void>;
  roomSetOptions(id: string, options: RoomOptions): Promise<void>;
  /** Stop always allowing something, so its card shows again. */
  roomForgetAllowed(id: string, rule: AllowedRule): Promise<void>;
  roomAddParticipant(id: string, participant: ParticipantConfig): Promise<void>;
  /** Replace the settings of a participant that is already in the chat. */
  roomUpdateParticipant(id: string, participant: ParticipantConfig): Promise<void>;
  roomRemoveParticipant(id: string, participant: string): Promise<void>;
  /** Empty the transcript, which is all the models see, and keep the participants. */
  roomClear(id: string): Promise<void>;
  /** Pin a fact for every model in the chat. Resolves with all pins. */
  roomDiff(id: string): Promise<ThreadDiff>;
  exportThread(fileName: string, contents: string): Promise<string | null>;
  /** Save a pasted or picked file for this thread. Resolves with its path. */
  saveAttachment(room: string, name: string, bytes: Uint8Array): Promise<string>;
  /** Copy a file dropped on the window into this thread's attachments. */
  copyAttachment(room: string, path: string): Promise<string>;
  /** Files dropped on the window, with where they landed in CSS pixels. */
  onFileDrop(cb: (paths: string[], x: number, y: number) => void): Promise<Unlisten>;
  roomPin(id: string, fact: string): Promise<string[]>;
  roomUnpin(id: string, index: number): Promise<string[]>;
  roomFork(source: string, target: string, upto: number | null): Promise<void>;
  /** Have a participant summarize the chat and show the models that summary
   *  in place of the messages so far. The transcript is kept. */
  roomCompact(id: string): Promise<void>;
  roomClose(id: string): Promise<void>;
  roomDelete(id: string): Promise<void>;
  onRoomEvent(cb: (room: string, event: RoomEvent) => void): Promise<Unlisten>;
  /** Show on the app's icon how many panes need you or failed (Ready is left out). With `nudge`,
   *  also draw the eye to the icon once, for when the app is in the background. */
  flagAttention(count: number, nudge: boolean): Promise<void>;
  /** Ask for Critical attention (on macOS the dock bounces until the window is focused), for an approval left waiting. */
  requestCriticalAttention(): Promise<void>;
  /** The window's close button, ⌘W, ⌘Q or Quit in the app menu was used.
   *  Answer with `quitHeard` at once, then `quitApp` to go ahead. */
  onQuitRequested(cb: (request: number) => void): Promise<Unlisten>;
  /** Tell the desktop shell the window got quit request `request`, so it waits for the person. */
  quitHeard(request: number): Promise<void>;
  /** Quit now, ending every terminal. Nothing asks again. */
  quitApp(): Promise<void>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { open } = await import("@tauri-apps/plugin-dialog");

  return {
    demo: false,
    listToolServers: (room, agent) => invoke<ToolServer[]>("list_tool_servers", { room, agent }),
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
    requestCriticalAttention: async () => {
      const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
      // Not available on every system; the app works without it.
      await getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
    },
    roomPost: (id, text) => invoke("room_post", { id, text }),
    roomTargets: (id, text) => invoke("room_targets", { id, text }),
    roomPostTo: (id, text, targets) => invoke("room_post_to", { id, text, targets }),
    roomTurn: (id, participants, hops) => invoke("room_turn", { id, participants, hops }),
    roomStop: (id, participant) => invoke("room_stop", { id, participant: participant ?? null }),
    roomDecide: (id, request, approve, always = false) => invoke("room_decide", { id, request, approve, always }),
    roomSetOptions: (id, options) => invoke("room_set_options", { id, options }),
    roomForgetAllowed: (id, rule) => invoke("room_forget_allowed", { id, rule }),
    roomAddParticipant: (id, participant) => invoke("room_add_participant", { id, participant }),
    roomUpdateParticipant: (id, participant) => invoke("room_update_participant", { id, participant }),
    roomRemoveParticipant: (id, participant) => invoke("room_remove_participant", { id, participant }),
    roomClear: (id) => invoke("room_clear", { id }),
    roomDiff: (id) => invoke("room_diff", { id }),
    exportThread: (fileName, contents) => invoke("export_thread", { fileName, contents }),
    saveAttachment: (room, name, bytes) => invoke("save_attachment", bytes, { headers: { "x-room": room, "x-name": name } }),
    copyAttachment: (room, path) => invoke("copy_attachment", { room, path }),
    onFileDrop: async (cb) => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") cb(e.payload.paths, e.payload.position.x / devicePixelRatio, e.payload.position.y / devicePixelRatio);
      });
    },
    roomPin: (id, fact) => invoke("room_pin", { id, fact }),
    roomUnpin: (id, index) => invoke("room_unpin", { id, index }),
    roomFork: (source, target, upto) => invoke("room_fork", { source, target, upto }),
    roomCompact: (id) => invoke("room_compact", { id }),
    roomClose: (id) => invoke("room_close", { id }),
    roomDelete: (id) => invoke("room_delete", { id }),
    onRoomEvent: (cb) => listen<{ room: string; event: RoomEvent }>("room-event", (e) => cb(e.payload.room, e.payload.event)),
    onQuitRequested: (cb) => listen<number>("quit-requested", (e) => cb(e.payload)),
    quitHeard: (request) => invoke("quit_heard", { request }),
    quitApp: () => invoke("quit_app"),
  };
}

/** A stand-in for the desktop shell. Terminals echo what you type and chat
 *  participants answer with a canned line. Nothing here talks to a model. */
function demoBackend(): Backend {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, code: number | null) => void>();
  /** Preview terminals whose pretend program has ended or been killed. */
  const endedPtys = new Set<string>();
  const emitExit = (id: string, code: number | null) => {
    endedPtys.add(id);
    exitListeners.forEach((cb) => cb(id, code));
  };
  const roomListeners = new Set<(room: string, event: RoomEvent) => void>();
  const rooms = new Map<string, { participants: ParticipantConfig[]; options: RoomOptions; transcript: RoomSnapshot["transcript"]; compaction?: RoomSnapshot["compaction"]; pins?: string[]; allowed?: AllowedRule[]; seq: number; stopped: boolean; last: string[] }>();
  const cancellations = new Map<string, () => void>();
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
  const asks = new Map<string, (approve: boolean, always?: boolean) => void>();
  let askCount = 0;
  /** Codex's hook denies a call nobody answered after this long (HELPER_DEADLINE in codex_hook.rs). */
  const HOOK_DEADLINE_MS = 570_000;

  // Preview only: made-up meter readings so the identicon battery can be
  // seen. Claude Code agents start nearly out of context (18% left), Codex
  // agents with plenty; each reply fills a little more.
  const WINDOWS: Partial<Record<AgentTool, number>> = { claude_code: 200_000, codex: 272_000 };
  const contextUsed = new Map<string, number>();
  const planUsed: Record<"claude_code" | "codex", number> = { claude_code: 36, codex: 58 };
  const hours = (n: number) => Math.floor(Date.now() / 1000 + n * 3600);
  const reportContext = (room: string, p: ParticipantConfig, grow: number) => {
    if (p.backend.kind !== "agent") return;
    const window = WINDOWS[p.backend.tool];
    if (!window) return;
    const key = `${room}:${p.id}`;
    const used = Math.min(window, (contextUsed.get(key) ?? (p.backend.tool === "claude_code" ? 164_000 : 98_000)) + grow);
    contextUsed.set(key, used);
    emitRoom(room, { type: "context_usage", id: p.id, used_tokens: used, window_tokens: window });
  };
  const reportPlan = (room: string, tool: AgentTool) => {
    if (tool === "claude_code") {
      emitRoom(room, { type: "plan_usage", provider: tool, partial: false, windows: [
        { name: "five_hour", used_percent: planUsed.claude_code, window_minutes: 300, resets_at: hours(2) },
        { name: "seven_day", used_percent: 19, window_minutes: 10_080, resets_at: hours(80) },
      ] });
    } else if (tool === "codex") {
      emitRoom(room, { type: "plan_usage", provider: tool, partial: false, windows: [
        { name: "primary", used_percent: planUsed.codex, window_minutes: 10_080, resets_at: hours(100) },
      ] });
    }
  };
  /** What a room shows when it opens: every agent's context, and the plan of
   *  providers that can be read outside a turn (only Codex can). */
  const reportMeters = (room: string, participants: ParticipantConfig[]) => {
    for (const p of participants) reportContext(room, p, 0);
    if (participants.some((p) => p.backend.kind === "agent" && p.backend.tool === "codex")) reportPlan(room, "codex");
  };

  const editors = new Map<string, string>();
  const askOwners = new Map<string, string>();
  /** Preview only: bots that already failed on purpose for a message, so Try again succeeds. */
  const failedOnce = new Set<string>();
  /** End a room's running preview turns and turn down their open cards, as the
   *  native room_stop (one participant) and room_close (everyone) do. */
  const stopPreview = (id: string, participant?: string) => {
    for (const [key, cancel] of cancellations) if (key === `${id}:${participant}` || (!participant && key.startsWith(`${id}:`))) cancel();
    for (const [request, owner] of askOwners) if (owner === `${id}:${participant}` || (!participant && owner.startsWith(`${id}:`))) asks.get(request)?.(false);
  };
  const targetsFor = (id: string, text: string): string[] => {
    const room = rooms.get(id);
    if (!room) throw new Error(`no group chat with id ${id}`);
    const named = room.participants.filter(p => text.toLowerCase().match(/@[a-z0-9_-]+/g)?.includes(`@${p.id.toLowerCase()}`)).map(p => p.id);
    const all = room.participants.map(p => p.id);
    return /@(all|everyone)\b/i.test(text) || (!named.length && room.options.policy !== "mention") ? all : named.length ? named : room.last.length ? room.last : all.slice(0,1);
  };
  /** One participant's turn. Resolves with the bots its reply addressed, so
   *  runChain can follow them the way the native room does. */
  const runPreview = async (id: string, participant: string): Promise<string[]> => {
      const key = `${id}:${participant}`;
      let active = true;
      let stopped = false;
      let addressed: string[] = [];
      const partials = new Map<string, string>();
      const emit = (event: RoomEvent) => {
        if (!active) return;
        if (event.type === "delta") partials.set(event.id, (partials.get(event.id) ?? "") + event.text);
        if (event.type === "message_added" && event.message.speaker.kind === "bot") partials.delete(event.message.speaker.id);
        emitRoom(id, event);
      };
      const cancelled = new Promise<void>(resolve => cancellations.set(key, () => {
        const room = rooms.get(id);
        for (const [bot, text] of partials) if (text.trim() && room) emit({type: "message_added", message: {seq: room.seq++, speaker: {kind:"bot", id:bot}, text: text.trim() + "\n\n[Interrupted]"}});
        stopped = true; active = false; resolve();
      }));
      try { await Promise.race([(async () => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      for (const target of [participant]) {
        const configured = room.participants.find((x) => x.id === target);
        if (!configured) continue;
        const ownsEditor = configured.access !== "read" && !editors.has(id);
        if (ownsEditor) { editors.set(id, target); emit({type: "editor_changed", id: target}); }
        const p = {...configured, access: ownsEditor ? configured.access : "read" as const};
        const lastHuman = [...room.transcript].reverse().find((m) => m.speaker.kind === "human");
        emit( { type: "turn_started", id: p.id });
        // Preview only: "fail" in your message makes each addressed bot fail
        // once, so Try again can be seen.
        const failKey = `${id}:${p.id}:${lastHuman?.seq}`;
        if (lastHuman && /\bfail\b/i.test(lastHuman.text) && !failedOnce.has(failKey)) {
          failedOnce.add(failKey);
          await sleep(400); if (!active) return [];
          emit({ type: "failed", id: p.id, error: "Preview: this bot failed on purpose. Try again runs it once more." });
          continue;
        }
        if (p.backend.kind === "agent") {
          await sleep(600); if (!active) return;
          for (const word of "I'll look at the project first.".split(" ")) {
            await sleep(25); if (!active) return;
            emit( { type: "delta", id: p.id, text: word + " " });
          }
          for (const step of ["Reading README.md", "Running: ls src", "Reading src/App.tsx"]) {
            emit( { type: "activity", id: p.id, text: step });
            await sleep(600); if (!active) return;
          }
          // Preview only: a message with "stall" in it leaves the bot silent
          // for six minutes, so the quiet warning can be seen.
          const said = [...room.transcript].reverse().find((m) => m.speaker.kind === "human")?.text ?? "";
          if (/\bstall\b/i.test(said)) {
            emit( { type: "activity", id: p.id, text: "Running: sleep 360" });
            await sleep(6 * 60_000); if (!active) return;
          }
          emit( { type: "delta", id: p.id, text: "\n\n" });
          // Preview only: a bot set to ask first proposes an edit, then a
          // command and an MCP tool call together (as a model calling two
          // tools at once does), then a tool's own permission question, so
          // the approval cards, the attention list and the changes list can
          // be seen. Like Codex's hook, the tool call is denied by itself if
          // nobody answers within 570 seconds.
          if (p.access === "ask") {
            const ask = async ({ action: proposed, change }: { action: ProposedAction; change?: FileChange }) => {
              const action = proposed.kind === "tool" ? { ...proposed, expires_at: Date.now() + HOOK_DEADLINE_MS } : proposed;
              const room = rooms.get(id);
              const rule = ruleFor(p.id, action);
              if (room?.allowed?.some(r => sameRule(r, rule))) {
                emit( { type: "activity", id: p.id, text: `Always allowed: ${action.title}` });
                if (change) emit( { type: "changed", id: p.id, change });
                return;
              }
              const request = `ask-${++askCount}`;
              emit( { type: "activity", id: p.id, text: `Waiting for approval: ${action.title}` });
              emit( { type: "approval_requested", id: p.id, request, action });
              askOwners.set(request, key);
              const expiry = action.expires_at ? setTimeout(() => asks.get(request)?.(false), action.expires_at - Date.now()) : undefined;
              const [approved, always] = await new Promise<[boolean, boolean]>((answer) => asks.set(request, (yes, forever = false) => answer([yes, forever])));
              clearTimeout(expiry);
              asks.delete(request); askOwners.delete(request);
              emit( { type: "approval_resolved", id: p.id, request, approved });
              if (approved && always && room) {
                room.allowed = [...(room.allowed ?? []), rule];
                saveRoom(id);
                emit( { type: "allowed_changed", allowed: room.allowed });
              }
              if (approved && change) emit( { type: "changed", id: p.id, change });
            };
            const steps: { action: ProposedAction; change?: FileChange }[][] = [
              [{
                action: { kind: "edit", title: "Edit README.md", detail: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n" },
                change: { path: "README.md", diff: "-A desktop workspace for running coding agents.\n+A desktop workspace for running coding agents side by side.\n+It is open source.\n", added: 2, removed: 1 },
              }],
              [
                { action: { kind: "command", title: "Run a command", detail: "npm test -- --run auth" } },
                { action: { kind: "tool", title: "x-mcp: post_tweet", detail: "{\n  \"text\": \"Apex Deck preview\"\n}" } },
              ],
              [{ action: { kind: "other", title: "node_repl asks permission", detail: "Allow Computer Use to use \"Apex Deck\"?\n\nApp: dev.apexdeck.app\nRequested by: node_repl" } }],
            ];
            for (const step of steps) {
              await Promise.all(step.map(ask));
              await sleep(300); if (!active) return;
            }
          }
        }
        let reply = [
          `## Preview reply from ${p.display_name}`,
          "This is **preview mode**: the desktop app sends your message to the *real* model. See [README.md](README.md) or `npm run tauri dev`.",
          "1. Steps appear while a bot works\n2. Text is written live\n   - nested point with `code`\n3. The final reply replaces the draft",
          "| Tool | Live text |\n|---|---|\n| Claude Code | yes |\n| Codex | yes |",
          "```sh\ncd ~/Downloads/apex-deck\nnpm run tauri dev\n```",
        ].join("\n\n");
        // Preview only: "relay" in your message makes each bot hand over to the
        // next one in the room ("relay all": to everyone else), so the round
        // limit and Let them answer can be seen.
        if (lastHuman && /\brelay\b/i.test(lastHuman.text) && room.participants.length > 1) {
          const others = room.participants.filter((x) => x.id !== p.id);
          const next = room.participants[(room.participants.findIndex((x) => x.id === p.id) + 1) % room.participants.length];
          const everyone = /\brelay all\b/i.test(lastHuman.text);
          reply += everyone ? "\n\n@all your turn." : `\n\n@${next.id} your turn.`;
          addressed = everyone ? others.map((x) => x.id) : [next.id];
        }
        for (const piece of reply.match(/\S+\s*/g) ?? []) {
          await sleep(25); if (!active) return;
          emit( { type: "delta", id: p.id, text: piece });
        }
        if (p.backend.kind === "agent") {
          emit( { type: "usage", id: p.id, input_tokens: 1840, output_tokens: 26 });
          reportContext(id, p, 2_400);
          if (p.backend.tool === "claude_code" || p.backend.tool === "codex") {
            planUsed[p.backend.tool] = Math.min(100, planUsed[p.backend.tool] + 1);
            reportPlan(id, p.backend.tool);
          }
        }
        emit( { type: "message_added", message: { seq: room.seq++, speaker: { kind: "bot", id: p.id }, text: reply } });
      }
      })(), cancelled]); }
      finally {
        active = false; cancellations.delete(key);
        if (editors.get(id) === participant) { editors.delete(id); emitRoom(id, {type: "editor_changed", id: null}); }
        emitRoom(id, {type: "participant_idle", id: participant});
      }
      return stopped ? [] : addressed;
    };

  /** Rooms with chains of turns running; a room is idle when its last chain ends. */
  const chains = new Map<string, number>();
  /** Run `first`, then whoever the replies address, up to `limit` rounds of
   *  bots answering bots, like ConcurrentRoom::run. */
  const runChain = async (id: string, first: string[], sequential: boolean, limit: number) => {
    chains.set(id, (chains.get(id) ?? 0) + 1);
    try {
      let wave = first;
      let inTurn = sequential;
      for (let hops = 0; wave.length > 0; hops++) {
        const replies: string[][] = [];
        if (inTurn) for (const target of wave) replies.push(await runPreview(id, target));
        else replies.push(...await Promise.all(wave.map((target) => runPreview(id, target))));
        const next = [...new Set(replies.flat())].filter((target) => rooms.get(id)?.participants.some((p) => p.id === target));
        if (next.length === 0) break;
        if (hops >= limit) { emitRoom(id, { type: "hop_limit_reached", limit, next }); break; }
        wave = next;
        inTurn = true;
      }
    } finally {
      const left = (chains.get(id) ?? 1) - 1;
      if (left > 0) chains.set(id, left);
      else { chains.delete(id); emitRoom(id, { type: "idle" }); }
    }
  };

  const postPreview = async (id: string, text: string, targets: string[]) => {
    const room = rooms.get(id);
    if (!room) throw new Error(`no group chat with id ${id}`);
    if (targets.some(target => !room.participants.some(p => p.id === target))) throw new Error("a message recipient is no longer in this room");
    room.last = targets;
    emitRoom(id, {type: "message_added", message: {seq: room.seq++, speaker: {kind: "human"}, text}});
    await runChain(id, targets, room.options.policy === "round_robin", room.options.max_bot_hops);
  };

  return {
    demo: true,
    listToolServers: async () => ["x-mcp", "hyperliquid", "computer-use"].map(token => ({token, label: token, aliases: []})),
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
      setTimeout(() => emitData(id, `\x1b[2m${what}: keys are echoed, nothing runs. Try ask, work, long, exit or fail.\x1b[0m\r\n$ `), 30);
    },
    ptyWrite: async (id, data) => {
      if (endedPtys.has(id)) throw new Error(`no terminal with id ${id}`);
      emitData(id, data.replace(/\r/g, "\r\n$ ").replace(/\x7f/g, "\b \b"));
      // Preview only: typing "ask" then Enter shows an approval prompt, "work"
      // prints for a few seconds and "long" for 90 seconds, so the attention
      // states and working times can be seen.
      typedSoFar.set(id, ((typedSoFar.get(id) ?? "") + data).slice(-12));
      const line = typedSoFar.get(id) ?? "";
      if (line.endsWith("ask\r")) setTimeout(() => emitData(id, "\r\n Do you want to create hello.txt?\r\n \u276f 1. Yes\r\n   2. No\r\n"), 300);
      if (line.endsWith("work\r")) {
        for (let i = 1; i <= 40; i++) setTimeout(() => emitData(id, `\r\ncompiling module ${i} of 40 ...`), 2000 + i * 100);
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 6200);
      }
      if (line.endsWith("long\r")) {
        for (let i = 1; i <= 180; i++) setTimeout(() => emitData(id, `\r\nstep ${i} of 180 ...`), i * 500);
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 181 * 500);
      }
      // "exit" ends the pretend program cleanly. "fail" ends it with code 1
      // two seconds later, so you can look away and see the Failed flag.
      if (line.endsWith("exit\r")) setTimeout(() => emitExit(id, 0), 100);
      if (line.endsWith("fail\r")) setTimeout(() => emitExit(id, 1), 2000);
    },
    ptyResize: async () => {},
    ptyKill: async (id) => {
      endedPtys.add(id);
    },
    onPtyData: async (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onPtyExit: async (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },

    roomCreate: async (id, participants, options) => {
      const saved = JSON.parse(localStorage.getItem(`apex-deck.demo.room.${id}`) ?? "null");
      const room = saved ?? { participants: [...participants], options, transcript: [], seq: 0, stopped: false, last: [] };
      room.stopped = false;
      rooms.set(id, room);
      saveRoom(id);
      setTimeout(() => reportMeters(id, room.participants), 50);
      return { participants: [...room.participants], options: { ...room.options }, transcript: [...room.transcript], compaction: room.compaction ?? null, pins: room.pins ?? [], allowed: room.allowed ?? [] };
    },
    apiModels: async (baseUrl) => {
      if (baseUrl.includes("11434")) return ["llama3", "qwen2.5-coder"];
      throw new Error(`could not reach ${baseUrl}/models (browser demo)`);
    },
    agentModels: async () => [],
    flagAttention: async (count) => {
      document.title = count > 0 ? `(${count}) Apex Deck` : "Apex Deck";
    },
    // The browser has no dock; the console says what the desktop app would do.
    requestCriticalAttention: async () => {
      console.info("[preview] Critical attention requested");
    },
    openTarget: async (target) => {
      if (/^https?:/.test(target)) window.open(target, "_blank", "noopener");
      else throw new Error("files cannot be opened in the browser demo");
    },
    roomTargets: async (id, text) => targetsFor(id, text),
    roomPost: async (id, text) => postPreview(id, text, targetsFor(id, text)),
    roomPostTo: async (id, text, targets) => {
      if (!rooms.has(id) || targets.some(target => !rooms.get(id)!.participants.some(p => p.id === target))) throw new Error("a message recipient is no longer in this room");
      void postPreview(id, text, targets).catch(error => emitRoom(id, {type: "failed", id: "storage", error: String(error)}));
    },
    roomTurn: async (id, participants, hops) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      if (participants.some((target) => !room.participants.some((p) => p.id === target))) throw new Error("that participant is no longer in this room");
      void runChain(id, [...new Set(participants)], true, hops ?? room.options.max_bot_hops);
    },
    roomStop: async (id, participant) => stopPreview(id, participant),
    roomDecide: async (_id, request, approve, always = false) => {
      const answer = asks.get(request);
      if (!answer) throw new Error("that request is no longer waiting for an answer");
      asks.delete(request);
      answer(approve, always);
    },
    roomForgetAllowed: async (id, rule) => {
      const room = rooms.get(id);
      if (!room?.allowed?.some(r => sameRule(r, rule))) throw new Error("that was no longer always allowed");
      room.allowed = room.allowed.filter(r => !sameRule(r, rule));
      saveRoom(id);
      emitRoom(id, { type: "allowed_changed", allowed: room.allowed });
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
      setTimeout(() => reportMeters(id, [participant]), 50);
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
    roomDiff: async (id) => {
      const room = rooms.get(id);
      const [first, second] = room?.participants ?? [];
      const patch = "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-const title = \"Deck\";\n+const title = \"Apex Deck\";\n export default App;\n";
      return {
        note: "Preview: these changes are made up. The desktop app reads them from git.",
        files: [
          { path: "src/App.tsx", added: 1, removed: 1, patch, by: first ? [first.id] : [] },
          { path: "README.md", added: 3, removed: 0, patch: "+## Commands\n+\n+/pin, /diff, /fork, /export\n", by: [first, second].filter(Boolean).map((p) => p.id) },
          { path: "package-lock.json", added: 12, removed: 4, patch: "", by: [] },
        ],
      };
    },

    exportThread: async (fileName, contents) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      return null;
    },
    // The browser keeps no files, so the "path" is only a name to show.
    saveAttachment: async (_room, name) => `/preview/attachments/${name}`,
    copyAttachment: async (_room, path) => path,
    onFileDrop: async () => () => {},
    roomPin: async (id, fact) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      const pins: string[] = (room.pins ??= []);
      const trimmed = fact.trim();
      if (!trimmed) throw new Error("type the fact after /pin");
      if ([...trimmed].length > 500) throw new Error("pins can be at most 500 characters");
      if (pins.includes(trimmed)) throw new Error("that is already pinned");
      pins.push(trimmed);
      saveRoom(id);
      return [...pins];
    },
    roomFork: async (source, target, upto) => {
      const sourceData = localStorage.getItem(`apex-deck.demo.room.${source}`);
      if (!sourceData) throw new Error("send a message before forking this thread");
      if (localStorage.getItem(`apex-deck.demo.room.${target}`)) throw new Error("a thread with that id already exists");
      const fork = JSON.parse(sourceData);
      const length = fork.transcript.length;
      const cutoff = upto === null ? length : Math.max(0, Math.min(length, upto));
      fork.transcript = fork.transcript.slice(0, cutoff);
      if (fork.compaction?.upto > cutoff) fork.compaction = null;
      if (cutoff < length) fork.last = [];
      if (fork.changes) fork.changes = fork.changes.filter((change: { seq: number }) => change.seq < cutoff);
      fork.seq = cutoff;
      fork.stopped = false;
      localStorage.setItem(`apex-deck.demo.room.${target}`, JSON.stringify(fork));
    },
    roomUnpin: async (id, index) => {
      const room = rooms.get(id);
      if (!Number.isInteger(index) || index < 0 || !room?.pins?.[index]) throw new Error("that pin is gone");
      room.pins.splice(index, 1);
      saveRoom(id);
      return [...room.pins];
    },
    roomClear: async (id) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      room.transcript = [];
      room.compaction = null;
      room.seq = 0;
      room.last = [];
      saveRoom(id);
    },
    roomCompact: async (id) => {
      const room = rooms.get(id);
      if (!room) throw new Error(`no group chat with id ${id}`);
      const by = room.participants.find((p) => p.id === room.last[0]) ?? room.participants[0];
      if (!by) throw new Error("add a participant before compacting");
      const upto = room.transcript.length;
      if (upto === (room.compaction?.upto ?? 0)) throw new Error("there is nothing new to summarize");
      emitRoom(id, { type: "turn_started", id: by.id });
      await sleep(400);
      const summary = `Preview summary of ${upto} messages. The desktop app asks ${by.display_name} to write the real one.`;
      room.compaction = { summary, upto };
      saveRoom(id);
      // The summary is far smaller than what it replaces.
      for (const p of room.participants) contextUsed.set(`${id}:${p.id}`, 9_000);
      emitRoom(id, { type: "compacted", id: by.id, summary, upto });
    },
    roomClose: async (id) => {
      stopPreview(id);
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
    // The browser has no window to close or app to quit. To see the question
    // in the preview, run apexDeckPreviewQuit() in the developer console.
    onQuitRequested: async (cb) => {
      const page = window as unknown as { apexDeckPreviewQuit?: () => void };
      let request = 0;
      const ask = () => cb(++request);
      page.apexDeckPreviewQuit = ask;
      return () => { if (page.apexDeckPreviewQuit === ask) delete page.apexDeckPreviewQuit; };
    },
    quitHeard: async () => {},
    quitApp: async () => { console.info("Preview: the desktop app would quit now."); },
  };
}

let cached: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  cached ??= inTauri ? tauriBackend() : Promise.resolve(demoBackend());
  return cached;
}
