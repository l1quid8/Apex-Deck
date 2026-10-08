// What a bot chip under the message box says, and whether a thread's row of
// chips is folded down to avatars.

import type { AgentTool, ParticipantConfig } from "./types";

/** The parts of a chip a person can hide in Settings. The avatar, name,
 *  model and "asks first" always show. */
export interface ChipParts { tool: boolean; effort: boolean; usage: boolean }

export const AGENT_LABEL: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok" };

/** The line after a bot's name: tool · model · effort · asks first, without the parts turned off. */
export function chipDescription(config: ParticipantConfig, parts: ChipParts): string {
  const b = config.backend;
  const effort = parts.effort ? (config.auto_effort ? `Auto (${config.effort || "default"} backup)` : config.effort || null) : null;
  const asks = config.access === "ask" ? "asks first" : null;
  const join = (...bits: (string | null)[]) => bits.filter(Boolean).join(" · ");
  if (b.kind === "open_ai_compatible") return join(b.model, effort);
  if (b.kind === "agent") return join(b.model ?? "default model", effort, asks);
  if (b.kind === "cli") return `Command · ${b.program}`;
  return "Scripted";
}

/** The usage levels a chip shows. With usage hidden, a level that runs low still shows. */
export function levelsShown<T extends { context: number | null; plan: number | null }>(levels: T, parts: ChipParts, isLow: (level: number | null) => boolean): T {
  if (parts.usage) return levels;
  return { ...levels, context: isLow(levels.context) ? levels.context : null, plan: isLow(levels.plan) ? levels.plan : null };
}

const key = (pane: string) => `deck.botsFolded.${pane}`;
export const loadFolded = (pane: string) => { try { return localStorage.getItem(key(pane)) === "1"; } catch { return false; } };
export const saveFolded = (pane: string, folded: boolean) => { try { folded ? localStorage.setItem(key(pane), "1") : localStorage.removeItem(key(pane)); } catch { /* private mode */ } };
