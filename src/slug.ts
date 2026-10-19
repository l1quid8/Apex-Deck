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

/** What a bot's id answers to: its letters, digits, dashes, underscores and dots, lower-cased. Old messages and older phone builds still use it. */
export function handleFor(id: string): string {
  return [...id].filter((c) => HANDLE_CHAR.test(c)).join("").toLowerCase();
}

/** Anything with a name and the id it is saved under: a bot, an agent, a person on the phone. */
export interface Mentionable {
  id: string;
  display_name: string;
}

/**
 * A bot's @mention: its current name as slug() writes it, or its id's handle
 * when the name has no letter or digit. The id never changes, so a renamed
 * bot answers to its new name. The daemon has the same rule
 * (apex_core::mention); shared/mention-names.json keeps the two together.
 */
export function mentionFor(bot: Mentionable): string {
  const fromName = slug(bot.display_name);
  return LETTER_OR_DIGIT.test(fromName) ? fromName : handleFor(bot.id);
}

/** A name that can't be used: the bot already answering to its mention, or null for @all and @everyone. */
export interface MentionClash {
  mention: string;
  by: Mentionable | null;
}

/** Why `bot` can't have its name among `others`, or null when it can. Another bot's old id is no clash: a name beats an id. */
export function mentionClash(bot: Mentionable, others: readonly Mentionable[]): MentionClash | null {
  const mention = mentionFor(bot);
  if (mention === "all" || mention === "everyone") return { mention, by: null };
  const by = others.find((other) => other.id !== bot.id && mentionFor(other) === mention);
  return by ? { mention, by } : null;
}

/** The refusal for a clash, in a chat or in the Agents tab. The daemon words a chat's the same way. */
export function clashMessage(clash: MentionClash, place: "chat" | "agents"): string {
  if (!clash.by) return `@${clash.mention} already means everyone in the chat. Pick a different name.`;
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
