import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Workspace } from './types';
import { mergeProjectConversations, replyTarget, type MonitorEvidence, type ProjectMonitor } from './apexAgentModel.ts';
import type { PersonalLane, PersonalMessage, PersonalTask } from './personalAssistant.ts';
import { PersonalPanels, type PanelName } from './PersonalPanels.tsx';
import './personal-panels.css';
import { PersonalCall } from './PersonalCall.tsx';
import './personal-call.css';

export type ApexAgentTaskContext = { id: string; project: string; label: string; send: (text: string) => Promise<void> };

const DAY = 24 * 60 * 60 * 1000;
/** The personal assistant's lane in the conversation. No workspace uses this id. */
const PERSONAL = 'personal';
const PERSONAL_STATUS: Record<string, string> = { needsYou: 'Needs you', queued: 'Approved', running: 'Running', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const everyText = (ms: number) => `every ${Math.round(ms / 60000)} min`;
const whenText = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Text with ``` fences shown as preformatted blocks. */
function fenced(text: string) {
  return text.split('```').map((part, index) => index % 2 ? <pre key={index}>{part.replace(/^\n/, '').replace(/\n$/, '')}</pre> : part.trim() ? <p key={index}>{part.trim()}</p> : null);
}

function evidenceList(items: MonitorEvidence[], open?: (item: MonitorEvidence) => void) {
  if (!items.length) return null;
  return <ul className="apex-agent-all-evidence">{items.map((item, index) => <li key={index}><button type="button" onClick={() => open?.(item)} disabled={!open}><strong>{item.label}</strong></button>{item.excerpt && <span> · “{item.excerpt}”</span>}</li>)}</ul>;
}

/** One conversation across every watched project. Replies go to the project they name, or the last one discussed. */
export function ApexAgentAll({ workspaces, monitors, onReply, onMutate, onSetUp, onClose, onHide, onCustomize, clearedAt = 0, onClear, fullScreen = false, onFullScreen, offlineWorkspaceIds = [], onOpenEvidence, onOverview, overviewEntries = [], tasks, taskContext = null, onClearTaskContext, personal = null }: {
  /** The personal assistant on its durable host, shown as one more lane in this conversation. */
  personal?: PersonalLane | null;
  offlineWorkspaceIds?: string[];
  onOpenEvidence?: (workspaceId: string, evidence: MonitorEvidence) => Promise<void>;
  onOverview?: (text: string) => Promise<void>;
  overviewEntries?: (ReturnType<typeof mergeProjectConversations>[number] & { citations?: { workspaceId: string; evidence: MonitorEvidence }[] })[];
  tasks?: ReactNode;
  taskContext?: ApexAgentTaskContext | null;
  onClearTaskContext?: () => void;
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
  const assistant = personal?.assistant ?? null;
  const personalTag = personal ? `${personal.name} · ${personal.hostName}` : '';
  // Projects plus the personal assistant: a reply goes to whichever is named, or the last one discussed.
  const lanes = [...watched.map((workspace) => ({ id: workspace.id, name: workspace.name })), ...(assistant ? [{ id: PERSONAL, name: personal!.name }] : [])];
  const laneNames: Record<string, string> = assistant ? { ...names, [PERSONAL]: personalTag } : names;
  const personalEntries = useMemo(() => (assistant?.messages ?? []).map((item: PersonalMessage) => ({
    workspaceId: PERSONAL, project: personalTag, personal: item,
    message: { id: item.id, role: item.role === 'human' ? 'human' : 'assistant', text: item.text, at: item.at, evidence: [] as MonitorEvidence[] },
  })), [assistant, personalTag]);
  const allEntries = useMemo(() => [...mergeProjectConversations(monitors, names), ...overviewEntries, ...personalEntries].sort((a, b) => a.message.at - b.message.at), [monitors, names, overviewEntries, personalEntries]);
  const entries = useMemo(() => allEntries.filter((entry) => entry.message.at > clearedAt), [allEntries, clearedAt]);
  const now = Date.now();
  const findings = monitors.flatMap((monitor) => monitor.findings
    .filter((finding) => finding.status === 'open' && !(finding.snoozedUntil && finding.snoozedUntil > now))
    .map((finding) => ({ workspaceId: monitor.workspaceId, finding })));
  const [text, setText] = useState('');
  const [draftTaskContext, setDraftTaskContext] = useState<ApexAgentTaskContext | null | undefined>(undefined);
  const selectedTaskContext = draftTaskContext === undefined ? taskContext : draftTaskContext;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  // The assistant's detail panels open as a sheet over the transcript.
  const [panelOpen, setPanelOpen] = useState<PanelName | null>(null);
  const [calling, setCalling] = useState(false);
  const openPanel = (name: PanelName, event?: { currentTarget: EventTarget | null }) => {
    (event?.currentTarget as HTMLElement | null | undefined)?.closest?.('details')?.removeAttribute('open');
    setPanelOpen(name);
  };
  // The project a draft continues is fixed when typing starts, so a background message can't redirect it.
  const [draftFallback, setDraftFallback] = useState<string | null>(null);
  // Clear only hides messages, so the project last discussed is still taken from the full history.
  const lastSpoken = allEntries[allEntries.length - 1]?.workspaceId ?? null;
  const fallbackLane = focus ?? draftFallback ?? lastSpoken ?? (assistant ? PERSONAL : null);
  const target = replyTarget(text, lanes, fallbackLane);
  // Consume longer names first so "Mobile launch" does not also select "Mobile".
  let unmatched = text;
  const namedProjects = [...lanes].sort((a, b) => b.name.length - a.name.length).filter((workspace) => {
    const name = workspace.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${name}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    if (!pattern.test(unmatched)) return false;
    unmatched = unmatched.replace(pattern, ' '); return true;
  });
  const globalReply = !!onOverview && (/\b(everywhere|all (?:my |the )?(?:projects|threads)|across (?:my |the )?projects|overall)\b/i.test(text) || namedProjects.length > 1 || (!namedProjects.length && (fallbackLane === '*' || !fallbackLane)));
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
    if (busy || sending.current || !message || (!selectedTaskContext && !target && !globalReply)) return;
    sending.current = true;
    // Empty the box now so anything typed while waiting survives; a failed send restores the message only into an empty box.
    const capturedTask = selectedTaskContext;
    setText(''); setDraftFallback(null); setDraftTaskContext(undefined); setFocus(globalReply ? '*' : target);
    void run(async () => {
      try { if (capturedTask) await capturedTask.send(message); else if (globalReply) await onOverview!(message); else if (target === PERSONAL) await personal!.send(message); else await onReply(target!, message); } catch (cause) { setText((current) => { if (current.trim()) return current; setDraftTaskContext(capturedTask); return message; }); throw cause; } finally { sending.current = false; }
    });
  };
  const online = monitors.filter((monitor) => !offlineWorkspaceIds.includes(monitor.workspaceId));
  const active = online.filter((monitor) => !monitor.completed);
  const anyPaused = active.some((monitor) => monitor.paused);
  const failed = active.filter((monitor) => monitor.error && !monitor.paused);
  const pausedCount = active.filter((monitor) => monitor.paused).length;
  const watchingCount = active.filter((monitor) => !monitor.paused && !monitor.error && !monitor.activeCheck).length;
  const checkingCount = active.filter((monitor) => !monitor.paused && monitor.activeCheck).length;
  const status = !monitors.length ? 'Not watching any project yet' : [
    watchingCount ? `Watching ${watchingCount} project${watchingCount === 1 ? '' : 's'}` : '',
    checkingCount ? `${checkingCount} checking` : '',
    pausedCount ? `${pausedCount} paused` : '',
    online.filter((monitor) => monitor.completed).length ? `${online.filter((monitor) => monitor.completed).length} complete` : '',
    monitors.length - online.length ? `${monitors.length - online.length} offline` : '',
    failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed` : '',
    findings.length ? `${findings.length} need${findings.length === 1 ? 's' : ''} you` : '',
  ].filter(Boolean).join(' · ');
  const personalWaiting = (assistant?.tasks ?? []).filter((task) => task.status === 'needsYou' && task.decision?.status === 'open').length;
  const personalStatus = !personal ? '' : personal.offline ? `${personal.name} on ${personal.hostName} · Offline` : assistant ? `${personal.name} on ${personal.hostName}${assistant.paused ? ' · Paused' : ''}${personalWaiting ? ` · ${personalWaiting} need${personalWaiting === 1 ? 's' : ''} you` : ''}` : '';
  const headline = [monitors.length || !personalStatus ? status : '', personalStatus].filter(Boolean).join(' · ');
  const unseenNotices = (assistant?.notices ?? []).filter((notice) => notice.deliveredAt && !notice.seenAt).length;
  // Which machine a task runs on: the assistant's own, or another machine it knows by name.
  const machineOf = (task: PersonalTask) => {
    const host = task.operation?.host;
    if (!assistant || !host || host === assistant.hostId) return personal?.hostName ?? '';
    return assistant.machines?.find((machine) => machine.hostId === host)?.name ?? host;
  };
  const planRows = (plan: NonNullable<PersonalTask['operation']>['plan']) => {
    if (!plan) return null;
    const until = plan.until ? [plan.until.exitCode !== undefined ? `exit code ${plan.until.exitCode}` : '', plan.until.outputContains ? `output contains “${plan.until.outputContains}”` : '', plan.until.outputLacks ? `output lacks “${plan.until.outputLacks}”` : ''].filter(Boolean).join(', ') : '';
    return <>
      {plan.startAt !== undefined && <><dt>Starts</dt><dd>{whenText(plan.startAt)}</dd></>}
      {plan.everyMs !== undefined && <><dt>Repeats</dt><dd>{everyText(plan.everyMs)}{plan.maxRuns !== undefined ? `, up to ${plan.maxRuns} runs` : ''}</dd></>}
      {until && <><dt>Stops when</dt><dd>{until}</dd></>}
      {plan.deadlineAt !== undefined && <><dt>Deadline</dt><dd>{whenText(plan.deadlineAt)}</dd></>}
      {plan.after && <><dt>After</dt><dd>task {plan.after}</dd></>}
    </>;
  };
  const cadenceOf = (schedule: { everyMs?: number; dailyAt?: string }) => schedule.everyMs ? everyText(schedule.everyMs) : schedule.dailyAt ? `Daily at ${schedule.dailyAt}` : 'Scheduled';
  const taskOf = (id?: string): PersonalTask | undefined => assistant?.tasks.find((task) => task.id === id);
  // Only the newest approval line for a task carries its buttons.
  const lastApproval = new Map<string, string>();
  for (const item of assistant?.messages ?? []) if (item.kind === 'approval' && item.taskId) lastApproval.set(item.taskId, item.id);
  // A task that's approved or running can be stopped from its newest line.
  const lastLine = new Map<string, string>();
  for (const item of assistant?.messages ?? []) if (item.taskId) lastLine.set(item.taskId, item.id);
  const batch = async (items: ProjectMonitor[], command: string, args: Record<string, unknown>) => {
    const results = await Promise.allSettled(items.map((monitor) => onMutate(monitor.workspaceId, command, args)));
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${names[items[index].workspaceId]}: ${String(result.reason)}`] : []);
    if (errors.length) throw new Error(errors.join(' · '));
  };
  const unwatched = workspaces.filter((workspace) => !monitors.some((monitor) => monitor.workspaceId === workspace.id));

  return <section className="apex-agent widget apex-agent-all" role="region" aria-label="ApexAgent">
    <header className="apex-agent-head">
      <div className="apex-agent-head-row">
        <div className="apex-agent-brand"><h1>ApexAgent</h1></div>
        <div className="apex-agent-head-actions"><details className="apex-agent-more"><summary aria-label="More ApexAgent options">⋯</summary><div role="menu">
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await batch(active.filter((monitor) => monitor.paused === anyPaused), 'monitor_pause', { paused: !anyPaused }); })}>{anyPaused ? 'Resume watching' : 'Pause'}</button>}
          {!!monitors.length && <button type="button" role="menuitem" disabled={busy || !active.some((monitor) => !monitor.paused)} onClick={() => void run(async () => { await batch(active.filter((monitor) => !monitor.paused), 'monitor_check_now', {}); })}>Check now</button>}
          {onClear && !!entries.length && <button type="button" role="menuitem" onClick={() => { if (window.confirm('Hide this conversation on this Mac? ApexAgent keeps its memory. Things that need you stay until you resolve them.')) onClear(); }}>Clear conversation</button>}
          {assistant && (['activity', 'scheduled', 'memory', 'rules', 'settings', 'costs', 'connections'] as const).map((name) => <button type="button" role="menuitem" key={name} onClick={(event) => openPanel(name, event)}>{{ activity: 'Activity', scheduled: 'Scheduled', memory: 'Memory', rules: 'Rules', settings: 'Assistant settings', costs: 'Costs', connections: 'Connections' }[name]}</button>)}
          {assistant && personal?.pause && <button type="button" role="menuitem" disabled={busy || personal.offline} onClick={() => void run(() => personal.pause!(!assistant.paused))}>{assistant.paused ? 'Resume assistant' : 'Pause assistant'}</button>}
          {personal?.setUp && <button type="button" role="menuitem" disabled={busy || personal.offline} onClick={() => void run(personal.setUp!)}>Set up assistant on {personal.hostName}</button>}
          {onCustomize && <button type="button" role="menuitem" onClick={onCustomize}>Quiet hours</button>}
          {onHide && <button type="button" role="menuitem" onClick={onHide}>Hide</button>}
          {workspaces.map((workspace) => <button type="button" role="menuitem" key={workspace.id} onClick={() => onSetUp(workspace.id)}>{monitors.some((monitor) => monitor.workspaceId === workspace.id) ? `Sources for ${workspace.name}` : `Watch ${workspace.name}…`}</button>)}
        </div></details>{assistant && personal && <button className="icon" aria-label="Voice call" title="Voice call" onClick={() => setCalling(true)}>📞</button>}{onFullScreen && <button className="icon" onClick={onFullScreen} aria-pressed={fullScreen} aria-label={fullScreen ? 'Exit full screen' : 'Full screen'} title={fullScreen ? 'Exit full screen' : 'Full screen'}>{fullScreen ? '⤡' : '⤢'}</button>}<button className="icon" onClick={onClose} aria-label="Close ApexAgent">×</button></div>
      </div>
      <div className="apex-agent-head-row apex-agent-head-context"><p>{headline}{unseenNotices > 0 && <> · <button type="button" className="apex-agent-new-notices" onClick={() => setPanelOpen('notices')}>{unseenNotices} new</button></>}</p></div>
    </header>
    {error && <div className="apex-agent-error" role="alert">{error}</div>}
    <div className="apex-agent-tabpanel"><div className="assistant-chat-transcript" aria-live="polite">
      {entries.map(({ workspaceId, project, message, ...entry }) => {
        const item = 'personal' in entry ? entry.personal as PersonalMessage : null;
        if (item) {
          const task = taskOf(item.taskId);
          const asking = !!task && item.kind === 'approval' && lastApproval.get(task.id) === item.id && task.status === 'needsYou' && task.decision?.status === 'open';
          const stoppable = !!task && lastLine.get(task.id) === item.id && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting' || task.status === 'blocked');
          const kindClass = item.kind === 'helper' ? ' apex-agent-helper' : item.kind === 'notice' ? ' apex-agent-notice' : '';
          return <article className={`assistant-chat-message ${message.role} apex-agent-personal${item.role === 'system' ? ' apex-agent-app-note' : ''}${asking ? ' apex-agent-needs-you' : ''}${kindClass}`} key={`${workspaceId}:${message.id}`}>
            <small>{item.role === 'human' ? 'You' : item.role === 'system' ? 'App' : personal!.name} · <button type="button" className="apex-agent-project-tag" onClick={() => { setFocus(PERSONAL); setDraftFallback(PERSONAL); }} title={`Reply to ${personal!.name}`}>{personal!.hostName}</button>{item.kind === 'helper' && <span className="apex-agent-helper-label">Helper</span>}{task && (item.kind === 'approval' || item.kind === 'result' || item.kind === 'update' || stoppable) && <span className="apex-agent-task-chip" data-status={task.status}>{PERSONAL_STATUS[task.status] ?? task.status}</span>}</small>
            {asking ? <p>{task!.decision!.kind === 'handOff' ? 'Your turn: run this yourself, then tell me.' : task!.decision!.kind === 'spend' || task!.decision!.kind === 'uncertain' ? task!.decision!.prompt : 'Approval needed to run this:'}</p> : fenced(message.text)}
            {asking && task!.operation && <dl className="apex-agent-operation">
              <dt>Command</dt><dd><code>{task!.operation.argv.join(' ')}</code></dd>
              <dt>Folder</dt><dd><code>{task!.operation.cwd}</code></dd>
              <dt>Machine</dt><dd>{machineOf(task!)}</dd>
              {planRows(task!.operation.plan)}
            </dl>}
            {asking && (() => {
              const decision = task!.decision!;
              const off = busy || personal!.offline;
              const answer = (approve: boolean) => () => void run(() => personal!.decide(decision.id, decision.paramsHash, approve));
              return <div className="apex-agent-buttons">
                {decision.kind === 'handOff' ? <>
                  <button className="primary" disabled={off} onClick={answer(true)}>I did it</button>
                  <button disabled={off} onClick={answer(false)}>Skip</button>
                </> : decision.kind === 'spend' ? <>
                  <button className="primary" disabled={off} onClick={answer(true)}>Go ahead</button>
                  <button disabled={off} onClick={answer(false)}>Not now</button>
                </> : <>
                  <button className="primary" disabled={off} onClick={answer(true)}>{decision.kind === 'uncertain' ? 'Run again' : 'Approve'}</button>
                  <button disabled={off} onClick={answer(false)}>Decline</button>
                </>}
              </div>;
            })()}
            {stoppable && <div className="apex-agent-buttons">
              <button disabled={busy || personal!.offline} onClick={() => void run(() => personal!.cancel(task.id))}>Stop task</button>
            </div>}
          </article>;
        }
        return <article className={`assistant-chat-message ${message.role}`} key={`${workspaceId}:${message.id}`}>
        <small>{message.role === 'human' ? 'You' : 'ApexAgent'} · <button type="button" className="apex-agent-project-tag" onClick={() => { setFocus(workspaceId); setDraftFallback(workspaceId); }} title={`Reply about ${project}`}>{project}</button></small>
        <p>{message.text}</p>
        {'citations' in entry && (entry.citations as { workspaceId: string; evidence: MonitorEvidence }[] | undefined)?.map((cite, index) => <div key={index}>{evidenceList([cite.evidence], onOpenEvidence && ((item) => void run(() => onOpenEvidence(cite.workspaceId, item))))}</div>)}
        {evidenceList(message.evidence ?? [], onOpenEvidence && ((item) => void run(() => onOpenEvidence(workspaceId, item))))}
      </article>;
      })}
      {personal && assistant && (assistant.schedules ?? []).filter((schedule) => schedule.status === 'proposed' && schedule.decision?.status === 'open').map((schedule) => {
        const decision = schedule.decision!;
        const off = busy || personal.offline;
        return <article className="assistant-chat-message assistant apex-agent-needs-you apex-agent-schedule-card" key={`schedule:${schedule.id}`}>
          <small>{personal.name} · {personal.hostName} · Proposed schedule</small>
          <p>{schedule.goal}</p>
          <dl className="apex-agent-operation">
            <dt>Command</dt><dd><code>{schedule.argv.join(' ')}</code></dd>
            <dt>Repeats</dt><dd>{cadenceOf(schedule)}</dd>
          </dl>
          <div className="apex-agent-buttons">
            <button className="primary" disabled={off} onClick={() => void run(() => personal.decide(decision.id, decision.paramsHash, true))}>Confirm schedule</button>
            <button disabled={off} onClick={() => void run(() => personal.decide(decision.id, decision.paramsHash, false))}>Decline</button>
          </div>
        </article>;
      })}
      {personal?.problem && <article className="assistant-chat-message assistant"><small>{personal.name} · {personal.hostName}</small><p>{personal.problem}</p></article>}
      {personal?.setUp && !monitors.length && <div className="apex-agent-intro"><strong>Your assistant can live on {personal.hostName}.</strong><p>It keeps one conversation that stays there when this Mac is closed. Choose “Set up assistant on {personal.hostName}” from ⋯.</p></div>}
      {failed.map((monitor) => <article className="assistant-chat-message assistant apex-agent-check-failed" key={`failed:${monitor.workspaceId}`}>
        <small>Last check failed · {names[monitor.workspaceId] ?? 'Project'}</small>
        <p title={monitor.error ?? ''}>{monitor.error}</p>
        <div className="apex-agent-buttons"><button disabled={busy} onClick={() => void run(() => onMutate(monitor.workspaceId, 'monitor_check_now', {}))}>Retry</button></div>
      </article>)}
      {!monitors.length && !assistant && !personal?.setUp && <div className="apex-agent-intro"><strong>Hi, I’m ApexAgent.</strong><p>I keep up with all your projects in one conversation. Pick a project to watch from ⋯ and tell me what to keep on track.</p></div>}
      {findings.map(({ workspaceId, finding }) => <article className="assistant-chat-message assistant apex-agent-needs-you" key={`${workspaceId}:${finding.id}`}>
        <small>Needs you{offlineWorkspaceIds.includes(workspaceId) ? ' · Offline, saved evidence' : ''} · {names[workspaceId] ?? 'Project'}</small>
        <p>{finding.summary}</p>
        {finding.reason && <p className="apex-agent-muted">{finding.confidence === 'observed' ? 'Observed' : finding.confidence === 'inferred' ? 'Inferred' : 'Unverified'} · {finding.reason}</p>}
        {evidenceList(finding.evidence ?? [], onOpenEvidence && ((item) => void run(() => onOpenEvidence(workspaceId, item))))}
        <div className="apex-agent-buttons">
          <button disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'resolved' }))}>Resolve</button>
          <button disabled={busy || offlineWorkspaceIds.includes(workspaceId)} onClick={() => void run(() => onMutate(workspaceId, 'monitor_resolve', { findingId: finding.id, status: 'snoozed', snoozedUntil: Date.now() + DAY }))}>Remind me tomorrow</button>
        </div>
      </article>)}
      {!!monitors.length && !!unwatched.length && entries.length === 0 && <p className="apex-agent-muted">Not watching yet: {unwatched.map((workspace) => workspace.name).join(', ')}.</p>}
      {tasks}
      <div ref={bottom} />
    </div></div>
    {/* Over the whole popup, not inside the scrolling transcript. */}
    {panelOpen && personal && <div className="apex-agent-panels-sheet">
      <PersonalPanels key={panelOpen} lane={personal} initial={panelOpen} onClose={() => setPanelOpen(null)} />
    </div>}
    {(!!watched.length || !!selectedTaskContext || !!assistant) && <form className="apex-agent-all-composer" onSubmit={send}>
      {selectedTaskContext && <div className="assistant-composer-heading"><strong>{selectedTaskContext.project} · {selectedTaskContext.label}</strong><button type="button" onClick={() => { setDraftTaskContext(null); setFocus(null); setDraftFallback(null); onClearTaskContext?.(); }}>New message</button></div>}
      <textarea value={text} onChange={(event) => { const value = event.target.value; if (!value.trim()) { setDraftFallback(null); setDraftTaskContext(undefined); } else if (!text.trim()) { setDraftFallback(focus ?? lastSpoken ?? (assistant ? PERSONAL : onOverview ? '*' : null)); setDraftTaskContext(selectedTaskContext); } setText(value); }} rows={2} aria-label="Message ApexAgent" placeholder={selectedTaskContext ? 'Reply to this task…' : target === PERSONAL ? `Message ${personal!.name}…` : 'Ask about any project…'}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div><small className="apex-agent-muted">{selectedTaskContext ? `Reply to ${selectedTaskContext.project} · ${selectedTaskContext.label}` : globalReply ? 'About all projects' : target === PERSONAL ? `To ${personalTag}` : target ? `About ${laneNames[target]}` : ''}{!selectedTaskContext && lanes.length > 1 ? ' · name a project to switch' : ''}</small><button className="primary" disabled={busy || !text.trim() || (!selectedTaskContext && !target && !globalReply)}>{busy ? 'Sending…' : 'Send'}</button></div>
    </form>}
    {calling && personal && <PersonalCall lane={personal} onEnd={() => setCalling(false)} />}
    {busy && <div className="apex-agent-busy" role="status">Saving…</div>}
  </section>;
}
