import type { Access, ParticipantConfig, Speed } from "../types.ts";
import { botIdentity, slug } from "../slug.ts";
import { botGroups, phoneSpeed, reasoningLevels } from "../phoneRules.ts";
import { accessOptions } from "../accessChange.ts";

/**
 * The Agents tab creates, changes and deletes the agents saved on the Mac. Those live in the
 * session's `profiles`, the same list the Mac's Agents page writes, so an agent made here is on the
 * Mac the moment it saves and the other way round.
 *
 * This file is the rules only: what the sheet shows, what a save writes back, and why a name can't
 * be used. The sheet itself is AgentSheet.tsx, and PhoneApp does the reading and saving.
 *
 * A save writes the fields the sheet edits and nothing else. Everything else an agent carries — its
 * voice, its look, its media settings, whether it may read screenshots — is left exactly as the Mac
 * has it, so changing a name on the phone can't quietly reset a setting changed on the Mac.
 */

/** What the sheet edits. The Mac's form has more; these are the ones that pay for themselves on a phone. */
export type AgentDraft = { name: string; brief: string; access: Access; model: string; effort: string; speed: string };


/** The CLI tool an agent runs, or "" for a scripted or API agent: the phone offers models only for tools. */
export function agentTool(config: ParticipantConfig): string {
  return config.backend.kind === "agent" ? config.backend.tool : "";
}

/** Access a tool can take: the Mac's own list, so Grok and Muse have no Ask on either. */
export function agentAccessChoices(tool: string): { id: Access; text: string }[] {
  return accessOptions(tool).map(({ value, text }) => ({ id: value, text }));
}

const modelOf = (config: ParticipantConfig) => ("model" in config.backend ? config.backend.model ?? "" : "");

/** The agent as the sheet shows it. */
export function agentDraft(config: ParticipantConfig): AgentDraft {
  return {
    name: config.display_name,
    brief: config.persona ?? "",
    access: config.access,
    model: modelOf(config),
    effort: config.effort ?? "",
    speed: config.speed ?? "",
  };
}

/** A new agent starts from a bot its machine already knows, with the name left blank to fill in. */
export const agentTemplateDraft = (template: ParticipantConfig): AgentDraft => ({ ...agentDraft(template), name: "" });

/** Model choices for the agent's own tool, from the phone's catalogue: no thread or room is needed. */
export const agentModels = (config: ParticipantConfig) => botGroups(config, []);

/** Whether the sheet can offer a model at all. */
export const agentPicksModel = (config: ParticipantConfig) => agentModels(config).length > 0;

/** Reasoning levels the chosen model takes; empty when it takes none, and then the row is hidden. */
export const agentReasoning = (config: ParticipantConfig, model: string) => reasoningLevels(config, agentModels(config), model);

/** Whether the agent's tool has a Speed setting to offer. */
export const agentPicksSpeed = (config: ParticipantConfig) => phoneSpeed(config);

const identityOf = (draft: AgentDraft, others: readonly ParticipantConfig[], editing: string | null) => {
  const name = draft.name.trim();
  // An edited agent keeps its id; a new one takes the id its name gives, or the next free one.
  return botIdentity({ id: editing ?? slug(name), display_name: name }, { editing, others, agents: [], place: "agents" });
};

/** Why the draft can't be saved — a missing name, a name another agent already answers to. "" when it can. */
export function agentProblem(draft: AgentDraft, others: readonly ParticipantConfig[], editing: string | null): string {
  if (!draft.name.trim()) return "Give the agent a name.";
  const identity = identityOf(draft, others, editing);
  return "error" in identity ? identity.error : "";
}

/**
 * The agent as it saves: the draft's fields written over the agent, everything else kept.
 * `editing` is the id of the agent being changed, or null for a new one, which takes `appearance`
 * so two agents made in a row don't come out looking the same.
 */
export function agentFromDraft(
  template: ParticipantConfig,
  draft: AgentDraft,
  { editing, others, appearance }: { editing: string | null; others: readonly ParticipantConfig[]; appearance?: { seed: string; color: string } | null },
): ParticipantConfig | string {
  const problem = agentProblem(draft, others, editing);
  if (problem) return problem;
  const identity = identityOf(draft, others, editing);
  if ("error" in identity) return identity.error;
  const levels = agentReasoning(template, draft.model);
  // A model that takes no reasoning level must not be sent one.
  const effort = levels.length > 0 && draft.effort && levels.includes(draft.effort) ? draft.effort : null;
  return {
    ...template,
    id: identity.id,
    display_name: draft.name.trim(),
    persona: draft.brief.trim(),
    access: draft.access,
    backend: template.backend.kind === "agent" ? { ...template.backend, model: draft.model || null } : template.backend,
    effort,
    ...(phoneSpeed(template) ? { speed: (draft.speed || null) as Speed | null } : {}),
    // A new agent never inherits the look of the bot it started from: two made in a row would match.
    ...(editing === null ? { appearance: appearance ?? null } : {}),
  };
}

/** The saved agents with this one added or replaced where it already was: the list the Mac reads too. */
export function upsertAgent(list: readonly ParticipantConfig[], config: ParticipantConfig): ParticipantConfig[] {
  const at = list.findIndex((item) => item.id === config.id);
  return at < 0 ? [...list, config] : list.map((item, index) => (index === at ? config : item));
}

/** The saved agents without this one. Its conversations stay: only the agent goes. */
export const removeAgent = (list: readonly ParticipantConfig[], id: string) => list.filter((item) => item.id !== id);
