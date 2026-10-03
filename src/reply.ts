export interface ReplyQuote {
  id: string;
  name: string;
  text: string;
}

/** Quote mentions are context, not instructions to summon another participant. */
export function replyText(text: string, quote: ReplyQuote | null): string {
  const body = text.trim();
  if (!quote) return body;
  const context = `${quote.name} wrote:\n${quote.text}`.replaceAll('@', '＠');
  return `@${quote.id} ${body}\n\n${context.split('\n').map((line) => `> ${line}`).join('\n')}`;
}
