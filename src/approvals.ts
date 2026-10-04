// Open approval cards, kept once for the whole app.
//
// A bot set to ask first stops on a card until the person answers it. The
// thread draws the card, but the attention list, the pane's flag and the
// dock need to know about it too, wherever the person is looking. Every
// chat's events feed this store (see hub.ts) before the thread sees them.
//
// Every card ends with `approval_resolved`, including on Stop and when its
// turn is dropped. As a backstop, a bot's turn ending, the thread going
// idle, or the thread's pane going away also takes its cards down, so a
// lost event can never leave a flag stuck on.

import type { Signal } from "./attention";
import type { ProposedAction, RoomEvent } from "./types";

/** One card waiting for an answer. */
export interface OpenCard {
  /** The thread it is in: the chat pane's id, which is also its room id. */
  room: string;
  /** The bot that asked. */
  participant: string;
  /** What `roomDecide` answers. Unique within its thread only. */
  request: string;
  action: ProposedAction;
  /** When it arrived, in milliseconds since the epoch. */
  at: number;
}

/** Every open card by thread, oldest first. */
export type ApprovalState = Readonly<Record<string, readonly OpenCard[]>>;

const NONE: readonly OpenCard[] = [];

function withRoom(state: ApprovalState, room: string, cards: readonly OpenCard[]): ApprovalState {
  const { [room]: _old, ...rest } = state;
  return cards.length > 0 ? { ...rest, [room]: cards } : rest;
}

/** The cards after one room event. Events that neither open nor close a card change nothing. */
export function applyApprovalEvent(state: ApprovalState, room: string, event: RoomEvent, now: number): ApprovalState {
  const cards = state[room] ?? NONE;
  switch (event.type) {
    case "approval_requested":
      if (cards.some((card) => card.request === event.request)) return state;
      return withRoom(state, room, [...cards, { room, participant: event.id, request: event.request, action: event.action, at: now }]);
    case "approval_resolved": {
      const left = cards.filter((card) => card.request !== event.request);
      return left.length === cards.length ? state : withRoom(state, room, left);
    }
    case "participant_idle": {
      const left = cards.filter((card) => card.participant !== event.id);
      return left.length === cards.length ? state : withRoom(state, room, left);
    }
    case "idle":
      return cards.length === 0 ? state : withRoom(state, room, NONE);
    default:
      return state;
  }
}

let state: ApprovalState = {};
const listeners = new Set<() => void>();

function publish(next: ApprovalState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Feed one room event to the store. hub.ts calls this for every event. */
export function recordApproval(room: string, event: RoomEvent): void {
  publish(applyApprovalEvent(state, room, event, Date.now()));
}

/** Take down a thread's cards, as when its pane goes away. */
export function forgetRoom(room: string): void {
  if (state[room]) publish(withRoom(state, room, NONE));
}

/** For useSyncExternalStore: called whenever a card opens or closes anywhere. */
export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For useSyncExternalStore: every open card, the same object until one changes. */
export function approvalSnapshot(): ApprovalState {
  return state;
}

/** A thread's open cards, oldest first. */
export function openCards(room: string, from: ApprovalState = state): readonly OpenCard[] {
  return from[room] ?? NONE;
}

/** A thread's cards by the bot that asked, each oldest first. */
export function cardsByBot(cards: readonly OpenCard[]): Record<string, OpenCard[]> {
  const by: Record<string, OpenCard[]> = {};
  for (const card of cards) (by[card.participant] ??= []).push(card);
  return by;
}

/** The kind label a card and the attention list show. */
export function cardLabel(kind: ProposedAction["kind"]): string {
  return kind === "edit" ? "Wants to change a file" : kind === "command" ? "Wants to run a command" : kind === "tool" ? "Wants to call an MCP tool" : "Wants permission";
}

/** A card in a few words: a command as "Run" and its first line (at most 60 characters), anything else by its title. */
export function cardTitle(action: ProposedAction): string {
  if (action.kind !== "command") return action.title;
  const line = action.detail.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return action.title;
  return `Run ${line.length > 60 ? `${line.slice(0, 59)}…` : line}`;
}

/** Whether a card still waits: one past its deadline is being denied by Codex's hook. */
function waiting(card: OpenCard, now: number): boolean {
  return card.action.expires_at == null || card.action.expires_at > now;
}

/**
 * The flag a thread shows while cards are open, from its oldest card:
 * "Null wants approval: Run npm test · +1 more". It is blocking, so looking
 * at the thread doesn't clear it, and its time is the oldest card's
 * arrival, so a new card never resets "ago". No cards, no flag.
 */
export function approvalSignal(cards: readonly OpenCard[], names: ReadonlyMap<string, string>, now: number): Signal | null {
  const live = cards.filter((card) => waiting(card, now));
  const oldest = live[0];
  if (!oldest) return null;
  const more = live.length - 1;
  const who = names.get(oldest.participant) ?? oldest.participant;
  return { kind: "needs_input", note: `${who} wants approval: ${cardTitle(oldest.action)}${more >= 1 ? ` · +${more} more` : ""}`, at: oldest.at, blocking: true };
}

/** "Denied automatically in 6m": the time left on a card Codex's hook will deny, in whole minutes rounded up. Null for a card that waits as long as you take. */
export function deadlineNote(expiresAt: number | null | undefined, now: number): string | null {
  if (expiresAt == null) return null;
  return `Denied automatically in ${Math.max(1, Math.ceil((expiresAt - now) / 60_000))}m`;
}

/** How long a card waits, with the window in the background, before the dock asks harder. */
export const ESCALATE_AFTER_MS = 2 * 60_000;

/** A card's identity for escalation: its thread, its request and when it arrived. */
export function escalationKey(card: OpenCard): string {
  return `${card.room}\u001f${card.request}\u001f${card.at}`;
}

/**
 * The cards to escalate now, from each blocked thread's cards. A thread's
 * oldest waiting card escalates once, when it has been open for 2 minutes
 * and the window doesn't have focus; `escalated` holds the keys of cards
 * already escalated, which never escalate again.
 */
export function dueEscalations(threads: readonly (readonly OpenCard[])[], escalated: ReadonlySet<string>, focused: boolean, now: number): OpenCard[] {
  if (focused) return [];
  return threads
    .map((cards) => cards.find((card) => waiting(card, now)))
    .filter((card): card is OpenCard => card !== undefined && now - card.at >= ESCALATE_AFTER_MS && !escalated.has(escalationKey(card)));
}
