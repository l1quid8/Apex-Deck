import type { PersonalAssistantRecord } from "./personalAssistant.ts";
import type { ParticipantConfig } from "./types.ts";

/** What this assistant can do on the computer, in the host's own terms. The host
 *  decides per reply (personal_worker/computer.rs); this only explains it. */
export function computerSummary(input: { name: string; profile?: ParticipantConfig | null; record: Pick<PersonalAssistantRecord, "modes" | "rules" | "paused">; access?: string; enabled?: boolean; available?: boolean }): { state: string; notes: string[] } {
  const { name, profile, record, access, enabled, available } = input;
  const backend = profile?.backend;
  const tool = backend?.kind === "agent" ? backend.tool : undefined;
  const supported = backend?.kind === "open_ai_compatible" || tool === "claude_code" || tool === "codex" || tool === "muse";
  if (!supported) return { state: "This model has no computer tools", notes: [`Choose a Claude, Codex, Muse or API model for ${name} to use apps.`] };
  if (available === false) return { state: "Needs the installed Mac app", notes: [] };
  if (!enabled) return { state: "Off for every agent", notes: ["Turn it on in Settings → Unified Computer Use."] };
  const handedOff = record.modes?.write === "handOff" || record.rules?.some(rule => rule.class === "write" && rule.mode === "handOff");
  const notes: string[] = [];
  if (record.paused) notes.push(`${name} is paused, so it won't use apps until you resume it.`);
  if (handedOff) notes.push("Your rules hand changes to you, so this stays read only.");
  else if (access === "read") notes.push("Project tools are Read only, and that also keeps apps read only.");
  if (backend?.kind === "open_ai_compatible" && !profile?.can_read_images) notes.push("This model can't read screenshots and relies on accessibility text. Some controls may be missing or misread.");
  if (tool === "muse") notes.push("Muse's screenshot support and tool access in assistant chats aren't confirmed yet.");
  return { state: handedOff || access === "read" ? "On · read only" : "On", notes };
}
