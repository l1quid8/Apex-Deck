// Who gets the message in the composer, and why, for the line above the
// message box. The room decides (roomTargets); this explains its answer in
// the room's own terms. Mentions follow crates/apex-core/src/mention.rs.

import type { TurnPolicy } from "./types";
import { joinNames } from "./composerStatus.ts";

const HANDLE_CHAR = /[\p{L}\p{N}_.-]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The @handle the room matches for a participant id: its letters, digits, dashes, underscores and dots, lower-cased. */
export function handleFor(id: string): string {
  return [...id].filter((c) => HANDLE_CHAR.test(c)).join("").toLowerCase();
}

/**
 * Who `text` @mentions, by the room's rules: "everyone" for @all or
 * @everyone, otherwise the ids mentioned, first mention first. An @ right
 * after a letter or digit (an email address) is not a mention, and trailing
 * dots are sentence punctuation.
 */
export function mentionTarget(text: string, ids: string[]): "everyone" | string[] {
  const found: string[] = [];
  let everyone = false;
  for (const match of text.matchAll(/@([\p{L}\p{N}_.-]*)/gu)) {
    const at = match.index ?? 0;
    if (at > 0 && LETTER_OR_DIGIT.test(text[at - 1])) continue;
    const word = match[1].toLowerCase().replace(/\.+$/, "");
    if (word === "all" || word === "everyone") everyone = true;
    else {
      const id = ids.find((candidate) => handleFor(candidate) === word);
      if (id && !found.includes(id)) found.push(id);
    }
  }
  return everyone ? "everyone" : found;
}

/** Whether `text` @mentions anyone in the room, or everyone. */
export function hasMention(text: string, ids: string[]): boolean {
  const target = mentionTarget(text, ids);
  return target === "everyone" || target.length > 0;
}

export interface RecipientInput {
  /** Who roomTargets said gets the message, in the order they answer. */
  targets: string[];
  /** Everyone in the room, in roster order. */
  roster: { id: string; name: string }[];
  policy: TurnPolicy;
  /** The message @mentions someone, or everyone. */
  mentioned: boolean;
  /** You have written in this thread before, so the room may have someone you addressed last. */
  addressedBefore: boolean;
  /** Bots at work now. A message to one of them waits in the queue. */
  busy: string[];
}

/** The line above the message box: "To Null · last addressed", plus " · queued (busy)" when a recipient is at work. */
export interface RecipientLine {
  /** "Null", "Null and Ada", "everyone", "Jigga, then Null". */
  to: string;
  /** you mentioned, last addressed, first in the room, everyone at once, or everyone in turn. */
  reason: string;
  queued: boolean;
}

export function recipientLine(input: RecipientInput): RecipientLine | null {
  const { targets, roster, policy, mentioned, addressedBefore, busy } = input;
  if (roster.length === 0 || targets.length === 0) return null;
  const name = (id: string) => roster.find((p) => p.id === id)?.name ?? id;
  const everyone = roster.length > 1 && roster.every((p) => targets.includes(p.id));
  // Everyone in turn answers one at a time, each seeing the reply before it.
  const to = policy === "round_robin" && targets.length > 1
    ? targets.map(name).join(", then ")
    : everyone ? "everyone" : joinNames(targets.map(name));
  const reason = mentioned ? "you mentioned"
    : policy === "everyone" ? "everyone at once"
    : policy === "round_robin" ? "everyone in turn"
    : addressedBefore ? "last addressed" : "first in the room";
  return { to, reason, queued: targets.some((id) => busy.includes(id)) };
}

/** Starter rows for an empty room, built from a real handle. Clicking one puts `text` in the composer; it is never sent for you. */
export function exampleRows(ids: string[]): { label: string; text: string }[] {
  if (ids.length === 0) return [];
  return ["@all what would you change first?", `@${handleFor(ids[0])} review the last commit`, "/pin Use pnpm, not npm"]
    .map((text) => ({ label: `e.g. ${text}`, text }));
}

/** Below this pane height the recipient line is hidden, to leave room for the conversation. */
export const MIN_LINE_HEIGHT = 260;

export function showsRecipientLine(paneHeight: number): boolean {
  return paneHeight >= MIN_LINE_HEIGHT;
}
