import { useEffect, useMemo, useState } from 'react';
import type { Backend } from './backend.ts';
import type { Pane, ParticipantConfig } from './types.ts';
import { AssistantProjects } from './AssistantProjects';
import { ProjectMemoryPanel } from './ProjectMemoryPanel';
import { projectIdentityKey, type ProjectRef } from './assistantIdentity.ts';
import { createProjectMemoryClient, PROJECT_MEMORY_CAPABILITY } from './projectMemory.ts';
import { ApexAgentTasks } from './lazyViews';
import { TaskViewContext, projectTaskKey } from './apexAgentTaskView.ts';
import { requestId, type PersonalApprovalOptions, type PersonalAssistantRecord } from './personalAssistant.ts';
import { PersonalWorkspaceTaskDetail } from './PersonalWorkspaceTaskDetail';
import { workspaceTaskHostMatches, guardWorkspaceTaskBackend, type WorkspaceTaskRow } from './workspaceTasks.ts';

/** Both docked and popped-out details resolve the row's saved route and owner. */
export function WorkspaceTaskDetails({ row, backend, profiles, panes = [], onOpenThread, onKeepThread, onOpenProject, onOpenNotebook, onCreateWorkerThread }: { row: WorkspaceTaskRow; backend: Backend | null; profiles: ParticipantConfig[]; panes?: Pane[]; onOpenThread?: (id: string) => void; onKeepThread?: (project: ProjectRef, id: string) => void; onOpenProject?: (project: ProjectRef) => void; onOpenNotebook?: (project: ProjectRef) => void; onCreateWorkerThread?: (project: ProjectRef, profile: ParticipantConfig) => Promise<string> }) {
  const [record, setRecord] = useState<PersonalAssistantRecord | null>(null);
  const [focusHandled, setFocusHandled] = useState(false);
  const [problem, setProblem] = useState('');
  const [notebook, setNotebook] = useState<ProjectRef | null>(null);
  const ownerBackend = useMemo(() => backend ? guardWorkspaceTaskBackend(row, backend) : null, [backend, row.key, row.verifiedHostId]);
  useEffect(() => {
    setRecord(null); setProblem('');
    if (!row.assistant || !backend || row.offline) return;
    let active = true, loading = false;
    const assistant = row.assistant;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const status = backend.host?.connection.get().status;
        if (status?.kind !== 'connected' || status.hostId !== assistant.hostId) throw new Error('Reconnect to verify the assistant machine owner.');
        const next = await backend.call<PersonalAssistantRecord>('personal_get', { assistantId: assistant.assistantId });
        if (next.hostId !== assistant.hostId || next.id !== assistant.assistantId) throw new Error('The machine returned a different assistant owner.');
        if (active) { setRecord(next); setProblem(''); }
      } catch (cause) { if (active) { setRecord(null); setProblem(cause instanceof Error ? cause.message : String(cause)); } }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, [row.key, row.offline, backend]);
  if (row.offline || !backend || !workspaceTaskHostMatches(row, backend.host?.connection.get().status)) return <><h3>{row.title}</h3><p>{row.status.replaceAll('_', ' ')}</p><p role="status">Reconnect the owning machine to inspect current task details and actions.</p></>;
  if (row.source === 'project' && row.owner && !row.assistant) return <TaskViewContext.Provider value={{ display: 'tasks', selectedKey: projectTaskKey(row.owner.hostId, row.owner.workspaceId, row.taskId), openTask: () => {}, report: () => {} }}>
    <ApexAgentTasks backend={ownerBackend!} owner={row.owner} profiles={profiles} panes={panes} projectName={row.projectName} onOpenThread={onOpenThread} />
  </TaskViewContext.Provider>;
  if (!row.assistant) return <p role="status">This task has no verified owner.</p>;
  if (problem) return <p role="status">{problem}</p>;
  if (!record) return <p role="status">Loading the owning assistant…</p>;
  const assistant = row.assistant;
  const act = async (command: string, args: Record<string, unknown>) => {
    const status = backend.host?.connection.get().status;
    if (status?.kind !== 'connected' || status.hostId !== assistant.hostId) throw new Error('The assistant machine owner changed. Reconnect before acting.');
    const result = await ownerBackend!.call<{ assistant: PersonalAssistantRecord }>(command, { ...args, assistantId: assistant.assistantId, ...(['personal_task_lifecycle', 'personal_todo'].includes(command) ? {} : { requestId: requestId('workspace-tasks') }) });
    if (result.assistant.id !== assistant.assistantId || result.assistant.hostId !== assistant.hostId) throw new Error('The host returned a different assistant owner.');
    setRecord(result.assistant);
  };
  if (row.source === 'project' && row.project && row.owner) {
    const project = row.project;
    const projectMemory = ownerBackend!.supports?.(PROJECT_MEMORY_CAPABILITY) === true ? createProjectMemoryClient({ assistant, route: ownerBackend!, assertAvailable: () => {
      if (!workspaceTaskHostMatches(row, backend.host?.connection.get().status)) throw new Error('Reconnect the owning machine.');
    }, assertBinding: target => { if (!record.projects?.some(binding => projectIdentityKey(binding.project) === projectIdentityKey(target))) throw new Error('This project is no longer assigned to the assistant.'); } }) : undefined;
    if (notebook && projectIdentityKey(notebook) === projectIdentityKey(project)) return <section><button type="button" onClick={() => { setFocusHandled(false); setNotebook(null); }}>Back to task</button><ProjectMemoryPanel lane={{ assistant: record, offline: false, projectMemory }} selectedProject={project} embedded /></section>;
    return <AssistantProjects compact managementOpen={false} focusTask={focusHandled ? null : { project, taskId: row.taskId, nonce: 1 }} onFocusHandled={() => setFocusHandled(true)} backend={ownerBackend!} profiles={profiles} projects={[{ project, name: row.projectName }]} taskScopes={[{ project, owner: row.owner }]} onOpenThread={(_project, id) => onOpenThread?.(id)} onKeepThread={onKeepThread} onOpenProject={onOpenProject} onOpenNotebook={onOpenNotebook ?? setNotebook} onCreateWorkerThread={onCreateWorkerThread} lane={{ name: record.name, hostName: record.hostId, assistant: record, offline: false, projectMemory,
      taskLifecycle: ownerBackend!.supports?.('assistant_task_lifecycle_v1') === true ? (action, task, expectedDeleted) => act('personal_task_lifecycle', { action, task, expectedDeleted, expectedRevision: record.revision }) : undefined,
    }} />;
  }
  if (row.source === 'schedule') return <WorkspaceScheduleDetail row={row} record={record} act={act} />;
  if (row.source === 'todo') return <WorkspaceTodoDetail row={row} record={record} act={act} />;
  return <PersonalWorkspaceTaskDetail row={row} lane={{ assistant: record, offline: false,
    approvalOptions: backend.supports?.('assistant_approval_grants_v1')!==true?undefined:async(decisionId,paramsHash)=>{
      if(!workspaceTaskHostMatches(row,backend.host?.connection.get().status))throw new Error('The assistant machine changed.');
      const options=await backend.call<PersonalApprovalOptions>('personal_approval_options',{assistantId:assistant.assistantId,decisionId,paramsHash});
      if(!workspaceTaskHostMatches(row,backend.host?.connection.get().status)||options.decisionId!==decisionId||options.paramsHash!==paramsHash)throw new Error('The approval owner or action changed.');return options;
    },
    decideAlways: backend.supports?.('assistant_approval_grants_v1')!==true?undefined:(options,scope)=>act('personal_decide_always',{decisionId:options.decisionId,paramsHash:options.paramsHash,expectedRevision:options.permissionRevision,capability:options.capability,scope}),
    decide: (decisionId, paramsHash, approve) => act('personal_decide', { decisionId, paramsHash, approve }),
    taskLifecycle: ownerBackend!.supports?.('assistant_task_lifecycle_v1') === true ? (action, task, expectedDeleted) => act('personal_task_lifecycle', { action, task, expectedDeleted, expectedRevision: record.revision }) : undefined,
    cancel: taskId => act('personal_cancel', { taskId }),
  }} />;
}

function WorkspaceTodoDetail({ row, record, act }: { row: WorkspaceTaskRow; record: PersonalAssistantRecord; act: (command: string, args: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const todo = record.taskManagerTodos?.find(todo => todo.id === row.taskId);
  if (!todo) return <p role="status">This to-do is no longer available.</p>;
  const mutate = async (action: 'complete' | 'reopen') => { setBusy(true); setError(''); try { await act('personal_todo', { expectedRevision: record.revision, todoId: todo.id, action }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <article className="workspace-todo-detail"><h2>{todo.text}</h2><p className="muted">Your to-do · {todo.status === 'done' ? 'Done' : 'Open'}</p>{todo.dueAt != null && <p>Due {new Date(todo.dueAt).toLocaleString()}</p>}{todo.remindAt != null && <p>{todo.status === 'done' ? 'Reminder cancelled on completion' : `Reminder ${new Date(todo.remindAt).toLocaleString()}`}</p>}<div className="workspace-detail-actions"><button type="button" disabled={busy} onClick={() => void mutate(todo.status === 'done' ? 'reopen' : 'complete')}>{todo.status === 'done' ? 'Mark open' : 'Mark done'}</button><button type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void act('personal_send', { text: `Please help with this to-do: ${todo.text}` }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}>Ask Alfred to do this</button></div>{error && <p role="alert">{error}</p>}</article>;
}

function WorkspaceScheduleDetail({ row, record, act }: { row: WorkspaceTaskRow; record: PersonalAssistantRecord; act: (command: string, args: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const schedule = record.schedules?.find(schedule => schedule.id === row.taskId);
  if (!schedule) return <p role="status">This schedule is no longer available.</p>;
  const mutate = async (command: string, args: Record<string, unknown>) => { setBusy(true); setError(''); try { await act(command, args); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const decision = schedule.decision?.status === 'open' ? schedule.decision : null;
  return <article className="workspace-todo-detail"><h2>{schedule.goal}</h2><p className="muted">Scheduled task · {schedule.status} · {schedule.runs} runs</p>{schedule.nextAt != null && <p>Next run {new Date(schedule.nextAt).toLocaleString()}</p>}{schedule.dailyAt && <p>Daily at {schedule.dailyAt}</p>}<div className="workspace-detail-actions">{decision && <section><h3>Confirm schedule</h3><p>{decision.prompt}</p><button type="button" disabled={busy} onClick={() => void mutate('personal_decide', { decisionId: decision.id, paramsHash: decision.paramsHash, approve: true })}>Confirm schedule</button><button type="button" disabled={busy} onClick={() => void mutate('personal_decide', { decisionId: decision.id, paramsHash: decision.paramsHash, approve: false })}>Decline</button></section>}{schedule.status !== 'cancelled' && <button type="button" disabled={busy} onClick={() => void mutate('personal_schedule_cancel', { scheduleId: schedule.id })}>Cancel schedule</button>}</div><p className="muted">This machine supports schedule confirmation and cancellation. Run now and pause are unavailable. Cancel a schedule before deleting its saved record permanently.</p>{error && <p role="alert">{error}</p>}</article>;
}
