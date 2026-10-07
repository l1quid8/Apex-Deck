// App-wide settings, saved in settings.json beside the session file.
//
// Each value is checked when the file is read, so a hand-edited or older
// file loses only the values that make no sense, never the rest.

import type { Access, ParticipantConfig, RoomOptions, TurnPolicy } from "./types";
import type { ChipParts } from "./botChip";

export interface DecisionSettings { enabled: boolean; provider: "jev" | "openrouter" | "cloudflare"; accountId: string; }
export const DEFAULT_DECISION: DecisionSettings = { enabled: false, provider: "jev", accountId: "" };

export interface AppSettings {
  decision?: DecisionSettings;
  version: 1;
  /** Tools hidden from the add menus and bot form. */
  disabledProviders: string[];
  /** What a new thread starts with. Threads already made keep their own. */
  newThread: RoomOptions;
  /** The access a bot gets when the add form opens. */
  newBotAccess: Access;
  terminal: { fontSize: number; scrollback: number };
  /** Hosts whose pages open in your browser instead of the Preview pane. */
  preview: { openExternally: string[] };
  /** Ask before a steer interrupts a bot mid-turn. A thread can override it. */
  confirmSteer: boolean;
  /** What the bot chips under the message box show. */
  botChips: ChipParts;
}

export const SCROLLBACK_CHOICES = [1000, 5000, 10000, 50000];
export const FONT_SIZES = { min: 10, max: 20 };
export const MAX_ROUNDS = 10;

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  disabledProviders: [],
  newThread: { policy: "mention", max_bot_hops: 3 },
  newBotAccess: "read",
  terminal: { fontSize: 13, scrollback: 5000 },
  preview: { openExternally: [] },
  confirmSteer: true,
  botChips: { tool: true, effort: true, usage: true },
};

const POLICIES: TurnPolicy[] = ["mention", "everyone", "round_robin"];
const ACCESS: Access[] = ["read", "ask", "edits", "full"];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null);
const whole = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Read a saved settings file. `legacyDisabled` is the provider list older
 *  versions kept in the session file; it is used only when this file has none. */
export function readSettings(raw: unknown, legacyDisabled?: unknown): AppSettings {
  const saved = record(raw);
  const thread = record(saved.newThread);
  const terminal = record(saved.terminal);
  const chips = record(saved.botChips);
  const d = DEFAULT_SETTINGS;
  return {
    ...(saved.decision ? { decision: {
      enabled: record(saved.decision).enabled === true && ["jev", "openrouter", "cloudflare"].includes(String(record(saved.decision).provider)),
      provider: (["jev", "openrouter", "cloudflare"].includes(String(record(saved.decision).provider)) ? record(saved.decision).provider : "jev") as DecisionSettings["provider"],
      accountId: typeof record(saved.decision).accountId === "string" ? record(saved.decision).accountId as string : "",
    } } : {}),
    version: 1,
    disabledProviders: strings(saved.disabledProviders) ?? strings(legacyDisabled) ?? [],
    newThread: {
      policy: POLICIES.includes(thread.policy as TurnPolicy) ? thread.policy as TurnPolicy : d.newThread.policy,
      max_bot_hops: whole(thread.max_bot_hops, 0, MAX_ROUNDS, d.newThread.max_bot_hops),
    },
    newBotAccess: ACCESS.includes(saved.newBotAccess as Access) ? saved.newBotAccess as Access : d.newBotAccess,
    terminal: {
      fontSize: whole(terminal.fontSize, FONT_SIZES.min, FONT_SIZES.max, d.terminal.fontSize),
      scrollback: SCROLLBACK_CHOICES.includes(terminal.scrollback as number) ? terminal.scrollback as number : d.terminal.scrollback,
    },
    preview: {
      openExternally: [...new Set((strings(record(saved.preview).openExternally) ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))],
    },
    confirmSteer: typeof saved.confirmSteer === "boolean" ? saved.confirmSteer : d.confirmSteer,
    botChips: {
      tool: typeof chips.tool === "boolean" ? chips.tool : d.botChips.tool,
      effort: typeof chips.effort === "boolean" ? chips.effort : d.botChips.effort,
      usage: typeof chips.usage === "boolean" ? chips.usage : d.botChips.usage,
    },
  };
}

/** The environment variable names saved agents read their keys from, with how many use each. */
export function keyNamesIn(profiles: Pick<ParticipantConfig, "backend">[]): { name: string; uses: number }[] {
  const uses = new Map<string, number>();
  for (const p of profiles) {
    const name = p.backend.kind === "open_ai_compatible" ? p.backend.api_key_env?.trim() : "";
    if (name) uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return [...uses].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => ({ name, uses: n }));
}
