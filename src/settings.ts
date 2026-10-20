// App-wide settings, saved in settings.json beside the session file.
//
// Each value is checked when the file is read, so a hand-edited or older
// file loses only the values that make no sense, never the rest.

import type { Access, ParticipantConfig, RoomOptions, TurnPolicy } from "./types";
import type { ChipParts } from "./botChip";
import { accentHex, readAppearance, themeMode, type AppearanceSettings, type AppearanceValues } from "./themes.ts";

export interface DecisionSettings { enabled: boolean; provider: "jev" | "openrouter" | "cloudflare"; accountId: string; }
export const DEFAULT_DECISION: DecisionSettings = { enabled: false, provider: "jev", accountId: "" };

/** The glyph field behind empty threads. Saved only after a user changes it; older files omit it. */
export interface LandingTextureSettings {
  enabled: boolean;
  mode: "rainbow" | "single";
  color: string;
  rainbowSpeed: number;
  rippleShape: "diamond" | "logo" | "circle";
}
export const DEFAULT_LANDING_TEXTURE: LandingTextureSettings = {
  enabled: true, mode: "rainbow", color: "#3def91", rainbowSpeed: 1, rippleShape: "diamond",
};

/** Read the landing texture settings, dropping each bad value on its own. */
export function readLandingTexture(raw: unknown): LandingTextureSettings {
  const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const d = DEFAULT_LANDING_TEXTURE;
  const color = typeof saved.color === "string" && /^#[0-9a-f]{6}$/i.test(saved.color.trim()) ? saved.color.trim().toLowerCase() : d.color;
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : d.enabled,
    mode: saved.mode === "rainbow" || saved.mode === "single" ? saved.mode : d.mode,
    color,
    rainbowSpeed: typeof saved.rainbowSpeed === "number" && Number.isFinite(saved.rainbowSpeed)
      ? Math.min(3, Math.max(0, saved.rainbowSpeed)) : d.rainbowSpeed,
    rippleShape: saved.rippleShape === "diamond" || saved.rippleShape === "logo" || saved.rippleShape === "circle"
      ? saved.rippleShape : d.rippleShape,
  };
}

/**
 * What the empty-thread field actually draws. Under Clay, a one-color field
 * still on the mint default follows the skin accent instead; any color the
 * user picked (or rainbow mode, or another theme) is left alone. The saved
 * settings are never rewritten, so leaving Clay restores the mint.
 */
export function effectiveLandingTexture(landing: LandingTextureSettings, appearance: AppearanceValues): LandingTextureSettings {
  if (themeMode(appearance) === "clay" && landing.mode === "single" && landing.color.toLowerCase() === DEFAULT_LANDING_TEXTURE.color) {
    return { ...landing, color: accentHex(appearance) };
  }
  return landing;
}

export interface AppSettings {
  decision?: DecisionSettings;
  /** Saved only after a user changes Appearance; older settings files omit it. */
  appearance?: AppearanceSettings;
  /** Saved only after a user changes the landing texture; older settings files omit it. */
  landingTexture?: LandingTextureSettings;
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
/** Rounds of bots answering each other: a whole number clamped to the stepper, or null for unlimited. */
const hops = (value: unknown, fallback: number | null): number | null =>
  value === null ? null : whole(value, 0, MAX_ROUNDS, fallback ?? DEFAULT_SETTINGS.newThread.max_bot_hops as number);

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
      max_bot_hops: hops(thread.max_bot_hops, d.newThread.max_bot_hops),
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
    ...(saved.appearance !== null && typeof saved.appearance === "object" && !Array.isArray(saved.appearance) ? { appearance: readAppearance(saved.appearance) } : {}),
    ...(saved.landingTexture !== null && typeof saved.landingTexture === "object" && !Array.isArray(saved.landingTexture) ? { landingTexture: readLandingTexture(saved.landingTexture) } : {}),
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

/** The name Deck files a provider's API key under, from its base URL: `https://api.venice.ai/api/v1` gives `VENICE_API_KEY`. Empty for local servers and addresses it can't read. */
export function keyNameFor(baseUrl: string): string {
  let host: string;
  try { host = new URL(baseUrl.trim()).hostname.toLowerCase(); } catch { return ""; }
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".local")) return "";
  const labels = host.split(".");
  const site = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  const known: Record<string, string> = { x: "XAI" };
  const word = known[site] ?? site.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return word && /^[A-Z_]/.test(word) ? `${word}_API_KEY` : "";
}
