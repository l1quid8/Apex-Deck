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

/**
 * Access a tool can take: the Mac's own list, so Grok and Muse have no Ask on either. The title is
 * the Mac's one-line explanation, kept so the phone can say what a level means in the same words
 * instead of inventing a second description.
 */
export function agentAccessChoices(tool: string): { id: Access; text: string; title: string }[] {
  return accessOptions(tool).map(({ value, text, title }) => ({ id: value, text, title }));
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

/** What the sheet hands back to be saved: the agent it opened, what it opened with, and what it holds now. */
export type AgentSave = {
  /** The agent being changed, or null for a new one. */
  id: string | null;
  /** The bot a new agent starts from. */
  template: ParticipantConfig;
  /** The draft as the sheet opened: a field still equal to this one was never touched. */
  initial: AgentDraft;
  draft: AgentDraft;
  /** The look a new agent gets, so two made in a row don't come out the same. */
  appearance: { seed: string; color: string } | null;
};

/**
 * `base` with the fields the person touched written over it, everything else kept as `base` has it.
 *
 * Only fields that differ from `initial` are written. That is what stops the sheet's copy — taken
 * when it opened — from putting back a brief, a model or an access level that was changed on the Mac
 * while it was open. Omit `initial` and every draft field is written, which is what a new agent needs.
 */
export function mergeAgentDraft(
  base: ParticipantConfig,
  draft: AgentDraft,
  { editing, others, appearance, initial }: { editing: string | null; others: readonly ParticipantConfig[]; appearance?: { seed: string; color: string } | null; initial?: AgentDraft },
): ParticipantConfig | string {
  const problem = agentProblem(draft, others, editing);
  if (problem) return problem;
  const identity = identityOf(draft, others, editing);
  if ("error" in identity) return identity.error;
  const touched = (field: keyof AgentDraft) => !initial || draft[field] !== initial[field];
  const config: ParticipantConfig = { ...base, id: identity.id };
  if (touched("name")) config.display_name = draft.name.trim();
  if (touched("brief")) config.persona = draft.brief.trim();
  if (touched("access")) config.access = draft.access;
  if (touched("model") && base.backend.kind === "agent") config.backend = { ...base.backend, model: draft.model || null };
  // A model can take reasoning levels its neighbour doesn't, so changing either one re-checks the level.
  if (touched("model") || touched("effort")) {
    const model = "model" in config.backend ? config.backend.model ?? "" : "";
    const levels = agentReasoning(base, model);
    const wanted = touched("effort") ? draft.effort : config.effort ?? "";
    // A model that takes no reasoning level must not be sent one.
    config.effort = levels.length > 0 && wanted && levels.includes(wanted) ? wanted : null;
  }
  if (touched("speed") && phoneSpeed(base)) config.speed = (draft.speed || null) as Speed | null;
  // A new agent never inherits the look of the bot it started from: two made in a row would match.
  if (editing === null) config.appearance = appearance ?? null;
  return config;
}

/** The agent as it saves from a draft where every field counts as touched: a brand new agent. */
export const agentFromDraft = (
  template: ParticipantConfig,
  draft: AgentDraft,
  options: { editing: string | null; others: readonly ParticipantConfig[]; appearance?: { seed: string; color: string } | null },
) => mergeAgentDraft(template, draft, options);

/**
 * The agent list to save: the sheet's changes merged into the machine's own copy of the agent.
 *
 * `fresh` is the list as the Mac has it this moment, read immediately before saving. An agent
 * changed there while the sheet was open keeps those changes — the phone writes only what it was
 * asked to change. Returns the reason as a string when it can't be saved.
 */
export function saveAgentDraft(fresh: readonly ParticipantConfig[], change: AgentSave): ParticipantConfig[] | string {
  const base = change.id === null ? change.template : fresh.find((item) => item.id === change.id);
  if (!base) return "That agent was deleted on your Mac while this was open. Close this and start again.";
  const merged = mergeAgentDraft(base, change.draft, {
    editing: change.id,
    others: fresh.filter((item) => item.id !== change.id),
    appearance: change.appearance,
    initial: change.initial,
  });
  if (typeof merged === "string") return merged;
  return upsertAgent(fresh, merged);
}

/** The saved agents with this one added or replaced where it already was: the list the Mac reads too. */
export function upsertAgent(list: readonly ParticipantConfig[], config: ParticipantConfig): ParticipantConfig[] {
  const at = list.findIndex((item) => item.id === config.id);
  return at < 0 ? [...list, config] : list.map((item, index) => (index === at ? config : item));
}

/** The saved agents without this one. Its conversations stay: only the agent goes. */
export const removeAgent = (list: readonly ParticipantConfig[], id: string) => list.filter((item) => item.id !== id);
