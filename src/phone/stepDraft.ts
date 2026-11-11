import { mentionFor } from "../slug.ts";

type Bot = Parameters<typeof mentionFor>[0];

/** What the composer holds after a next-step suggestion is tapped. With
 *  several bots in the thread, the suggestion is tagged for the bot that
 *  offered it, so it still reaches that bot once sent. Typing already in the
 *  box is kept: the suggestion goes after it. */
export function stepDraft(current: string, prompt: string, by?: Bot): string {
  const body = prompt.trim();
  const tag = by ? `@${mentionFor(by)} ` : "";
  const said = current.replace(/\s+$/, "");
  if (!said) return `${tag}${body}`;
  // The bot is already tagged in what was typed: don't tag it twice.
  const lead = tag && said.includes(tag.trim()) ? "" : tag;
  return `${said} ${lead}${body}`;
}
