import { useEffect, useMemo, useState } from 'react';
import type { Backend } from './backend.ts';
import type { Pane, ParticipantConfig } from './types.ts';
import { ApexAgentTasks } from './lazyViews';
import { TaskViewContext, projectTaskKey } from './apexAgentTaskView.ts';
import { requestId, type PersonalAssistantRecord } from './personalAssistant.ts';
import { PersonalWorkspaceTaskDetail } from './PersonalWorkspaceTaskDetail';
import { workspaceTaskHostMatches, guardWorkspaceTaskBackend, type WorkspaceTaskRow } from './workspaceTasks.ts';

/** Both docked and popped-out details resolve the row's saved route and owner. */
export function WorkspaceTaskDetails({ row, backend, profiles, panes = [], onOpenThread }: { row: WorkspaceTaskRow; backend: Backend | null; profiles: ParticipantConfig[]; panes?: Pane[]; onOpenThread?: (id: string) => void }) {
  const [record, setRecord] = useState<PersonalAssistantRecord | null>(null);
  const [problem, setProblem] = useState('');
  const ownerBackend = useMemo(() => backend ? guardWorkspaceTaskBackend(row, backend) : null, [backend, row.key, row.verifiedHostId]);
  useEffect(() => {
    setRecord(null); setProblem('');
    if (row.source !== 'personal' || !row.assistant || !backend || row.offline) return;
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
  if (row.source === 'project' && row.owner) return <TaskViewContext.Provider value={{ display: 'tasks', selectedKey: projectTaskKey(row.owner.hostId, row.owner.workspaceId, row.taskId), openTask: () => {}, report: () => {} }}>
    <ApexAgentTasks backend={ownerBackend!} owner={row.owner} profiles={profiles} panes={panes} projectName={row.projectName} onOpenThread={onOpenThread} />
  </TaskViewContext.Provider>;
  if (row.source !== 'personal' || !row.assistant) return <p role="status">This task has no verified owner.</p>;
  if (problem) return <p role="status">{problem}</p>;
  if (!record) return <p role="status">Loading the owning assistant…</p>;
  const assistant = row.assistant;
  const act = async (command: string, args: Record<string, unknown>) => {
    const status = backend.host?.connection.get().status;
    if (status?.kind !== 'connected' || status.hostId !== assistant.hostId) throw new Error('The assistant machine owner changed. Reconnect before acting.');
    const result = await backend.call<{ assistant: PersonalAssistantRecord }>(command, { ...args, assistantId: assistant.assistantId, requestId: requestId('workspace-tasks') });
    if (result.assistant.id !== assistant.assistantId || result.assistant.hostId !== assistant.hostId) throw new Error('The host returned a different assistant owner.');
    setRecord(result.assistant);
  };
  return <PersonalWorkspaceTaskDetail row={row} lane={{ assistant: record, offline: false,
    decide: (decisionId, paramsHash, approve) => act('personal_decide', { decisionId, paramsHash, approve }),
    cancel: taskId => act('personal_cancel', { taskId }),
  }} />;
}
