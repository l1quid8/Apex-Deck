import { botIdentity, type Mentionable, mentionFor } from "./slug.ts";
import type { ParticipantConfig } from "./types";

export const MAX_NEW_BOTS = 4;

/** The batch submit button's text for `total` bots. */
export function batchLabel(total: number): string {
  if (total === 0) return "Pick a bot";
  if (total === 1) return "Add 1 bot";
  return `Add ${total} bots`;
}

export function checkBatch(
  items: ParticipantConfig[],
  options: { others: readonly Mentionable[]; agents: readonly Mentionable[] }
): { ok: ParticipantConfig[] } | { index: number; error: string } {
  const accepted: ParticipantConfig[] = [];
  for (let i = 0; i < items.length; i++) {
    const result = botIdentity(
      items[i],
      {
        editing: null,
        others: [...options.others, ...accepted],
        agents: options.agents,
        place: "chat"
      }
    );
    if ("error" in result) {
      // Check if the clash is with a bot already in `accepted`
      const secondResult = botIdentity(
        items[i],
        {
          editing: null,
          others: options.others,
          agents: options.agents,
          place: "chat"
        }
      );
      if (!("error" in secondResult)) {
        return { index: i, error: `Another bot in this batch already answers to @${mentionFor(items[i])}. Pick a different name.` };
      }
      return { index: i, error: result.error };
    }
    accepted.push({ ...items[i], id: result.id });
  }
  return { ok: accepted };
}

export async function addInOrder(
  items: ParticipantConfig[],
  add: (config: ParticipantConfig) => Promise<void>
): Promise<{ added: ParticipantConfig[]; failed: { index: number; error: string } | null }> {
  const added: ParticipantConfig[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      await add(items[i]);
      added.push(items[i]);
    } catch (e: unknown) {
      return { added, failed: { index: i, error: String(e) } };
    }
  }
  return { added, failed: null };
}

/** How many of the `added` bots were saved agents and how many were new rows. Saved agents always go first. */
export function splitAdded(added: number, savedCount: number): { saved: number; rows: number } {
  const saved = Math.min(added, savedCount);
  return { saved, rows: added - saved };
}

/** The add menu's bottom strip: how many bots will join, and who. */
export function lineupText(names: string[]): string {
  const n = names.length;
  if (n === 0) return "Pick at least one bot";
  const list = names.map(name => name.trim() === "" ? "New bot" : name.trim()).join(", ");
  return n === 1 ? `1 bot will join: ${list}` : `${n} bots will join: ${list}`;
}
