/**
 * Phone agent editor: who can write a persona, and how the answer reaches the sheet.
 *
 * The Mac already knows how to write a persona (`persona_draft`). The phone
 * never changes the Mac; it just asks for a persona and fills the form with
 * what comes back. Nothing is saved until Save agent.
 *
 * Coding AIs come from the Mac's `chat_profiles` answer (its `backends` list,
 * chatOk only). Saved agents come from the session's full profiles (agent or
 * API, no picture/video, provider on), not from `chat_profiles`, because
 * that call redacts the API-key env name and a saved API writer would then
 * fail when asked to write.
 */

import type { AgentTool, ParticipantConfig } from "../types.ts";
import { providerEnabled } from "../providers.ts";
import { personaWriters as desktopPersonaWriters, type PersonaWriter, type WriterPreset } from "../personaDraft.ts";
import { TOOL_LABELS } from "../phoneRules.ts";

export interface WriterOption {
  key: string; // "agent:claude_code" | "saved:<id>"
  label: string; // "Claude Code", "Scout (saved)"
  own: boolean;
}

export type DraftReply = { name?: string; brief: string } | { error: string };

export interface PersonaDrafter {
  /** The Mac's name, for "Codex on <Mac> is writing." */
  readonly machine: string;
  writerOptions(own: ParticipantConfig): Promise<WriterOption[]>;
  draftPersona(req: { writer: string; idea: string; name?: string }): Promise<DraftReply>;
  cancelDraft(): void;
}

type ChatProfilesRaw = {
  profiles?: unknown;
  backends?: unknown;
};

type BackendRow = { tool: AgentTool; chatOk: boolean };

function parseBackends(raw: unknown): BackendRow[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as ChatProfilesRaw;
  const list = (r as { backends?: unknown }).backends;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as { tool?: unknown; chatOk?: unknown };
    // Only tools this phone knows; a newer Mac's extra tool is left out rather than mislabelled.
    if (typeof o.tool !== "string" || !Object.hasOwn(TOOL_LABELS, o.tool)) return [];
    return [{ tool: o.tool as AgentTool, chatOk: o.chatOk === true }];
  });
}

export function createPersonaDrafter(opts: {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  personaDraft(writer: ParticipantConfig, idea: string, taken: string[]): Promise<{ name: string; persona: string }>;
  profiles: () => ParticipantConfig[];
  disabledProviders: () => readonly string[];
  editingId: string | null;
  machine: string;
}): PersonaDrafter {
  let latest = 0;
  let lastBackends: BackendRow[] | null = null;
  let cachedWriters: PersonaWriter[] = [];

  const writerCacheKey = (profiles: ParticipantConfig[], disabled: readonly string[]) =>
    `${profiles.map((p) => p.id).join(",")}|${disabled.join(",")}`;

  let lastWriterCacheKey = "";

  const ensureWriters = async (): Promise<PersonaWriter[]> => {
    const disabled = opts.disabledProviders();
    const full = opts.profiles();
    const key = writerCacheKey(full, disabled);
    const sameKey = key === lastWriterCacheKey && lastBackends !== null;

    if (sameKey) return cachedWriters;

    let backends: BackendRow[];
    try {
      const raw = await opts.call<ChatProfilesRaw>("chat_profiles", {});
      backends = parseBackends(raw);
      lastBackends = backends;
    } catch {
      backends = lastBackends ?? [];
    }

    const presets: WriterPreset[] = backends
      .filter((b) => b.chatOk && providerEnabled(b.tool, disabled))
      .map((b) => ({ key: b.tool, label: TOOL_LABELS[b.tool], tool: b.tool, installed: true }));

    cachedWriters = desktopPersonaWriters(presets, full, disabled);
    lastWriterCacheKey = key;
    return cachedWriters;
  };

  return {
    machine: opts.machine,
    async writerOptions(own: ParticipantConfig): Promise<WriterOption[]> {
      try {
        const writers = await ensureWriters();
        const ownTool = own.backend.kind === "agent" ? own.backend.tool : "";
        const ownKey = ownTool ? `agent:${ownTool}` : "";

        return writers.map((w) => ({
          key: w.key,
          label: w.label,
          own: w.key === ownKey || (ownKey === "" && w.key === `saved:${own.id}`),
        }));
      } catch {
        return [];
      }
    },

    async draftPersona(req: { writer: string; idea: string; name?: string }): Promise<DraftReply> {
      const idea = req.idea.trim();
      if (!idea) return { error: "Type a few words about the agent first." };

      const token = ++latest;
      try {
        const writers = await ensureWriters();
        if (token !== latest) return { error: "" };

        const writer = writers.find((w) => w.key === req.writer);
        if (!writer) return { error: "Pick a writer first." };

        const profiles = opts.profiles();
        const taken = profiles
          .filter((p) => p.id !== opts.editingId)
          .map((p) => p.display_name)
          .filter(Boolean);

        const result = await opts.personaDraft(writer.config, idea, taken);

        if (token !== latest) return { error: "" };

        const brief = result.persona.trim();
        if (!brief) return { error: "The AI returned an empty brief. Try again with more detail." };

        // Name only when the request had none.
        if (req.name && req.name.trim()) {
          return { brief };
        }
        const name = result.name.trim();
        return name ? { name, brief } : { brief };
      } catch (e) {
        if (token !== latest) return { error: "" };
        const msg = e instanceof Error ? e.message : String(e);
        // Map offline / transport errors to one sentence.
        if (/not connected|offline|disconnected|Failed to fetch|NetworkError|not paired/i.test(msg)) {
          return { error: "The Mac isn't connected." };
        }
        // Mac's own plain sentence, e.g. "That AI's API key is missing…"
        const cleaned = msg.replace(/^Error:\s*/, "").trim();
        return { error: cleaned || "Couldn't write the brief. Try again." };
      }
    },

    cancelDraft() {
      latest++;
    },
  };
}
