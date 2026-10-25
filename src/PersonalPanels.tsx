import { useEffect, useRef, useState } from 'react';
import type { AssistantTask } from './assistantTaskModel.ts';
import type { ProjectRef } from './assistantIdentity.ts';
import { PersonalBrowser } from './PersonalBrowser.tsx';
import { pathBase } from './paths.ts';
import { ProjectMemoryPanel } from './ProjectMemoryPanel.tsx';
import { CLASS_LABEL, MODE_LABEL, TASK_STATUS, type ActionMode, type ConnectorState, type CostEntry, type PersonalAssistantRecord, type PersonalLane, type PersonalSettings, type PersonalTask, type ToolClass } from './personalAssistant.ts';

export type PanelName = 'activity' | 'scheduled' | 'memory' | 'rules' | 'settings' | 'costs' | 'notices' | 'connections';

const TABS: { id: PanelName; label: string }[] = [
  { id: 'activity', label: 'Activity' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'memory', label: 'Memory' },
  { id: 'rules', label: 'Rules' }, { id: 'settings', label: 'Settings' }, { id: 'costs', label: 'Costs' }, { id: 'notices', label: 'Notices' }, { id: 'connections', label: 'Connections' },
];
const CLASSES: ToolClass[] = ['read', 'write', 'send', 'spend'];
const MODES: ActionMode[] = ['auto', 'onRequest', 'ask', 'handOff'];
const DEFAULT_MODES: Record<ToolClass, ActionMode> = { read: 'auto', write: 'ask', send: 'ask', spend: 'ask' };
const SPEND_NOTE = "Spending can't run without asking unless you set a budget";
const DAY = 24 * 60 * 60 * 1000;
const ACTIVE: PersonalTask['status'][] = ['queued', 'running', 'waiting', 'blocked'];
const SETTLED: PersonalTask['status'][] = ['done', 'failed', 'cancelled'];

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayOf = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;
const roughUsd = (micros: number) => `est. $${(micros / 1e6).toFixed(2)}`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const replies = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

function waitText(wait: PersonalTask['wait']) {
  if (!wait) return '';
  if (wait.kind === 'timer') return `Next run at ${clock(wait.at)}`;
  if (wait.kind === 'dependency') return `After task ${wait.taskId}`;
  return `Waiting for ${wait.hostId} to connect`;
}

function costOf(entry: CostEntry) {
  if (entry.source === 'reported') return usd(entry.micros ?? 0);
  if (entry.source === 'estimated') return roughUsd(entry.micros ?? 0);
  return 'unknown';
}

/** Unknown-cost replies are counted, never added as $0. */
function totals(costs: CostEntry[], since: number) {
  let reported = 0, estimated = 0, unknown = 0, bytes = 0;
  for (const entry of costs) {
    if (entry.at < since) continue;
    bytes += entry.bytesOut ?? 0;
    if (entry.source === 'reported') reported += entry.micros ?? 0;
    else if (entry.source === 'estimated') estimated += entry.micros ?? 0;
    else unknown += 1;
  }
  return { reported, estimated, unknown, bytes };
}

type Draft = {
  name: string; style: string; timezone: string; quietStart: string; quietEnd: string; dailyDollars: string;
  unknownCostOk: boolean; localOnly: boolean; endpoints: string; contextChars: string;
};
type PrivateCorrection = { id: string; text: string; save: (text: string) => Promise<void> };

function draftOf(a: PersonalAssistantRecord): Draft {
  return {
    name: a.name ?? '', style: a.style ?? '', timezone: a.timezone ?? '',
    quietStart: a.quietHours?.start ?? '', quietEnd: a.quietHours?.end ?? '',
    dailyDollars: a.budget?.dailyLimitMicros != null ? String(a.budget.dailyLimitMicros / 1e6) : '',
    unknownCostOk: !!a.budget?.unknownCostOk, localOnly: !!a.privacy?.localOnly,
    endpoints: (a.privacy?.allowedEndpoints ?? []).join('\n'), contextChars: String(a.contextBudgetChars ?? ''),
  };
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Only the fields the user changed are sent. */
function settingsPatch(a: PersonalAssistantRecord, d: Draft): Partial<PersonalSettings> {
  const base = draftOf(a);
  const patch: Partial<PersonalSettings> = {};
  if (d.name !== base.name) patch.name = d.name.trim();
  if (d.style !== base.style) patch.style = d.style;
  if (d.timezone !== base.timezone) patch.timezone = d.timezone.trim();
  if (d.quietStart !== base.quietStart || d.quietEnd !== base.quietEnd) {
    patch.quietHours = d.quietStart && d.quietEnd ? { start: d.quietStart, end: d.quietEnd } : undefined;
  }
  if (d.dailyDollars !== base.dailyDollars || d.unknownCostOk !== base.unknownCostOk) {
    const dollars = d.dailyDollars.trim() === '' ? undefined : Number(d.dailyDollars);
    if (dollars !== undefined && (!Number.isFinite(dollars) || dollars < 0)) throw new Error('Enter a daily limit in dollars, or leave it empty for none.');
    patch.budget = { ...(a.budget ?? {}), dailyLimitMicros: dollars === undefined ? undefined : Math.round(dollars * 1e6), unknownCostOk: d.unknownCostOk };
  }
  if (d.localOnly !== base.localOnly || d.endpoints !== base.endpoints) {
    patch.privacy = { ...(a.privacy ?? { localOnly: false, allowedEndpoints: [] }), localOnly: d.localOnly, allowedEndpoints: lines(d.endpoints) };
  }
  if (d.contextChars !== base.contextChars) {
    const chars = Number(d.contextChars);
    if (!Number.isInteger(chars) || chars <= 0) throw new Error('Context budget must be a whole number of characters.');
    patch.contextBudgetChars = chars;
  }
  return patch;
}

/** One panel for the personal assistant: tabs on top, one scrollable view below. */
export type PersonalPanelsProps = { lane: PersonalLane; initial?: PanelName; initialProject?: ProjectRef; delegatedTasks?: AssistantTask[]; onClose: () => void; embedded?: boolean; onOpenBrowser?: () => void };

export function PersonalPanels({ lane, initial = 'activity', initialProject, delegatedTasks = [], onClose, embedded = false, onOpenBrowser }: PersonalPanelsProps) {
  const ownerKey = JSON.stringify([lane.ref?.hostId ?? lane.assistant?.hostId, lane.ref?.assistantId ?? lane.assistant?.id]);
  const [panel, setPanel] = useState<PanelName>(initial);
  const [notebooks, setNotebooks] = useState<Record<string, string>>(initialProject ? { [ownerKey]: JSON.stringify([initialProject.hostId, initialProject.workspaceId, initialProject.cwd]) } : {});
  const [memorySearches, setMemorySearches] = useState<Record<string, string>>({});
  const [addingMemory, setAddingMemory] = useState<Record<string, boolean>>({});
  const notebook = notebooks[ownerKey] ?? 'personal';
  const memoryQuery = memorySearches[ownerKey] ?? '';
  const showMemoryForm = !embedded || !!addingMemory[ownerKey];
  const [pending, setPending] = useState<Record<string, number | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const operation = useRef(0);
  const busy = pending[ownerKey] !== undefined;
  const error = errors[ownerKey] ?? '';
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<Record<string, PrivateCorrection | null>>({});
  const editing = corrections[ownerKey] ?? null;
  const setEditing = (value: PrivateCorrection | null) => setCorrections(before => ({ ...before, [ownerKey]: value }));
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, string>>({});
  const memoryText = memoryDrafts[ownerKey] ?? '';
  const setMemoryText = (value: string) => setMemoryDrafts(before => ({ ...before, [ownerKey]: value }));
  const [rule, setRule] = useState<{ text: string; cls: ToolClass; mode: ActionMode }>({ text: '', cls: 'write', mode: 'ask' });
  const [draft, setDraft] = useState<{ rev: number; value: Draft } | null>(null);
  const [connectors, setConnectors] = useState<ConnectorState[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [folder, setFolder] = useState('~/apex-assistant');
  const [githubToken, setGithubToken] = useState('');
  const [google, setGoogle] = useState({ clientId: '', clientSecret: '' });
  const connectorOwner = useRef(ownerKey);
  connectorOwner.current = ownerKey;
  const reloadConnectors = async () => {
    if (!lane.connectors) return;
    const result = await lane.connectors();
    if (connectorOwner.current === ownerKey) setConnectors(result);
  };
  useEffect(() => {
    if (panel !== 'connections' || !lane.connectors) return;
    let cancelled = false;
    setConnectors([]);
    lane.connectors().then(result => { if (!cancelled && connectorOwner.current === ownerKey) setConnectors(result); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [panel, ownerKey, lane.connectors]);

  const a = lane.assistant;
  const locked = busy || lane.offline;
  const now = Date.now();

  const run = async (work: () => Promise<void>) => {
    const ticket = ++operation.current;
    setPending(before => ({ ...before, [ownerKey]: ticket }));
    setErrors(before => ({ ...before, [ownerKey]: '' }));
    try {
      await work();
    } catch (err) {
      setErrors(before => ({ ...before, [ownerKey]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPending(before => before[ownerKey] === ticket ? { ...before, [ownerKey]: undefined } : before);
    }
  };

  const current = a ? (draft && draft.rev === a.revision ? draft.value : draftOf(a)) : null;
  const edit = (patch: Partial<Draft>) => { if (a && current) setDraft({ rev: a.revision, value: { ...current, ...patch } }); };

  const waitingRow = (task: PersonalTask) => {
    const expanded = openTask === task.id;
    const receipt = task.receipts[task.receipts.length - 1];
    const unsettled = !SETTLED.includes(task.status);
    const wait = waitText(task.wait);
    return (
      <div className={embedded ? 'personal-panels-row assistant-activity-item' : 'personal-panels-row'} key={task.id}>
        {embedded && <time dateTime={new Date(task.updatedAt).toISOString()}>{when(task.updatedAt)}</time>}
        <button type="button" className="personal-panels-rowmain" aria-expanded={expanded} onClick={() => setOpenTask(expanded ? null : task.id)}>
          <span className="personal-panels-goal">{task.goal}</span>
          <span className="personal-panels-chip" data-status={task.status}>{TASK_STATUS[task.status]}</span>
          {task.kind === 'helper' && <span className="personal-panels-muted">helper</span>}
          {!!task.runsDone && <span className="personal-panels-muted">{task.runsDone === 1 ? '1 run' : `${task.runsDone} runs`}</span>}
        </button>
        <div className="personal-panels-muted">
          {task.lastUpdate ?? when(task.updatedAt)}
          {wait && <span> · {wait}</span>}
        </div>
        {unsettled && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.cancel(task.id))}>Stop task</button></div>}
        {expanded && <>
          {embedded && <p className="personal-panels-muted">{lane.name} · {task.targetHost} · Task {task.id}</p>}
          <pre>{receipt?.outputExcerpt.trim() ? receipt.outputExcerpt : receipt?.finishedAt ? 'It printed nothing.' : 'No output yet.'}</pre>
          {embedded && task.receipts.length > 0 && <details><summary>Run history · {task.receipts.length}</summary>{task.receipts.map((run, index) => <div className="assistant-activity-receipt" key={`${run.opId}-${index}`}><time>{when(run.finishedAt ?? run.startedAt)}</time><span>{run.phase} · {run.opId}</span><pre>{run.outputExcerpt || 'No output recorded.'}</pre></div>)}</details>}
        </>}
      </div>
    );
  };

  const activityView = (rec: PersonalAssistantRecord) => {
    const tasks = [...(rec.tasks ?? [])].sort((x, y) => y.updatedAt - x.updatedAt);
    const groups: [string, PersonalTask[]][] = [
      ['Needs you', tasks.filter((task) => task.status === 'needsYou')],
      ['In progress', tasks.filter((task) => ACTIVE.includes(task.status))],
      ['Finished', tasks.filter((task) => SETTLED.includes(task.status)).slice(0, 20)],
    ];
    const projectTasks = delegatedTasks.filter(task => task.lineage?.assistant.hostId === rec.hostId && task.lineage.assistant.assistantId === rec.id);
    const delegatedRow = (task: AssistantTask) => {
      const project = task.lineage!.project;
      const status = task.desiredState === 'paused' ? 'Paused' : task.status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
      // Native request history can contain kind/text without a timestamp.
      // Keep that evidence visible without inventing a time or calling ISO on
      // an invalid Date, which would unmount the entire renderer.
      const historyTimestamp = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : undefined;
      const history = [...(task.resultData?.taskHistory ?? [])].sort((left, right) => (historyTimestamp(right.atMs) ?? -Infinity) - (historyTimestamp(left.atMs) ?? -Infinity));
      return <article className="personal-panels-row assistant-activity-item" key={`project:${project.hostId}:${project.workspaceId}:${task.id}`} data-activity-source="project">
        <time dateTime={new Date(task.updatedAtMs).toISOString()}>{when(task.updatedAtMs)}</time>
        <div className="personal-panels-rowmain"><strong className="personal-panels-goal">{task.brief}</strong><span className="personal-panels-chip" data-status={task.status}>{status}</span></div>
        <div className="personal-panels-muted">{rec.name} → {task.workers.join(', ') || 'Worker not selected'} · {project.cwd.split('/').filter(Boolean).pop()} · {project.hostId}</div>
        <details><summary>Task history{history.length > 0 ? ` · ${history.length}` : ''}</summary>
          <p className="personal-panels-muted">Task {task.id} · revision {task.revision} · {project.cwd}</p>
          {history.length ? history.map((entry, index) => <div className="assistant-activity-receipt" key={`${entry.atMs}-${index}`}>{historyTimestamp(entry.atMs) !== undefined && <time dateTime={new Date(entry.atMs).toISOString()}>{when(entry.atMs)}</time>}<span>{entry.text}</span></div>) : <p className="personal-panels-muted">No task history reported by this host.</p>}
          {task.result && <pre>{task.result}</pre>}
        </details>
      </article>;
    };
    const timeline = [...tasks.map(task => ({ at: task.updatedAt, node: waitingRow(task) })), ...projectTasks.map(task => ({ at: task.updatedAtMs, node: delegatedRow(task) }))].sort((left, right) => right.at - left.at);
    if (embedded) return <section className="assistant-panel-page">
      <div className="assistant-panel-heading"><h2>What {rec.name} has been doing</h2><span className="assistant-panel-tag">{timeline.length} tasks</span></div>
      <p className="assistant-panel-subtitle">Assignments, updates, and decisions for {rec.name} on {lane.hostName}.</p>
      <div className="assistant-activity-timeline">{timeline.length ? timeline.map(item => item.node) : <p className="assistant-panel-empty">No activity yet. Give {rec.name} a task in the conversation to get started.</p>}</div>
    </section>;
    if (!tasks.length) return <p className="personal-panels-muted">No tasks yet.</p>;
    return groups.filter(([, list]) => list.length).map(([title, list]) => (
      <section key={title}><h4>{title}</h4>{list.map(waitingRow)}</section>
    ));
  };

  const scheduledView = (rec: PersonalAssistantRecord) => {
    const schedules = (rec.schedules ?? []).filter((item) => item.status !== 'cancelled');
    if (!schedules.length) return <p className="personal-panels-muted">Nothing scheduled. Ask the assistant to do something every day or at a set time.</p>;
    return schedules.map((item) => {
      const cadence = item.everyMs ? `Every ${Math.round(item.everyMs / 60000)} min` : item.dailyAt ? `Daily at ${item.dailyAt}` : 'Scheduled';
      return (
        <div className="personal-panels-row" key={item.id}>
          <div className="personal-panels-rowmain"><span className="personal-panels-goal">{item.goal}</span><span className="personal-panels-muted">{cadence}</span></div>
          <div className="personal-panels-muted">{item.status === 'proposed' ? 'Waiting for you to confirm it in the conversation' : item.nextAt ? `Next run ${when(item.nextAt)}` : 'No next run set'}</div>
          {lane.cancelSchedule && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.cancelSchedule!(item.id))}>Cancel schedule</button></div>}
        </div>
      );
    });
  };

  const memoryView = (rec: PersonalAssistantRecord) => {
    const FactRecord = embedded ? 'details' : 'div';
    const facts = rec.facts ?? [];
    const live = facts.filter((fact) => !fact.deletedAt && !fact.supersededBy && !(fact.expiresAt && fact.expiresAt <= now));
    const visible = live.filter(fact => !embedded || `${fact.text} ${fact.kind}`.toLowerCase().includes(memoryQuery.trim().toLowerCase()));
    const projects = rec.projects ?? [];
    const bindingKey = (project: { hostId: string; workspaceId: string; cwd: string }) => JSON.stringify([project.hostId, project.workspaceId, project.cwd]);
    const selectedProject = projects.find(binding => bindingKey(binding.project) === notebook);
    const notebookControl = <select aria-label="Memory notebook" value={selectedProject ? notebook : 'personal'} onChange={event => {
      setNotebooks(before => ({ ...before, [ownerKey]: event.target.value }));
      setMemorySearches(before => ({ ...before, [ownerKey]: '' }));
      setAddingMemory(before => ({ ...before, [ownerKey]: false }));
    }}><option value="personal">{rec.name}’s personal notes</option>{projects.map(binding => <option key={bindingKey(binding.project)} value={bindingKey(binding.project)}>Project · {pathBase(binding.project.cwd)} · {binding.project.hostId}</option>)}</select>;
    if (embedded && selectedProject) return <section className="assistant-panel-page">
      <div className="assistant-panel-heading"><h2>{pathBase(selectedProject.project.cwd)} notebook</h2><span className="assistant-panel-tag">Shared project</span></div>
      <p className="assistant-panel-subtitle">Personal notes stay with the assistant. Project notebooks are shared only within that project.</p>
      <ProjectMemoryPanel key={JSON.stringify([rec.hostId, rec.id])} lane={lane} embedded initialProject={selectedProject.project} selectedProject={selectedProject.project} notebookControl={notebookControl} />
    </section>;
    const older = facts.filter((fact) => !fact.deletedAt && fact.supersededBy);
    return (
      <section className={embedded ? "assistant-panel-page" : undefined}>
        {embedded ? <>
          <div className="assistant-panel-heading"><h2>{rec.name}’s memory</h2><span className="assistant-panel-tag">Personal notes</span></div>
          <p className="assistant-panel-subtitle">Personal notes stay with the assistant. Project notebooks are shared only within that project.</p>
          <div className="assistant-memory-controls">{notebookControl}{lane.remember && <button type="button" disabled={locked} onClick={() => setAddingMemory(before => ({ ...before, [ownerKey]: !showMemoryForm }))}>＋ Add note</button>}</div>
          <p className="assistant-memory-scope-info">Private to {rec.name} on {lane.hostName}. Other assistants have separate personal notes.</p>
          <input className="assistant-memory-search" type="search" aria-label="Search notes" placeholder="Search saved notes…" value={memoryQuery} onChange={event => setMemorySearches(before => ({ ...before, [ownerKey]: event.target.value }))} />
        </> : <><h4>Private assistant memory</h4><p className="personal-panels-muted">Private to {rec.name} on {lane.hostName}. Saved assistant revision {rec.revision}; these facts are separate from shared project notes.</p></>}
        {lane.remember && showMemoryForm && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const text = memoryText.trim();
            if (!text) return;
            const submitted = memoryText;
            void run(async () => {
              await lane.remember!(text);
              setMemoryDrafts(before => before[ownerKey] === submitted ? { ...before, [ownerKey]: '' } : before);
            });
          }}>
            <input aria-label="Something to remember" value={memoryText} onChange={(event) => setMemoryText(event.target.value)} placeholder="Something to remember" />
            <button type="submit" disabled={locked || !memoryText.trim()}>Remember</button>
          </form>
        )}
        {!visible.length && <p className="personal-panels-muted assistant-panel-empty">{live.length ? 'No notes match your search.' : 'Nothing remembered yet. Add a note to get started.'}</p>}
        {visible.map((fact) => (
          <div className={embedded ? "personal-panels-row assistant-memory-note" : "personal-panels-row"} key={fact.id}>
            {editing?.id === fact.id ? (
              <div className="personal-panels-inline">
                <input aria-label="Corrected fact" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                <button type="button" disabled={locked || !editing.text.trim()} onClick={() => {
                  const correction = editing;
                  void run(async () => {
                    await correction.save(correction.text.trim());
                    setCorrections(before => before[ownerKey] === correction ? { ...before, [ownerKey]: null } : before);
                  });
                }}>Save</button>
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <div className="personal-panels-rowmain assistant-memory-title">{embedded && <span aria-hidden="true">▤</span>}<span className="personal-panels-goal">{embedded ? fact.kind[0].toUpperCase() + fact.kind.slice(1) : fact.text}</span>{embedded && lane.correctFact && <button type="button" disabled={locked} onClick={() => { const correct = lane.correctFact!; setEditing({ id: fact.id, text: fact.text, save: text => correct(fact.id, text) }); }}>Edit</button>}</div>
            )}
            {embedded && <p className="assistant-memory-text">{fact.text}</p>}
            {embedded && <div className="assistant-memory-meta"><span>Personal · {rec.name}</span><span>Revision {rec.revision} · {dayOf(fact.createdAt)}</span></div>}
            <FactRecord className={embedded ? "assistant-memory-record" : "personal-memory-record"}>{embedded && <summary>Record and source</summary>}<div className="personal-panels-muted">
              {fact.kind} · {fact.explicit ? 'You said' : 'Inferred'}{!fact.explicit && ` · ${fact.confidence}%`} · {dayOf(fact.createdAt)}
              <br />{fact.id} · revision {rec.revision} · created {when(fact.createdAt)}
              {fact.source.messageId && <> · message {fact.source.messageId}</>}{fact.source.taskId && <> · task {fact.source.taskId}</>}
              {fact.expiresAt !== undefined && <> · expires {when(fact.expiresAt)}</>}
            </div>
            </FactRecord>
            {editing?.id !== fact.id && (
              <div className="personal-panels-actions">
                {!embedded && lane.correctFact && <button type="button" disabled={locked} onClick={() => {
                  const correct = lane.correctFact!;
                  setEditing({ id: fact.id, text: fact.text, save: text => correct(fact.id, text) });
                }}>Correct</button>}
                {lane.forgetFact && <button type="button" disabled={locked} onClick={() => {
                  if (typeof window !== 'undefined' && !window.confirm('Forget this?')) return;
                  void run(() => lane.forgetFact!(fact.id));
                }}>Forget</button>}
              </div>
            )}
          </div>
        ))}
        {!!older.length && (
          <details>
            <summary>Older versions</summary>
            <ul>{older.map((fact) => <li key={fact.id} className="personal-panels-muted personal-panels-struck">{fact.text}</li>)}</ul>
          </details>
        )}
        {!embedded && <ProjectMemoryPanel key={JSON.stringify([rec.hostId, rec.id])} lane={lane} initialProject={initialProject} />}
      </section>
    );
  };

  const rulesView = (rec: PersonalAssistantRecord) => {
    const modes = rec.modes ?? DEFAULT_MODES;
    const rules = rec.rules ?? [];
    return (
      <>
        {CLASSES.map((cls) => (
          <div className="personal-panels-row" key={cls}>
            <div className="personal-panels-rowmain">
              <span className="personal-panels-goal">{CLASS_LABEL[cls]}</span>
              {lane.configure ? (
                <select aria-label={CLASS_LABEL[cls]} value={modes[cls]} disabled={locked} onChange={(event) => {
                  const mode = event.target.value as ActionMode;
                  void run(() => lane.configure!({ modes: { ...modes, [cls]: mode } }));
                }}>
                  {MODES.map((mode) => {
                    const blocked = cls === 'spend' && mode === 'auto';
                    return <option key={mode} value={mode} disabled={blocked} title={blocked ? SPEND_NOTE : undefined}>{MODE_LABEL[mode]}</option>;
                  })}
                </select>
              ) : <span className="personal-panels-muted">{MODE_LABEL[modes[cls]]}</span>}
            </div>
          </div>
        ))}
        <h4>Standing rules</h4>
        {!rules.length && <p className="personal-panels-muted">No standing rules yet.</p>}
        {rules.map((item) => (
          <div className="personal-panels-row" key={item.id}>
            <div className="personal-panels-rowmain"><span className="personal-panels-goal">{item.text}</span></div>
            <div className="personal-panels-muted">{CLASS_LABEL[item.class]} · {MODE_LABEL[item.mode]}</div>
            {lane.removeRule && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.removeRule!(item.id))}>Remove</button></div>}
          </div>
        ))}
        {lane.addRule && (
          <form className="personal-panels-form" onSubmit={(event) => {
            event.preventDefault();
            const text = rule.text.trim();
            if (!text) return;
            void run(async () => { await lane.addRule!(text, rule.cls, rule.mode); setRule((prev) => ({ ...prev, text: '' })); });
          }}>
            <input aria-label="Rule text" value={rule.text} placeholder="e.g. Ask before emailing clients" onChange={(event) => setRule((prev) => ({ ...prev, text: event.target.value }))} />
            <div className="personal-panels-inline">
              <select aria-label="Rule class" value={rule.cls} onChange={(event) => setRule((prev) => ({ ...prev, cls: event.target.value as ToolClass }))}>
                {CLASSES.map((cls) => <option key={cls} value={cls}>{CLASS_LABEL[cls]}</option>)}
              </select>
              <select aria-label="Rule mode" value={rule.mode} onChange={(event) => setRule((prev) => ({ ...prev, mode: event.target.value as ActionMode }))}>
                {(['ask', 'handOff'] as ActionMode[]).map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
              </select>
            </div>
            <p className="personal-panels-muted">Rules can only make it more careful.</p>
            <div><button type="submit" disabled={locked || !rule.text.trim()}>Add rule</button></div>
          </form>
        )}
      </>
    );
  };

  const settingsView = (rec: PersonalAssistantRecord, d: Draft) => {
    const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(rec));
    return (
      <form className="personal-panels-form" onSubmit={(event) => {
        event.preventDefault();
        if (!lane.configure || !dirty) return;
        void run(async () => { await lane.configure!(settingsPatch(rec, d)); setDraft(null); });
      }}>
        <label className="personal-panels-field">Name<input value={d.name} onChange={(event) => edit({ name: event.target.value })} /></label>
        <label className="personal-panels-field">Style<textarea rows={3} value={d.style} onChange={(event) => edit({ style: event.target.value })} /></label>
        <label className="personal-panels-field">Timezone<input value={d.timezone} placeholder="Europe/London" onChange={(event) => edit({ timezone: event.target.value })} /></label>
        <div className="personal-panels-inline">
          <label className="personal-panels-field">Quiet hours start<input type="time" value={d.quietStart} onChange={(event) => edit({ quietStart: event.target.value })} /></label>
          <label className="personal-panels-field">Quiet hours end<input type="time" value={d.quietEnd} onChange={(event) => edit({ quietEnd: event.target.value })} /></label>
        </div>
        <label className="personal-panels-field">Daily spend limit (dollars, empty for none)<input type="number" min="0" step="0.01" value={d.dailyDollars} onChange={(event) => edit({ dailyDollars: event.target.value })} /></label>
        <label><input type="checkbox" checked={d.unknownCostOk} onChange={(event) => edit({ unknownCostOk: event.target.checked })} /> Allow replies whose cost isn't reported</label>
        <label><input type="checkbox" checked={d.localOnly} onChange={(event) => edit({ localOnly: event.target.checked })} /> Local only (no cloud model or network tools)</label>
        <label className="personal-panels-field">Allowed model endpoints (one per line)<textarea rows={3} value={d.endpoints} onChange={(event) => edit({ endpoints: event.target.value })} /></label>
        <label className="personal-panels-field">Context budget (characters)<input type="number" min="1" step="1" value={d.contextChars} onChange={(event) => edit({ contextChars: event.target.value })} /></label>
        <p className="personal-panels-muted">Your conversation is stored on {lane.hostName}, but each reply sends its context to the model's provider.</p>
        <div><button type="submit" className="primary" disabled={locked || !dirty || !lane.configure}>Save</button></div>
      </form>
    );
  };

  const costsView = (rec: PersonalAssistantRecord) => {
    const costs = rec.costs ?? [];
    const windows: [string, number][] = [['Today', new Date(now).setHours(0, 0, 0, 0)], ['Last 7 days', now - 7 * DAY]];
    const newest = [...costs].sort((x, y) => y.at - x.at).slice(0, 30);
    return (
      <>
        {windows.map(([label, since]) => {
          const sum = totals(costs, since);
          return (
            <p key={label}>
              <strong>{label}</strong>: {usd(sum.reported)} · {roughUsd(sum.estimated)} · {sum.unknown > 0 ? `${replies(sum.unknown)} with unknown cost` : 'no unknown costs'} · Sent to model providers: {kb(sum.bytes)}
            </p>
          );
        })}
        {!costs.length && <p className="personal-panels-muted">No model calls yet.</p>}
        {!!newest.length && (
          <table>
            <thead><tr><th>Time</th><th>Purpose</th><th>Kind</th><th>Endpoint</th><th>Cost</th></tr></thead>
            <tbody>
              {newest.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{when(entry.at)}</td><td>{entry.purpose}</td><td>{entry.kind}</td><td>{entry.endpoint}</td><td>{costOf(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  };

  const noticesView = (rec: PersonalAssistantRecord) => {
    const notices = [...(rec.notices ?? [])].sort((x, y) => y.at - x.at);
    const unseen = notices.filter((item) => !item.seenAt).length;
    if (!notices.length) return <p className="personal-panels-muted">No notices.</p>;
    return (
      <>
        {!!unseen && lane.seeNotices && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.seeNotices!())}>Mark all seen</button></div>}
        {notices.map((item) => {
          const pending = item.deliveredAt == null;
          const status = pending ? (item.urgent ? 'Held for quiet hours' : 'In next digest') : `Delivered ${when(item.deliveredAt!)}`;
          return (
            <div className="personal-panels-row" key={item.id}>
              <div className="personal-panels-rowmain">{item.seenAt ? <span className="personal-panels-goal">{item.text}</span> : <strong className="personal-panels-goal personal-panels-unseen">{item.text}</strong>}</div>
              <div className="personal-panels-muted">{when(item.at)} · {status}{pending && item.deliverAt > now ? ` · ${when(item.deliverAt)}` : ''}</div>
            </div>
          );
        })}
      </>
    );
  };

  const connectionsView = (rec: PersonalAssistantRecord) => {
    const machines = rec.machines ?? [];
    const mine = machines.find((machine) => machine.hostId === lane.localHostId);
    const others = machines.filter((machine) => machine.hostId !== lane.localHostId);
    const github = connectors.find((item) => item.kind === 'github');
    const googleOn = connectors.some((item) => (item.kind === 'gmail' || item.kind === 'drive') && item.connected);
    const browser = connectors.find((item) => item.kind === 'browser');
    const signIn = typeof window === 'undefined' ? undefined : (window as unknown as { apexDeck?: { googleSignIn?: (args: { clientId: string; clientSecret: string }) => Promise<{ refreshToken: string }> } }).apexDeck?.googleSignIn;
    const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
    return (
      <>
        <h4>This Mac</h4>
        <p className="personal-panels-muted">{mine ? `Linked. Folder: ${mine.folder}` : 'Not linked.'}</p>
        {!mine && lane.linkThisMac && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const value = folder.trim();
            if (value) void run(() => lane.linkThisMac!(value));
          }}>
            <input aria-label="Folder on this Mac" value={folder} onChange={(event) => setFolder(event.target.value)} />
            <button type="submit" disabled={locked || !folder.trim()}>Let assistant use this Mac</button>
          </form>
        )}
        {mine && lane.unlinkMachine && lane.localHostId && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.unlinkMachine!(lane.localHostId!))}>Stop using this Mac</button></div>}
        <p className="personal-panels-muted">Commands for this Mac run only while Deck is open here. Nothing moves to another machine.</p>
        {others.map((machine) => (
          <div className="personal-panels-row" key={machine.hostId}>
            <div className="personal-panels-rowmain"><span className="personal-panels-goal">{machine.name}</span></div>
            <div className="personal-panels-muted">{machine.folder}</div>
            {lane.unlinkMachine && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void run(() => lane.unlinkMachine!(machine.hostId))}>Remove</button></div>}
          </div>
        ))}

        <h4>GitHub</h4>
        <p className="personal-panels-muted">{github?.connected ? 'Connected.' : 'Not connected.'} Use a fine-grained token with read-only access.</p>
        {lane.saveKey && (
          <form className="personal-panels-inline" onSubmit={(event) => {
            event.preventDefault();
            const value = githubToken.trim();
            if (!value) return;
            void run(async () => { await lane.saveKey!('GITHUB_TOKEN', value); setGithubToken(''); await reloadConnectors(); });
          }}>
            <input type="password" aria-label="GitHub token" placeholder="Personal access token" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} />
            <button type="submit" disabled={locked || !githubToken.trim()}>Save</button>
            {github?.connected && lane.removeKey && <button type="button" disabled={locked} onClick={() => void run(async () => { await lane.removeKey!('GITHUB_TOKEN'); await reloadConnectors(); })}>Disconnect</button>}
          </form>
        )}

        <h4>Google (Gmail and Drive)</h4>
        <p className="personal-panels-muted">{googleOn ? 'Connected.' : 'Not connected.'} Read-only: Gmail and Drive are only searched and read, never changed or sent.</p>
        {lane.saveKey && (
          <form className="personal-panels-form" onSubmit={(event) => event.preventDefault()}>
            <input aria-label="OAuth client ID" placeholder="Client ID (Desktop app type)" value={google.clientId} onChange={(event) => setGoogle({ ...google, clientId: event.target.value })} />
            <input type="password" aria-label="OAuth client secret" placeholder="Client secret" value={google.clientSecret} onChange={(event) => setGoogle({ ...google, clientSecret: event.target.value })} />
            <div className="personal-panels-inline">
              {signIn && (
                <button type="button" className="primary" disabled={locked || !google.clientId.trim() || !google.clientSecret.trim()} onClick={() => void run(async () => {
                  const { refreshToken } = await signIn({ clientId: google.clientId.trim(), clientSecret: google.clientSecret.trim() });
                  await lane.saveKey!('GOOGLE_CLIENT_ID', google.clientId.trim());
                  await lane.saveKey!('GOOGLE_CLIENT_SECRET', google.clientSecret.trim());
                  await lane.saveKey!('GOOGLE_REFRESH_TOKEN', refreshToken);
                  setGoogle({ clientId: '', clientSecret: '' });
                  await reloadConnectors();
                })}>Sign in with Google</button>
              )}
              {googleOn && lane.removeKey && <button type="button" disabled={locked} onClick={() => void run(async () => { for (const key of GOOGLE_KEYS) await lane.removeKey!(key); await reloadConnectors(); })}>Disconnect</button>}
            </div>
          </form>
        )}

        <h4>Browser</h4>
        <p className="personal-panels-muted">{browser?.connected ? 'Available.' : 'Not available.'} The assistant can open pages; you can take over to click and sign in.</p>
        {lane.browserView && <div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => onOpenBrowser ? onOpenBrowser() : setBrowserOpen(true)}>Open browser / Take over</button></div>}
      </>
    );
  };

  const content = () => {
    if (!a) {
      if (lane.problem) return <p className="personal-panels-muted">{lane.problem}</p>;
      return (
        <>
          <p className="personal-panels-muted">No assistant yet.</p>
          {lane.setUp && <div className="personal-panels-actions"><button type="button" className="primary" disabled={locked} onClick={() => void run(() => lane.setUp!())}>Set up assistant</button></div>}
        </>
      );
    }
    switch (panel) {
      case 'activity': return activityView(a);
      case 'scheduled': return scheduledView(a);
      case 'memory': return memoryView(a);
      case 'rules': return rulesView(a);
      case 'settings': return current ? settingsView(a, current) : null;
      case 'costs': return costsView(a);
      case 'notices': return noticesView(a);
      case 'connections': return connectionsView(a);
    }
  };

  return (
    <div className={`personal-panels${embedded ? " personal-panels-embedded" : ""}`} data-panel={panel}>
      {!embedded && <div className="personal-panels-head">
        <strong>{lane.name}</strong>
        <span className="personal-panels-muted">{lane.hostName}</span>
        <button type="button" className="personal-panels-close" onClick={onClose}>Close</button>
      </div>}
      {!embedded && <div className="personal-panels-tabs" role="tablist" aria-label="Assistant panels">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={panel === tab.id} onClick={() => setPanel(tab.id)}>{tab.label}</button>
        ))}
      </div>}
      {lane.offline && <p className="personal-panels-muted">Offline. Changes are paused until it reconnects.</p>}
      {error && <p role="alert" className="personal-panels-alert">{error}</p>}
      <div className="personal-panels-body">{content()}</div>
      {browserOpen && lane.browserView && <PersonalBrowser lane={lane} onClose={() => setBrowserOpen(false)} />}
    </div>
  );
}
