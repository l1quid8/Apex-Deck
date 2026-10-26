import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Backend } from './backend';
import type { Pane, ParticipantConfig, Workspace } from './types';
import { workspaceHost } from './hostSession.ts';
import { compatibleMonitorProfiles, defaultMonitorProfileId, parseProjectFiles, type ProjectMonitor } from './apexAgentModel.ts';
import { assistantDisplayName } from './assistantName.ts';
import './apex-agent-sources.css';

/** A save reply may name chats deleted since the last save; the host drops them from the sources and reports them. */
type SourcesReply = ProjectMonitor & { removedThreads?: string[] | number };

function removedCount(reply: SourcesReply): number {
  return Array.isArray(reply.removedThreads) ? reply.removedThreads.length : typeof reply.removedThreads === 'number' ? reply.removedThreads : 0;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Per-project sources: which chats and files ApexAgent watches, and the AI profile it uses. Replaces the old per-project chat window. */
export function ApexAgentSources({ workspace, backend, profiles, panes, onBack, onClose, onMonitorChange, assistantName }: {
  workspace: Workspace;
  /** The name the human gave this assistant, for labels that name it. */
  assistantName?: string;
  backend: Backend;
  profiles: ParticipantConfig[];
  panes: Pane[];
  onBack: () => void;
  onClose: () => void;
  onMonitorChange?: (workspaceId: string, hostId: string, monitor: ProjectMonitor | null) => void;
}) {
  const who = assistantDisplayName(assistantName);
  const [monitor, setMonitor] = useState<ProjectMonitor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [profileId, setProfileId] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [selectedThreads, setSelectedThreads] = useState<string[]>([]);
  const [fileDraft, setFileDraft] = useState('');
  const [connectionVersion, setConnectionVersion] = useState(0);
  const profilesAvailable = useMemo(() => compatibleMonitorProfiles(profiles), [profiles]);
  const chatPanes = panes.filter((pane) => pane.kind === 'chat' && pane.workspaceId === workspace.id && !pane.archived);
  const recentThreadIds = chatPanes.slice(-3).map((pane) => pane.id);
  const requestVersion = useRef(0);
  const requestEpoch = useRef(0);
  const latestSnapshot = useRef<ProjectMonitor | null>(null);
  const sourcesDirty = useRef(false);
  const sourceEditVersion = useRef(0);
  const shownOwner = useRef<{ workspaceId: string; cwd: string | null; workspaceHostId: string; routeHostId: string } | null>(null);
  const mutationsPending = useRef(0);
  const componentAlive = useRef(true);
  const callbackRef = useRef(onMonitorChange);
  callbackRef.current = onMonitorChange;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const routeHostId = backend.host?.id ?? workspaceHost(workspace);
  const connection = backend.host?.connection;
  const owner = {
    workspaceId: workspace.id,
    cwd: workspace.path ?? null,
    workspaceHostId: workspaceHost(workspace),
    routeHostId,
    backend,
    connection,
    connectionStatus: connection?.get().status,
  };
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const isOlderSnapshot = (snapshot: ProjectMonitor | null) => {
    const current = latestSnapshot.current;
    return !!snapshot && !!current
      && snapshot.conversationId === current.conversationId
      && (snapshot.snapshotVersion ?? 0) < (current.snapshotVersion ?? 0);
  };
  const ownsCurrentRequest = (requestOwner: typeof owner) => {
    const active = activeOwner.current;
    return active.workspaceId === requestOwner.workspaceId
      && active.cwd === requestOwner.cwd
      && active.workspaceHostId === requestOwner.workspaceHostId
      && active.routeHostId === requestOwner.routeHostId
      && active.backend === requestOwner.backend
      && active.connection === requestOwner.connection
      && active.connectionStatus === requestOwner.connectionStatus
      && (!requestOwner.connection || requestOwner.connection.get().status === requestOwner.connectionStatus);
  };
  const validSnapshot = (snapshot: ProjectMonitor | null, requestOwner: typeof owner) => snapshot === null || (
    snapshot.workspaceId === requestOwner.workspaceId
    && snapshot.cwd === requestOwner.cwd
    && snapshot.hostId === requestOwner.routeHostId
  );

  useEffect(() => {
    if (monitor) return;
    const storedId = window.localStorage?.getItem('apex-agent-profile') ?? null;
    setProfileId((current) => current && profilesAvailable.some((profile) => profile.id === current)
      ? current : defaultMonitorProfileId(profilesAvailable, storedId));
  }, [monitor, profilesAvailable]);

  useEffect(() => {
    componentAlive.current = true;
    return () => { componentAlive.current = false; };
  }, []);

  useEffect(() => {
    if (!connection) return;
    return connection.subscribe(() => setConnectionVersion((version) => version + 1));
  }, [connection]);

  useEffect(() => {
    let alive = true;
    const requestOwner = owner;
    const { workspaceId: id, routeHostId: hostId } = requestOwner;
    requestEpoch.current++;
    requestVersion.current++;
    const previous = shownOwner.current;
    const ownerChanged = !previous
      || previous.workspaceId !== requestOwner.workspaceId
      || previous.cwd !== requestOwner.cwd
      || previous.workspaceHostId !== requestOwner.workspaceHostId
      || previous.routeHostId !== requestOwner.routeHostId;
    if (ownerChanged) {
      shownOwner.current = { workspaceId: requestOwner.workspaceId, cwd: requestOwner.cwd, workspaceHostId: requestOwner.workspaceHostId, routeHostId: requestOwner.routeHostId };
      latestSnapshot.current = null;
      sourcesDirty.current = false;
      sourceEditVersion.current++;
      setResponsibility(''); setSelectedFiles([]); setSelectedThreads([]); setFileDraft(''); setNotice('');
    }
    mutationsPending.current = 0;
    setMonitor(null); setError(''); setLoadError(''); setLoading(true); setBusy(false);
    if (backend.demo) {
      setLoadError('The assistant needs the desktop app and an online project machine. Browser preview cannot run checks.');
      setLoading(false);
      return () => { alive = false; };
    }
    const status = requestOwner.connectionStatus as { kind?: string } | undefined;
    if (status && status.kind !== 'connected' && status.kind !== 'resync') {
      setLoadError('The assistant needs the project machine to be online.');
      setLoading(false);
      return () => { alive = false; };
    }
    const load = async () => {
      if (mutationsPending.current > 0 || !ownsCurrentRequest(requestOwner)) return;
      const version = ++requestVersion.current;
      try {
        const result = await backend.call<ProjectMonitor | null>('monitor_get', { workspaceId: id });
        if (!validSnapshot(result, requestOwner)) throw new Error('The assistant received a monitor for a different project folder or machine.');
        if (alive && componentAlive.current && ownsCurrentRequest(requestOwner) && requestVersion.current === version) {
          if (isOlderSnapshot(result)) return;
          latestSnapshot.current = result;
          setMonitor(result);
          setLoadError('');
          if (result && !sourcesDirty.current) { setSelectedFiles(result.files); setSelectedThreads(result.threads); }
          callbackRef.current?.(id, hostId, result);
        }
      } catch (cause) {
        if (alive && componentAlive.current && ownsCurrentRequest(requestOwner) && requestVersion.current === version) setLoadError(messageOf(cause));
      } finally {
        if (alive && componentAlive.current && ownsCurrentRequest(requestOwner) && requestVersion.current === version) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [backend, backend.host?.id, backend.host?.connection, workspace.id, workspace.path, workspace.hostId, connectionVersion]);

  const mutate = async (command: string, args: Record<string, unknown>) => {
    const requestOwner = owner;
    const { workspaceId, routeHostId: hostId } = requestOwner;
    const epoch = requestEpoch.current;
    const version = ++requestVersion.current;
    const sourceVersionAtStart = sourceEditVersion.current;
    const boundOwner = monitor ? { cwd: monitor.cwd, hostId: monitor.hostId, conversationId: monitor.conversationId } : {};
    mutationsPending.current++;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await backend.call<SourcesReply>(command, { workspaceId, ...args, ...boundOwner });
      if (!validSnapshot(result, requestOwner)) throw new Error('The assistant received a monitor for a different project folder or machine.');
      if (componentAlive.current && requestEpoch.current === epoch && ownsCurrentRequest(requestOwner) && requestVersion.current === version) {
        if (isOlderSnapshot(result)) return;
        latestSnapshot.current = result;
        setMonitor(result);
        if (command === 'monitor_assign') {
          sourcesDirty.current = false;
          sourceEditVersion.current++;
          setSelectedFiles(result.files); setSelectedThreads(result.threads);
        } else if (command === 'monitor_sources_update') {
          const removed = removedCount(result);
          setNotice(removed ? `Saved. Removed ${removed} deleted chat${removed === 1 ? '' : 's'} from sources.` : 'Saved.');
          if (sourceEditVersion.current === sourceVersionAtStart) {
            sourcesDirty.current = false;
            sourceEditVersion.current++;
            setSelectedFiles(result.files); setSelectedThreads(result.threads);
          } else if (!sourcesDirty.current) {
            setSelectedFiles(result.files); setSelectedThreads(result.threads);
          }
        } else if (!sourcesDirty.current) {
          setSelectedFiles(result.files); setSelectedThreads(result.threads);
        }
        callbackRef.current?.(workspaceId, hostId, result);
        // Starting to watch a project lands back on its conversation.
        if (command === 'monitor_assign') backRef.current();
      }
    } catch (cause) {
      if (componentAlive.current && requestEpoch.current === epoch && ownsCurrentRequest(requestOwner) && requestVersion.current === version) setError(messageOf(cause));
    } finally {
      if (requestEpoch.current === epoch && ownsCurrentRequest(requestOwner)) {
        mutationsPending.current = Math.max(0, mutationsPending.current - 1);
        if (componentAlive.current && mutationsPending.current === 0) setBusy(false);
      }
    }
  };

  const editFiles = (update: (current: string[]) => string[]) => {
    sourcesDirty.current = true;
    sourceEditVersion.current++;
    setNotice('');
    setSelectedFiles(update);
  };
  const editThreads = (update: (current: string[]) => string[]) => {
    sourcesDirty.current = true;
    sourceEditVersion.current++;
    setNotice('');
    setSelectedThreads(update);
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    const text = responsibility.trim();
    const profile = profilesAvailable.find((item) => item.id === profileId);
    if (!text || !profile) return;
    if (recentThreadIds.length && !window.confirm(`Include ${recentThreadIds.length} recent project chat${recentThreadIds.length === 1 ? '' : 's'} in assistant checks?`)) return;
    window.localStorage?.setItem('apex-agent-profile', profile.id);
    // The project's machine may not have this Mac's saved profiles, so send it.
    void mutate('monitor_assign', {
      cwd: owner.cwd, hostId: owner.routeHostId,
      text, files: [], threads: recentThreadIds, profile,
      onlyIfAbsent: true,
    });
  };

  const addFiles = (event: FormEvent) => {
    event.preventDefault();
    const added = parseProjectFiles(fileDraft);
    if (!added.length) return;
    editFiles((current) => [...new Set([...current, ...added])]);
    setFileDraft('');
  };

  const saveSources = () => {
    if (!monitor) return;
    void mutate('monitor_sources_update', {
      cwd: owner.cwd, hostId: owner.routeHostId, conversationId: monitor.conversationId,
      files: selectedFiles, threads: selectedThreads, mode: 'replace',
    });
  };

  const profileName = monitor
    ? profiles.find((profile) => profile.id === monitor.profileId)?.display_name ?? 'Saved profile — no longer in Agents'
    : '';
  // Chats the monitor still names but that no longer exist stay out of the list; the save reports them as removed.
  const watchedBody = monitor && <div className="apex-agent-sources-watched">
    <p className="apex-agent-sources-profile">AI profile · <strong>{profileName}</strong></p>
    <section className="apex-agent-sources-section">
      <h3>Chats</h3>
      {chatPanes.length === 0 && <p className="apex-agent-muted">No chats in this project yet.</p>}
      {chatPanes.map((pane) => <label className="apex-agent-sources-row" key={pane.id}>
        <input type="checkbox" checked={selectedThreads.includes(pane.id)} disabled={busy} onChange={(event) => editThreads((all) => event.target.checked ? [...all, pane.id] : all.filter((id) => id !== pane.id))} />
        <span>{pane.title}</span>
      </label>)}
    </section>
    <section className="apex-agent-sources-section">
      <h3>Files</h3>
      {selectedFiles.map((file) => <div className="apex-agent-sources-row" key={file}>
        <span>{file}</span>
        <button type="button" className="apex-agent-sources-remove" aria-label={`Remove ${file}`} disabled={busy} onClick={() => editFiles((all) => all.filter((item) => item !== file))}>✕</button>
      </div>)}
      {selectedFiles.length === 0 && <p className="apex-agent-muted">No files yet.</p>}
      <form className="apex-agent-sources-add" onSubmit={addFiles}>
        <input aria-label="Add a file path" placeholder="Path relative to the project" value={fileDraft} disabled={busy} onChange={(event) => setFileDraft(event.target.value)} />
        <button type="submit" disabled={busy || parseProjectFiles(fileDraft).length === 0}>Add file</button>
      </form>
    </section>
  </div>;
  // Save and a way out sit outside the scrolling list, so both stay on screen even if the top bar can't be reached.
  const saveBar = <div className="apex-agent-sources-actions apex-agent-sources-save">
    {monitor && notice && <p className="apex-agent-sources-notice" role="status">{notice}</p>}
    {monitor && <button className="primary" type="button" disabled={busy} onClick={saveSources}>{busy ? 'Saving…' : 'Save sources'}</button>}
    <button type="button" className="apex-agent-sources-done" onClick={onBack}>Done</button>
  </div>;

  const startForm = <form className="apex-agent-sources-start" onSubmit={start}>
    <p className="apex-agent-muted">{who} isn’t watching {workspace.name} yet.</p>
    {profilesAvailable.length === 0 && <p className="apex-agent-muted">Add an OpenAI-compatible HTTP or Claude Code profile in Agents before watching this project.</p>}
    {profilesAvailable.length > 0 && <label className="apex-agent-sources-field">AI profile
      <select value={profileId} onChange={(event) => { setProfileId(event.target.value); window.localStorage?.setItem('apex-agent-profile', event.target.value); }}>
        {profilesAvailable.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
      </select>
    </label>}
    <label className="apex-agent-sources-field">What should {who} keep on track in {workspace.name}?
      <textarea value={responsibility} onChange={(event) => setResponsibility(event.target.value)} rows={3} required />
    </label>
    <div className="apex-agent-sources-actions"><button className="primary" type="submit" disabled={busy || !responsibility.trim() || !profileId}>Start watching</button></div>
  </form>;

  const content = loading
    ? <p className="apex-agent-muted" role="status">Opening this project’s sources…</p>
    : monitor ? watchedBody : loadError ? null : startForm;

  return <section className="apex-agent-sources" role="region" aria-label={`Sources for ${workspace.name}`} onKeyDown={(event) => { if (event.key === 'Escape') onBack(); }}>
    <header className="apex-agent-sources-head">
      <button type="button" className="apex-agent-sources-back" onClick={onBack}>‹ Back to conversation</button>
      <button type="button" className="icon" onClick={onClose} aria-label={`Close ${who}`}>×</button>
    </header>
    <h2 className="apex-agent-sources-title">{`Sources · ${workspace.name}`}</h2>
    {(error || loadError) && <div className="apex-agent-error" role="alert">{error || loadError}</div>}
    <div className="apex-agent-sources-body">{content}</div>
    {saveBar}
  </section>;
}
