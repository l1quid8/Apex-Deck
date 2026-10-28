// Move to a Work thread: the saved request a phone or the desktop sends as `chat_promote`.
// It is kept before it is sent and until the machine confirms, so a lost reply is finished with
// the same thread and the same access, or started over on purpose, never resent with other choices.

import type { Access } from "./types.ts";

/** One move to a Work thread, saved on this device before it is sent. A retry sends exactly this
 *  again, so a lost reply can't be followed by a request that asks for different access. */
export interface PromoteTicket { target: string; requestId: string; cwd: string; access: Record<string, Access> }
export const PROMOTES_KEY = "apex-deck.phone.chat-promotes.v2";
export const DESKTOP_PROMOTES_KEY = "apex-deck.desktop.chat-promotes.v1";
export const promoteKey = (hostId: string, room: string) => JSON.stringify([hostId, room]);

const ACCESS: readonly string[] = ["read", "ask", "edits", "full"];
function ticket(value: unknown): PromoteTicket | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.target !== "string" || !raw.target || typeof raw.requestId !== "string" || !raw.requestId || typeof raw.cwd !== "string" || !raw.cwd) return null;
  if (!raw.access || typeof raw.access !== "object" || Object.values(raw.access).some((level) => !ACCESS.includes(String(level)))) return null;
  return { target: raw.target, requestId: raw.requestId, cwd: raw.cwd, access: { ...(raw.access as Record<string, Access>) } };
}

export function readPromoteTickets(storage: Pick<Storage, "getItem">, key = PROMOTES_KEY): Record<string, PromoteTicket> {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => { const saved = ticket(item); return saved ? [[key, saved]] : []; }));
  } catch { return {}; }
}

/** Saves and reads back. Throws when the device couldn't keep it, so the caller sends nothing. */
export function writePromoteTickets(storage: Pick<Storage, "getItem" | "setItem">, tickets: Record<string, PromoteTicket>, key = PROMOTES_KEY, device = "This phone"): void {
  const text = JSON.stringify(tickets);
  const lost = `${device} couldn't save the move, so nothing was sent. Free some space and try again.`;
  try { storage.setItem(key, text); } catch { throw new Error(lost); }
  if (storage.getItem(key) !== text) throw new Error(lost);
}

const sameAccess = (a: Record<string, Access>, b: Record<string, Access>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** The tickets with one move's taken out, but only if it is still that request: a reply to an older move
 *  must not drop the one that replaced it. */
export function withoutTicket(tickets: Record<string, PromoteTicket>, key: string, requestId: string): Record<string, PromoteTicket> | null {
  if (tickets[key]?.requestId !== requestId) return null;
  const { [key]: _gone, ...rest } = tickets;
  return rest;
}

/** A machine's answer to `chat_promote_abandon`: the move was fenced off for good, or it had already happened. */
export function parseAbandon(raw: unknown): { state: "abandoned" } | { state: "done"; work: unknown; chat: unknown } {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (value.state === "abandoned") return { state: "abandoned" };
  if (value.state === "done" && value.work) return { state: "done", work: value.work, chat: value.chat };
  throw new Error("The machine didn't say whether the move was stopped. It is kept until it can be checked.");
}

/** The request to send for a move. An unconfirmed earlier move must be finished as it was asked, or
 *  started over on purpose; it is never quietly resent with other choices. */
export function promoteRequest(saved: PromoteTicket | undefined, cwd: string, access: Record<string, Access>, fresh: () => { target: string; requestId: string }): { ticket: PromoteTicket; fresh: boolean } {
  if (saved) {
    if (saved.cwd !== cwd || !sameAccess(saved.access, access)) throw new Error("A move to a Work thread was started and not confirmed. Finish it as it was, or start over.");
    return { ticket: saved, fresh: false };
  }
  return { ticket: { ...fresh(), cwd, access: { ...access } }, fresh: true };
}
