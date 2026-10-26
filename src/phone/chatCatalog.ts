// The phone's Chats list. Each paired machine lists its own chats (`chat_list`), so a phone
// with only a headless Linux box still has them. The phone merges those lists and keeps the
// merged copy, so chats and the Work threads made from them still show while a machine is off.

import type { Message, ParticipantConfig } from "../types.ts";

export interface ChatBot { id: string; name: string }
export interface ChatEntry {
  hostId: string;
  id: string;
  kind: "chat" | "work";
  title: string;
  bots: ChatBot[];
  updatedAt: number;
  archived: boolean;
  /** A promoted Work thread's folder; null for a chat. */
  cwd: string | null;
  folderName: string | null;
  promotedFrom: string | null;
  promotedTo: string | null;
  /** Set on a chat that moved to another machine. The chat lives on there now. */
  movedTo: { host: string; room: string } | null;
  /** Bot id in this chat → the saved profile it was made from. */
  profiles: Record<string, string>;
}
export interface ChatCatalog {
  version: 1;
  hosts: Record<string, { name: string; rooms: ChatEntry[] }>;
  /** What New chat starts with: the last machine and the saved profiles last picked there. */
  last: { hostId: string; profiles: string[] } | null;
}
export interface ChatProfile { profile: ParticipantConfig; ok: boolean; reason: string | null }

export const CHAT_CATALOG_KEY = "apex-deck.phone.chats.v1";
export const emptyCatalog = (): ChatCatalog => ({ version: 1, hosts: {}, last: null });

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

function entry(hostId: string, raw: unknown): ChatEntry | null {
  if (!record(raw) || typeof raw.id !== "string" || !raw.id || (raw.kind !== "chat" && raw.kind !== "work")) return null;
  // A machine sends participants; the phone's saved copy keeps only each bot's id and name.
  const listed = Array.isArray(raw.participants) ? raw.participants : Array.isArray(raw.bots) ? raw.bots : [];
  const bots = listed.flatMap((bot) => {
    if (!record(bot) || typeof bot.id !== "string" || !bot.id) return [];
    const name = typeof bot.display_name === "string" && bot.display_name ? bot.display_name : typeof bot.name === "string" && bot.name ? bot.name : bot.id;
    return [{ id: bot.id, name }];
  });
  const moved = record(raw.movedTo) && text(raw.movedTo.host) && text(raw.movedTo.room) ? { host: raw.movedTo.host as string, room: raw.movedTo.room as string } : null;
  const profiles = record(raw.profiles) ? Object.fromEntries(Object.entries(raw.profiles).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0)) : {};
  return {
    hostId,
    id: raw.id,
    kind: raw.kind,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : raw.kind === "chat" ? "New chat" : "Work thread",
    bots,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    archived: raw.archived === true,
    cwd: text(raw.cwd),
    folderName: text(raw.folderName),
    promotedFrom: text(raw.promotedFrom),
    promotedTo: text(raw.promotedTo),
    movedTo: moved,
    profiles,
  };
}

/** One machine's `chat_list` answer. Rows the phone can't read are left out, not guessed at. */
export function parseChatList(hostId: string, raw: unknown): ChatEntry[] {
  if (!record(raw) || !Array.isArray(raw.rooms)) throw new Error("The machine sent a chat list this phone can't read.");
  return raw.rooms.flatMap((item) => { const row = entry(hostId, item); return row ? [row] : []; });
}

/** One row from a `chat_promote` or `chat_create` answer, added before the next full list arrives. */
export function parseChatEntry(hostId: string, raw: unknown): ChatEntry | null { return entry(hostId, raw); }

/** Replace one machine's rows with what it just listed. */
export function withHostRooms(catalog: ChatCatalog, hostId: string, name: string, rooms: ChatEntry[]): ChatCatalog {
  return { ...catalog, hosts: { ...catalog.hosts, [hostId]: { name, rooms } } };
}

/** Add or replace one row, keeping the rest of that machine's list. */
export function withRoom(catalog: ChatCatalog, hostId: string, name: string, room: ChatEntry): ChatCatalog {
  const rooms = catalog.hosts[hostId]?.rooms ?? [];
  return withHostRooms(catalog, hostId, name, [...rooms.filter((item) => item.id !== room.id), room]);
}

/** A machine that was unpaired takes its rows with it. */
export function withoutHosts(catalog: ChatCatalog, paired: readonly string[]): ChatCatalog {
  const hosts = Object.fromEntries(Object.entries(catalog.hosts).filter(([id]) => paired.includes(id)));
  const last = catalog.last && paired.includes(catalog.last.hostId) ? catalog.last : null;
  return Object.keys(hosts).length === Object.keys(catalog.hosts).length && last === catalog.last ? catalog : { ...catalog, hosts, last };
}

export function rememberLast(catalog: ChatCatalog, hostId: string, profiles: string[]): ChatCatalog {
  return { ...catalog, last: { hostId, profiles: [...profiles] } };
}

export function readCatalog(raw: string | null): ChatCatalog {
  if (!raw) return emptyCatalog();
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !record(value.hosts)) return emptyCatalog();
    const hosts: ChatCatalog["hosts"] = {};
    for (const [hostId, host] of Object.entries(value.hosts)) {
      if (!record(host) || !Array.isArray(host.rooms)) continue;
      hosts[hostId] = { name: typeof host.name === "string" ? host.name : hostId, rooms: host.rooms.flatMap((item) => { const row = entry(hostId, item); return row ? [row] : []; }) };
    }
    const last = record(value.last) && typeof value.last.hostId === "string" && Array.isArray(value.last.profiles)
      ? { hostId: value.last.hostId, profiles: value.last.profiles.filter((id): id is string => typeof id === "string") } : null;
    return { version: 1, hosts, last };
  } catch { return emptyCatalog(); }
}

/** Every chat that lives on its machine, newest first. A chat that moved is listed by the machine it moved to. */
export function chatRows(catalog: ChatCatalog, archived: boolean): { rows: ChatEntry[]; archivedCount: number } {
  const chats = Object.values(catalog.hosts).flatMap((host) => host.rooms).filter((row) => row.kind === "chat" && !row.movedTo);
  return {
    rows: chats.filter((row) => archived || !row.archived).sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
    archivedCount: chats.filter((row) => row.archived).length,
  };
}

/** The Work threads made from chats on one machine, for its section under Projects. */
export function promotedWork(catalog: ChatCatalog, hostId: string): ChatEntry[] {
  return (catalog.hosts[hostId]?.rooms ?? []).filter((row) => row.kind === "work" && !row.archived).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findRoom(catalog: ChatCatalog, hostId: string, id: string): ChatEntry | null {
  return catalog.hosts[hostId]?.rooms.find((row) => row.id === id) ?? null;
}

/** "Jigga · Null", the first line under a chat's title. */
export function botNames(row: Pick<ChatEntry, "bots">): string {
  return row.bots.length ? row.bots.map((bot) => bot.name).join(" · ") : "No bots";
}

/** A machine's `chat_profiles` answer: its saved bots and whether each can join a chat. */
export function parseChatProfiles(raw: unknown): ChatProfile[] {
  if (!record(raw) || !Array.isArray(raw.profiles)) throw new Error("The machine sent a bot list this phone can't read.");
  return raw.profiles.flatMap((item) => {
    if (!record(item) || !record(item.profile) || typeof item.profile.id !== "string" || !item.profile.id) return [];
    return [{ profile: item.profile as unknown as ParticipantConfig, ok: item.chatOk === true, reason: typeof item.reason === "string" ? item.reason : null }];
  });
}

/** What New chat starts with: the last machine if it's still paired and can chat, else the first that can;
 *  the bots last picked there that can still join, else the first one that can. */
export function newChatStart(catalog: ChatCatalog, machines: readonly { id: string; chats: boolean }[], profiles: (hostId: string) => ChatProfile[] | undefined): { hostId: string; picked: string[] } | null {
  const able = machines.filter((machine) => machine.chats);
  const machine = able.find((item) => item.id === catalog.last?.hostId) ?? able[0];
  if (!machine) return null;
  const list = profiles(machine.id) ?? [];
  const ok = list.filter((item) => item.ok).map((item) => item.profile.id);
  const last = catalog.last?.hostId === machine.id ? catalog.last.profiles.filter((id) => ok.includes(id)) : [];
  return { hostId: machine.id, picked: last.length ? last : ok.slice(0, 1) };
}

/** A title from the first message, as Work threads get theirs. */
export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "New chat";
}

// ---- The old Local chat screen's history ------------------------------------------------------

/** Where the retired Local chat screen kept its sessions. */
export const LEGACY_HISTORY_KEY = "apex-deck.ios.thread-history.v1";
export const LEGACY_GATEWAY_KEY = "apex-deck.ios.gateway-config.v1";
export interface LegacyChat { id: string; title: string; bots: string[]; messages: { role: "user" | "assistant"; agent?: string; content: string }[] }

/** The old screen wrote "Preview reply from …" itself when no machine was set up. Those are not answers. */
const canned = (content: string) => content.startsWith("Preview reply from ");

/** The old sessions that hold at least one real reply. Preview-only sessions are worth nothing to keep. */
export function legacyChats(raw: string | null): LegacyChat[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!record(item) || typeof item.id !== "string" || !Array.isArray(item.messages)) return [];
      const messages = item.messages.flatMap((message) => record(message) && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim() && message.streaming !== true
        ? [{ role: message.role as "user" | "assistant", ...(typeof message.agent === "string" ? { agent: message.agent } : {}), content: message.content }] : []);
      if (!messages.some((message) => message.role === "assistant" && !canned(message.content))) return [];
      return [{ id: item.id, title: typeof item.title === "string" && item.title.trim() ? item.title : "Local chat", bots: Array.isArray(item.bots) ? item.bots.filter((bot): bot is string => typeof bot === "string") : [], messages }];
    });
  } catch { return []; }
}

/** The history `chat_import` copies in. Canned previews are dropped; nothing here starts a bot. */
export function legacyEntries(chat: LegacyChat): Message[] {
  return chat.messages.filter((message) => message.role === "user" || !canned(message.content)).map((message, seq) => message.role === "user"
    ? { seq, speaker: { kind: "human" }, text: message.content }
    : { seq, speaker: { kind: "bot", id: (message.agent ?? "bot").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "bot" }, text: message.content });
}
