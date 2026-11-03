import type { TaskDelegationTarget, TaskWorkerThreadCreator } from '../taskManagerDelegation.ts';
import type { Backend } from '../backend.ts';
import type { Pane, ParticipantConfig } from '../types.ts';
import type { ProjectRef } from '../assistantIdentity.ts';
import type { WorkspaceTaskRow, PersonalTaskSource } from '../workspaceTasks.ts';
import { WorkspaceTasks } from '../WorkspaceTasksScreen';
import { WorkspaceTaskDetails } from '../WorkspaceTaskDetails';
import './phone-tasks.css';

/** The complete shared detail keeps questions, written answers, review and recovery available. */
export function PhoneTasks({ rows, problems, covered, backendForRow, profiles, panes, personalSources, onOpenThread, onOpenProject, onOpenNotebook, onKeepThread, onCreateWorkerThread, delegationTargets, onCreateTaskWorkerThread }: {
  rows: readonly WorkspaceTaskRow[]; problems: readonly string[]; covered: boolean;
  backendForRow(row: WorkspaceTaskRow): Backend | null;
  delegationTargets?: readonly TaskDelegationTarget[];
  onCreateTaskWorkerThread?: TaskWorkerThreadCreator;
  personalSources?: readonly PersonalTaskSource[];
  profiles: ParticipantConfig[]; panes: Pane[];
  onOpenThread(row: WorkspaceTaskRow, id: string): void;
  onOpenProject?: (row: WorkspaceTaskRow, project: ProjectRef) => void;
  onOpenNotebook?: (row: WorkspaceTaskRow, project: ProjectRef) => void;
  onKeepThread?: (row: WorkspaceTaskRow, project: ProjectRef, id: string) => void;
  onCreateWorkerThread?: (row: WorkspaceTaskRow, project: ProjectRef, profile: ParticipantConfig) => Promise<string>;
}) {
  return <main className="ph-content ph-tasks" inert={covered}>
    <WorkspaceTasks profiles={profiles} delegationTargets={delegationTargets} onCreateWorkerThread={onCreateTaskWorkerThread} personalSources={personalSources} rows={rows} problems={problems} backendForRow={backendForRow} renderDetail={row => <>
      {!backendForRow(row) && <p role="status">Saved task · Reconnect its machine with Full access for current details and actions.</p>}
      <WorkspaceTaskDetails row={row} backend={backendForRow(row)} profiles={profiles} panes={panes} onOpenThread={id => onOpenThread(row, id)} onOpenProject={onOpenProject ? project => onOpenProject(row, project) : undefined} onOpenNotebook={onOpenNotebook ? project => onOpenNotebook(row, project) : undefined} onKeepThread={onKeepThread ? (project, id) => onKeepThread(row, project, id) : undefined} onCreateWorkerThread={onCreateWorkerThread ? (project, profile) => onCreateWorkerThread(row, project, profile) : undefined} />
    </>} />
  </main>;
}
