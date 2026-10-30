import { readCallLook } from "./callView.ts";
import type { CallEngine, VoicePreferences, VoiceSettings } from "./types.ts";
export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;
export const DEFAULT_REALTIME_VOICE = "verse";
/** The OpenAI realtime models a GPT-Live call can use; the first is the default. */
export const REALTIME_MODELS = [
  { id: "gpt-realtime", label: "GPT Realtime" },
  { id: "gpt-realtime-2.1", label: "GPT Realtime 2.1" },
] as const;
export const DEFAULT_REALTIME_MODEL = REALTIME_MODELS[0].id;
export const readRealtimeModel = (raw: unknown): string | undefined =>
  REALTIME_MODELS.some((m) => m.id === raw) ? (raw as string) : undefined;
/** "verse" → "Verse": GPT-Live voices have no accent tag like the local ones. */
export const realtimeVoiceLabel = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
export const CALL_ENGINES: { id: CallEngine; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "realtime", label: "GPT-Live" },
];
export const readCallEngine = (raw: unknown): CallEngine =>
  raw === "realtime" ? "realtime" : "local";
export const readRealtimeVoice = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[a-z]{2,20}$/.test(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : undefined;
export const DEFAULT_VOICE = "am_michael";
/** The English Kokoro voices the call helper offers ([ab][fm]_*), for picking one outside a call. */
export const CALL_VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
] as const;
/** A saved voice id, or undefined when it isn't one. */
export const readVoiceId = (v: unknown): string | undefined =>
  typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : undefined;
export const voicePreferenceKey = (
  hostId: string,
  profileId: string,
  roomId?: string,
  participantId?: string,
) =>
  JSON.stringify(
    roomId && participantId
      ? [hostId, profileId, roomId, participantId]
      : [hostId, profileId],
  );
export function readVoiceSettings(raw: unknown): VoiceSettings {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const preferences: Record<string, VoicePreferences> = Object.create(null);
  if (r.preferences && typeof r.preferences === "object")
    for (const [key, value] of Object.entries(r.preferences).slice(0, 1000)) {
      if (
        !value ||
        typeof value !== "object" ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        continue;
      const p = value as Record<string, unknown>;
      const voice = readVoiceId(p.voice);
      preferences[key] = {
        ...(voice ? { voice } : {}),
        aliases: Array.isArray(p.aliases)
          ? p.aliases
              .filter((x): x is string => typeof x === "string" && !!x.trim())
              .slice(0, 16)
              .map((x) => x.trim().slice(0, 64))
          : [],
      };
    }
  const defaultVoice = readVoiceId(r.defaultVoice);
  const realtimeVoice = readRealtimeVoice(r.realtimeVoice);
  const realtimeModel = readRealtimeModel(r.realtimeModel);
  return {
    enabled: r.enabled === true,
    ...(defaultVoice ? { defaultVoice } : {}),
    silenceMs:
      typeof r.silenceMs === "number" && Number.isFinite(r.silenceMs)
        ? Math.min(2000, Math.max(100, Math.round(r.silenceMs)))
        : 100,
    look: readCallLook(r.look),
    preferences,
    engine: readCallEngine(r.engine),
    ...(realtimeVoice ? { realtimeVoice } : {}),
    ...(realtimeModel ? { realtimeModel } : {}),
  };
}
export function preferenceFor(
  s: VoiceSettings,
  host: string,
  profile: string,
  room?: string,
  participant?: string,
): VoicePreferences {
  return (
    s.preferences[voicePreferenceKey(host, profile, room, participant)] ??
    s.preferences[voicePreferenceKey(host, profile)] ?? { aliases: [] }
  );
}
/** The app-wide voice: the one picked in Settings, else Michael. */
export const defaultVoiceOf = (s: VoiceSettings) => s.defaultVoice ?? DEFAULT_VOICE;
/**
 * The voice a call uses, first set wins: the one picked for this agent in this chat
 * (during a call), the agent's own voice (its form), then the app-wide default.
 */
export function voiceFor(
  s: VoiceSettings,
  host: string,
  profile: string,
  room: string | undefined,
  participant: string | undefined,
  agentVoice: string | null | undefined,
): string {
  return (
    (room && participant ? s.preferences[voicePreferenceKey(host, profile, room, participant)]?.voice : undefined) ??
    s.preferences[voicePreferenceKey(host, profile)]?.voice ??
    readVoiceId(agentVoice) ??
    defaultVoiceOf(s)
  );
}
/** The voice picked for one agent in one chat during a call, or "" to use the agent's own. */
export const chatVoice = (s: VoiceSettings, host: string, profile: string, room: string, participant: string) =>
  s.preferences[voicePreferenceKey(host, profile, room, participant)]?.voice ?? "";
/** Settings with one agent's choices in one chat changed. A blank voice goes back to the agent's own. */
export function withChatPreference(
  s: VoiceSettings,
  host: string,
  profile: string,
  room: string,
  participant: string,
  patch: Partial<VoicePreferences>,
): VoiceSettings {
  const key = voicePreferenceKey(host, profile, room, participant);
  const next: VoicePreferences = { ...(s.preferences[key] ?? { aliases: preferenceFor(s, host, profile).aliases }), ...patch };
  if (!next.voice) delete next.voice;
  return { ...s, preferences: { ...s.preferences, [key]: next } };
}
export const validateVoice = (voice: string, catalog: readonly string[]) =>
  catalog.includes(voice);
