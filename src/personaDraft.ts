// Who can write a new agent's persona, and how the answer fills the form.
import type { AgentTool, ParticipantConfig, PersonaDraftResult } from "./types";
import { providerEnabled, providerForConfig } from "./providers.ts";

export interface WriterPreset { key: string; label: string; tool: AgentTool; installed: boolean }
export interface PersonaWriter { key: string; label: string; logo: string; config: ParticipantConfig }

/** The writer runs read-only with none of its own character (the daemon enforces this too). */
function asWriter(config: ParticipantConfig): ParticipantConfig {
  return { ...config, persona: "", access: "read", auto_effort: false };
}

/** Installed, enabled coding agents on their default model, then saved chat agents whose provider is enabled. */
export function personaWriters(presets: WriterPreset[], profiles: ParticipantConfig[], disabled: readonly string[]): PersonaWriter[] {
  const agents = presets
    .filter((p) => p.installed && providerEnabled(p.key, disabled))
    .map((p) => ({
      key: `agent:${p.tool}`,
      label: p.label,
      logo: p.key,
      config: asWriter({ id: `writer-${p.tool}`, display_name: p.label, backend: { kind: "agent", tool: p.tool, model: null }, persona: "", access: "read", effort: null }),
    }));
  const savedAgents = profiles
    .filter((p) => (p.backend.kind === "agent" || p.backend.kind === "open_ai_compatible") && !p.media && providerEnabled(providerForConfig(p), disabled))
    .map((p) => ({ key: `saved:${p.id}`, label: `${p.display_name} (saved)`, logo: providerForConfig(p), config: asWriter(p) }));
  return [...agents, ...savedAgents];
}

/** The form's chosen provider when it can write, else the first writer. */
export function defaultWriter(writers: PersonaWriter[], preset: string): string {
  return writers.find((w) => w.key === `agent:${preset}`)?.key ?? writers[0]?.key ?? "";
}

/** The persona is always replaced; the name only when empty or still the AI's last one. */
export function applyPersona(form: { name: string; persona: string }, result: PersonaDraftResult, lastName: string | null): { name: string; persona: string } {
  const keepName = form.name.trim() !== "" && form.name !== lastName;
  return { name: keepName ? form.name : result.name, persona: result.persona };
}

/** Each Write it gets a token; Cancel or a newer run makes older answers stale. */
export class DraftRun {
  private latest = 0;
  start(): number { return ++this.latest; }
  cancel(): void { this.latest++; }
  current(token: number): boolean { return token === this.latest; }
}
