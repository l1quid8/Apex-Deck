// Buttons on chat notices: Try again after a bot fails, and Let them answer
// after the room cuts off bots answering each other. Both run bots once on
// the transcript as it is (roomTurn) and post nothing. Plain functions so
// the rules can be tested without the interface.

import type { Message, ParticipantConfig } from "./types";
import { joinNames } from "./composerStatus.ts";
import { mentionTarget } from "./recipients.ts";

/** What a notice's button does. */
export type NoticeAction = { kind: "retry"; id: string } | { kind: "let"; ids: string[] } | { kind: "rejoin"; config: ParticipantConfig };

/** `failed` events from the app's own storage use this id; there is no bot to try again. */
const STORAGE = "storage";

/** Try again for a bot's failure, while that bot is in the room. Never for a storage error. */
export function retryFor(failedId: string, roster: string[]): NoticeAction | null {
  return failedId !== STORAGE && roster.includes(failedId) ? { kind: "retry", id: failedId } : null;
}

/** The bots an action would run that are still in the room. With none left, no button shows. */
export function stillHere(action: NoticeAction, roster: string[]): string[] {
  if (action.kind === "rejoin") return [];
  return (action.kind === "retry" ? [action.id] : action.ids).filter((id) => roster.includes(id));
}

/** The notice when the room cut off bots answering each other. `asker` and `next` are display names. */
export function hopNotice(limit: number, asker: string | null, next: string[]): string {
  const stopped = limit === 0
    ? "Stopped so you can choose."
    : `Stopped after ${limit} ${limit === 1 ? "round" : "rounds"} of models answering each other.`;
  if (next.length === 0) return stopped;
  const who = asker ? `${asker} asked ${joinNames(next)} next.` : `${joinNames(next)} ${next.length === 1 ? "is" : "are"} next.`;
  return `${stopped} ${who}`;
}

/** "Let Null answer", or "Let them answer" for several. */
export function letLabel(names: string[]): string {
  return names.length === 1 ? `Let ${names[0]} answer` : "Let them answer";
}

/** Who asked the cut-off bots: the latest bot reply since your last message that @mentions one of them, or everyone. */
export function askerOf(messages: Message[], next: string[], roster: string[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const speaker = messages[i].speaker;
    if (speaker.kind === "human") return null;
    const target = mentionTarget(messages[i].text, roster);
    if (target === "everyone" || target.some((id) => next.includes(id))) return speaker.id;
  }
  return null;
}

/** Notices whose button still shows: those after your latest message, not used yet. */
export function liveActions(entries: { key: number | null; human: boolean }[], used: ReadonlySet<number>): Set<number> {
  const live = new Set<number>();
  for (let i = entries.length - 1; i >= 0 && !entries[i].human; i--) {
    const key = entries[i].key;
    if (key !== null && !used.has(key)) live.add(key);
  }
  return live;
}
