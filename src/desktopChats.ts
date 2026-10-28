// Chats on the desktop: the rail's Chats list and what an open chat sends through.
//
// Each machine lists its own chats (`chat_list`), as it does for the phone. The desktop keeps no
// list of its own between launches: what a machine said this session is what shows, greyed while
// that machine is off. Every message goes through the shared outbox (chatDelivery.ts), saved under
// the desktop's own key so it never shares an outbox with a phone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { HostConnectionStore } from "./hostConnections";
import type { Access, Pane, ParticipantConfig, RoomEvent, RoomSnapshot, Speed, Workspace } from "./types";
import { workspaceHost } from "./hostSession.ts";
import { addFolders, setHidden } from "./workspaces.ts";
import { ChatDeliveryController, JsonChatDeliveryStorage, type ChatDeliverySnapshot } from "./chatDelivery.ts";
import { chatRows, chatTitle, emptyCatalog, findRoom, parseChatEntry, parseChatList, parseChatProfiles, withListedRooms, withRoom, withoutHosts, type ChatCatalog, type ChatEntry, type ChatProfile } from "./chatCatalog.ts";
import { DESKTOP_PROMOTES_KEY, parseAbandon, promoteKey, promoteRequest, readPromoteTickets, withoutTicket, writePromoteTickets, type PromoteTicket } from "./chatPromote.ts";
import { createChatDeliveryRpc } from "./phone/phoneChatDelivery.ts";
import { watchChatDelivery } from "./phone/chatDeliveryWatch.ts";

export const DESKTOP_CHAT_DELIVERY_KEY = "apex-deck.desktop-chat-delivery";
export const OPEN_CHAT_KEY = "apex-deck.desktop-open-chat";

export interface ChatMachine { id: string; name: string }
export interface ChatPlace { hostId: string; room: string }
/** What a bot edit may change in a chat. The machine fills in the rest from its saved profile. */
export interface ChatBotPatch { model?: string | null; effort?: string | null; speed?: Speed | null }

/** Machine and room together: room ids are only unique per machine. */
export const chatKey = (place: ChatPlace): string => JSON.stringify([place.hostId, place.room]);
/** The outbox id, the same one the phone uses for a chat it hasn't moved. */
export const deliveryId = chatKey;

export function readOpenChat(storage: Pick<Storage, "getItem">): ChatPlace | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(OPEN_CHAT_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { hostId, room } = value as Record<string, unknown>;
    return typeof hostId === "string" && hostId && typeof room === "string" && room ? { hostId, room } : null;
  } catch { return null; }
}
export function saveOpenChat(storage: Pick<Storage, "setItem" | "removeItem">, place: ChatPlace | null): void {
  try { if (place) storage.setItem(OPEN_CHAT_KEY, JSON.stringify(place)); else storage.removeItem(OPEN_CHAT_KEY); } catch { /* reopened from the rail */ }
}

/** A restored open chat stays only while its machine still lists it as a chat it holds.
 *  Unknown until that machine answers; gone once it answers without it, or says it moved. */
export function restoredChat(catalog: ChatCatalog, place: ChatPlace): "keep" | "drop" | "unknown" {
  const host = catalog.hosts[place.hostId];
  if (!host || host.listedAt === undefined) return "unknown";
  const row = findRoom(catalog, place.hostId, place.room);
  return row && row.kind === "chat" && !row.movedTo ? "keep" : "drop";
}

/** Where a chat's Work thread opens: its pane on the chat's own machine, adding the project
 *  and the thread when this Deck doesn't show them yet (a phone made the move). The room
 *  already exists on that machine, so opening the pane only reads it. A project inside its
 *  Remove/Undo window comes back (`restored`). Null while that machine hasn't listed the
 *  Work thread yet, or a clash when that id is open from another machine. */
export function workThreadPlace(workspaces: Workspace[], panes: Pane[], hostId: string, work: ChatEntry | null, makeId: () => string, nameOf: (path: string) => string): { workspaces: Workspace[]; pane: Pane; added: boolean; restored: string | null } | "unlisted" | "clash" {
  if (!work || work.kind !== "work" || !work.cwd) return "unlisted";
  const hostOf = (pane: Pane) => (pane as Pane & { hostId?: string }).hostId ?? workspaceHost(workspaces.find((w) => w.id === pane.workspaceId) ?? { id: "", name: "", path: "" });
  const hiddenId = (id: string) => workspaces.some((w) => w.id === id && w.hidden) ? id : null;
  const open = panes.find((pane) => pane.id === work.id && pane.kind === "chat" && hostOf(pane) === hostId);
  if (open) {
    const restored = hiddenId(open.workspaceId);
    return { workspaces: restored ? setHidden(workspaces, restored, false) : workspaces, pane: open, added: false, restored };
  }
  // Deck keys a thread's pane by room id alone, so the same id open from another machine can't show beside it.
  if (panes.some((pane) => pane.id === work.id)) return "clash";
  const { list, ids } = addFolders(workspaces, [work.cwd], makeId, (path) => work.folderName ?? nameOf(path), hostId);
  return { workspaces: list, pane: { id: work.id, workspaceId: ids[0], kind: "chat", title: work.title }, added: true, restored: hiddenId(ids[0]) };
}

type Call = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Tickets = Pick<Storage, "getItem" | "setItem">;

/** Drop one move's ticket, only if it is still that move: a late answer to an older one leaves its replacement alone. */
function forgetPromote(storage: Tickets, row: ChatPlace, requestId: string): void {
  const rest = withoutTicket(readPromoteTickets(storage, DESKTOP_PROMOTES_KEY), promoteKey(row.hostId, row.room), requestId);
  if (!rest) return;
  try { writePromoteTickets(storage, rest, DESKTOP_PROMOTES_KEY, "Deck"); } catch { /* kept: finishing it again is harmless */ }
}

/** Send a move to a Work thread. The ticket is saved first and kept until the machine confirms, so a
 *  retry after a lost answer is the same move; nothing is sent if it can't be saved. */
export async function sendPromote(storage: Tickets, call: Call, row: ChatEntry, cwd: string, access: Record<string, Access>, fresh: () => { target: string; requestId: string }, machine: string): Promise<{ work: ChatEntry; chat: ChatEntry | null }> {
  const key = promoteKey(row.hostId, row.id);
  const saved = readPromoteTickets(storage, DESKTOP_PROMOTES_KEY);
  const { ticket, fresh: isNew } = promoteRequest(saved[key], cwd, access, fresh);
  if (isNew) writePromoteTickets(storage, { ...saved, [key]: ticket }, DESKTOP_PROMOTES_KEY, "Deck");
  const reply = await call<{ work?: unknown; chat?: unknown }>("chat_promote", { source: row.id, target: ticket.target, cwd: ticket.cwd, access: ticket.access, requestId: ticket.requestId });
  const work = parseChatEntry(row.hostId, reply?.work);
  if (!work) throw new Error(`${machine} didn't confirm the Work thread. Try again: the same move is reused.`);
  forgetPromote(storage, { hostId: row.hostId, room: row.id }, ticket.requestId);
  return { work, chat: parseChatEntry(row.hostId, reply?.chat) };
}

/** Start an unconfirmed move over, only once the machine has fenced it off, so the old access can't land
 *  later. If it had already happened, the Work thread it made. */
export async function abandonPromote(storage: Tickets, call: Call, row: ChatEntry): Promise<{ work: ChatEntry | null; chat: ChatEntry | null } | null> {
  const saved = readPromoteTickets(storage, DESKTOP_PROMOTES_KEY)[promoteKey(row.hostId, row.id)];
  if (!saved) return null;
  const outcome = parseAbandon(await call<unknown>("chat_promote_abandon", { source: row.id, requestId: saved.requestId }));
  forgetPromote(storage, { hostId: row.hostId, room: row.id }, saved.requestId);
  return outcome.state === "done" ? { work: parseChatEntry(row.hostId, outcome.work), chat: parseChatEntry(row.hostId, outcome.chat) } : null;
}

/** The patch a bot edit sends: only what changed, and never a whole config. */
export function botPatch(saved: ParticipantConfig, change: ChatBotPatch): ChatBotPatch {
  const model = saved.backend.kind === "agent" || saved.backend.kind === "open_ai_compatible" ? saved.backend.model : null;
  const patch: ChatBotPatch = {};
  if (change.model !== undefined && (change.model || null) !== (model || null)) patch.model = change.model || null;
  if (change.effort !== undefined && (change.effort || null) !== (saved.effort || null)) patch.effort = change.effort || null;
  if (change.speed !== undefined && (change.speed ?? null) !== (saved.speed ?? null)) patch.speed = change.speed ?? null;
  return patch;
}

/** Why a chat can't take a message right now, or null when it can. */
/** Offline is not a block: the message waits in the outbox and goes when the machine is back. */
export function sendBlock(row: ChatEntry, machine: ChatMachine, rooms: boolean | undefined): string | null {
  if (row.promotedTo) return "This chat moved to a Work thread. Carry on there.";
  if (rooms === false) return `Update Deck on ${machine.name} to chat here.`;
  return null;
}

const words = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface DesktopChats {
  catalog: ChatCatalog;
  rows: ChatEntry[];
  archived: ChatEntry[];
  machines: ChatMachine[];
  /** Per machine: it answered `chat_list` (true), it can't hold chats (false), or not asked yet. */
  rooms: Record<string, boolean | undefined>;
  problems: Record<string, string>;
  delivery: ChatDeliveryController | null;
  deliveryProblem: string | null;
  /** Bumped whenever the outbox changes, so views re-read it. */
  tick: number;
  online(hostId: string): boolean;
  backendOf(hostId: string): Backend | null;
  connectionOf(hostId: string): HostConnectionStore | null;
  machineName(hostId: string): string;
  refresh(hostId: string): Promise<void>;
  profiles(hostId: string): Promise<ChatProfile[]>;
  create(hostId: string, profiles: string[]): Promise<ChatEntry>;
  updateMeta(row: ChatEntry, change: { title?: string; archived?: boolean }): Promise<void>;
  addBot(row: ChatEntry, profile: string): Promise<void>;
  removeBot(row: ChatEntry, bot: string): Promise<void>;
  updateBot(row: ChatEntry, saved: ParticipantConfig, change: ChatBotPatch): Promise<ParticipantConfig | null>;
  /** Keep the room's latest state in the outbox, so a relaunch can recover from it. */
  remember(row: ChatEntry, snapshot: RoomSnapshot): void;
  send(row: ChatEntry, text: string): void;
  retry(row: ChatEntry, messageId: string): void;
  /** A folder on the chat's machine, from the same picker Add project uses. */
  pickFolder(hostId: string): Promise<string | null>;
  /** A move to a Work thread sent earlier whose answer never came back. */
  promoteTicket(row: ChatEntry): PromoteTicket | undefined;
  /** Move the chat to a Work thread in `cwd`. Saved before it is sent, so a retry is the same move. */
  promote(row: ChatEntry, cwd: string, access: Record<string, Access>): Promise<ChatEntry>;
  /** Drop an unconfirmed move once the machine has fenced it off; the Work thread if it had already happened. */
  promoteOver(row: ChatEntry): Promise<ChatEntry | null>;
}

export function useDesktopChats({ machines, backendOf, connectionOf, onError, storage = localStorage }: {
  machines: ChatMachine[];
  backendOf(hostId: string): Backend | null;
  connectionOf(hostId: string): HostConnectionStore | null;
  onError(message: string): void;
  storage?: Pick<Storage, "getItem" | "setItem">;
}): DesktopChats {
  const [catalog, setCatalog] = useState<ChatCatalog>(emptyCatalog);
  const [rooms, setRooms] = useState<Record<string, boolean | undefined>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const [statusTick, setStatusTick] = useState(0);
  const live = useRef({ machines, backendOf, connectionOf, onError });
  live.current = { machines, backendOf, connectionOf, onError };
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const online = useCallback((hostId: string) => {
    const kind = live.current.connectionOf(hostId)?.get().status.kind;
    return kind === undefined ? hostId === "local" : kind === "connected";
  }, []);
  const machineName = useCallback((hostId: string) => hostId === "local" ? "This Mac" : live.current.machines.find((m) => m.id === hostId)?.name ?? catalogRef.current.hosts[hostId]?.name ?? hostId, []);

  // One outbox for the window. A store that can't be read pauses sending instead of losing messages.
  const deliveryRef = useRef<{ controller: ChatDeliveryController | null; problem: string | null } | null>(null);
  if (!deliveryRef.current) {
    try {
      const controller = new ChatDeliveryController({
        storage: new JsonChatDeliveryStorage(localStorage, { key: DESKTOP_CHAT_DELIVERY_KEY }),
        rpc: createChatDeliveryRpc((id) => {
          const backend = live.current.backendOf(id), connection = live.current.connectionOf(id);
          return backend && connection ? { machine: { id, name: machineName(id) }, backend, connection } : undefined;
        }),
        onChange: () => setTick((n) => n + 1),
        canSend: (_chat, message) => online(message.machine.id),
      });
      deliveryRef.current = { controller, problem: null };
    } catch (error) { deliveryRef.current = { controller: null, problem: words(error) }; }
  }
  const delivery = deliveryRef.current.controller;

  const refresh = useCallback(async (hostId: string) => {
    const backend = live.current.backendOf(hostId);
    if (!backend || !online(hostId)) return;
    if (backend.supports && !backend.supports("chat_rooms")) { setRooms((all) => ({ ...all, [hostId]: false })); return; }
    const askedAt = Date.now();
    try {
      const rows = parseChatList(hostId, await backend.call<unknown>("chat_list", {}));
      setCatalog((current) => withListedRooms(current, hostId, machineName(hostId), rows, askedAt));
      setRooms((all) => ({ ...all, [hostId]: true }));
      setProblems((all) => { if (!all[hostId]) return all; const { [hostId]: _, ...rest } = all; return rest; });
    } catch (error) { setProblems((all) => ({ ...all, [hostId]: words(error) })); }
  }, [online, machineName]);

  const machineIds = machines.map((m) => m.id).join("\n");
  // A removed server takes its chats with it.
  useEffect(() => { setCatalog((current) => withoutHosts(current, machineIds ? machineIds.split("\n") : [])); }, [machineIds]);

  // Each machine is asked when it connects, when the window comes back to the front, every 30 s,
  // and soon after a message finishes in one of its chats.
  useEffect(() => {
    const ids = machineIds ? machineIds.split("\n") : [];
    let on = true;
    const timers = new Map<string, number>();
    const soon = (hostId: string) => {
      if (!on || timers.has(hostId)) return;
      timers.set(hostId, window.setTimeout(() => { timers.delete(hostId); if (on) void refresh(hostId); }, 1500));
    };
    const stops: (() => void)[] = [];
    for (const hostId of ids) {
      void refresh(hostId);
      const connection = live.current.connectionOf(hostId);
      let was = connection?.get().status.kind;
      if (connection) stops.push(connection.subscribe(() => {
        const now = connection.get().status.kind;
        if (now === was) return;
        was = now; setStatusTick((n) => n + 1);
        if (now === "connected") soon(hostId);
      }));
      const backend = live.current.backendOf(hostId);
      backend?.onRoomEvent((room, raw) => {
        const event: RoomEvent = raw.type === "voice_event" ? raw.event : raw;
        if ((event.type === "message_added" || event.type === "idle") && findRoom(catalogRef.current, hostId, room)) soon(hostId);
      }).then((stop) => { if (on) stops.push(stop); else stop(); }).catch(() => {});
    }
    const focus = () => ids.forEach(soon);
    window.addEventListener("focus", focus);
    const timer = window.setInterval(focus, 30_000);
    return () => { on = false; window.removeEventListener("focus", focus); clearInterval(timer); timers.forEach((t) => clearTimeout(t)); stops.forEach((stop) => stop()); };
  }, [machineIds, refresh]);

  // The outbox recovers on launch and after each reconnect: unsent and uncertain messages go again
  // with the same id, which the machine treats as already had if it got them.
  useEffect(() => {
    if (!delivery) return;
    const hosts = (machineIds ? machineIds.split("\n") : []).flatMap((id) => {
      const backend = live.current.backendOf(id), connection = live.current.connectionOf(id);
      return backend && connection && backend.supports?.("chat_delivery_v1") !== false ? [{ machine: { id }, backend, connection }] : [];
    });
    const watch = watchChatDelivery(delivery, hosts, (error) => live.current.onError(words(error)));
    return () => watch.stop();
  }, [delivery, machineIds]);

  const need = (hostId: string): Backend => {
    const backend = live.current.backendOf(hostId);
    if (!backend || !online(hostId)) throw new Error(`${machineName(hostId)} isn't connected. Nothing changed.`);
    return backend;
  };
  const upsert = (hostId: string, raw: unknown, fallback?: ChatEntry) => {
    const row = parseChatEntry(hostId, raw) ?? fallback;
    if (row) setCatalog((current) => withRoom(current, hostId, machineName(hostId), row));
  };

  const api: Omit<DesktopChats, "catalog" | "rows" | "archived" | "machines" | "rooms" | "problems" | "tick"> = {
    delivery,
    deliveryProblem: deliveryRef.current.problem,
    online,
    backendOf: (id) => live.current.backendOf(id),
    connectionOf: (id) => live.current.connectionOf(id),
    machineName,
    refresh,
    async profiles(hostId) { return parseChatProfiles(await need(hostId).call<unknown>("chat_profiles", {})); },
    async create(hostId, profiles) {
      const backend = need(hostId);
      const id = `chat-${crypto.randomUUID()}`;
      const snapshot = await backend.call<RoomSnapshot>("chat_create", { id, title: "New chat", participants: profiles.map((profile) => ({ profile })), options: { policy: "everyone", max_bot_hops: 3 } });
      const row = parseChatEntry(hostId, { id, kind: "chat", title: "New chat", participants: snapshot.participants, updatedAt: Date.now(), archived: false, profiles: Object.fromEntries(snapshot.participants.map((bot, index) => [bot.id, profiles[index] ?? bot.id])) });
      if (!row) throw new Error(`${machineName(hostId)} didn't confirm the new chat.`);
      setCatalog((current) => withRoom(current, hostId, machineName(hostId), row));
      delivery?.cacheChat({ id: deliveryId({ hostId, room: id }), title: row.title, machine: { id: hostId, name: machineName(hostId) }, room: id, profiles: row.profiles, snapshot: { ...snapshot, kind: "chat" } });
      void refresh(hostId);
      return row;
    },
    async updateMeta(row, change) {
      upsert(row.hostId, await need(row.hostId).call<unknown>("chat_update_meta", { id: row.id, ...change }), { ...row, ...change });
      if (change.title !== undefined && delivery) {
        const kept = delivery.snapshot().chats[deliveryId({ hostId: row.hostId, room: row.id })];
        if (kept) delivery.cacheChat({ id: kept.id, title: change.title, machine: kept.machine, room: kept.room, profiles: kept.snapshot.importProfiles ?? {}, snapshot: kept.snapshot });
      }
    },
    async addBot(row, profile) {
      await need(row.hostId).call("chat_add_participant", { id: row.id, participant: { profile } });
      await refresh(row.hostId);
    },
    async removeBot(row, bot) {
      await need(row.hostId).call("chat_remove_participant", { id: row.id, participant: bot });
      await refresh(row.hostId);
    },
    async updateBot(row, saved, change) {
      const patch = botPatch(saved, change);
      if (Object.keys(patch).length === 0) return null;
      return await need(row.hostId).call<ParticipantConfig>("chat_update_participant", { id: row.id, participant: saved.id, patch });
    },
    remember(row, snapshot) {
      if (!delivery) return;
      const id = deliveryId({ hostId: row.hostId, room: row.id });
      const chat: ChatDeliverySnapshot = { ...snapshot, kind: "chat" };
      try {
        if (delivery.snapshot().chats[id]) void delivery.observe(id, row.hostId, row.id, chat).catch((error) => live.current.onError(words(error)));
        else delivery.cacheChat({ id, title: row.title, machine: { id: row.hostId, name: machineName(row.hostId) }, room: row.id, profiles: row.profiles, snapshot: chat });
      } catch (error) { live.current.onError(words(error)); }
    },
    send(row, text) {
      if (!delivery) throw new Error(deliveryRef.current?.problem ?? "Sending is paused.");
      const id = deliveryId({ hostId: row.hostId, room: row.id });
      if (!delivery.snapshot().chats[id]) throw new Error(`Open this chat once while ${machineName(row.hostId)} is connected, then send.`);
      const messageId = delivery.enqueue(id, text, []);
      // A new chat takes its name from its first message, as a Work thread does.
      if (row.title === "New chat" && online(row.hostId)) api.updateMeta(row, { title: chatTitle(text) }).catch(() => {});
      delivery.send(id, messageId).catch((error) => live.current.onError(words(error)));
    },
    retry(row, messageId) {
      if (!delivery) return;
      delivery.retry(deliveryId({ hostId: row.hostId, room: row.id }), messageId).catch((error) => live.current.onError(words(error)));
    },
    pickFolder: (hostId) => need(hostId).pickFolder(),
    promoteTicket: (row) => readPromoteTickets(storage, DESKTOP_PROMOTES_KEY)[promoteKey(row.hostId, row.id)],
    async promote(row, cwd, access) {
      const backend = need(row.hostId);
      const fresh = () => ({ target: `pane-${crypto.randomUUID()}`, requestId: crypto.randomUUID() });
      try {
        const { work, chat } = await sendPromote(storage, (command, args) => backend.call(command, args), row, cwd, access, fresh, machineName(row.hostId));
        const name = machineName(row.hostId);
        setCatalog((current) => withRoom(withRoom(current, row.hostId, name, chat ?? { ...row, promotedTo: work.id }), row.hostId, name, work));
        void refresh(row.hostId);
        return work;
      } finally { setTick((n) => n + 1); }
    },
    async promoteOver(row) {
      const backend = need(row.hostId);
      try {
        const done = await abandonPromote(storage, (command, args) => backend.call(command, args), row);
        if (!done) return null;
        const name = machineName(row.hostId);
        setCatalog((current) => [done.chat, done.work].reduce((next, item) => item ? withRoom(next, row.hostId, name, item) : next, current));
        void refresh(row.hostId);
        return done.work;
      } finally { setTick((n) => n + 1); }
    },
  };

  const lists = useMemo(() => {
    const all = chatRows(catalog, true).rows;
    return { rows: all.filter((row) => !row.archived), archived: all.filter((row) => row.archived) };
  }, [catalog]);
  void statusTick;
  return { ...api, catalog, rows: lists.rows, archived: lists.archived, machines, rooms, problems, tick };
}
