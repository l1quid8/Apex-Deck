// What a bot chip under the message box says, and whether a thread's row of
// chips is folded down to avatars.

import type { AgentTool, ParticipantConfig } from "./types";

/** Shared chip display preferences. Compact layouts keep full details in
 *  the hover card and bot settings. Omitted style preserves the original look. */
export const CHIP_STYLES = [
  { id: "classic", label: "Classic" },
  { id: "dashed", label: "Dashed off / solid on" },
  { id: "tinted", label: "Tinted fill" },
  { id: "stamp", label: "Stamp" },
  { id: "stack", label: "Avatar stack" },
  { id: "mono", label: "Square mono tags" },
  { id: "ticket", label: "Ticket" },
  { id: "keycap", label: "Keycap" },
  { id: "tab", label: "Tab" },
  { id: "ledger", label: "Ledger" },
  { id: "terminal", label: "Terminal brackets" },
  { id: "tiles", label: "Avatar tiles" },
  { id: "two-line", label: "Two-line cards" },
] as const;
export type ChipStyle = typeof CHIP_STYLES[number]["id"];
export interface ChipParts { tool: boolean; effort: boolean; usage: boolean; style?: ChipStyle }
export function isChipStyle(value: unknown): value is ChipStyle {
  return CHIP_STYLES.some(style => style.id === value);
}

export const AGENT_LABEL: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Antigravity / Gemini", grok: "Grok", muse: "Muse Code" };

/** The line after a bot's name: tool · model · effort · asks first, without the parts turned off. */
export function chipDescription(config: ParticipantConfig, parts: ChipParts): string {
  const b = config.backend;
  const effort = parts.effort && config.effort ? config.effort : null;
  const asks = config.access === "ask" ? "asks first" : null;
  const join = (...bits: (string | null)[]) => bits.filter(Boolean).join(" · ");
  if (b.kind === "open_ai_compatible") return join(b.model, effort);
  const fast = parts.effort && config.speed === "fast" ? "fast" : null;
  if (b.kind === "agent") return join(b.model ?? "default model", effort, fast, asks);
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
