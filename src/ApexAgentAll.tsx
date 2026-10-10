import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from './types';
import { mergeProjectConversations, replyTarget, type MonitorEvidence, type ProjectMonitor } from './apexAgentModel.ts';

const DAY = 24 * 60 * 60 * 1000;

function evidenceList(items: MonitorEvidence[]) {
  if (!items.length) return null;
  return <ul className="apex-agent-all-evidence">{items.map((item, index) => <li key={index}><strong>{item.label}</strong>{item.excerpt && <span> · “{item.excerpt}”</span>}</li>)}</ul>;
}

/** One conversation across every watched project. Replies go to the project they name, or the last one discussed. */
export function ApexAgentAll({ workspaces, monitors, onReply, onMutate, onSetUp, onClose, onHide, onCustomize, clearedAt = 0, onClear, fullScreen = false, onFullScreen }: {
  workspaces: Workspace[];
  monitors: ProjectMonitor[];
  onReply: (workspaceId: string, text: string) => Promise<void>;
  onMutate: (workspaceId: string, command: string, args: Record<string, unknown>) => Promise<void>;
  onSetUp: (workspaceId: string) => void;
  onClose: () => void;
  onHide?: () => void;
  onCustomize?: () => void;
  /** Messages at or before this time are hidden; each project's assistant still remembers them. */
  clearedAt?: number;
  onClear?: () => void;
  fullScreen?: boolean;
  onFullScreen?: () => void;
}) {
  const names = useMemo(() => Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const watched = workspaces.filter((workspace) => monitors.some((monitor) => monitor.workspaceId === workspace.id));
  const allEntries = useMemo(() => mergeProjectConversations(monitors, names), [monitors, names]);
  const entries = useMemo(() => allEntries.filter((entry) => entry.message.at > clearedAt), [allEntries, clearedAt]);
  const now = Date.now();
  const findings = monitors.flatMap((monitor) => monitor.findings
    .filter((finding) => finding.status === 'open' && !(finding.snoozedUntil && finding.snoozedUntil > now))
    .map((finding) => ({ workspaceId: monitor.workspaceId, finding })));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  // The project a draft continues is fixed when typing starts, so a background message can't redirect it.
  const [draftFallback, setDraftFallback] = useState<string | null>(null);
  // Clear only hides messages, so the project last discussed is still taken from the full history.
  const lastSpoken = allEntries[allEntries.length - 1]?.workspaceId ?? null;
  const target = replyTarget(text, watched.map((workspace) => ({ id: workspace.id, name: workspace.name })), focus ?? draftFallback ?? lastSpoken);
  const bottom = useRef<HTMLDivElement | null>(null);
  // `busy` only updates on the next render; this blocks a second Enter pressed before then.
  const sending = useRef(false);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: 'end' }); }, [entries.length, findings.length]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (busy || sending.current || !message || !target) return;
    sending.current = true;
    // Empty the box now so anything typed while waiting survives; a failed send restores the message only into an empty box.
    setText(''); setDraftFallback(null); setFocus(target);
    void run(async () => {
      try { await onReply(target, message); } catch (cause) { setText((current) => current.trim() ? current : message); throw cause; } finally { sending.current = false; }
    });
  };
  const anyPaused = monitors.some((monitor) => monitor.paused);
  const failed = monitors.filter((monitor) => monitor.error && !monitor.paused);
  const pausedCount = monitors.filter((monitor) => monitor.paused).length;
  const watchingCount = monitors.length - pausedCount;
  const projectsWord = (count: number) => `${count} project${count === 1 ? '' : 's'}`;
  const status = !monitors.length ? 'Not watching any project yet'
    : [watchingCount ? `Watching ${projectsWord(watchingCount)}` : `Paused · ${projectsWord(pausedCount)}`,
      watchingCount && pausedCount ? `${pausedCount} paused` : '',
      failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed` : '',
      findings.length ? `${findings.length} need${findings.length === 1 ? 's' : ''} you` : ''].filter(Boolean).join(' · ');
  const unwatched = workspaces.filter((workspace) => !monitors.some((monitor) => monitor.workspaceId === workspace.id));

  return <section className="apex-agent widget apex-agent-all" role="region" aria-label="ApexAgent">
    <header className="apex-agent-head">
      <div className="apex-agent-head-row">
        <div className="apex-agent-brand"><h1>ApexAgent</h1></div>
        <div className="apex-agent-head-actions"><details className="apex-agent-more"><summary aria-label="More ApexAgent options">⋯</summary><div role="menu">
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { for (const monitor of monitors) if (monitor.paused === anyPaused) await onMutate(monitor.workspaceId, 'monitor_pause', { paused: !anyPaused }); })}>{anyPaused ? 'Resume watching' : 'Pause'}</button>}
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy || anyPaused} onClick={() => void run(async () => { for (const monitor of monitors) await onMutate(monitor.workspaceId, 'monitor_check_now', {}); })}>Check now</button>}
          {onClear && !!entries.length && <button type="button" role="menuitem" onClick={() => { if (window.confirm('Clear this conversation? Things that need you stay until you resolve them.')) onClear(); }}>Clear conversation</button>}
          {onCustomize && <button type="button" role="menuitem" onClick={onCustomize}>Quiet hours</button>}
          {onHide && <button type="button" role="menuitem" onClick={onHide}>Hide</button>}
          {workspaces.map((workspace) => <button type="button" role="menuitem" key={workspace.id} onClick={() => onSetUp(workspace.id)}>{monitors.some((monitor) => monitor.workspaceId === workspace.id) ? `Sources for ${workspace.name}` : `Watch ${workspace.name}…`}</button>)}
        </div></details>{onFullScreen && <button className="icon" onClick={onFullScreen} aria-pressed={fullScreen} aria-label={fullScreen ? 'Exit full screen' : 'Full screen'} title={fullScreen ? 'Exit full screen' : 'Full screen'}>{fullScreen ? '⤡' : '⤢'}</button>}<button className="icon" onClick={onClose} aria-label="Close ApexAgent">×</button></div>
      </div>
      <div className="apex-agent-head-row apex-agent-head-context"><p>{status}</p></div>
    </header>
    {error && <div className="apex-agent-error" role="alert">{error}</div>}
    <div className="apex-agent-tabpanel"><div className="assistant-chat-transcript" aria-live="polite">
      {entries.map(({ workspaceId, project, message }) => <article className={`assistant-chat-message ${message.role}`} key={`${workspaceId}:${message.id}`}>
        <small>{message.role === 'human' ? 'You' : 'ApexAgent'} · <button type="button" className="apex-agent-project-tag" onClick={() => setFocus(workspaceId)} title={`Reply about ${project}`}>{project}</button></small>
        <p>{message.text}</p>
        {evidenceList(message.evidence ?? [])}
      </article>)}
      {failed.map((monitor) => <article className="assistant-chat-message assistant apex-agent-check-failed" key={`failed:${monitor.workspaceId}`}>
        <small>Last check failed · {names[monitor.workspaceId] ?? 'Project'}</small>
        <p title={monitor.error ?? ''}>{monitor.error}</p>
        <div className="apex-agent-buttons"><button disabled={busy} onClick={() => void run(() => onMutate(monitor.workspaceId, 'monitor_check_now', {}))}>Retry</button></div>
      </article>)}
      {!monitors.length && <div className="apex-agent-intro"><strong>Hi, I’m ApexAgent.</strong><p>I keep up with all your projects in one conversation. Pick a project to watch from ⋯ and tell me what to keep on track.</p></div>}
      {findings.map(({ workspaceId, finding }) => <article className="assistant-chat-message assistant apex-agent-needs-you" key={`${workspaceId}:${finding.id}`}>
        <small>Needs you · {names[workspaceId] ?? 'Project'}</small>
        <p>{finding.summary}</p>
        {finding.reason && <p className="apex-agent-muted">{finding.confidence === 'observed' ? 'Observed' : finding.confidence === 'inferred' ? 'Inferred' : 'Unverified'} · {finding.reason}</p>}
        {evidenceList(finding.evidence ?? [])}
        <div className="apex-agent-buttons">
          <button disabled={busy} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'resolved' }))}>Resolve</button>
          <button disabled={busy} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'snoozed', snoozedUntil: Date.now() + DAY }))}>Remind me tomorrow</button>
        </div>
      </article>)}
      {!!monitors.length && !!unwatched.length && entries.length === 0 && <p className="apex-agent-muted">Not watching yet: {unwatched.map((workspace) => workspace.name).join(', ')}.</p>}
      <div ref={bottom} />
    </div></div>
    {!!watched.length && <form className="apex-agent-all-composer" onSubmit={send}>
      <textarea value={text} onChange={(event) => { const value = event.target.value; if (!value.trim()) setDraftFallback(null); else if (!text.trim()) setDraftFallback(focus ?? lastSpoken); setText(value); }} rows={2} aria-label="Message ApexAgent" placeholder="Ask about any project…"
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div><small className="apex-agent-muted">{target ? `About ${names[target]}` : ''}{watched.length > 1 ? ' · name a project to switch' : ''}</small><button className="primary" disabled={busy || !text.trim() || !target}>{busy ? 'Sending…' : 'Send'}</button></div>
    </form>}
    {busy && <div className="apex-agent-busy" role="status">Saving…</div>}
  </section>;
}
