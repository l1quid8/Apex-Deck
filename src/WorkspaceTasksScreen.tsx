import { useState, type ReactNode } from 'react';
import { assistantIdentityKey, projectIdentityKey } from './assistantIdentity.ts';
import { filterWorkspaceTasks, type WorkspaceTaskRow } from './workspaceTasks.ts';
import './workspace-tasks.css';

const GROUPS = [{ id: 'waiting', label: 'Waiting for you' }, { id: 'working', label: 'Working' }, { id: 'done', label: 'Finished' }] as const;
function readCollapsed(): Set<string> {
  try { const value: unknown = JSON.parse(localStorage.getItem('apex.workspace-tasks.collapsed') ?? '[]'); return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []); }
  catch { return new Set(); }
}
export function WorkspaceTasks({ rows, problems = [], renderDetail }: { rows: readonly WorkspaceTaskRow[]; problems?: readonly string[]; renderDetail: (row: WorkspaceTaskRow) => ReactNode }) {
  const [query, setQuery] = useState('');
  const [assistant, setAssistant] = useState('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const assistants = [...new Map(rows.filter(row => row.assistant).map(row => [assistantIdentityKey(row.assistant!), { ref: row.assistant!, name: row.assistantName }])).entries()];
  const projects = [...new Map(rows.filter(row => row.project).map(row => [projectIdentityKey(row.project!), { ref: row.project!, name: row.projectName }])).entries()];
  const filters = { query, assistant: assistant === 'unassigned' ? 'unassigned' as const : assistants.find(([key]) => key === assistant)?.[1].ref, project: projects.find(([key]) => key === project)?.[1].ref, group: status as 'all' | WorkspaceTaskRow['group'] };
  const visible = filterWorkspaceTasks(rows, filters);
  const detail = rows.find(row => row.key === selected);
  const toggle = (key: string) => setCollapsed(before => {
    const next = new Set(before); if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem('apex.workspace-tasks.collapsed', JSON.stringify([...next])); } catch { /* Optional preference only. */ }
    return next;
  });
  return <section className="workspace-tasks" aria-label="Workspace tasks">
    <header><h2>Tasks</h2><p className="muted">All assistants and projects</p></header>
    {problems.length > 0 && <div role="status" className="workspace-tasks-problems">{problems.map((problem, index) => <p key={index}>{problem}</p>)}</div>}
    {selected ? <>
      <button type="button" className="assistant-back" onClick={() => setSelected(null)}>Back to all tasks</button>
      {detail ? <div key={detail.key}>
        <p className="muted">{detail.assistantName} · {detail.projectName} · {detail.project?.hostId ?? detail.assistant?.hostId}</p>
        {detail.offline && <p role="status">Offline · Last updated {new Date(detail.observedAt).toLocaleString()}. Reconnect to use task actions.</p>}
        {renderDetail(detail)}
      </div> : <p role="status">This task is no longer available in its saved assignment.</p>}
    </> : <>
      <div className="workspace-tasks-filters">
        <input type="search" aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="Filter by assistant" value={assistant} onChange={event => setAssistant(event.target.value)}><option value="">All assistants</option><option value="unassigned">Unassigned</option>{assistants.map(([key, item]) => <option key={key} value={key}>{item.name} · {item.ref.hostId}</option>)}</select>
        <select aria-label="Filter by project" value={project} onChange={event => setProject(event.target.value)}><option value="">All projects</option>{projects.map(([key, item]) => <option key={key} value={key}>{item.name} · {item.ref.hostId}</option>)}</select>
        <select aria-label="Task status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{GROUPS.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select>
      </div>
      {!visible.length && <p className="muted">{rows.length ? 'No tasks match these filters.' : 'No saved tasks yet.'}</p>}
      {GROUPS.map(group => {
        const tasks = visible.filter(row => row.group === group.id); if (!tasks.length) return null;
        const expanded = !collapsed.has(group.id);
        return <section key={group.id} className="workspace-tasks-group">
          <h3><button type="button" aria-expanded={expanded} onClick={() => toggle(group.id)}>{expanded ? '▾' : '▸'} {group.label} <span className="muted">{tasks.length}</span></button></h3>
          <ul hidden={!expanded}>{tasks.map(row => <li key={row.key}><button type="button" className="workspace-task-row" onClick={() => setSelected(row.key)}>
            <strong>{row.title}</strong><span className="muted">{row.assistantName} · {row.projectName}</span>
            <span>{row.status.replaceAll('_', ' ')}{row.offline ? ' · Offline' : ''}</span>
            <span className="muted" title={new Date(row.observedAt).toLocaleString()}>Last updated {new Date(row.observedAt).toLocaleTimeString()}</span>
          </button></li>)}</ul>
        </section>;
      })}
    </>}
  </section>;
}
