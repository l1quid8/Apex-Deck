// Chats on the desktop: the rail's Chats list and what an open chat sends through.
//
// Each machine lists its own chats (`chat_list`), as it does for the phone. The desktop keeps no
// list of its own between launches: what a machine said this session is what shows, greyed while
// that machine is off. Every message goes through the shared outbox (chatDelivery.ts), saved under
// the desktop's own key so it never shares an outbox with a phone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { HostConnectionStore } from "./hostConnections";
import type { ParticipantConfig, RoomEvent, RoomSnapshot, Speed } from "./types";
import { ChatDeliveryController, JsonChatDeliveryStorage, type ChatDeliverySnapshot } from "./chatDelivery.ts";
import { chatRows, chatTitle, emptyCatalog, findRoom, parseChatEntry, parseChatList, parseChatProfiles, withListedRooms, withRoom, withoutHosts, type ChatCatalog, type ChatEntry, type ChatProfile } from "./chatCatalog.ts";
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
}

export function useDesktopChats({ machines, backendOf, connectionOf, onError }: {
  machines: ChatMachine[];
  backendOf(hostId: string): Backend | null;
  connectionOf(hostId: string): HostConnectionStore | null;
  onError(message: string): void;
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
  };

  const lists = useMemo(() => {
    const all = chatRows(catalog, true).rows;
    return { rows: all.filter((row) => !row.archived), archived: all.filter((row) => row.archived) };
  }, [catalog]);
  void statusTick;
  return { ...api, catalog, rows: lists.rows, archived: lists.archived, machines, rooms, problems, tick };
}
