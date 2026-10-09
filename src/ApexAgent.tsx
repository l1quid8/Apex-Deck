import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend';
import type { Pane, ParticipantConfig, Workspace } from './types';
import { workspaceHost } from './hostSession.ts';
import { compatibleMonitorProfiles, defaultMonitorProfileId, monitorStatusLabel, parseProjectFiles, type MonitorEvidence, type ProjectMonitor } from './apexAgentModel.ts';

function time(value: number | null | undefined): string {
  if (!value) return 'Not yet';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ApexAgent({ workspace, backend, profiles, panes, onClose, onOpenThread, onMonitorChange, widgetMode = false, onHide, onCustomize }: {
  workspace: Workspace;
  backend: Backend;
  profiles: ParticipantConfig[];
  panes: Pane[];
  onClose: () => void;
  onOpenThread?: (id: string) => void;
  onMonitorChange?: (workspaceId: string, hostId: string, monitor: ProjectMonitor | null) => void;
  widgetMode?: boolean;
  onHide?: () => void;
  onCustomize?: () => void;
}) {
  const [monitor, setMonitor] = useState<ProjectMonitor | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [profileId, setProfileId] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedThreads, setSelectedThreads] = useState<string[]>([]);
  const [tab, setTab] = useState<'chat' | 'activity' | 'settings'>('chat');
  const [draft, setDraft] = useState('');
  const profilesAvailable = useMemo(() => compatibleMonitorProfiles(profiles), [profiles]);
  const requestVersion = useRef(0);
  const requestEpoch = useRef(0);
  const latestSnapshot = useRef<ProjectMonitor | null>(null);
  const sourcesDirty = useRef(false);
  const sourceEditVersion = useRef(0);
  const autoSuggestionStarted = useRef(false);
  const suggestSourcesRef = useRef<(() => Promise<void>) | null>(null);
  const sourceRequestVersion = useRef(0);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const callbackRef = useRef(onMonitorChange);
  callbackRef.current = onMonitorChange;
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
  const sourceSelectionOwner = useRef<{ workspaceId: string; cwd: string | null; workspaceHostId: string; routeHostId: string } | null>(null);
  const ownsSourceSelectionOwner = (requestOwner: typeof owner) => {
    const active = activeOwner.current;
    return active.workspaceId === requestOwner.workspaceId
      && active.cwd === requestOwner.cwd
      && active.workspaceHostId === requestOwner.workspaceHostId
      && active.routeHostId === requestOwner.routeHostId;
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
  const componentAlive = useRef(true);
  const mutationsPending = useRef(0);
  const chatThreads = panes.filter((pane) => pane.kind === 'chat' && pane.workspaceId === workspace.id && !pane.archived);
  const recentThreads = chatThreads.slice(-3);

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
    const previousSourceOwner = sourceSelectionOwner.current;
    const sourceOwnerChanged = !previousSourceOwner
      || previousSourceOwner.workspaceId !== requestOwner.workspaceId
      || previousSourceOwner.cwd !== requestOwner.cwd
      || previousSourceOwner.workspaceHostId !== requestOwner.workspaceHostId
      || previousSourceOwner.routeHostId !== requestOwner.routeHostId;
    if (sourceOwnerChanged) {
      sourceSelectionOwner.current = { workspaceId: requestOwner.workspaceId, cwd: requestOwner.cwd, workspaceHostId: requestOwner.workspaceHostId, routeHostId: requestOwner.routeHostId };
      latestSnapshot.current = null;
      sourcesDirty.current = false;
      sourceEditVersion.current++;
      autoSuggestionStarted.current = false;
      sourceRequestVersion.current++;
      setResponsibility(''); setDraft(''); setSelectedFiles([]); setSelectedThreads(recentThreads.map((pane) => pane.id)); setTab('chat'); setSourcesLoading(false);
    }
    mutationsPending.current = 0;
    setMonitor(null); setError(''); setLoading(true); setBusy(false);
    if (backend.demo) {
      setError('ApexAgent needs the desktop app and an online project machine. Browser preview cannot run checks.');
      setLoading(false);
      return () => { alive = false; };
    }
    const status = requestOwner.connectionStatus as { kind?: string } | undefined;
    if (status && status.kind !== 'connected' && status.kind !== 'resync') {
      setError('ApexAgent needs the project machine to be online.');
      setLoading(false);
      return () => { alive = false; };
    }
    const load = async () => {
      if (mutationsPending.current > 0 || !ownsCurrentRequest(requestOwner)) return;
      const version = ++requestVersion.current;
      try {
        const result = await backend.call<ProjectMonitor | null>('monitor_get', { workspaceId: id });
        if (!validSnapshot(result, requestOwner)) throw new Error('ApexAgent received a monitor for a different project folder or machine.');
        if (alive && componentAlive.current && ownsCurrentRequest(requestOwner) && requestVersion.current === version) {
          if (isOlderSnapshot(result)) return;
          latestSnapshot.current = result;
          setMonitor(result);
          if (result && !sourcesDirty.current) { setSelectedFiles(result.files); setSelectedThreads(result.threads); }
          callbackRef.current?.(id, hostId, result);
          if (result === null && !autoSuggestionStarted.current) {
            autoSuggestionStarted.current = true;
            void suggestSourcesRef.current?.();
          }
        }
      } catch (cause) {
        if (alive && componentAlive.current && ownsCurrentRequest(requestOwner) && requestVersion.current === version) setError(cause instanceof Error ? cause.message : String(cause));
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
    const boundOwner = monitor ? { cwd: monitor.cwd, hostId: monitor.hostId, conversationId: monitor.conversationId } : {};
    mutationsPending.current++;
    setBusy(true); setError('');
    try {
      const result = await backend.call<ProjectMonitor>(command, { workspaceId, ...args, ...boundOwner });
      if (!validSnapshot(result, requestOwner)) throw new Error('ApexAgent received a monitor for a different project folder or machine.');
      if (componentAlive.current && requestEpoch.current === epoch && ownsCurrentRequest(requestOwner) && requestVersion.current === version) {
        if (isOlderSnapshot(result)) return;
        latestSnapshot.current = result;
        setMonitor(result);
        if (command === 'monitor_assign' || command === 'monitor_sources_update') {
          sourcesDirty.current = false;
          sourceEditVersion.current++;
          setSelectedFiles(result.files); setSelectedThreads(result.threads);
        } else if (!sourcesDirty.current) {
          setSelectedFiles(result.files); setSelectedThreads(result.threads);
        }
        callbackRef.current?.(workspaceId, hostId, result);
      }
    } catch (cause) {
      if (componentAlive.current && requestEpoch.current === epoch && ownsCurrentRequest(requestOwner) && requestVersion.current === version) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestEpoch.current === epoch && ownsCurrentRequest(requestOwner)) {
        mutationsPending.current = Math.max(0, mutationsPending.current - 1);
        if (componentAlive.current && mutationsPending.current === 0) setBusy(false);
      }
    }
  };

  const assign = (event: React.FormEvent) => {
    event.preventDefault();
    if (!responsibility.trim() || !profileId) return;
    const profile = profilesAvailable.find((item) => item.id === profileId);
    if (!profile) return;
    if (selectedThreads.length && !window.confirm(`Include ${selectedThreads.length} recent project chat${selectedThreads.length === 1 ? '' : 's'} in ApexAgent checks?`)) return;
    window.localStorage?.setItem('apex-agent-profile', profileId);
    // The project's machine may not have this Mac's saved profiles, so send it.
    void mutate('monitor_assign', {
      cwd: owner.cwd, hostId: owner.routeHostId,
      text: responsibility.trim(), files: selectedFiles, threads: selectedThreads, profile,
      onlyIfAbsent: true,
    });
  };
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    const text = draft.trim(); setDraft(''); void mutate('monitor_message', { text });
  };
  const openEvidence = (evidence: MonitorEvidence) => {
    const thread = chatThreads.find((pane) => pane.id === evidence.sourceId);
    if (thread) { onOpenThread?.(thread.id); return; }
    void backend.openTarget(evidence.sourceId.replace(/^file:/, ''), workspace.path || null, false).catch((cause) => setError(String(cause)));
  };

  const editFiles = (update: (current: string[]) => string[]) => {
    sourcesDirty.current = true;
    sourceEditVersion.current++;
    setSelectedFiles(update);
  };
  const editThreads = (update: (current: string[]) => string[]) => {
    sourcesDirty.current = true;
    sourceEditVersion.current++;
    setSelectedThreads(update);
  };

  const suggestSources = async () => {
    const requestOwner = owner;
    const epoch = requestEpoch.current;
    const version = requestVersion.current;
    const editVersion = sourceEditVersion.current;
    const sourceRequestId = ++sourceRequestVersion.current;
    setSourcesLoading(true); setError('');
    try {
      const result = await backend.call<{ files: string[] }>('monitor_suggest_sources', { cwd: requestOwner.cwd });
      if (!componentAlive.current || requestEpoch.current !== epoch || requestVersion.current !== version || sourceEditVersion.current !== editVersion || !ownsCurrentRequest(requestOwner)) return;
      const files = parseProjectFiles((result?.files ?? []).join('\n'));
      if (files.length) {
        sourcesDirty.current = true;
        setSelectedFiles((current) => [...new Set([...current, ...files])]);
      }
    } catch (cause) {
      if (componentAlive.current && requestEpoch.current === epoch && ownsCurrentRequest(requestOwner)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (componentAlive.current && sourceRequestVersion.current === sourceRequestId && ownsSourceSelectionOwner(requestOwner)) setSourcesLoading(false);
    }
  };
  suggestSourcesRef.current = suggestSources;

  const updateSources = () => {
    if (!monitor) return;
    void mutate('monitor_sources_update', {
      cwd: owner.cwd, hostId: owner.routeHostId, conversationId: monitor.conversationId,
      files: selectedFiles, threads: selectedThreads, mode: 'replace',
    });
  };

  const findings = (monitor?.findings ?? []).filter((finding) => finding.status === 'open' && !(finding.snoozedUntil && finding.snoozedUntil > Date.now()));
  const findingCards = findings.length > 0 && <div className="apex-agent-findings"><strong>Open findings</strong>{findings.map((finding) => <article key={finding.id} className={finding.status === 'open' ? '' : 'settled'}>
    <div><span>{finding.summary}</span><small>{finding.confidence === 'observed' ? 'Observed' : finding.confidence === 'inferred' ? 'Inferred' : 'Unverified'} · {finding.reason}</small></div>
    {finding.evidence.map((item, index) => <button key={index} className="apex-agent-evidence-link" onClick={() => openEvidence(item)} title={item.excerpt}>{item.label}<small>{item.excerpt}</small></button>)}
    {finding.status === 'open' && <div className="apex-agent-buttons"><button disabled={busy} onClick={() => void mutate('monitor_resolve', { findingId: finding.id, status: 'resolved' })}>Resolve</button><button disabled={busy} onClick={() => void mutate('monitor_resolve', { findingId: finding.id, status: 'dismissed' })}>Dismiss</button><button disabled={busy} onClick={() => void mutate('monitor_resolve', { findingId: finding.id, status: 'snoozed', snoozedUntil: Date.now() + 24 * 60 * 60 * 1000 })}>Snooze</button></div>}
  </article>)}</div>;

  const chatView = loading ? <div className="apex-agent-empty" role="status">Opening this project’s conversation…</div> : monitor ? <>
    <div className="apex-agent-transcript" aria-live="polite">
      {monitor.messages.map((message) => <article className={`apex-agent-message ${message.role}`} key={message.id}>
        <div className="apex-agent-message-role">{message.role === 'human' ? 'You' : 'ApexAgent'} <time>{time(message.at)}</time></div>
        <p>{message.text}</p>
        {message.evidence.length > 0 && <div className="apex-agent-evidence">{message.evidence.map((item, index) => <button key={`${item.sourceId}:${index}`} onClick={() => openEvidence(item)} title={item.excerpt}>{item.label}<small>{item.excerpt}</small></button>)}</div>}
      </article>)}
      {monitor.messages.length === 0 && <div className="apex-agent-empty">ApexAgent is ready to talk about {workspace.name}.</div>}
      {findingCards}
    </div>
    <form className="apex-agent-composer" onSubmit={send}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message ApexAgent about this project…" aria-label="Message ApexAgent" rows={2} />
      <button className="primary" disabled={busy || !draft.trim()}>Send</button>
    </form>
  </> : <div className="apex-agent-setup">
    <div className="apex-agent-intro"><strong>Hi, I’m ApexAgent.</strong><p>I’ll keep an eye on {workspace.name} and help you stay on top of the work. What should I take responsibility for?</p></div>
    {profilesAvailable.length === 0 && <div className="apex-agent-empty">Add a Claude Code, Codex, Grok or OpenAI-compatible text profile in Agents before assigning ApexAgent.</div>}
    {recentThreads.length > 0 && <fieldset className="apex-agent-recent"><legend>Recent project chats <span>Up to 3 are selected for context</span></legend>{recentThreads.map((pane) => <label className="apex-agent-chip" key={pane.id}><input type="checkbox" checked={selectedThreads.includes(pane.id)} onChange={(event) => editThreads((all) => event.target.checked ? [...all, pane.id] : all.filter((id) => id !== pane.id))} />{pane.title}</label>)}</fieldset>}
    <div className="apex-agent-source-picker"><button type="button" disabled={sourcesLoading || busy} onClick={() => void suggestSources()}>{sourcesLoading ? 'Looking for project files…' : 'Suggest local files'}</button><div className="apex-agent-chips">{selectedFiles.map((file) => <button type="button" className="apex-agent-chip removable" key={file} onClick={() => editFiles((all) => all.filter((item) => item !== file))}>{file}<span aria-hidden="true">×</span><span className="sr-only">Remove {file}</span></button>)}{!selectedFiles.length && <span className="apex-agent-muted">No local files selected</span>}</div></div>
    {profilesAvailable.length > 0 && <form className="apex-agent-setup-form" onSubmit={assign}><textarea value={responsibility} onChange={(event) => setResponsibility(event.target.value)} placeholder={`Tell ApexAgent what to own in ${workspace.name}…`} aria-label="Responsibility for ApexAgent" rows={3} required /><button className="primary" disabled={busy || !responsibility.trim() || !profileId}>Assign responsibility</button></form>}
  </div>;

  const activityView = monitor && <div className="apex-agent-activity-view">
    <div className="apex-agent-controls"><div><strong>Activity</strong><p>Last checked {time(monitor.lastCheckedAt)} · Next check {time(monitor.nextCheckAt)}{monitor.wakeReason ? ` · ${monitor.wakeReason}` : ''}</p><p>{monitor.responsibility}</p><p>Next: {monitor.nextStep || 'Waiting for the next check'}</p>{!!monitor.decisions.length && <p>Decisions: {monitor.decisions.join(' · ')}</p>}{!!monitor.preferences.length && <p>Preferences: {monitor.preferences.join(' · ')}</p>}</div><div className="apex-agent-buttons"><button disabled={busy} onClick={() => void mutate('monitor_pause', { paused: !monitor.paused })}>{monitor.paused ? 'Resume' : 'Pause'}</button><button disabled={busy || monitor.paused} onClick={() => void mutate('monitor_check_now', {})}>Check now</button></div></div>
    {monitor.findings.map((finding) => <div className="apex-agent-activity-row" key={finding.id}><span>{finding.summary}</span><span>{finding.status}</span></div>)}
    {monitor.activity.map((item, index) => <div className="apex-agent-activity-row" key={`${item.at}:${index}`}><time>{time(item.at)}</time><span>{item.summary}</span></div>)}
  </div>;
  const settingsView = <div className="apex-agent-settings">
    {monitor ? <><h2>Current assignment</h2><p>{monitor.responsibility}</p><label>Saved profile<input readOnly value={profiles.find((profile) => profile.id === monitor.profileId)?.display_name ?? monitor.profileId} /></label><p className="apex-agent-muted">The profile is saved with this assignment. Choose a profile when creating a new assignment.</p><h2>Sources</h2><div className="apex-agent-chips">{selectedFiles.map((file) => <button type="button" className="apex-agent-chip removable" key={file} onClick={() => editFiles((all) => all.filter((item) => item !== file))}>{file}<span aria-hidden="true">×</span><span className="sr-only">Remove {file}</span></button>)}{!selectedFiles.length && <span className="apex-agent-muted">No files selected</span>}</div><button type="button" disabled={busy || sourcesLoading} onClick={() => void suggestSources()}>Suggest local files</button><fieldset className="apex-agent-recent"><legend>Project chats</legend>{chatThreads.map((pane) => <label className="apex-agent-chip" key={pane.id}><input type="checkbox" checked={selectedThreads.includes(pane.id)} onChange={(event) => editThreads((all) => event.target.checked ? [...all, pane.id] : all.filter((id) => id !== pane.id))} />{pane.title}</label>)}</fieldset><button className="primary" type="button" disabled={busy} onClick={updateSources}>Save sources</button></> : <><h2>New assignment</h2><label>Chat profile<select value={profileId} onChange={(event) => { setProfileId(event.target.value); window.localStorage?.setItem('apex-agent-profile', event.target.value); }}><option value="">Choose a saved profile</option>{profilesAvailable.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}</select></label><p className="apex-agent-muted">This profile will be used for this and future assignments.</p></>}
    {onHide && <button type="button" onClick={onHide}>Hide widget (keep watching)</button>}
    {onCustomize && <button type="button" onClick={onCustomize}>Appearance and quiet hours</button>}
  </div>;
  const panel = <section className={`apex-agent${widgetMode ? ' widget' : ''}`} role={widgetMode ? 'region' : 'dialog'} aria-modal={widgetMode ? undefined : true} aria-label={`ApexAgent for ${workspace.name}`}>
    {!widgetMode && <header className="apex-agent-head"><div><span className="eyebrow">ApexAgent · {workspace.name}</span><h1>{monitor?.responsibility || 'Project conversation'}</h1></div><div className="apex-agent-head-actions">{monitor && <span className={`apex-agent-status ${monitor.paused ? 'paused' : ''}`}>{monitorStatusLabel(monitor)}</span>}<button className="icon" onClick={onClose} aria-label="Close ApexAgent">×</button></div></header>}
    {error && <div className="apex-agent-error" role="alert">{error}</div>}
    <nav className="apex-agent-tabs" aria-label="ApexAgent views">{(['chat', 'activity', 'settings'] as const).map((view) => <button key={view} className={tab === view ? 'active' : ''} onClick={() => setTab(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</nav>
    <div className="apex-agent-tabpanel">{tab === 'chat' ? chatView : tab === 'activity' ? (activityView ?? <div className="apex-agent-empty">Activity appears after you assign ApexAgent.</div>) : settingsView}</div>
    {busy && <div className="apex-agent-busy" role="status">Saving…</div>}
  </section>;
  return widgetMode ? panel : <div className="apex-agent-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{panel}</div>;
}
