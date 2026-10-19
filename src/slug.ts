/** The @handle the room will match: lower-case letters, digits, dash, underscore, dot. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/\.+$/, "");
}

const HANDLE_CHAR = /[\p{L}\p{N}_.-]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A bot's id as a handle: its letters, digits, dashes, underscores and dots, lower-cased. */
function handleFor(id: string): string {
  return [...id].filter((c) => HANDLE_CHAR.test(c)).join("").toLowerCase();
}

/** Anything with a name and the id it is saved under: a bot, an agent, a person on the phone. */
export interface Mentionable {
  id: string;
  display_name: string;
}

/** Whether a name has a letter or number to be @mentioned by. */
export function mentionable(name: string): boolean {
  return LETTER_OR_DIGIT.test(slug(name));
}

/**
 * A bot's @mention, and the only one it answers to: its current name as
 * slug() writes it. The id never changes, so a renamed bot answers to its new
 * name and its old one reaches nobody. Only a name saved before names needed
 * a letter or number falls back to the id's handle. The daemon has the same
 * rule (apex_core::mention); shared/mention-names.json keeps the two together.
 */
export function mentionFor(bot: Mentionable): string {
  return mentionable(bot.display_name) ? slug(bot.display_name) : handleFor(bot.id);
}

/** A name that can't be used: another bot already answers to its mention, it means everyone, or it has no letter or number (the id, an old name, would stand in). */
export type MentionClash =
  | { kind: "taken"; mention: string; by: Mentionable }
  | { kind: "everyone"; mention: string }
  | { kind: "unmentionable" };

/** Why `bot` can't have its name among `others`, or null when it can. Another bot's old name is free to take. */
export function mentionClash(bot: Mentionable, others: readonly Mentionable[]): MentionClash | null {
  if (!mentionable(bot.display_name)) return { kind: "unmentionable" };
  const mention = mentionFor(bot);
  if (mention === "all" || mention === "everyone") return { kind: "everyone", mention };
  const by = others.find((other) => other.id !== bot.id && mentionFor(other) === mention);
  return by ? { kind: "taken", mention, by } : null;
}

/** The refusal for a clash, in a chat or in the Agents tab. The daemon words a chat's the same way. */
export function clashMessage(clash: MentionClash, place: "chat" | "agents"): string {
  if (clash.kind === "unmentionable") return "A name needs a letter or a number. Pick a different name.";
  if (clash.kind === "everyone") return `@${clash.mention} already means everyone in the chat. Pick a different name.`;
  const who = place === "chat" ? `${clash.by.display_name} in this chat` : `Your agent ${clash.by.display_name}`;
  return `${who} already answers to @${clash.mention}. Pick a different name.`;
}

/** `id`, or the first of `id-2`, `id-3`, … nobody has: a renamed bot keeps the id its old name gave it. */
export function freeId(id: string, taken: readonly string[]): string {
  if (!taken.includes(id)) return id;
  for (let n = 2; ; n++) if (!taken.includes(`${id}-${n}`)) return `${id}-${n}`;
}

/**
 * The id a bot is saved under, or why its name can't be used. An edited bot
 * keeps its id. A new one gets the id its name gives, or the next free one
 * when a renamed bot still holds that id. In a chat, an agent with another
 * name keeps its id too, so a new bot is never taken for that agent's copy.
 */
export function botIdentity(bot: Mentionable, options: { editing: string | null; others: readonly Mentionable[]; agents: readonly Mentionable[]; place: "chat" | "agents" }): { id: string } | { error: string } {
  const mention = mentionFor(bot);
  const held = [...options.others, ...options.agents.filter((agent) => mentionFor(agent) !== mention)].map((p) => p.id);
  const id = options.editing ?? freeId(bot.id, held);
  const clash = mentionClash({ ...bot, id }, options.others);
  return clash ? { error: clashMessage(clash, options.place) } : { id };
}
