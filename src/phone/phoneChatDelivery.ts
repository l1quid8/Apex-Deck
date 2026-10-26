import type { Backend } from "../backend.ts";
import type { HostConnectionStore } from "../hostConnections.ts";
import type { RoomSnapshot } from "../types.ts";
import { ChatDeliveryController, JsonChatDeliveryStorage, type CachedChat, type ChatOutboxMessage, type ChatDeliveryRpc } from "./chatDelivery.ts";
import { watchChatDelivery, type ChatDeliveryWatchHost } from "./chatDeliveryWatch.ts";

export interface ChatDeliveryHost {
  machine: { id: string; name: string };
  backend: Pick<Backend, "call" | "supports">;
  connection: Pick<HostConnectionStore, "get">;
}

/** Keep one instance for the phone session. Task3 caches a chat on open, then
 * enqueues before clearing the composer; its busy-bot queue calls send.
 * Mount watch(hosts) with the current paired connections and stop on cleanup. */
export function createPhoneChatDelivery(options: {
  storage: Pick<Storage, "getItem" | "setItem">;
  findHost(id: string): ChatDeliveryHost | undefined;
  onChange?(): void;
  onError(error: unknown): void;
  canSend?(chat: CachedChat, message: ChatOutboxMessage): boolean;
}) {
  const controller = new ChatDeliveryController({
    storage: new JsonChatDeliveryStorage(options.storage),
    rpc: createChatDeliveryRpc(options.findHost),
    onChange: options.onChange,
    canSend: (chat, message) => options.findHost(message.machine.id)?.connection.get().status.kind === "connected"
      && (options.canSend?.(chat, message) ?? true),
  });
  return { controller, watch: (hosts: readonly ChatDeliveryWatchHost[]) => watchChatDelivery(controller, hosts, options.onError) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receipt(value: unknown): { state: "running" | "done" | "fenced" | "interrupted"; replySeqs: number[] } {
  if (!record(value) || !["running", "done", "fenced", "interrupted"].includes(String(value.state))
    || !Array.isArray(value.replySeqs) || !value.replySeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)) {
    throw new Error("The machine returned an invalid delivery receipt. This message may have reached it.");
  }
  return { state: value.state as "running" | "done" | "fenced" | "interrupted", replySeqs: value.replySeqs };
}

function chatSnapshot(value: unknown): RoomSnapshot {
  if (!record(value) || value.kind !== "chat" || !Array.isArray(value.transcript) || !Array.isArray(value.participants)) {
    throw new Error("This operation requires a talk-only chat.");
  }
  const integer = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const origin = (item: unknown) => record(item) && typeof item.machine === "string" && item.machine.length > 0
    && typeof item.room === "string" && item.room.length > 0 && integer(item.seq);
  const validMessages = value.transcript.every(item => record(item) && integer(item.seq) && typeof item.text === "string"
    && record(item.speaker) && (item.speaker.kind === "human" || (item.speaker.kind === "bot" && typeof item.speaker.id === "string"))
    && (item.at === undefined || integer(item.at)) && (item.originSeq === undefined || integer(item.originSeq)) && (item.origin === undefined || origin(item.origin))
    && (item.clientMessageId === undefined || typeof item.clientMessageId === "string")
    && (item.replyToClientMessageId === undefined || typeof item.replyToClientMessageId === "string"));
  const options = value.options;
  if (!validMessages || !record(options) || !["everyone", "mention", "round_robin"].includes(String(options.policy))
    || !(options.max_bot_hops === null || integer(options.max_bot_hops))) {
    throw new Error("The machine returned an invalid chat snapshot. The saved transcript is kept.");
  }
  if (value.clientMessages !== undefined) {
    if (!record(value.clientMessages)) throw new Error("The machine returned an invalid chat snapshot ledger.");
    for (const entry of Object.values(value.clientMessages)) {
      try { receipt(entry); }
      catch { throw new Error("The machine returned an invalid chat snapshot ledger."); }
    }
  }
  return value as unknown as RoomSnapshot;
}

/** Uses the chosen machine directly, without the Mac session or gateway HTTP keys. */
export function createChatDeliveryRpc(findHost: (id: string) => ChatDeliveryHost | undefined): ChatDeliveryRpc {
  const backend = (machine: string) => {
    const host = findHost(machine);
    if (!host) throw new Error("Pair this machine again to recover its pending messages.");
    if (!host.backend.supports?.("chat_rooms") || !host.backend.supports("chat_delivery_v1")) {
      throw new Error(`Update Deck on ${host.machine.name} to send and move chats safely.`);
    }
    return host.backend;
  };
  return {
    async exportRoom(machine, room) {
      const state = await backend(machine).call<{ snapshot: unknown }>("room_state", { id: room });
      return chatSnapshot(state?.snapshot);
    },
    async post(machine, room, message) {
      const { targets, ...body } = message;
      const value = await backend(machine).call<unknown>(targets.length ? "room_post_to" : "room_post",
        { id: room, ...body, ...(targets.length ? { targets } : {}) });
      const result = receipt(value);
      if (!record(value) || value.clientMessageId !== message.clientMessageId) {
        throw new Error("The machine returned the wrong delivery receipt. This message may have reached it.");
      }
      return { ...result, clientMessageId: message.clientMessageId };
    },
    async claim(machine, room, clientMessageId) {
      return receipt(await backend(machine).call("chat_message_claim", { id: room, clientMessageId }));
    },
    async importRoom(machine, input) {
      const value = await backend(machine).call<unknown>("chat_import", input);
      if (!record(value) || typeof value.id !== "string" || !value.id.trim() || !Array.isArray(value.skipped)
        || !value.skipped.every(item => record(item) && typeof item.participant === "string" && typeof item.reason === "string")) {
        throw new Error("The destination did not confirm the imported chat. The move is saved for recovery.");
      }
      return { id: value.id, room: chatSnapshot(value.room), skipped: value.skipped as { participant: string; reason: string }[] };
    },
    async mergeHistory(machine, room, entries) {
      const value = await backend(machine).call<unknown>("chat_merge_history", { id: room, entries });
      if (!record(value) || !Number.isSafeInteger(value.added) || (value.added as number) < 0) {
        throw new Error("The destination did not confirm the history merge. It will be retried.");
      }
      return { added: value.added as number };
    },
    async archive(machine, room, movedTo) {
      await backend(machine).call("chat_update_meta", { id: room, archived: true, movedTo });
    },
    async stop(machine, room) {
      await backend(machine).call("room_stop", { id: room, participant: null });
    },
  };
}
