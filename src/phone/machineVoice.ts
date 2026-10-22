import type { VoiceSettings } from "../voice/types.ts";
/** Which call settings the phone has changed itself. Those stay the phone's; the rest follow the machine. */
export type PhoneTouched = { silence: boolean; look: boolean };
/**
 * The settings a call in one machine's threads uses: the phone's own, with the machine's saved
 * pause, look, default voice and agents' voices wherever the phone hasn't chosen. A Mac files its own threads' voices
 * under "local", so they're re-keyed to the phone's id for that machine.
 */
export function machineVoice(
  phone: VoiceSettings,
  machine: VoiceSettings | null,
  touched: PhoneTouched,
  hostId: string,
): VoiceSettings {
  if (!machine) return phone;
  const preferences: VoiceSettings["preferences"] = Object.create(null);
  for (const [key, value] of Object.entries(machine.preferences)) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (Array.isArray(parts) && parts[0] === "local")
      preferences[JSON.stringify([hostId, ...parts.slice(1)])] = value;
  }
  Object.assign(preferences, phone.preferences);
  const defaultVoice = phone.defaultVoice ?? machine.defaultVoice;
  return {
    ...phone,
    ...(defaultVoice ? { defaultVoice } : {}),
    silenceMs: touched.silence ? phone.silenceMs : machine.silenceMs,
    look: touched.look ? phone.look : machine.look,
    preferences,
  };
}
