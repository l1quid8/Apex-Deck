import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PersonalAssistantRecord } from './personalAssistant.ts';
import type { Backend } from './backend.ts';
import type { AssistantTaskSnapshot } from './assistantTaskModel.ts';
import type { ParticipantConfig } from './types.ts';
import { parseTaskQuickAdd, proposeWorkerTask, type TaskDelegationTarget, type TaskDelegationDraft, type TaskWorkerThreadCreator } from './taskManagerDelegation.ts';
import { assistantIdentityKey, projectIdentityKey } from './assistantIdentity.ts';
import { collectWorkspaceTasks, filterWorkspaceTasks, canPurgeWorkspaceTask, purgeWorkspaceTasks, guardWorkspaceTaskBackend, type WorkspaceTaskRow, type PersonalTaskSource } from './workspaceTasks.ts';
import './workspace-tasks.css';

const GROUPS = [{ id: 'waiting', label: 'Needs you' }, { id: 'working', label: 'In progress' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'done', label: 'Done' }] as const;
function readCollapsed(): Set<string> {
  try { const value: unknown = JSON.parse(localStorage.getItem('apex.workspace-tasks.collapsed-v2') ?? '["done"]'); return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : ['done']); }
  catch { return new Set(['done']); }
}
export function WorkspaceTasks({ rows, problems = [], renderDetail, backendForRow, personalSources = [], profiles = [], delegationTargets = [], onCreateWorkerThread }: { rows: readonly WorkspaceTaskRow[]; problems?: readonly string[]; renderDetail: (row: WorkspaceTaskRow) => ReactNode; backendForRow?: (row: WorkspaceTaskRow) => Backend | null; personalSources?: readonly PersonalTaskSource[]; profiles?: readonly ParticipantConfig[]; delegationTargets?: readonly TaskDelegationTarget[]; onCreateWorkerThread?: TaskWorkerThreadCreator }) {
  const [addText, setAddText] = useState('');
  const [addAssistant, setAddAssistant] = useState('');
  const [addProject, setAddProject] = useState('');
  const [taskMode, setTaskMode] = useState<'read_only' | 'isolated'>('read_only');
  const delegationDraft = useRef<{ key: string; draft: TaskDelegationDraft } | null>(null);
  const [dueAt, setDueAt] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [addedRows, setAddedRows] = useState<WorkspaceTaskRow[]>([]);
  const [query, setQuery] = useState('');
  const [assistant, setAssistant] = useState('');
  const [project, setProject] = useState('');
  const [machine, setMachine] = useState('');
  const [status, setStatus] = useState('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const [confirmation, setConfirmation] = useState<readonly WorkspaceTaskRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [purged, setPurged] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  useEffect(() => {
    setAddedRows(before => {
      const pending = before.filter(row => row.source === 'project'
        ? !rows.some(saved => saved.key === row.key)
        : !personalSources.some(source => row.assistant && assistantIdentityKey(source.assistant) === assistantIdentityKey(row.assistant) && source.revision != null && row.assistantRevision != null && source.revision >= row.assistantRevision));
      return pending.length === before.length ? before : pending;
    });
  }, [rows, personalSources, addedRows]);
  const optimisticLive = useRef({ addedRows, backendForRow });
  optimisticLive.current = { addedRows, backendForRow };
  useEffect(() => {
    let active = true;
    let running = false;
    const timer = setInterval(async () => {
      if (!active || running) return;
      running = true;
      try {
        for (const row of optimisticLive.current.addedRows) {
          if (!active) break;
          if (row.source !== 'project' || !row.owner || !row.project) continue;
          try {
            const route = optimisticLive.current.backendForRow?.(row);
            if (!route) continue;
            const guarded = guardWorkspaceTaskBackend(row, route);
            const snapshot = await guarded.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner: row.owner, includeDiffs: false });
            if (!snapshot.project || projectIdentityKey(snapshot.project) !== projectIdentityKey(row.project)) continue;
            const saved = collectWorkspaceTasks([], [{ project: row.project, owner: row.owner, name: row.projectName, snapshot, offline: false, observedAt: Date.now(), authenticatedHostId: row.verifiedHostId ?? undefined }]);
            if (active && !saved.some(task => task.taskId === row.taskId)) setAddedRows(before => before.filter(pending => pending !== row));
          } catch { /* Keep retained rows until the exact owning host proves absence. */ }
        }
      } finally { running = false; }
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const optimisticRows = addedRows.filter(row => row.source === 'project' ? !rows.some(saved => saved.key === row.key) : !personalSources.some(source => row.assistant && assistantIdentityKey(source.assistant) === assistantIdentityKey(row.assistant) && source.revision != null && row.assistantRevision != null && source.revision >= row.assistantRevision));
  const remaining = [...new Map([...optimisticRows, ...rows].map(row => [row.key, row])).values()].filter(row => !purged.has(row.key));
  const targets = personalSources.length ? personalSources : [...new Map(remaining.filter(row => row.assistant).map(row => [assistantIdentityKey(row.assistant!), { assistant: row.assistant!, name: row.assistantName, hostName: row.machineName, revision: row.assistantRevision, tasks: [], offline: row.offline, observedAt: row.observedAt, routeHostId: row.routeHostId }])).values()];
  const target = targets.find(source => assistantIdentityKey(source.assistant) === addAssistant) ?? targets[0];
  let parsed: ReturnType<typeof parseTaskQuickAdd> | null = null;
  let parseError = '';
  try { if (addText.trim()) parsed = parseTaskQuickAdd(addText, profiles); } catch (cause) { parseError = cause instanceof Error ? cause.message : String(cause); }
  const workerProjects = delegationTargets.filter(item => target && assistantIdentityKey(item.assistant) === assistantIdentityKey(target.assistant));
  const workerProject = workerProjects.find(item => projectIdentityKey(item.project) === addProject);
  const addRow = target ? { key: '__add', source: 'todo' as const, assistant: target.assistant, project: null, taskId: '__add', title: '', status: 'open', updatedAt: 0, observedAt: target.observedAt, offline: target.offline, group: 'waiting' as const, assistantName: target.name, projectName: 'Personal', owner: null, revision: null, routeHostId: target.routeHostId ?? target.assistant.hostId, verifiedHostId: target.assistant.hostId } : null;
  const addBackend = addRow && !addRow.offline ? backendForRow?.(addRow) : null;
  const add = async () => {
    if (!target || !addBackend || !addText.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const command = parseTaskQuickAdd(addText, profiles);
      if (addBackend.supports?.('assistant_task_purge_v1') !== true) throw new Error('Update the owning machine before adding tasks.');
      if (command.kind === 'worker') {
        if (!workerProject || !addRow) throw new Error('Choose an assigned project for this worker task.');
        const key = JSON.stringify([assistantIdentityKey(target.assistant), projectIdentityKey(workerProject.project), command.profile, command.text, taskMode]);
        if (delegationDraft.current?.key !== key) delegationDraft.current = { key, draft: { id: crypto.randomUUID() } };
        const saved = await proposeWorkerTask({ backend: addBackend, assistant: target.assistant, project: workerProject.project, projectName: workerProject.name, assistantName: target.name, profile: command.profile, brief: command.text, mode: taskMode, draft: delegationDraft.current.draft, routeHostId: addRow.routeHostId, createWorkerThread: onCreateWorkerThread });
        setAddedRows(before => [...before.filter(row => !saved.some(item => item.key === row.key)), ...saved]);
        setAddText(''); setAddProject(''); setDueAt(''); setRemindAt(''); setTaskMode('read_only'); delegationDraft.current = null;
        return;
      }
      if (!addRow || addBackend.supports?.('assistant_task_purge_v1') !== true) throw new Error('Update the owning machine to add to-dos.');
      const guarded = guardWorkspaceTaskBackend(addRow, addBackend);
      const record = await guarded.call<PersonalAssistantRecord>('personal_get', { assistantId: target.assistant.assistantId });
      if (record.id !== target.assistant.assistantId || record.hostId !== target.assistant.hostId) throw new Error('The assistant owner changed.');
      const handoff = command.kind === 'assistant';
      await guarded.call(handoff ? 'personal_send' : 'personal_todo', { assistantId: record.id, ...(handoff ? { requestId: crypto.randomUUID(), text: command.text } : { expectedRevision: record.revision, action: 'add', text: addText.trim(), ...(dueAt ? { dueAt: new Date(dueAt).getTime() } : {}), ...(remindAt ? { remindAt: new Date(remindAt).getTime() } : {}) }) });
      const updated = await guarded.call<PersonalAssistantRecord>('personal_get', { assistantId: record.id });
      if (updated.id !== record.id || updated.hostId !== record.hostId) throw new Error('The assistant owner changed.');
      setAddedRows(before => [...before.filter(row => !row.assistant || assistantIdentityKey(row.assistant) !== assistantIdentityKey(target.assistant)), ...collectWorkspaceTasks([{ ...target, tasks: updated.tasks, todos: updated.taskManagerTodos, revision: updated.revision }], [])]);
      setAddText(''); setDueAt(''); setRemindAt('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const assistants = [...new Map(remaining.filter(row => row.assistant).map(row => [assistantIdentityKey(row.assistant!), { ref: row.assistant!, name: row.assistantName }])).entries()];
  const projects = [...new Map(remaining.filter(row => row.project).map(row => [projectIdentityKey(row.project!), { ref: row.project!, name: row.projectName }])).entries()];
  const machines = [...new Set(remaining.map(row => row.verifiedHostId ?? row.routeHostId).filter(Boolean))];
  const filters = { query, assistant: assistant === 'unassigned' ? 'unassigned' as const : assistants.find(([key]) => key === assistant)?.[1].ref, project: projects.find(([key]) => key === project)?.[1].ref, group: status as 'all' | WorkspaceTaskRow['group'] };
  const matching = filterWorkspaceTasks(remaining, filters).filter(row => !machine || (row.verifiedHostId ?? row.routeHostId) === machine);
  const visible = matching.filter(row => !row.dismissed || showDismissed);
  const dismissed = matching.filter(row => row.dismissed).length;
  const detail = remaining.find(row => row.key === selected);
  const deletable = (row: WorkspaceTaskRow) => canPurgeWorkspaceTask(row) && !!backendForRow?.(row)?.supports?.('assistant_task_purge_v1');
  const filtered = !!query.trim() || !!assistant || !!project || !!machine || status !== 'all';
  const finished = matching.filter(row => row.group === 'done' && deletable(row));
  const toggle = (key: string) => setCollapsed(before => {
    const next = new Set(before); if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem('apex.workspace-tasks.collapsed-v2', JSON.stringify([...next])); } catch { /* Optional preference only. */ }
    return next;
  });
  const pick = (row: WorkspaceTaskRow) => { if (!deletable(row)) return; setPicks(before => { const next = new Set(before); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; }); };
  const confirm = (targets: readonly WorkspaceTaskRow[]) => { setError(''); setConfirmation(targets.map(row => ({ ...row }))); };
  const remove = async () => {
    if (!confirmation || !backendForRow || busy) return;
    setBusy(true); setError('');
    try {
      await purgeWorkspaceTasks(confirmation, backendForRow);
      setPurged(before => new Set([...before, ...confirmation.map(row => row.key)]));
      setConfirmation(null); setSelected(null); setPicks(new Set()); setSelecting(false);
    } catch (cause) {
      const removed = cause && typeof cause === 'object' && 'purgedKeys' in cause && Array.isArray(cause.purgedKeys) ? cause.purgedKeys as string[] : [];
      if (removed.length) { setPurged(before => new Set([...before, ...removed])); setConfirmation(before => before?.filter(row => !removed.includes(row.key)) ?? null); setPicks(before => new Set([...before].filter(key => !removed.includes(key)))); }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBusy(false); }
  };
  return <section className="workspace-tasks" aria-label="Workspace tasks">
    {problems.length > 0 && <div role="status" className="workspace-tasks-problems">{problems.map((problem, index) => <p key={index}>{problem}</p>)}</div>}
    {selected ? <>
      <div className="workspace-tasks-detailbar"><button type="button" className="assistant-back" onClick={() => setSelected(null)}>‹ Tasks</button>{detail && <button type="button" className="workspace-task-delete" disabled={!deletable(detail)} onClick={() => confirm([detail])}>Delete</button>}</div>
      {detail ? <div key={detail.key}>
        <p className="muted workspace-task-owner">{detail.assistantName} · {detail.projectName} · {detail.machineName ?? 'Owning machine'}</p>
        {detail.offline && <p role="status">Offline · Last observed {new Date(detail.observedAt).toLocaleString()}. Reconnect to use task actions.</p>}
        {renderDetail(detail)}
      </div> : <p role="status">This task is no longer available in its saved assignment.</p>}
    </> : <>
      {!selecting && target && <form className="workspace-tasks-add" onSubmit={event => { event.preventDefault(); void add(); }}>
        <div><span aria-hidden="true">＋</span><input aria-label="Add a to-do or hand off a task" placeholder="Add a to-do, @alfred or @worker" value={addText} disabled={!addBackend || busy} onChange={event => setAddText(event.target.value)} /><button type="submit" disabled={!addBackend || busy || !addText.trim() || !!parseError || (parsed?.kind === 'worker' && !workerProject)}>{parsed?.kind === 'worker' ? 'Review plan' : 'Add'}</button></div>
        {(!!addText || targets.length > 1) && <div className="workspace-tasks-add-options">{targets.length > 1 && <select aria-label="Owning assistant" value={assistantIdentityKey(target.assistant)} onChange={event => setAddAssistant(event.target.value)}>{targets.map(source => <option key={assistantIdentityKey(source.assistant)} value={assistantIdentityKey(source.assistant)}>{source.name}</option>)}</select>}{parsed?.kind === 'worker' && <><label>Project<select aria-label="Worker task project" value={addProject} disabled={busy} onChange={event => setAddProject(event.target.value)}><option value="">Choose an assigned project</option>{workerProjects.map(item => <option key={projectIdentityKey(item.project)} value={projectIdentityKey(item.project)}>{item.name}</option>)}</select></label><label>Task access<select aria-label="Worker task access" value={taskMode} disabled={busy} onChange={event => setTaskMode(event.target.value as 'read_only' | 'isolated')}><option value="read_only">Read only</option><option value="isolated">Separate copy</option></select></label><span>Creates a proposal for your approval.</span></>}{parsed?.kind === 'todo' && <><label>Due<input type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} /></label><label>Remind me<input type="datetime-local" value={remindAt} onChange={event => setRemindAt(event.target.value)} /></label></>}</div>}
        {parseError && <p role="status">{parseError}</p>}
      </form>}
      <header className="workspace-tasks-toolbar"><h2>{selecting ? 'Select tasks' : 'Tasks'}</h2><button type="button" aria-label="Search tasks" aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>Search</button><button type="button" aria-label="Filter tasks" aria-pressed={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filter</button><button type="button" aria-label="Select tasks" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setPicks(new Set()); }}>Select</button></header>
      <div className="workspace-tasks-filters" hidden={!filtersOpen && !searchOpen}>
        <input hidden={!searchOpen} type="search" aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} />
        <select hidden={!filtersOpen} aria-label="Filter by assistant" value={assistant} onChange={event => setAssistant(event.target.value)}><option value="">All assistants</option><option value="unassigned">Unassigned</option>{assistants.map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}</select>
        <select hidden={!filtersOpen} aria-label="Filter by project" value={project} onChange={event => setProject(event.target.value)}><option value="">All projects</option>{projects.map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}</select>
        <select hidden={!filtersOpen} aria-label="Filter by machine" value={machine} onChange={event => setMachine(event.target.value)}><option value="">All machines</option>{machines.map(id => <option key={id} value={id}>{remaining.find(row => (row.verifiedHostId ?? row.routeHostId) === id)?.machineName ?? 'Owning machine'}</option>)}</select>
        <select hidden={!filtersOpen} aria-label="Task status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{GROUPS.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select>
        {filtersOpen && <button type="button" onClick={() => { setAssistant(''); setProject(''); setMachine(''); setStatus('all'); setQuery(''); }}>Clear filters</button>}
      </div>
      {dismissed > 0 && <div className="workspace-tasks-cleanup"><button type="button" onClick={() => setShowDismissed(!showDismissed)}>{showDismissed ? 'Hide' : 'Show'} dismissed ({dismissed})</button><span>Clear finished includes eligible dismissed tasks.</span></div>}
      {!visible.length && <p className="muted">{remaining.length ? 'No tasks match these filters.' : 'No saved tasks yet.'}</p>}
      {GROUPS.map(group => {
        const tasks = visible.filter(row => row.group === group.id); if (!tasks.length && !(group.id === 'done' && dismissed)) return null;
        const expanded = !!query || !collapsed.has(group.id);
        return <section key={group.id} className="workspace-tasks-group">
          <div className="workspace-tasks-group-head"><h3><button type="button" aria-expanded={expanded} onClick={() => toggle(group.id)}>{expanded ? '▾' : '▸'} {group.label} <span className="muted">{tasks.length}</span></button></h3>{group.id === 'done' && !selecting && !filtered && <button type="button" className="workspace-task-delete" disabled={!finished.length} onClick={() => confirm(finished)}>Clear finished{dismissed ? ` (${finished.length})` : ''}</button>}{selecting && <button type="button" onClick={() => setPicks(before => new Set([...before, ...tasks.filter(deletable).map(row => row.key)]))}>Select all</button>}</div>
          <ul hidden={!expanded}>{tasks.map(row => <li key={row.key} className="workspace-task-item">
            {selecting ? <input type="checkbox" aria-label={`Select ${row.title}`} checked={picks.has(row.key)} disabled={!deletable(row)} onChange={() => pick(row)} /> : <span className="workspace-task-dot" data-state={row.group} aria-hidden="true" />}
            <button type="button" className="workspace-task-row" onClick={() => selecting ? pick(row) : setSelected(row.key)}>
              <strong title={row.title}>{row.title}</strong><time dateTime={new Date(row.updatedAt).toISOString()} title={`${row.source === 'schedule' ? 'Created' : 'Last updated'} ${new Date(row.updatedAt).toLocaleString()}`}>{new Date(row.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
              <span className="muted">{row.assistantName} · {row.projectName} · {row.status.replaceAll('_', ' ')}{row.dismissed ? ' · Dismissed' : ''}{row.offline ? ` · Offline · Last observed ${new Date(row.observedAt).toLocaleString()}` : ''}</span>
            </button>
            {!selecting && <button type="button" className="workspace-task-trash" aria-label={`Delete ${row.title}`} title={deletable(row) ? 'Delete permanently' : 'Reconnect, finish or stop this task before deleting'} disabled={!deletable(row)} onClick={() => confirm([row])}>×</button>}
          </li>)}</ul>
        </section>;
      })}
      {selecting && <div className="workspace-tasks-selection"><span>{picks.size} selected</span><button type="button" onClick={() => { setSelecting(false); setPicks(new Set()); }}>Cancel</button><button type="button" disabled={!picks.size} onClick={() => confirm(remaining.filter(row => picks.has(row.key)))}>Delete {picks.size || ''}</button></div>}
    </>}
    {error && !confirmation && <p role="alert">{error}</p>}
    {confirmation && <div className="workspace-tasks-dialog-backdrop"><div className="workspace-tasks-dialog" role="alertdialog" aria-modal="true" aria-labelledby="workspace-task-delete-title" aria-describedby="workspace-task-delete-description" onKeyDown={event => { if (event.key === 'Escape' && !busy) setConfirmation(null); if (event.key === 'Tab') { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}>
      <h3 id="workspace-task-delete-title">Delete {confirmation.length === 1 ? 'this task' : `${confirmation.length} tasks`} permanently?</h3><p id="workspace-task-delete-description">This cannot be undone. Removes the selected task records, results and task-linked status messages and notices from the assistant’s chat. Your messages and normal replies stay. Worker conversations, accepted changes, project notebooks and worktrees are kept. Source events and replay and ownership receipts are retained.</p>
      <ul>{confirmation.map(row => <li key={row.key}>{row.title}<small>{row.assistantName} · {row.projectName} · {row.machineName ?? 'Owning machine'}</small></li>)}</ul>
      {error && <p role="alert">{error}</p>}<div className="workspace-tasks-dialog-actions"><button type="button" autoFocus ref={node => { if (node && !busy) node.focus(); }} disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="workspace-task-delete" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete permanently'}</button></div>
    </div></div>}
  </section>;
}
