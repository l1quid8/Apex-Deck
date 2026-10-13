// Interactive answers: a card's place in its thread and its words outside
// the card: its version, the snapshot "Discuss these settings" writes, and
// the summary exports print instead of the JSON.

import { parseBlocks, swapFences } from "../markdownText.ts";
import { CARD_LANGUAGE, cardKey, fingerprint, type AnswerEntry, type InputValues } from "./contract.ts";
import { evaluate, formatValue, inputText, resultLine, type Evaluation } from "./comparison.ts";
import { readCard, type ComparisonCard } from "./schema.ts";

/**
 * Each bot card's version, by cardKey. A card is version n when n - 1 bot
 * cards with the same id came before it in the thread. A block that doesn't
 * read as a card has no version and doesn't count.
 */
export function cardVersions(messages: { seq: number; speaker: { kind: string }; text: string }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const versions = new Map<string, number>();
  for (const message of messages) {
    if (message.speaker.kind !== "bot" || !message.text.includes(CARD_LANGUAGE)) continue;
    for (const block of parseBlocks(message.text)) {
      if (block.kind !== "code" || block.language !== CARD_LANGUAGE) continue;
      const read = readCard(block.text);
      if (!read.ok) continue;
      const n = (seen.get(read.card.cardId) ?? 0) + 1;
      seen.set(read.card.cardId, n);
      versions.set(cardKey(message.seq, read.card.cardId), n);
    }
  }
  return versions;
}

/** The result line, then which options are out and why. */
function outcome(card: ComparisonCard, ev: Evaluation): string {
  const out = ev.options.filter((o) => o.out.length > 0).map((o) => `${o.label} (${o.out.join(", ").toLowerCase()})`);
  return out.length ? `${resultLine(card, ev)} Out: ${out.join("; ")}.` : resultLine(card, ev);
}

/** What "Discuss these settings" writes: whose card, which version, each setting, and what they give. */
export function snapshotText(card: ComparisonCard, values: InputValues | null, version: number, author: string): string {
  const ev = evaluate(card, values);
  return [
    `Settings from ${author}'s card "${card.title}" (v${version}):`,
    ...card.inputs.map((input) => `- ${input.label}: ${inputText(input, ev.inputs[input.id])}`),
    outcome(card, ev),
  ].join("\n");
}

/** The message box after Discuss: the snapshot under anything already typed, then an empty line to write on. */
export function discussDraft(current: string, snapshot: string): string {
  return current.trim() ? `${current.trimEnd()}\n\n${snapshot}\n\n` : `${snapshot}\n\n`;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The card in Markdown at `values` (its defaults when null): for exports, and anywhere it can't be drawn. */
export function cardMarkdown(card: ComparisonCard, values: InputValues | null): string {
  const ev = evaluate(card, values);
  const table = [
    ["", ...card.options.map((o) => o.label)],
    ["---", ...card.options.map(() => "---")],
    ...card.rows.map((row) => [row.label, ...card.options.map((o) => formatValue(o.values[row.id], row.unit))]),
  ].map((cells) => `| ${cells.map(cell).join(" | ")} |`).join("\n");
  const settings = card.inputs.map((input) => `${input.label}: ${inputText(input, ev.inputs[input.id])}`).join(" · ");
  const notes = [...card.assumptions.map((a) => `- ${a}`), ...card.sources.map((s) => `- [${s.label}](${s.url})`)].join("\n");
  return [`**${card.title}**`, card.summary, settings, table, outcome(card, ev), notes].filter(Boolean).join("\n\n");
}

/** A bot reply with each card that reads swapped for its summary, at its saved settings when they were set on that card. */
export function withCardSummaries(text: string, seq: number, answers: Record<string, AnswerEntry> = {}): string {
  return swapFences(text, CARD_LANGUAGE, (source) => {
    const read = readCard(source);
    if (!read.ok) return null;
    const saved = answers[cardKey(seq, read.card.cardId)];
    return cardMarkdown(read.card, saved && saved.fingerprint === fingerprint(source) ? saved.inputs : null);
  });
}
