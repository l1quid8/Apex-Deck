// Quoting a message in the composer, and handing the quote to a bot.

import type { Message } from "./types";
import { hasMention } from "./recipients.ts";

export interface ReplyQuote {
  /** The quoted bot's id, or "" for one of your own messages. */
  id: string;
  name: string;
  text: string;
  /** Who the quote is handed to, chosen in Send to ▾: a bot id or "all". Unset follows the quoted bot. */
  to?: string;
}

/**
 * The handle a quoted reply leads with: your choice in Send to ▾; else the
 * quoted bot, unless your own text already @mentions someone or the quote
 * is one of your messages. Null leads with nobody, and the room's policy or
 * your mention decides.
 */
export function quoteLead(body: string, quote: ReplyQuote, ids: string[]): string | null {
  if (quote.to) return quote.to;
  if (!quote.id || hasMention(body, ids)) return null;
  return quote.id;
}

/** Quote mentions are context, not instructions to summon another participant. */
export function replyText(text: string, quote: ReplyQuote | null, ids: string[] = []): string {
  const body = text.trim();
  if (!quote) return body;
  const context = `${quote.name} wrote:\n${quote.text}`.replaceAll('@', '＠');
  const lead = quoteLead(body, quote, ids);
  return `${lead ? `@${lead} ` : ""}${body}\n\n${context.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

/** The quote for a message: a bot's reply under its name, or one of yours ("I wrote:" to the models). */
export function quoteFor(message: Message, nameOf: (id: string) => string): ReplyQuote {
  return message.speaker.kind === "bot"
    ? { id: message.speaker.id, name: nameOf(message.speaker.id), text: message.text }
    : { id: "", name: "I", text: message.text };
}

/** The choices in Send to ▾: every bot but the current lead, then Everyone. */
export function handOffChoices(lead: string | null, bots: { id: string; name: string }[]): { to: string; label: string }[] {
  return [
    ...bots.filter((bot) => bot.id !== lead).map((bot) => ({ to: bot.id, label: bot.name })),
    ...(lead === "all" ? [] : [{ to: "all", label: "Everyone" }]),
  ];
}

/** "Send to Null", "Send to everyone", or "Send to…" when the room's policy or your mention decides. */
export function handOffLabel(lead: string | null, nameOf: (id: string) => string): string {
  return lead === "all" ? "Send to everyone" : lead ? `Send to ${nameOf(lead)}` : "Send to…";
}

/** Below this pane width, Quote, Copy and Fork fold into one ⋯ menu. */
export const MIN_ACTIONS_WIDTH = 360;

export function foldsMessageActions(paneWidth: number): boolean {
  return paneWidth < MIN_ACTIONS_WIDTH;
}
