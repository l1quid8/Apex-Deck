// Where each chat lives now, as the phone's saved delivery record says. That record (the outbox and
// move journal) is the one source of truth: the Chats list, the open chat and Send all follow it, so
// the screen can never name one machine while a message goes to another.

import type { ChatCatalog, ChatEntry, ChatProfile } from "../chatCatalog.ts";
import { chatDeliveryStatus, type CachedChat, type ChatDeliveryState, type ChatDeliveryStatus, type ChatOutboxMessage } from "../chatDelivery.ts";

/** The delivery id for a chat the phone hasn't kept yet. Machine and room together, so two machines
 *  that both have a room called `shared` never share one outbox. */
export const freshChatId = (hostId: string, room: string): string => JSON.stringify([hostId, room]);

const imported = (step: string) => step === "archive" || step === "complete";

export interface ChatRoute {
  /** The id the delivery controller keeps this chat under. */
  chatId: string;
  /** Where the chat lives now. Differs from the asked-for place only when `moved`. */
  hostId: string;
  room: string;
  /** True when the asked-for place is an old home: the chat was imported somewhere else since. */
  moved: boolean;
}

/** The chat a list row or open thread stands for, followed to wherever it lives now. */
export function chatRoute(state: ChatDeliveryState, hostId: string, room: string): ChatRoute {
  const here = Object.values(state.chats).find((chat) => chat.machine.id === hostId && chat.room === room);
  if (here) return { chatId: here.id, hostId, room, moved: false };
  const move = Object.values(state.moves).find((item) => item.from.id === hostId && item.sourceRoom === room && imported(item.step) && state.chats[item.chat]);
  if (move) {
    const chat = state.chats[move.chat];
    return { chatId: chat.id, hostId: chat.machine.id, room: chat.room, moved: true };
  }
  return { chatId: freshChatId(hostId, room), hostId, room, moved: false };
}

function rowFromCache(chat: CachedChat, updatedAt: number): ChatEntry {
  return {
    hostId: chat.machine.id, id: chat.room, kind: "chat", title: chat.title,
    bots: chat.snapshot.participants.map((bot) => ({ id: bot.id, name: bot.display_name || bot.id })),
    updatedAt, archived: false, cwd: null, folderName: null, promotedFrom: null, promotedTo: null, movedTo: null,
    profiles: { ...(chat.snapshot.importProfiles ?? {}) },
  };
}

/** The saved list with the delivery record laid over it: an old home of a moved chat drops out, and
 *  the new home shows even before its machine has listed it (or while that machine is off). Only on a
 *  machine still paired (`paired`), and never against that machine's own word: once it has sent a whole
 *  list asked for after the import, a chat it left out stays out (this phone may no longer see it). */
export function projectChats(catalog: ChatCatalog, state: ChatDeliveryState, paired: ReadonlySet<string>): ChatCatalog {
  const hosts: ChatCatalog["hosts"] = Object.fromEntries(Object.entries(catalog.hosts).map(([id, host]) => [id, { ...host, rooms: [...host.rooms] }]));
  let changed = false;
  for (const move of Object.values(state.moves)) {
    const chat = state.chats[move.chat];
    if (!imported(move.step) || !chat) continue;
    const from = hosts[move.from.id];
    const index = from?.rooms.findIndex((row) => row.id === move.sourceRoom) ?? -1;
    let age = 0;
    if (from && index >= 0) {
      age = from.rooms[index].updatedAt;
      if (!from.rooms[index].movedTo) { from.rooms[index] = { ...from.rooms[index], movedTo: { host: move.to.id, room: move.targetRoom } }; changed = true; }
    }
    // Only the chat's current home is added: an in-between machine on a longer trip stays as it listed.
    if (chat.machine.id !== move.to.id || chat.room !== move.targetRoom || !paired.has(move.to.id)) continue;
    const listed = hosts[move.to.id]?.listedAt;
    if (listed !== undefined && (move.importedAt === undefined || listed >= move.importedAt)) continue;
    const to = hosts[chat.machine.id] ??= { name: chat.machine.name, rooms: [] };
    if (!to.rooms.some((row) => row.id === chat.room)) { to.rooms.push(rowFromCache(chat, age)); changed = true; }
  }
  return changed ? { ...catalog, hosts } : catalog;
}

// ---- What a chat's outbox shows -----------------------------------------------------------------

export interface ChatOutboxRow { id: string; text: string; line: string; kind: ChatDeliveryStatus["kind"]; canRetry: boolean; canSendAnyway: boolean;
  /** Never left the phone, so it can go back in the box. */
  canTakeBack: boolean }

/** The outbox lines under a chat. A message already in the transcript hides its line, unless the line
 *  is how you recover it: Retry for a stopped one, Send here anyway for one stuck on another machine. */
export function chatOutboxRows(chat: CachedChat | undefined, view: {
  /** The open chat's place and whether its machine is connected now. */
  hostId: string; room: string; online: boolean;
  /** Client message ids already in the transcript on screen. */
  shown: ReadonlySet<string>;
  /** The message whose Send here anyway was tapped once and waits for a second tap. */
  confirming: string | null;
  /** Why the chat's machine can't take a send right now, when it's connected but can't. */
  sendWhy: string;
}): ChatOutboxRow[] {
  if (!chat) return [];
  return chat.outbox.flatMap((item: ChatOutboxMessage) => {
    const status = chatDeliveryStatus(item, chat.machine);
    const here = item.machine.id === view.hostId && item.room === view.room;
    if (status.kind === "delivered") return [];
    if (view.shown.has(item.id) && !status.canRetry && !status.canSendAnyway) return [];
    if (here && view.online && status.kind === "pending") return [];
    const line = view.confirming === item.id ? "Both machines may answer this. Tap Send here anyway again to send it."
      : here && view.online && status.kind === "queued" && view.sendWhy ? view.sendWhy
      : here && view.online && status.kind === "uncertain" ? "Sending…" : status.line;
    return [{ id: item.id, text: item.text, line, kind: status.kind, canRetry: status.canRetry, canSendAnyway: status.canSendAnyway, canTakeBack: item.state === "unsent" }];
  });
}

// ---- What this phone may do with chats on a machine -------------------------------------------

export interface ChatRights {
  /** May ask the machine for its chat list. Any paired level may; the machine filters it. */
  list: boolean;
  /** May post, rename, archive and change bots in a chat it can see. */
  post: boolean;
  /** May start a chat there or move one in. */
  create: boolean;
  /** Why `create` is false, or "". */
  why: string;
  /** Why `post` is false, or "". */
  postWhy: string;
  /** May keep a message on the phone while the machine is away: false once the phone knows it would be refused. */
  queue: boolean;
  /** Why `queue` is false, or "". */
  queueWhy: string;
}

/** Both chat capabilities are needed to send: without `chat_delivery_v1` a machine would ignore the
 *  message id that stops a resent message being answered twice. */
export function chatRights(machine: {
  name: string; online: boolean; rooms: boolean; delivery: boolean;
  access: { tier: "read_only" | "chat" | "full"; threads: unknown } | null | undefined;
}): ChatRights {
  const update = `Update Deck on ${machine.name} to chat here.`;
  const unknown = !machine.rooms && !machine.online;
  const capable = machine.rooms && machine.delivery;
  const readOnly = machine.access?.tier === "read_only";
  const scoped = !!machine.access && machine.access.threads !== "all";
  const postWhy = unknown ? `Waiting for ${machine.name} to connect.` : !capable ? update : readOnly ? `This phone can only read on ${machine.name}.` : "";
  const why = postWhy || (scoped ? `This phone only sees some threads on ${machine.name}.` : "");
  // Before the first welcome the phone can't know the machine's version, but it may already know its own access.
  const queueWhy = readOnly ? `This phone can only read on ${machine.name}.` : !unknown && !capable ? update : "";
  return { list: machine.rooms, post: !postWhy, create: !why, why, postWhy, queue: !queueWhy, queueWhy };
}

/** Whether this phone may post to one room: not read-only, and the room is among the threads it may
 *  use. Unknown access (before the first welcome) doesn't block; the machine checks again anyway. */
export function mayPostIn(access: { tier: "read_only" | "chat" | "full"; threads: unknown } | null | undefined, room: string): boolean {
  if (!access) return true;
  if (access.tier === "read_only") return false;
  return access.threads === "all" || (Array.isArray(access.threads) && access.threads.includes(room));
}

// ---- New chat's bots ---------------------------------------------------------------------------

/** The bots New chat starts with once a machine's list is in: the group last picked there that can
 *  still join, else the first that can. */
export function startingBots(list: readonly ChatProfile[], saved: readonly string[]): string[] {
  const ok = list.filter((item) => item.ok).map((item) => item.profile.id);
  const kept = saved.filter((id) => ok.includes(id));
  return kept.length ? kept : ok.slice(0, 1);
}

// ---- Which thread is open -----------------------------------------------------------------------

/** The key a thread's live state (working bots, queued rows, approvals) is kept under on the phone:
 *  the machine and the room, since two machines can each have a room with the same id. */
export const machineThreadKey = (hostId: string, id: string): string => JSON.stringify([hostId, id]);

/** The key a thread's on-phone state (draft, quotes, TL;DR, working bots) is kept under. A thread belongs to
 *  its machine, and two machines can each have a room with the same id, so every thread's key names both: a
 *  chat its own machine, a Work thread the machine its project or its chat list put it on. */
export const threadKey = (pane: { id: string; hostId?: string }, hostId: string): string => machineThreadKey(pane.hostId || hostId || "local", pane.id);

/** The open thread. With a machine named (a chat or a Work thread opened from Chats), only that machine's
 *  room is it, so a same-id thread in the Mac's session never stands in for it; without one, the session's. */
export function pickOpenPane<S extends { id: string }, C extends { id: string; hostId?: string }>(
  session: readonly S[], chats: readonly C[], openId: string | null, openHost: string | null, hostOf: (pane: S) => string,
): S | C | null {
  if (openId === null) return null;
  if (openHost === null) return session.find((pane) => pane.id === openId) ?? chats.find((pane) => pane.id === openId) ?? null;
  return chats.find((pane) => pane.id === openId && pane.hostId === openHost) ?? session.find((pane) => pane.id === openId && hostOf(pane) === openHost) ?? null;
}
