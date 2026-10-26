import type { Message, ParticipantConfig, RoomOptions, RoomSnapshot } from '../types.ts';

export interface ChatMachine { id: string; name: string }
export type ChatAcceptedState = 'running' | 'done' | 'interrupted' | 'fenced';
export interface ChatReceipt { state: ChatAcceptedState; replySeqs: number[]; clientMessageId?: string }
export interface ChatOrigin { machine: string; room: string; seq: number }
export type ChatHistoryEntry = Message & {
  origin?: ChatOrigin;
  originSeq?: number;
  clientMessageId?: string;
  replyToClientMessageId?: string;
};
export type ChatDeliverySnapshot = RoomSnapshot & {
  kind?: 'chat' | 'work';
  clientMessages?: Record<string, ChatReceipt & { humanSeq?: number }>;
};
export interface ChatOutboxMessage {
  id: string;
  text: string;
  targets: string[];
  machine: ChatMachine;
  room: string;
  state: 'unsent' | 'uncertain' | 'delivered';
  accepted?: ChatAcceptedState;
  /** Set only after this phone receives and saves the source's atomic claim answer. */
  fenceClaimed?: boolean;
  replySeqs: number[];
  createdAt: number;
  blockedReason?: string;
  retryOf?: string;
  duplicateRiskAcknowledged?: boolean;
}
export interface CachedChat {
  id: string;
  title: string;
  machine: ChatMachine;
  room: string;
  snapshot: ChatDeliverySnapshot;
  outbox: ChatOutboxMessage[];
}
export interface ChatMergeRecord {
  id: string;
  machine: string;
  room: string;
  entries: ChatHistoryEntry[];
  confirmed: boolean;
}
export interface ChatMoveRecord {
  id: string;
  chat: string;
  from: ChatMachine;
  sourceRoom: string;
  to: ChatMachine;
  targetRoom: string;
  step: 'export' | 'import' | 'archive' | 'complete';
  pending: 'wait' | 'stop' | 'leave';
  snapshot: ChatDeliverySnapshot;
  skipped: { participant: string; reason: string }[];
  mergedOrigins: string[];
  merges: ChatMergeRecord[];
}
export interface ChatDeliveryState {
  version: 1;
  chats: Record<string, CachedChat>;
  moves: Record<string, ChatMoveRecord>;
}
export interface ChatDeliveryStorage {
  load(): ChatDeliveryState;
  save(state: ChatDeliveryState): void;
}
export interface ChatDeliveryRpc {
  exportRoom(machine: string, room: string): Promise<ChatDeliverySnapshot>;
  post(machine: string, room: string, message: { clientMessageId: string; text: string; targets: string[] }): Promise<ChatReceipt>;
  claim(machine: string, room: string, clientMessageId: string): Promise<ChatReceipt>;
  importRoom(machine: string, payload: { id: string; moveId: string; title: string; participants: ParticipantConfig[]; options?: RoomOptions; entries: ChatHistoryEntry[] }): Promise<{ id?: string; room: ChatDeliverySnapshot; skipped: { participant: string; reason: string }[] }>;
  mergeHistory(machine: string, room: string, entries: ChatHistoryEntry[]): Promise<{ added: number }>;
  archive(machine: string, room: string, movedTo: { host: string; room: string }): Promise<void>;
  stop(machine: string, room: string): Promise<void>;
}

const copy = <T,>(value: T): T => structuredClone(value);
const emptyState = (): ChatDeliveryState => ({ version: 1, chats: {}, moves: {} });
const states: readonly string[] = ['running', 'done', 'interrupted', 'fenced'];
const originKey = (entry: ChatHistoryEntry): string => JSON.stringify(entry.origin);
const routeMatches = (message: ChatOutboxMessage, machine: string, room: string) => message.machine.id === machine && message.room === room;

export class ChatStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ChatStorageError'; }
}
export class ChatPendingAnswersError extends Error {
  readonly machine: ChatMachine;
  readonly moveId: string;
  constructor(machine: ChatMachine, moveId: string) {
    super(`Answers are still running on ${machine.name}. Wait for answers or stop and move.`);
    this.name = 'ChatPendingAnswersError'; this.machine = machine; this.moveId = moveId;
  }
}

export interface ChatDeliveryStatus {
  kind: 'queued' | 'blocked' | 'uncertain' | 'pending' | 'interrupted' | 'fenced' | 'delivered';
  line: string;
  canRetry: boolean;
  canSendAnyway: boolean;
}
/** Shared by the folderless chat UI; ownership always names the actual source machine. */
export function chatDeliveryStatus(message: ChatOutboxMessage, currentMachine?: ChatMachine): ChatDeliveryStatus {
  const base = { canRetry: false, canSendAnyway: false };
  const name = message.machine.name;
  if (message.blockedReason) return { ...base, kind: 'blocked', line: message.blockedReason };
  if (message.state === 'unsent') return { ...base, kind: 'queued', line: `Waiting for ${name}` };
  if (message.accepted === 'interrupted') return { ...base, kind: 'interrupted', line: `Answer stopped on ${name}`, canRetry: true };
  if (message.accepted === 'fenced') return { ...base, kind: 'fenced', line: `Not sent on ${name}`, canRetry: true };
  const moved = currentMachine !== undefined && currentMachine.id !== message.machine.id;
  if (message.accepted === 'running') return { ...base, kind: 'pending', line: `Answer pending on ${name}`, canSendAnyway: moved };
  if (message.state === 'uncertain') return { ...base, kind: 'uncertain', line: `May have reached ${name}`, canSendAnyway: moved };
  return { ...base, kind: 'delivered', line: `Delivered to ${name}` };
}

/** One localStorage replacement is the transaction boundary for cache, outbox and move journal. */
export class JsonChatDeliveryStorage implements ChatDeliveryStorage {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private readonly key: string;
  private readonly maxBytes: number;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, options: { key?: string; maxBytes?: number } = {}) {
    this.storage = storage; this.key = options.key ?? 'apex.phone.chat-delivery.v1'; this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }
  load(): ChatDeliveryState {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return emptyState();
      const parsed: unknown = JSON.parse(raw);
      assertState(parsed);
      return copy(parsed);
    } catch (error) { throw new ChatStorageError('Saved chats could not be read. Sending is paused to protect messages.', { cause: error }); }
  }
  save(state: ChatDeliveryState): void {
    try {
      assertState(state);
      const serialized = JSON.stringify(state);
      if (new TextEncoder().encode(serialized).byteLength > this.maxBytes) throw new Error('Chat storage quota exceeded');
      this.storage.setItem(this.key, serialized);
      if (this.storage.getItem(this.key) !== serialized) throw new Error('Chat storage write could not be verified');
    } catch (error) {
      throw new ChatStorageError(`Chats could not be saved: ${error instanceof Error ? error.message : String(error)}. Sending is paused.`, { cause: error });
    }
  }
}
function assertState(value: unknown): asserts value is ChatDeliveryState {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved chat state');
  const data = value as ChatDeliveryState;
  if (data.version !== 1 || !data.chats || typeof data.chats !== 'object' || !data.moves || typeof data.moves !== 'object') throw new Error('Unsupported saved chat state');
  for (const chat of Object.values(data.chats)) {
    if (!chat || !chat.id || !chat.machine?.id || !chat.machine?.name || !chat.room || !Array.isArray(chat.outbox)) throw new Error('Invalid saved chat');
    assertChatSnapshot(chat.snapshot);
    for (const item of chat.outbox) {
      if (!item.id || !item.machine?.id || !item.room || typeof item.text !== 'string' || !Array.isArray(item.targets) || !Array.isArray(item.replySeqs)
        || !['unsent', 'uncertain', 'delivered'].includes(item.state) || (item.accepted !== undefined && !states.includes(item.accepted))
        || (item.fenceClaimed !== undefined && typeof item.fenceClaimed !== 'boolean')
        || item.targets.some(target => typeof target !== 'string') || item.replySeqs.some(seq => !Number.isSafeInteger(seq))) throw new Error('Invalid saved outbox');
    }
  }
  for (const move of Object.values(data.moves)) {
    if (!move?.id || !data.chats[move.chat] || !move.from?.id || !move.to?.id || !move.sourceRoom || !move.targetRoom
      || !['export', 'import', 'archive', 'complete'].includes(move.step) || !['wait', 'stop', 'leave'].includes(move.pending)
      || !Array.isArray(move.merges) || !Array.isArray(move.mergedOrigins) || !Array.isArray(move.skipped)) throw new Error('Invalid saved move');
    assertChatSnapshot(move.snapshot);
    for (const merge of move.merges) {
      if (!merge?.id || !merge.machine || !merge.room || typeof merge.confirmed !== 'boolean' || !Array.isArray(merge.entries)) throw new Error('Invalid saved history merge');
      for (const entry of merge.entries) assertHistoryEntry(entry, true);
    }
  }
}
function assertChatSnapshot(snapshot: ChatDeliverySnapshot): void {
  if (!snapshot || snapshot.kind !== 'chat' || !Array.isArray(snapshot.transcript) || !Array.isArray(snapshot.participants) || !snapshot.options) throw new Error('Only chat rooms can use phone chat delivery');
  for (const entry of snapshot.transcript) assertHistoryEntry(entry);
  for (const [id, known] of Object.entries(snapshot.clientMessages ?? {})) receipt(known, id);
}
function assertHistoryEntry(entry: ChatHistoryEntry, requireOrigin = false): void {
  if (!entry || typeof entry.text !== 'string' || !Number.isSafeInteger(entry.seq) || !entry.speaker
    || (entry.speaker.kind !== 'human' && entry.speaker.kind !== 'bot')
    || (entry.speaker.kind === 'bot' && typeof entry.speaker.id !== 'string')) throw new Error('Invalid saved transcript message');
  if (requireOrigin || entry.origin) {
    const origin = entry.origin;
    if (!origin || typeof origin.machine !== 'string' || !origin.machine || typeof origin.room !== 'string' || !origin.room || !Number.isSafeInteger(origin.seq)) throw new Error('Invalid saved message origin');
  }
}
function receipt(value: ChatReceipt, id: string): ChatReceipt {
  if (!value || !states.includes(value.state) || !Array.isArray(value.replySeqs) || value.replySeqs.some(seq => !Number.isSafeInteger(seq))
    || (value.clientMessageId !== undefined && value.clientMessageId !== id)) throw new Error('The machine did not confirm this message ID');
  return { state: value.state, replySeqs: [...value.replySeqs] };
}
function mergeReceipt(previous: ChatReceipt | undefined, incoming: ChatReceipt): ChatReceipt {
  const state = previous && previous.state !== 'running' ? previous.state : incoming.state;
  return { state, replySeqs: [...new Set([...(previous?.replySeqs ?? []), ...incoming.replySeqs])].sort((a, b) => a - b) };
}
function withOrigins(snapshot: ChatDeliverySnapshot, machine: string, room: string): ChatDeliverySnapshot {
  assertChatSnapshot(snapshot);
  const result = copy(snapshot);
  result.transcript = result.transcript.map((message: ChatHistoryEntry) => ({ ...message, origin: message.origin ?? { machine, room, seq: message.originSeq ?? message.seq } }));
  return result;
}
function appendHistory(chat: CachedChat, entries: readonly ChatHistoryEntry[]): void {
  const seen = new Set(chat.snapshot.transcript.map(originKey));
  let seq = Math.max(0, ...chat.snapshot.transcript.map(entry => entry.seq));
  for (const entry of entries) {
    if (seen.has(originKey(entry))) continue;
    chat.snapshot.transcript.push({ ...copy(entry), seq: ++seq });
    seen.add(originKey(entry));
  }
}

/** No Mac, session, React or connection globals: the folderless phone route supplies storage and RPC. */
export class ChatDeliveryController {
  private state: ChatDeliveryState;
  private readonly storage: ChatDeliveryStorage;
  private readonly rpc: ChatDeliveryRpc;
  private readonly id: () => string;
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private readonly canSend: (chat: CachedChat, message: ChatOutboxMessage) => boolean;
  private readonly sending = new Set<string>();
  private readonly moving = new Map<string, Promise<void>>();
  private recovering?: Promise<void>;
  private readonly readVersions = new Map<string, number>();
  constructor(options: { storage: ChatDeliveryStorage; rpc: ChatDeliveryRpc; id?: () => string; now?: () => number; onChange?: () => void; canSend?: (chat: CachedChat, message: ChatOutboxMessage) => boolean }) {
    this.storage = options.storage; this.rpc = options.rpc; this.id = options.id ?? (() => crypto.randomUUID()); this.now = options.now ?? Date.now; this.onChange = options.onChange;
    this.canSend = options.canSend ?? (() => true);
    this.state = this.storage.load(); assertState(this.state);
  }
  snapshot(): ChatDeliveryState { return copy(this.state); }
  private advanceRead(machine: string, room: string): number {
    const key = JSON.stringify([machine, room]), version = (this.readVersions.get(key) ?? 0) + 1;
    this.readVersions.set(key, version); return version;
  }
  private async readRoom(machine: string, room: string): Promise<ChatDeliverySnapshot | undefined> {
    const version = this.advanceRead(machine, room), snapshot = await this.rpc.exportRoom(machine, room);
    return this.readVersions.get(JSON.stringify([machine, room])) === version ? snapshot : undefined;
  }
  private update(change: (next: ChatDeliveryState) => void): void {
    const next = copy(this.state); change(next); this.storage.save(next); this.state = next; this.onChange?.();
  }
  private chat(id: string): CachedChat {
    const chat = this.state.chats[id]; if (!chat) throw new Error('Chat is not cached on this phone'); return chat;
  }
  private outbox(chat: string, id: string): ChatOutboxMessage {
    const item = this.chat(chat).outbox.find(message => message.id === id); if (!item) throw new Error('Message is not in this chat outbox'); return item;
  }
  cacheChat(input: { id: string; title: string; machine: ChatMachine; room: string; snapshot: ChatDeliverySnapshot }): void {
    const normalized = withOrigins(input.snapshot, input.machine.id, input.room);
    this.advanceRead(input.machine.id, input.room);
    this.update(next => {
      const existing = next.chats[input.id];
      if (existing) {
        existing.title = input.title;
        if (existing.machine.id === input.machine.id && existing.room === input.room) {
          this.syncCurrentSnapshot(existing, normalized);
        }
      } else next.chats[input.id] = { ...copy(input), snapshot: normalized, outbox: [] };
    });
  }
  enqueue(chatId: string, text: string, targets: string[] = []): string {
    if (!text.trim()) throw new Error('Message is empty');
    const chat = this.chat(chatId), id = this.id();
    this.update(next => {
      if (next.chats[chatId].outbox.some(message => message.id === id)) throw new Error('Message ID was reused');
      next.chats[chatId].outbox.push({ id, text, targets: [...targets], machine: copy(chat.machine), room: chat.room, state: 'unsent', replySeqs: [], createdAt: this.now() });
    });
    return id;
  }
  async send(chatId: string, id: string): Promise<void> {
    const item = this.outbox(chatId, id), chat = this.chat(chatId);
    const sendingKey = JSON.stringify([item.machine.id, item.room, id]);
    if (item.state !== 'unsent' || item.blockedReason || !routeMatches(item, chat.machine.id, chat.room) || this.sending.has(sendingKey) || !this.canSend(copy(chat), copy(item))) return;
    // Starting a move permanently closes the old route to automatic queued sends.
    if (Object.values(this.state.moves).some(move => move.chat === chatId && move.from.id === item.machine.id && move.sourceRoom === item.room)) return;
    const machine = item.machine.id, room = item.room;
    this.update(next => { next.chats[chatId].outbox.find(message => message.id === id)!.state = 'uncertain'; });
    this.sending.add(sendingKey);
    try {
      const result = receipt(await this.rpc.post(machine, room, { clientMessageId: id, text: item.text, targets: [...item.targets] }), id);
      this.applyReceipt(chatId, id, machine, room, result);
    } finally { this.sending.delete(sendingKey); }
  }
  async flush(chatId: string): Promise<void> {
    for (const item of [...this.chat(chatId).outbox]) if (item.state === 'unsent') await this.send(chatId, item.id);
  }
  private applyReceipt(chatId: string, id: string, machine: string, room: string, result: ChatReceipt, claimed = false): void {
    if (!routeMatches(this.outbox(chatId, id), machine, room)) return; // A late A acknowledgement cannot undo a fence and successful B send.
    this.update(next => {
      const chat = next.chats[chatId], item = chat.outbox.find(message => message.id === id)!;
      const merged = mergeReceipt(item.accepted ? { state: item.accepted, replySeqs: item.replySeqs } : undefined, result);
      item.state = 'delivered'; item.accepted = merged.state; item.replySeqs = merged.replySeqs;
      if (claimed && result.state === 'fenced') item.fenceClaimed = true;
      if (chat.machine.id === machine && chat.room === room) {
        chat.snapshot.clientMessages ??= {};
        chat.snapshot.clientMessages[id] = merged;
      }
    });
  }
  private acceptSnapshot(chat: CachedChat, machine: string, room: string, snapshot: ChatDeliverySnapshot): void {
    if (chat.machine.id === machine && chat.room === room) {
      chat.snapshot.clientMessages ??= {};
      for (const [id, known] of Object.entries(snapshot.clientMessages ?? {})) chat.snapshot.clientMessages[id] = mergeReceipt(chat.snapshot.clientMessages[id], receipt(known, id));
    }
    for (const item of chat.outbox) {
      const known = snapshot.clientMessages?.[item.id];
      if (routeMatches(item, machine, room) && known) {
        const result = mergeReceipt(item.accepted ? { state: item.accepted, replySeqs: item.replySeqs } : undefined, receipt(known, item.id));
        item.state = 'delivered'; item.accepted = result.state; item.replySeqs = result.replySeqs;
      }
    }
  }
  private syncCurrentSnapshot(chat: CachedChat, snapshot: ChatDeliverySnapshot): void {
    const previousLedger = chat.snapshot.clientMessages;
    chat.snapshot = copy(snapshot); chat.snapshot.clientMessages = copy(previousLedger ?? {});
    this.acceptSnapshot(chat, chat.machine.id, chat.room, snapshot);
  }
  async move(chatId: string, to: ChatMachine, options: { pending?: 'wait' | 'stop' | 'leave'; targetRoom?: string } = {}): Promise<string> {
    const chat = this.chat(chatId);
    let journal = Object.values(this.state.moves).find(move => move.chat === chatId && move.to.id === to.id && move.step !== 'complete');
    if (journal) {
      const moveId = journal.id;
      this.update(next => { if (options.pending) next.moves[moveId].pending = options.pending; });
    } else {
      if (chat.machine.id === to.id) throw new Error(`This chat already runs on ${to.name}`);
      if (Object.values(this.state.moves).some(move => move.chat === chatId && move.step === 'export' || move.chat === chatId && move.step === 'import')) throw new Error('Finish the current machine move first');
      const moveId = this.id();
      this.update(next => {
        next.moves[moveId] = { id: moveId, chat: chatId, from: copy(chat.machine), sourceRoom: chat.room, to: copy(to), targetRoom: options.targetRoom ?? moveId, step: 'export', pending: options.pending ?? 'wait', snapshot: copy(chat.snapshot), skipped: [], mergedOrigins: [], merges: [] };
      });
      journal = this.state.moves[moveId];
    }
    await this.runMove(journal.id);
    await this.flush(chatId);
    return journal.id;
  }
  private async runMove(id: string): Promise<void> {
    const existing = this.moving.get(id); if (existing) return existing;
    const operation = this.performMove(id);
    this.moving.set(id, operation);
    try { await operation; } finally { this.moving.delete(id); }
  }
  private async performMove(id: string): Promise<void> {
    let move = this.state.moves[id];
    if (move.step === 'export') {
      let exported: ChatDeliverySnapshot | undefined;
      try { exported = await this.readRoom(move.from.id, move.sourceRoom); } catch { /* Offline: use the phone's saved copy and retain source ownership. */ }
      if (exported) {
        await this.recordSource(id, exported);
        await this.claimSourceMessages(id);
        move = this.state.moves[id];
        const running = Object.values(move.snapshot.clientMessages ?? {}).some(item => item.state === 'running')
          || this.chat(move.chat).outbox.some(item => routeMatches(item, move.from.id, move.sourceRoom) && item.accepted === 'running');
        if (running && move.pending === 'wait') throw new ChatPendingAnswersError(move.from, id);
        if (running && move.pending === 'stop') {
          await this.rpc.stop(move.from.id, move.sourceRoom);
          const stopped = await this.readRoom(move.from.id, move.sourceRoom);
          if (stopped) await this.recordSource(id, stopped);
        }
      }
      this.update(next => { next.moves[id].step = 'import'; });
    }
    move = this.state.moves[id];
    if (move.step === 'import') {
      const result = await this.rpc.importRoom(move.to.id, { id: move.targetRoom, moveId: move.id, title: this.chat(move.chat).title, participants: copy(move.snapshot.participants), options: copy(move.snapshot.options), entries: copy(move.snapshot.transcript) });
      const targetRoom = result.id ?? move.targetRoom;
      const imported = withOrigins(result.room, move.to.id, targetRoom);
      this.update(next => {
        const record = next.moves[id], chat = next.chats[record.chat];
        record.targetRoom = targetRoom; record.skipped = copy(result.skipped); record.step = 'archive'; record.mergedOrigins = record.snapshot.transcript.map(originKey);
        chat.machine = copy(record.to); chat.room = record.targetRoom; chat.snapshot = imported;
        const skipped = new Set(result.skipped.map(item => item.participant));
        for (const item of chat.outbox) {
          if (!routeMatches(item, record.from.id, record.sourceRoom) || (item.state !== 'unsent' && !(item.accepted === 'fenced' && item.fenceClaimed))) continue;
          const hadTargets = item.targets.length > 0;
          item.targets = item.targets.filter(target => !skipped.has(target));
          if (hadTargets && !item.targets.length) item.blockedReason = 'The bots this message is for are not set up on this machine.';
          item.machine = copy(record.to); item.room = record.targetRoom; item.state = 'unsent'; delete item.accepted; delete item.fenceClaimed; item.replySeqs = [];
        }
      });
    }
    move = this.state.moves[id];
    if (move.step === 'archive') {
      let archived = false;
      try { await this.rpc.archive(move.from.id, move.sourceRoom, { host: move.to.id, room: move.targetRoom }); archived = true; } catch { /* Durable journal retries this when A returns. */ }
      if (archived) this.update(next => { next.moves[id].step = 'complete'; });
    }
    await this.reconcileMove(id);
  }
  private async claimSourceMessages(id: string): Promise<void> {
    const move = this.state.moves[id];
    for (const item of [...this.chat(move.chat).outbox]) {
      if (!routeMatches(item, move.from.id, move.sourceRoom) || item.state === 'unsent' || item.accepted === 'done' || item.accepted === 'interrupted' || (item.accepted === 'fenced' && item.fenceClaimed)) continue;
      let claimed: ChatReceipt;
      try { claimed = await this.rpc.claim(move.from.id, move.sourceRoom, item.id); } catch { continue; }
      this.applyReceipt(move.chat, item.id, move.from.id, move.sourceRoom, receipt(claimed, item.id), true);
    }
  }
  private async recordSource(id: string, snapshot: ChatDeliverySnapshot): Promise<void> {
    const move = this.state.moves[id], normalized = withOrigins(snapshot, move.from.id, move.sourceRoom);
    this.update(next => {
      const record = next.moves[id], chat = next.chats[record.chat];
      record.snapshot = normalized;
      if (chat.machine.id === record.from.id && chat.room === record.sourceRoom) this.syncCurrentSnapshot(chat, normalized);
      else { this.acceptSnapshot(chat, record.from.id, record.sourceRoom, normalized); appendHistory(chat, normalized.transcript); }
    });
  }
  private async reconcileMove(id: string): Promise<void> {
    const move = this.state.moves[id];
    if (move.step === 'export' || move.step === 'import') return;
    let exported: ChatDeliverySnapshot | undefined;
    try { exported = await this.readRoom(move.from.id, move.sourceRoom); } catch { /* Still reconcile any merge already saved before the disconnect. */ }
    if (exported) {
      await this.recordSource(id, exported);
      await this.claimSourceMessages(id);
      // A fresh fence after an offline import safely releases only that ID onto B.
      this.update(next => {
        const chat = next.chats[move.chat];
        for (const item of chat.outbox) if (routeMatches(item, move.from.id, move.sourceRoom) && item.accepted === 'fenced' && item.fenceClaimed) {
          item.machine = copy(chat.machine); item.room = chat.room; item.state = 'unsent'; delete item.accepted; delete item.fenceClaimed; item.replySeqs = [];
          const hadTargets = item.targets.length > 0;
          const available = new Set(chat.snapshot.participants.map(participant => participant.id));
          item.targets = item.targets.filter(target => available.has(target));
          if (hadTargets && !item.targets.length) item.blockedReason = 'The bots this message is for are not set up on this machine.';
        }
      });
    }
    // Route saved late history straight to the current room. An offline intermediate host must not block it.
    const current = this.chat(move.chat);
    const known = new Set<string>();
    for (const record of Object.values(this.state.moves)) {
      if (record.chat !== move.chat) continue;
      if (record.to.id === current.machine.id && record.targetRoom === current.room && (record.step === 'archive' || record.step === 'complete')) {
        for (const origin of record.mergedOrigins) known.add(origin);
      }
      for (const merge of record.merges) if (merge.machine === current.machine.id && merge.room === current.room) {
        for (const entry of merge.entries) known.add(originKey(entry));
      }
    }
    const entries = this.state.moves[id].snapshot.transcript.filter(entry => !known.has(originKey(entry)));
    if (entries.length) this.update(next => { next.moves[id].merges.push({ id: this.id(), machine: current.machine.id, room: current.room, entries: copy(entries), confirmed: false }); });
    for (const merge of [...this.state.moves[id].merges]) {
      if (merge.confirmed) continue;
      try { await this.rpc.mergeHistory(merge.machine, merge.room, copy(merge.entries)); } catch { continue; }
      this.update(next => {
        next.moves[id].merges.find(item => item.id === merge.id)!.confirmed = true;
        if (merge.machine === move.to.id && merge.room === move.targetRoom) next.moves[id].mergedOrigins.push(...merge.entries.map(originKey));
      });
    }
  }
  async observe(chatId: string, machine: string, room: string, snapshot: ChatDeliverySnapshot): Promise<void> {
    const normalized = withOrigins(snapshot, machine, room);
    this.advanceRead(machine, room);
    this.update(next => {
      const chat = next.chats[chatId]; if (!chat) throw new Error('Chat is not cached on this phone');
      this.acceptSnapshot(chat, machine, room, normalized);
      if (chat.machine.id === machine && chat.room === room) {
        this.syncCurrentSnapshot(chat, normalized);
      }
    });
    for (const move of Object.values(this.state.moves)) if (move.chat === chatId && move.from.id === machine && move.sourceRoom === room) {
      await this.recordSource(move.id, normalized);
      await this.reconcileMove(move.id);
    }
  }
  async resume(): Promise<void> {
    if (this.recovering) return this.recovering;
    const recovery = this.performResume(); this.recovering = recovery;
    try { await recovery; } finally { this.recovering = undefined; }
  }
  private async performResume(): Promise<void> {
    let failure: unknown;
    for (const move of Object.values(this.state.moves)) {
      try { await this.runMove(move.id); } catch (error) { if (!(error instanceof ChatPendingAnswersError)) failure ??= error; }
    }
    for (const chat of Object.values(this.state.chats)) {
      let exported: ChatDeliverySnapshot | undefined;
      try { exported = await this.readRoom(chat.machine.id, chat.room); } catch { /* The saved transcript remains available offline. */ }
      if (exported) {
        const normalized = withOrigins(exported, chat.machine.id, chat.room);
        this.update(next => {
          const current = next.chats[chat.id];
          if (current.machine.id !== chat.machine.id || current.room !== chat.room) return;
          this.syncCurrentSnapshot(current, normalized);
        });
      }
      for (const item of [...this.chat(chat.id).outbox]) {
        if (!routeMatches(item, chat.machine.id, chat.room) || item.state === 'unsent' || (item.accepted && item.accepted !== 'running')) continue;
        let result: ChatReceipt;
        try { result = await this.rpc.claim(item.machine.id, item.room, item.id); } catch { continue; }
        this.applyReceipt(chat.id, item.id, item.machine.id, item.room, receipt(result, item.id), true);
      }
      try { await this.flush(chat.id); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  async reconnect(_machine: string): Promise<void> { await this.resume(); }
  async retry(chatId: string, messageId: string): Promise<string> {
    const original = this.outbox(chatId, messageId);
    if (original.accepted !== 'interrupted' && original.accepted !== 'fenced') throw new Error('Only a stopped or fenced message can be retried');
    const id = this.enqueue(chatId, original.text, original.targets);
    this.update(next => { next.chats[chatId].outbox.find(item => item.id === id)!.retryOf = messageId; });
    await this.send(chatId, id); return id;
  }
  async sendAnyway(chatId: string, messageId: string, acknowledgement: { acknowledgeDuplicateRisk: boolean }): Promise<string> {
    if (acknowledgement.acknowledgeDuplicateRisk !== true) throw new Error('Acknowledge the risk of a duplicate answer before sending anyway');
    const original = this.outbox(chatId, messageId);
    if (original.state !== 'uncertain' && original.accepted !== 'running') throw new Error('This message does not have an uncertain answer');
    const id = this.enqueue(chatId, original.text, original.targets);
    this.update(next => { const item = next.chats[chatId].outbox.find(item => item.id === id)!; item.retryOf = messageId; item.duplicateRiskAcknowledged = true; });
    await this.send(chatId, id); return id;
  }
}
