import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ParticipantConfig } from "../types";
import type { ChatProfile } from "../chatCatalog";
import { createAppearance } from "../identicon";
import { effortLabel } from "../models";
import { profileLine } from "./ChatSheets";
import { agentAccessChoices, agentDraft, agentModels, agentPicksModel, agentPicksSpeed, agentProblem, agentReasoning, agentTemplateDraft, type AgentDraft, type AgentSave } from "./agentEdit";
import type { PersonaDrafter, WriterOption } from "./personaDrafter";
import { applyPersona, DraftRun } from "../personaDraft";

/**
 * Create or change a saved agent from the Agents tab: the name it answers to, its brief, its model,
 * how hard it thinks, how fast it answers, and what it may touch.
 *
 * A save hands back the draft it opened with and the draft as it stands now, not a finished agent.
 * PhoneApp merges the difference into the Mac's own copy of the agent, so only fields the person
 * actually changed are written and nothing the Mac changed meanwhile is put back. Deleting asks once,
 * because it can't be undone: the conversations it worked in stay, the agent goes.
 *
 * The Brief box can be filled by AI: Type a few words, tap ✨ Write with AI, pick which AI writes it,
 * see Writing… with Cancel, then Done with Undo · Try again, or an amber error line. Nothing is saved
 * until Save agent. (mockups/phone-agent-write-with-ai-v2.html, five steps)
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
  drafter?: PersonaDrafter;
}) {
  const [template, setTemplate] = useState<ParticipantConfig | null>(props.agent);
  const [opened] = useState<AgentDraft | null>(() => (props.agent ? agentDraft(props.agent) : null));
  const [initial, setInitial] = useState<AgentDraft | null>(opened);
  const [draft, setDraft] = useState<AgentDraft | null>(opened);
  const [confirm, setConfirm] = useState(false);
  const set = (change: Partial<AgentDraft>) => setDraft((now) => (now ? { ...now, ...change } : now));

  // --- Persona Write with AI (v2 mockup) ---
  const [writers, setWriters] = useState<WriterOption[]>([]);
  const [writerKey, setWriterKey] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ before: AgentDraft; aiName: string } | null>(null);
  const runRef = useRef(new DraftRun());
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const [freshBrief, setFreshBrief] = useState(false);

  // Load writers whenever template or drafter changes, default to own AI every open
  useEffect(() => {
    if (!template || !props.drafter) return;
    const drafter = props.drafter;
    let live = true;
    void drafter.writerOptions(template).then((list) => {
      if (!live) return;
      setWriters(list);
      const own = list.find((w) => w.own)?.key ?? list[0]?.key ?? "";
      setWriterKey(own);
    }).catch(() => {
      if (!live) return;
      setWriters([]);
    });
    return () => { live = false; };
  }, [template, props.drafter]);

  // Cleanup on unmount / sheet change: cancel in-flight
  useEffect(() => () => {
    runRef.current.cancel();
    props.drafter?.cancelDraft();
  }, [props.drafter]);

  const activeWriter = writers.find((w) => w.key === writerKey) ?? writers[0] ?? null;

  // Grow box to fit after AI brief arrives (layout effect so measurement happens after React puts new text in)
  useLayoutEffect(() => {
    const el = briefRef.current;
    if (!el) return;
    if (!freshBrief) return;
    if (!draft?.brief) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft?.brief, freshBrief]);

  const resizeBrief = (resetToDefault?: boolean) => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (resetToDefault) return;
    el.style.height = `${el.scrollHeight}px`;
  };

  const go = async (sourceIdea?: string) => {
    if (!draft || !props.drafter) return;
    const idea = (sourceIdea ?? draft.brief).trim();
    if (!idea || !activeWriter) {
      setError(idea ? "Pick a writer first." : "Type a few words about the agent first.");
      return;
    }

    const typedName = (() => {
      if (!draft.name.trim()) return undefined;
      if (!initial) return draft.name.trim() ? draft.name : undefined;
      return draft.name !== initial.name ? draft.name : undefined;
    })();

    const token = runRef.current.start();
    setBusy(true);
    setError("");
    setFreshBrief(false);
    try {
      const reply = await props.drafter.draftPersona({ writer: activeWriter.key, idea, name: typedName });
      if (!runRef.current.current(token)) return;
      if ("error" in reply) {
        if (reply.error === "") return; // cancelled, show nothing
        setError(reply.error);
        return;
      }
      // Don't wipe a name typed while writing: use current draft at reply time
      const beforeDraft = done?.before ?? draft;
      setDraft((now) => {
        if (!now) return now;
        return {
          ...now,
          ...(() => {
            const applied = applyPersona({ name: now.name, persona: now.brief }, { name: reply.name ?? "", persona: reply.brief }, done?.aiName ?? null);
            return { name: applied.name, brief: applied.persona };
          })(),
        };
      });
      setDone({ before: beforeDraft, aiName: reply.name ?? "" });
      setFreshBrief(true);
    } catch (e) {
      if (!runRef.current.current(token)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (runRef.current.current(token)) setBusy(false);
    }
  };

  const cancel = () => {
    runRef.current.cancel();
    props.drafter?.cancelDraft();
    setBusy(false);
    setError("");
  };

  const undo = () => {
    if (!done) return;
    set({ brief: done.before.brief, name: done.before.name });
    setDone(null);
    setError("");
    setFreshBrief(false);
    resizeBrief(true);
  };

  // Making one: pick the bot it starts from, which is what gives it a tool to run.
  if (!template || !draft) {
    const ready = (props.templates ?? []).filter((item) => item.ok);
    return <>
      <p className="ph-sheet-text">An agent starts from a bot its machine already knows. Pick one, then name it and adjust what it does.</p>
      {!props.templates && !props.templatesProblem && <p className="ph-sheet-text">Asking for this machine's bots…</p>}
      {props.templatesProblem && <p className="ph-sheet-text ph-amber">{props.templatesProblem}</p>}
      {props.templates && ready.length === 0 && <p className="ph-sheet-text">This machine has no bots to start from. Set one up on the Mac first.</p>}
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

  // Try again source is the person's own words before the AI overwrote, not the last answer (like desktop)
  const retrySource = done?.before.brief ?? draft.brief;

  // Group writers for optgroups
  const agentWriters = writers.filter((w) => w.key.startsWith("agent:"));
  const savedWriters = writers.filter((w) => w.key.startsWith("saved:"));

  return <>
    <label className="ph-label">Name
      <input value={draft.name} autoFocus autoCapitalize="words" onChange={(event) => set({ name: event.target.value })} />
      <small>What you @mention in a thread. {profileLine(template)}</small>
    </label>

    {/* Brief + ✨ Write with AI — only when drafter is present (real connection) */}
    {props.drafter ? (() => {
      const cleanError = error.replace(/\.\s*$/, "");
      return (
      <div className="ph-label">
        <span className="ph-brief-head">
          <span>Brief</span>
          {busy ? (
            <span className="ph-ai-busy" role="status">
              <i className="ph-dot busy" />
              Writing…
              <button type="button" className="ph-plain ph-ai-link" onClick={cancel}>Cancel</button>
            </span>
          ) : (
            <button
              type="button"
              className="ph-plain ph-ai"
              disabled={!draft.brief.trim()}
              onClick={() => void go()}
              aria-label="Write with AI"
            >✨ Write with AI</button>
          )}
        </span>
        <textarea
          ref={briefRef}
          rows={4}
          value={draft.brief}
          disabled={busy}
          placeholder="What this agent is for, and how it should work."
          className={`${busy ? "ph-ai-dim" : ""} ${freshBrief ? "ph-ai-fresh" : ""}`.trim()}
          onChange={(event) => set({ brief: event.target.value, })}
        />
        {writers.length > 0 && (
          <span className="ph-writer">
            Written by
            <span className={`ph-pick ${busy ? "ph-off" : ""}`}>
              {activeWriter?.label ?? "Pick"}
              <span className="ph-chev">⌄</span>
              <select aria-label="Written by" value={writerKey} disabled={busy} onChange={(e) => setWriterKey(e.target.value)}>
                {agentWriters.length > 0 && (
                  <optgroup label="Coding AIs">
                    {agentWriters.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
                  </optgroup>
                )}
                {savedWriters.length > 0 && (
                  <optgroup label="Saved agents">
                    {savedWriters.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
                  </optgroup>
                )}
              </select>
            </span>
          </span>
        )}
        {busy && activeWriter && props.drafter && (
          <small>{activeWriter.label} on {props.drafter.machine} is writing. Usually 10–30 seconds.</small>
        )}
        {!busy && error && (
          <small className="ph-ai-done ph-amber">
            <span>Couldn't write it: {cleanError}. Your words are still in the box. Pick another AI or Try again.</span>
            <span className="ph-ai-acts"><button type="button" className="ph-plain ph-ai-link" onClick={() => void go(retrySource)}>Try again</button></span>
          </small>
        )}
        {!busy && !error && done && (
          <small className="ph-ai-done">
            <span>Done. Edit it, then Save agent. To compare, pick another AI and Try again.</span>
            <span className="ph-ai-acts">
              <button type="button" className="ph-plain ph-ai-link" onClick={undo}>Undo</button>
              <span aria-hidden="true">·</span>
              <button type="button" className="ph-plain ph-ai-link" onClick={() => void go(retrySource)}>Try again</button>
            </span>
          </small>
        )}
        {!busy && !error && !done && (
          <small>Type a few words, then ✨ Write with AI turns them into a full brief.</small>
        )}
      </div>
      );
    })() : (
      <label className="ph-label">Brief
        <textarea rows={4} value={draft.brief} placeholder="What this agent is for, and how it should work." onChange={(event) => set({ brief: event.target.value })} />
      </label>
    )}

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
