import { useState } from "react";
import type { ParticipantConfig } from "../types";
import type { ChatProfile } from "../chatCatalog";
import { createAppearance } from "../identicon";
import { effortLabel } from "../models";
import { profileLine } from "./ChatSheets";
import { agentAccessChoices, agentDraft, agentFromDraft, agentModels, agentPicksModel, agentPicksSpeed, agentProblem, agentReasoning, agentTemplateDraft, type AgentDraft } from "./agentEdit";

/**
 * Create or change a saved agent from the Agents tab: the name it answers to, its brief, its model,
 * how hard it thinks, how fast it answers, and what it may touch.
 *
 * A save hands back a whole agent built from the draft and the agent as the machine has it, so the
 * fields this sheet doesn't show are kept rather than blanked. Deleting asks once, because it can't
 * be undone: the conversations it worked in stay, the agent goes.
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
  onSave(config: ParticipantConfig): void;
  onDelete(): void;
}) {
  const [template, setTemplate] = useState<ParticipantConfig | null>(props.agent);
  const [draft, setDraft] = useState<AgentDraft | null>(props.agent ? agentDraft(props.agent) : null);
  const [confirm, setConfirm] = useState(false);
  const set = (change: Partial<AgentDraft>) => setDraft((now) => (now ? { ...now, ...change } : now));

  // Making one: pick the bot it starts from, which is what gives it a tool to run.
  if (!template || !draft) {
    const ready = (props.templates ?? []).filter((item) => item.ok);
    return <>
      <p className="ph-sheet-text">An agent starts from a bot its machine already knows. Pick one, then name it and adjust what it does.</p>
      {!props.templates && !props.templatesProblem && <p className="ph-sheet-text">Asking for this machine's bots…</p>}
      {props.templatesProblem && <p className="ph-sheet-text ph-amber">{props.templatesProblem}</p>}
      {props.templates && ready.length === 0 && <p className="ph-sheet-text">This machine has no bots to start from. Set one up on the Mac first.</p>}
      <div className="ph-list">{ready.map((item) => (
        <button key={item.profile.id} type="button" className="ph-srow ph-project-assistant" onClick={() => { setTemplate(item.profile); setDraft(agentTemplateDraft(item.profile)); }}>
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
    const built = agentFromDraft(template, draft, {
      editing: props.agent?.id ?? null,
      others: props.others,
      appearance: createAppearance(props.others.map((item) => item.appearance).filter((look): look is { seed: string; color: string } => Boolean(look))),
    });
    if (typeof built === "string") return;
    props.onSave(built);
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
    <p className="ph-sheet-text ph-quiet">Voice, look and picture settings stay as {props.agent ? "the Mac has them" : "the bot you started from"}.</p>
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
