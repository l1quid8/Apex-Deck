import { useEffect, useRef, useState } from 'react';
import type { PersonalLane } from './personalAssistant.ts';
import { assistantIdentityKey, projectIdentityKey } from './assistantIdentity.ts';
import type { ProjectMemoryRead, ProjectNote, ProjectNoteKind } from './projectMemory.ts';

type ReadState = { scope: string; read?: ProjectMemoryRead; loading?: boolean; error?: string };
type Correction = { id: string; text: string; kind: ProjectNoteKind; version: number; expiresAt?: number };
const when = (at: number) => new Date(at).toLocaleString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ProjectMemoryPanel({ lane }: { lane: PersonalLane }) {
  const owner = lane.ref ?? (lane.assistant ? { hostId: lane.assistant.hostId, assistantId: lane.assistant.id } : null);
  const ownerKey = owner ? assistantIdentityKey(owner) : '';
  const projects = lane.assistant?.projects ?? [];
  const [selection, setSelection] = useState({ owner: ownerKey, project: '' });
  const project = projects.find(binding => selection.owner === ownerKey && projectIdentityKey(binding.project) === selection.project)?.project ?? projects[0]?.project;
  const projectKey = project ? projectIdentityKey(project) : '';
  const scope = JSON.stringify([ownerKey, projectKey]);
  const [state, setState] = useState<ReadState>({ scope });
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<ProjectNoteKind>('fact');
  const [editing, setEditing] = useState<Correction | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const sequence = useRef(0);
  const activeScope = useRef(scope);
  // Hide an old owner's contents during the render that changes selection,
  // before effects have a chance to clean up the preceding request.
  if (activeScope.current !== scope) { activeScope.current = scope; sequence.current++; }
  const api = lane.projectMemory;
  const unavailable = lane.offline ? "This assistant's machine is offline. Reconnect to read or change project memory."
    : !api ? lane.projectMemoryProblem ?? "Update this machine's service to use project memory."
    : project ? api.unavailable(project) : undefined;
  const current = state.scope === scope ? state : undefined;
  const read = current?.read;
  const busy = busyScope === scope;
  const locked = !!unavailable || busy || !!current?.loading;

  const refresh = async () => {
    if (!api || !project || unavailable) return;
    const ticket = ++sequence.current;
    setState({ scope, read, loading: true });
    try {
      const result = await api.list(project);
      if (ticket === sequence.current && activeScope.current === scope) setState({ scope, read: result });
    } catch (error) {
      if (ticket === sequence.current && activeScope.current === scope) setState({ scope, read, error: errorText(error) });
    }
  };
  useEffect(() => {
    setDraft(''); setEditing(null); setBusyScope(null);
    void refresh();
    return () => { sequence.current++; };
  }, [scope, unavailable]);

  const mutate = async (work: () => Promise<ProjectNote>, done?: () => void) => {
    if (!api || !project || locked) return;
    const ticket = ++sequence.current;
    setBusyScope(scope); setState({ scope, read });
    let saved = false;
    try {
      await work();
      if (ticket !== sequence.current || activeScope.current !== scope) return;
      saved = true; done?.();
      // A durable mutation receipt is followed by a fresh inspection. Reads
      // never retry or manufacture another mutation after an uncertain result.
      const result = await api.list(project);
      if (ticket === sequence.current && activeScope.current === scope) setState({ scope, read: result });
    } catch (error) {
      if (ticket === sequence.current && activeScope.current === scope) setState({ scope, read, error: saved ? `The note was saved, but the inspection failed. Refresh notes to see the current notebook. ${errorText(error)}` : errorText(error) });
    } finally {
      if (ticket === sequence.current && activeScope.current === scope) setBusyScope(null);
    }
  };

  const metadata = (note: ProjectNote) => (
    <div className="personal-panels-muted">
      {note.id} · version {note.version} · {note.kind}<br />
      Created {when(note.createdAt)} · updated {when(note.updatedAt)}
      {note.author ? <> · author {note.author.hostId}/{note.author.assistantId}</> : ' · human author'}
      <br />Source: {Object.keys(note.source).length === 0 ? 'human notebook edit' : <>
        {note.source.taskId && <>task {note.source.taskId} </>}{note.source.attempt !== undefined && <>attempt {note.source.attempt} </>}
        {note.source.runId && <>run {note.source.runId} </>}{note.source.scratchId && <>scratch {note.source.scratchId} </>}
        {note.source.messageId && <>message {note.source.messageId}</>}
      </>}
      {note.expiresAt !== undefined && <> · expires {when(note.expiresAt)}</>}
      {note.supersededBy && <> · superseded by {note.supersededBy}</>}
      {note.deletedAt !== undefined && <> · forgotten {when(note.deletedAt)}</>}
    </div>
  );
  const now = Date.now();
  const active = read?.notes.filter(note => note.deletedAt === undefined && !note.supersededBy && (note.expiresAt === undefined || note.expiresAt > now)) ?? [];
  const older = read?.notes.filter(note => !active.includes(note)) ?? [];

  return (
    <section>
      <h4>Shared project memory</h4>
      <p className="personal-panels-muted">Notes belong to the selected project and are shared with its assigned assistants. Memory text never grants tools or machine access.</p>
      {unavailable && <p className="personal-panels-muted" role="status">{unavailable}</p>}
      {!project ? <p className="personal-panels-muted">No projects assigned to this assistant.</p> : <>
        <div className="personal-panels-inline">
          <select aria-label="Project notebook" value={projectKey} onChange={event => setSelection({ owner: ownerKey, project: event.target.value })}>
            {projects.map(binding => <option key={projectIdentityKey(binding.project)} value={projectIdentityKey(binding.project)}>{binding.project.cwd} · {binding.project.hostId} · {binding.project.workspaceId}</option>)}
          </select>
          <button type="button" disabled={locked} onClick={() => void refresh()}>Refresh notes</button>
        </div>
        <p className="personal-panels-muted">Project {project.workspaceId} · {project.hostId} · {project.cwd}</p>
        {!unavailable && <>
          {current?.loading && <p className="personal-panels-muted" role="status">Reading project memory…</p>}
          {current?.error && <p role="alert">{current.error}</p>}
          {read && <>
            <p className="personal-panels-muted">Read at {when(read.readAt)} from {read.project.hostId} · {read.project.workspaceId}</p>
            <form className="personal-panels-inline" onSubmit={event => {
              event.preventDefault();
              if (!draft.trim() || !api) return;
              void mutate(() => api.save({ project, text: draft.trim(), kind }), () => setDraft(''));
            }}>
              <input aria-label="New shared project note" placeholder="A note for this project" value={draft} disabled={locked} onChange={event => setDraft(event.target.value)} />
              <select aria-label="Project note kind" value={kind} disabled={locked} onChange={event => setKind(event.target.value as ProjectNoteKind)}>
                {(['fact', 'preference', 'decision', 'commitment'] as const).map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <button type="submit" disabled={locked || !draft.trim()}>Add project note</button>
            </form>
            {!active.length && <p className="personal-panels-muted">No active shared notes in this project.</p>}
            {active.map(note => <div className="personal-panels-row" key={note.id}>
              {editing?.id === note.id ? <div className="personal-panels-inline">
                <input aria-label="Corrected project note" value={editing.text} disabled={locked} onChange={event => setEditing({ ...editing, text: event.target.value })} />
                <button type="button" disabled={locked || !editing.text.trim()} onClick={() => {
                  if (!api) return;
                  const correction = editing;
                  void mutate(() => api.save({ project, id: correction.id, expectedVersion: correction.version, text: correction.text, kind: correction.kind,
                    ...(correction.expiresAt === undefined ? {} : { expiresAt: correction.expiresAt }) }), () => setEditing(null));
                }}>Save correction</button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel correction</button>
              </div> : <div className="personal-panels-rowmain"><span className="personal-panels-goal">{note.text}</span></div>}
              {metadata(note)}
              {editing?.id !== note.id && <div className="personal-panels-actions">
                <button type="button" disabled={locked} onClick={() => setEditing({ id: note.id, text: note.text, kind: note.kind, version: note.version, expiresAt: note.expiresAt })}>Correct</button>
                <button type="button" disabled={locked} onClick={() => {
                  if (!api || (typeof window !== 'undefined' && !window.confirm('Forget this project note and its correction history?'))) return;
                  void mutate(() => api.forget({ project, id: note.id, expectedVersion: note.version }));
                }}>Forget project note</button>
              </div>}
            </div>)}
            {!!older.length && <details><summary>Project note history</summary>{older.map(note => <div className="personal-panels-row" key={note.id}>
              <p>{note.deletedAt !== undefined ? 'Forgotten note' : note.text}</p>{metadata(note)}
            </div>)}</details>}
            <section data-memory-source="monitor">
              <h4>Monitor sources</h4>
              <p className="personal-panels-muted">Read only · Existing project monitor context</p>
              {!read.sources.length && <p className="personal-panels-muted">No monitor sources in this read.</p>}
              {read.sources.map(source => <div className="personal-panels-row" key={source.id}>
                <p>{source.text}</p><div className="personal-panels-muted">{source.id} · {source.kind} · monitor · Read only · updated {when(source.updatedAt)}</div>
              </div>)}
            </section>
          </>}
        </>}
      </>}
    </section>
  );
}
