import { mentionFor } from "../slug.ts";

type Bot = Parameters<typeof mentionFor>[0];

/** The prompt without a leading tag for the bot that wrote it. Bots sometimes
 *  open their own suggestion with their own name; tags for other bots stay. */
function untagged(prompt: string, by?: Bot): string {
  let body = prompt.trim();
  if (!by) return body;
  const tag = `@${mentionFor(by)}`;
  // Only the whole name counts: "@novak" is not a tag for nova.
  while (body.startsWith(tag) && /^[\s,:]/.test(body.slice(tag.length))) body = body.slice(tag.length).replace(/^[\s,:]+/, "");
  return body;
}

/** What the composer holds after a next-step suggestion is tapped: the
 *  suggestion as written, with no bot tagged. Who receives it is the
 *  composer's choice, like any other message. Typing already in the box is
 *  kept: the suggestion goes after it. */
export function stepDraft(current: string, prompt: string, by?: Bot): string {
  const body = untagged(prompt, by);
  const said = current.replace(/\s+$/, "");
  return said ? `${said} ${body}` : body;
}
