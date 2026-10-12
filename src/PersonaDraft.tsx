import { useEffect, useRef, useState } from "react";
import type { ParticipantConfig, PersonaDraftResult } from "./types";
import { ProviderLogo } from "./providerLogos";
import { applyPersona, defaultWriter, DraftRun, type PersonaWriter } from "./personaDraft";
import "./persona-draft.css";

type Form = { name: string; persona: string };

export function PersonaDraft({ writers, preset, taken, form, onApply, onIdea, write }: {
  writers: PersonaWriter[];
  preset: string;
  taken: string[];
  form: Form;
  onApply: (next: Form) => void;
  onIdea: (persona: string) => void;
  write: (writer: ParticipantConfig, idea: string, taken: string[]) => Promise<PersonaDraftResult>;
}) {
  const [writerKey, setWriterKey] = useState(() => defaultWriter(writers, preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ by: string; before: Form; name: string } | null>(null);
  const run = useRef(new DraftRun());

  // A late answer must never land in a closed form.
  useEffect(() => () => run.current.cancel(), []);
  useEffect(() => {
    if (!writers.some((w) => w.key === writerKey)) setWriterKey(defaultWriter(writers, preset));
  }, [writers, preset, writerKey]);

  const writer = writers.find((w) => w.key === writerKey);
  const idea = form.persona;
  // Try again starts from the person's own words, not the last answer.
  const go = async (source = idea) => {
    if (!writer || !source.trim() || busy) return;
    const token = run.current.start();
    setBusy(true);
    setError("");
    try {
      const result = await write(writer.config, source.trim(), taken);
      if (!run.current.current(token)) return;
      onApply(applyPersona(form, result, done?.name ?? null));
      setDone((previous) => ({ by: writer.label, before: previous?.before ?? form, name: result.name }));
    } catch (e) {
      if (run.current.current(token)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run.current.current(token)) setBusy(false);
    }
  };
  const cancel = () => {
    run.current.cancel();
    setBusy(false);
  };
  const undo = () => {
    if (done) {
      onApply(done.before);
      setDone(null);
    }
  };

  if (writers.length === 0) {
    return (
      <section className="persona-draft wide persona-draft-off" aria-label="Persona writing">
        <span className="persona-draft-title">Describe the agent you want</span>
        <p>Install or turn on an AI in Providers to use this.</p>
      </section>
    );
  }

  return (
    <section className="persona-draft wide" aria-label="Write an agent persona">
      <label className="persona-draft-title" htmlFor="persona-idea">Persona — describe the agent you want</label>
      <textarea
        id="persona-idea"
        name="persona"
        value={form.persona}
        rows={4}
        disabled={busy}
        placeholder="e.g. a blunt reviewer who hunts security bugs — Write it expands this into a full prompt you can edit, then Save."
        onChange={(e) => onIdea(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void go();
          }
        }}
      />
      <div className="persona-draft-row">
        <span className="persona-draft-source">
          <span className="persona-draft-by">Written by</span>
          {writer && <ProviderLogo preset={writer.logo} label={`${writer.label} logo`} />}
        </span>
        <select aria-label="Written by" value={writerKey} disabled={busy} onChange={(e) => setWriterKey(e.target.value)}>
          {writers.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        {busy && <button type="button" className="persona-draft-link" onClick={cancel}>Cancel</button>}
        <button type="button" className="persona-draft-go" aria-live="polite" disabled={busy || !idea.trim()} onClick={() => void go()}>
          {busy ? "Writing…" : "Write it"}
        </button>
      </div>
      {error && <p className="persona-draft-error" role="alert">{error}</p>}
      {done && !busy && !error && (
        <p className="persona-draft-done" role="status">
          Written by {done.by}. Tweak it above, then Save.
          <span className="persona-draft-actions">
            <button type="button" className="persona-draft-link" onClick={undo}>Undo</button>
            <span aria-hidden="true">·</span>
            <button type="button" className="persona-draft-link" onClick={() => void go(done.before.persona)}>Try again</button>
          </span>
        </p>
      )}
    </section>
  );
}
