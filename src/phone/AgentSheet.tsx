import { useState } from "react";
import type { ParticipantConfig } from "../types";
import type { ChatProfile } from "../chatCatalog";
import { createAppearance } from "../identicon";
import { effortLabel } from "../models";
import { profileLine } from "./ChatSheets";
import { agentAccessChoices, agentDraft, agentModels, agentPicksModel, agentPicksSpeed, agentProblem, agentReasoning, agentTemplateDraft, type AgentDraft, type AgentSave } from "./agentEdit";

/**
 * Create or change a saved agent from the Agents tab: the name it answers to, its brief, its model,
 * how hard it thinks, how fast it answers, and what it may touch.
 *
 * A save hands back the draft it opened with and the draft as it stands now, not a finished agent.
 * PhoneApp merges the difference into the Mac's own copy of the agent, so only fields the person
 * actually changed are written and nothing the Mac changed meanwhile is put back. Deleting asks once,
 * because it can't be undone: the conversations it worked in stay, the agent goes.
 */
export function AgentSheet(props: {
  /** The agent being changed, or null to make a new one. */
  agent: ParticipantConfig | null;
  /** Every other saved agent: a name another one already answers to can't be used. */
  others: ParticipantConfig[];
  /** The bots the machine already knows, a new agent starts from one of them. Null while loading. */
  templates: ChatProfile[] | null;
  templatesProblem: string;
  /** Why the last save failed on the machine, if it did. */
  saveProblem: string;
  saving: boolean;
  onSave(change: AgentSave): void;
  onDelete(): void;
}) {
  const [template, setTemplate] = useState<ParticipantConfig | null>(props.agent);
  const [opened] = useState<AgentDraft | null>(() => (props.agent ? agentDraft(props.agent) : null));
  const [initial, setInitial] = useState<AgentDraft | null>(opened);
  const [draft, setDraft] = useState<AgentDraft | null>(opened);
  const [confirm, setConfirm] = useState(false);
  const set = (change: Partial<AgentDraft>) => setDraft((now) => (now ? { ...now, ...change } : now));

  // Making one: pick the bot it starts from, which is what gives it a tool to run.
  if (!template || !draft) {
    const ready = (props.templates ?? []).filter((item) => item.ok);
    return <>
      <p className="ph-sheet-text">An agent starts from a saved agent its machine already knows. Pick one, then name it and adjust what it does.</p>
      {!props.templates && !props.templatesProblem && <p className="ph-sheet-text">Asking for this machine's agents…</p>}
      {props.templatesProblem && <p className="ph-sheet-text ph-amber">{props.templatesProblem}</p>}
      {props.templates && ready.length === 0 && <p className="ph-sheet-text">This machine has no agents to start from. Set one up on the Mac first.</p>}
      <div className="ph-list">{ready.map((item) => (
        <button key={item.profile.id} type="button" className="ph-srow ph-project-assistant" onClick={() => { const start = agentTemplateDraft(item.profile); setTemplate(item.profile); setInitial(start); setDraft(start); }}>
          <span className="ph-grow"><strong>{item.profile.display_name}</strong><small>{profileLine(item.profile)}</small></span>
        </button>
      ))}</div>
    </>;
  }

  const problem = agentProblem(draft, props.others, props.agent?.id ?? null);
  const models = agentPicksModel(template) ? agentModels(template) : [];
  const levels = agentReasoning(template, draft.model);
  const access = agentAccessChoices(template.backend.kind === "agent" ? template.backend.tool : "");
  const save = () => {
    // What the sheet opened with goes back with the draft: PhoneApp needs the difference to know
    // which fields the person actually changed.
    if (!initial) return;
    props.onSave({
      id: props.agent?.id ?? null,
      template,
      initial,
      draft,
      appearance: props.agent ? null : createAppearance(props.others.map((item) => item.appearance).filter((look): look is { seed: string; color: string } => Boolean(look))),
    });
  };

  return <>
    <label className="ph-label">Name
      <input value={draft.name} autoFocus autoCapitalize="words" onChange={(event) => set({ name: event.target.value })} />
      <small>What you @mention in a thread. {profileLine(template)}</small>
    </label>
    <label className="ph-label">Brief
      <textarea rows={4} value={draft.brief} placeholder="What this agent is for, and how it should work." onChange={(event) => set({ brief: event.target.value })} />
    </label>
    {models.length > 0 && <label className="ph-label">Model
      <select value={draft.model} onChange={(event) => set({ model: event.target.value, effort: "" })}>
        <option value="">Default model</option>
        {models.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.models.map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
          </optgroup>
        ))}
      </select>
    </label>}
    {levels.length > 0 && <label className="ph-label">Reasoning
      <select value={draft.effort} onChange={(event) => set({ effort: event.target.value })}>
        <option value="">Default reasoning</option>
        {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
      </select>
    </label>}
    {agentPicksSpeed(template) && <>
      <div className="ph-section">Speed</div>
      <div className="ph-segment" role="radiogroup" aria-label="Speed">
        {[{ id: "", text: "Standard" }, { id: "fast", text: "Fast" }].map((choice) => (
          <button key={choice.id} type="button" role="radio" aria-checked={draft.speed === choice.id} onClick={() => set({ speed: choice.id })}>{choice.text}</button>
        ))}
      </div>
    </>}
    <div className="ph-section">Access</div>
    <div className="ph-segment" role="radiogroup" aria-label="Access">
      {access.map((choice) => (
        <button key={choice.id} type="button" role="radio" aria-checked={draft.access === choice.id} onClick={() => set({ access: choice.id })}>{choice.text}</button>
      ))}
    </div>
    <p className="ph-sheet-text">{access.find((choice) => choice.id === draft.access)?.title}</p>
    <p className="ph-sheet-text ph-quiet">Voice, look and picture settings stay as {props.agent ? "the Mac has them" : "the agent you started from"}.</p>
    {problem && <p className="ph-sheet-text ph-amber">{problem}</p>}
    {props.saveProblem && <p className="ph-sheet-text ph-amber">{props.saveProblem}</p>}
    <button type="button" className="primary ph-wide" disabled={props.saving || Boolean(problem) || !draft.name.trim()} onClick={save}>{props.saving ? "Saving…" : props.agent ? "Save agent" : "Create agent"}</button>
    {props.agent && (confirm
      ? <>
        <p className="ph-sheet-text ph-amber">Delete {props.agent.display_name}? Its conversations stay. This can't be undone.</p>
        <button type="button" className="ph-wide ph-danger" disabled={props.saving} onClick={props.onDelete}>Delete agent</button>
        <button type="button" className="ph-plain ph-wide" onClick={() => setConfirm(false)}>Keep it</button>
      </>
      : <button type="button" className="ph-plain ph-wide ph-danger" onClick={() => setConfirm(true)}>Delete agent…</button>)}
  </>;
}
