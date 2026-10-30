/** What /curate says in the chat, and where its notes sit. */
import type { CurateReply, Curation, CurationUndo } from "./types";

type Notice = { text: string; tone: "info" | "error" };
type Range = [number, number];

/** The host's step for a curator turn (curation::CURATE_WORKING). */
export const CURATE_WORKING = "Choosing what to hide";
export const isCurating = (steps: readonly string[]) => steps.includes(CURATE_WORKING);

const countOf = (curation: Curation) => curation.hidden.reduce((sum, [a, b]) => sum + b - a + 1, 0);
const rangeOf = ([a, b]: Range) => a === b ? `#${a}` : `#${a}–#${b}`;
/** The line bots see in place of a range (curation::hidden_line). */
const hiddenLine = ([a, b]: Range) => a === b ? `[#${a} hidden, 1 message]` : `[#${a}–#${b} hidden, ${b - a + 1} messages]`;
const originals = (count: number) => count === 1 ? "The original remains in your chat and available for lookup." : "Originals remain in your chat and available for lookup.";

/** A summary replaces everything before it, so undo can't reach this curation. */
export function isSealed(curation: Curation, compactedUpto: number): boolean {
  return curation.at <= compactedUpto;
}

/** Notes sit where the chat was when they were made: before the first later
 *  message, by seq because entries also hold notices, and above any summary
 *  that covers them. Applying a new list replaces the old notes. */
export function withCurationNotes<E extends { kind: string }>(entries: E[], curations: Curation[]): E[] {
  const list = entries.filter((entry) => entry.kind !== "curation");
  for (const curation of curations) {
    const later = list.findIndex((entry) => {
      const { message, summary } = entry as unknown as { message?: { seq: number }; summary?: { upto: number } };
      return (message?.seq ?? summary?.upto ?? -1) >= curation.at;
    });
    list.splice(later < 0 ? list.length : later, 0, { kind: "curation", curation } as unknown as E);
  }
  return list;
}

export function noteTitle(curation: Curation, name: string): string {
  const count = countOf(curation);
  return curation.undone != null
    ? `${count} ${count === 1 ? "message was" : "messages were"} hidden here · undone`
    : `${count} older ${count === 1 ? "message" : "messages"} hidden from bots · chosen by ${name}`;
}

export function noteLines(curation: Curation, name: string, sealed: boolean, time: (ms: number) => string): string[] {
  const count = countOf(curation);
  const ranges = curation.hidden.map(rangeOf).join(", ");
  if (curation.undone != null) {
    const them = count === 1 ? "it" : "them";
    return [`${name} hid ${count === 1 ? "message" : "messages"} ${ranges} at ${time(curation.when)}. You brought ${them} back at ${time(curation.undone)}, so bots see ${them} again.`];
  }
  const reason = curation.reason.trim();
  const picked = `${count === 1 ? "Message" : "Messages"} ${ranges}${reason ? ` · ${name}’s reason: ${reason}` : "."}`;
  if (sealed) return [
    picked,
    `${count === 1 ? "This message was" : "These messages were"} hidden before the latest /compact. ${originals(count)}`,
    "Undo can’t restore messages to active context from before the latest /compact.",
  ];
  const first = hiddenLine(curation.hidden[0]);
  return [
    picked,
    `Bots now see ${curation.hidden.length === 1 ? `one short line there, ${first},` : `a short line for each range, like ${first},`} and can look up any of it.`,
    "Your pins and the newest 20 messages are never hidden.",
  ];
}

export function undoNotice({ restored, sealed }: CurationUndo): Notice {
  const blocked = `${sealed === 1 ? "it’s" : "they’re"} before the latest /compact. ${originals(sealed)}`;
  if (restored > 0) {
    const back = `${restored} ${restored === 1 ? "message is" : "messages are"} back for the bots.`;
    return { text: sealed > 0 ? `${back} The ${sealed} older ${sealed === 1 ? "message" : "messages"} can’t be restored to active context: ${blocked}` : back, tone: "info" };
  }
  if (sealed > 0) return { text: `Can’t restore ${sealed === 1 ? "this message" : `these ${sealed} messages`} to active context: ${blocked}`, tone: "error" };
  return { text: "Nothing is hidden in this chat.", tone: "error" };
}

export function failedNotice(command: string, error: unknown): string {
  return `Couldn’t finish ${command}: ${error instanceof Error ? error.message : String(error)}`;
}

/** `reply.by` is the bot's display name here. Null when the note says it all. */
export function curateNotice(reply: CurateReply): Notice | null {
  if (reply.status === "stopped") return { text: "Nothing was hidden.", tone: "info" };
  const left = reply.unchecked ?? 0;
  const more = left > 0 ? `Run /curate again to check the next ${left === 1 ? "message" : `${left} messages`}.` : "";
  const text = reply.status === "nothing" ? `${reply.by} found nothing worth hiding. ${more}`.trimEnd() : more;
  return text ? { text, tone: "info" } : null;
}
