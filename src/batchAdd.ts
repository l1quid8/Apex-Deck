import { botIdentity, type Mentionable } from "./slug.ts";
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
