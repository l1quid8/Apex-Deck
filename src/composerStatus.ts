import type { ThreadStatus } from "./types";

/** "Opus", "Opus and Codex", "Opus, Codex and Gemini". */
export function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The verb after the names in the status line. */
export function replyingVerb(count: number): string {
  return count === 1 ? "is replying" : "are replying";
}

/** What the composer says Enter will do, so the placeholder and hint never disagree. */
export function composerCopy(busy: boolean, empty: boolean): { placeholder: string; hint: string } {
  if (empty) return { placeholder: "Add a model to start", hint: "↵ send · ⇧↵ new line" };
  if (busy) return { placeholder: "Add to the next turn, or ⌘↵ to steer now…", hint: "↵ queue · ⌘↵ steer now · ⇧↵ new line" };
  return { placeholder: "Message the room. @name picks who answers.", hint: "↵ send · ⇧↵ new line" };
}

/**
 * What a thread tells App: the pane head's words, and who is replying or
 * stopped on a card. `working` holds every bot with a turn running, `asking`
 * every bot with an open approval card. Names follow the room's order.
 */
export function threadStatusOf(bots: { id: string; display_name: string }[], working: string[], asking: string[]): ThreadStatus {
  const count = bots.length === 0 ? "No bots yet" : bots.length === 1 ? "1 bot" : `${bots.length} bots`;
  return {
    text: `${count}${working.length > 0 ? " · replying" : ""}`,
    replying: bots.filter((bot) => working.includes(bot.id) && !asking.includes(bot.id)).map((bot) => bot.display_name),
    waiting: bots.filter((bot) => asking.includes(bot.id)).map((bot) => bot.display_name),
  };
}
