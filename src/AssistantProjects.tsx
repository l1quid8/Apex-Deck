import { useEffect, useRef, useState } from 'react';
import type { Backend } from './backend';
import type { PersonalAssistantRecord, PersonalLane } from './personalAssistant';
import type { ParticipantConfig, Question } from './types';
import { isWorkingTask } from './assistantStatus';
import { projectIdentityKey, type AssistantProjectBinding, type ProjectRef } from './assistantIdentity';
import { assistantTaskActionArgs, taskDisplayStatus, type AssistantTask, type AssistantTaskOwner, type AssistantTaskSnapshot } from './assistantTaskModel';
import { activeProjectTask, assignmentBlocked, projectTasks, sameWorkerConfiguration } from './assistantProjectsModel';
import './assistant-projects.css';

export type AssistantProjectItem = { project: ProjectRef; name: string; goal?: string; unavailable?: string };
export type AssistantProjectScope = { project: ProjectRef; owner: AssistantTaskOwner; snapshot?: AssistantTaskSnapshot };
export type AssistantProjectsProps = {
  lane: PersonalLane; backend: Backend; projects: AssistantProjectItem[]; availableProjects?: AssistantProjectItem[]; unavailableProjects?: {id:string;name:string;path:string;problem:string}[]; taskScopes: AssistantProjectScope[];
  onEnsureCoordinator?: (project: ProjectRef) => Promise<AssistantProjectScope>;
  profiles?: ParticipantConfig[]; onCreateWorkerThread?: (project: ProjectRef, profile: ParticipantConfig) => Promise<string>;
  onOpenProject?: (project: ProjectRef) => void; onOpenNotebook?: (project: ProjectRef) => void; onOpenThread?: (project: ProjectRef, threadId: string) => void;
  /** Inside the Work view: no intro, stats or filter, which Work already shows. */
  compact?: boolean;
  /** A task Work asked to open. */
  focusTask?: { project: ProjectRef; taskId: string; nonce: number } | null;
  /** Called once the focused task is open, so the same focus never reopens it. */
  onFocusHandled?: () => void;
  onDetailChange?: (open: boolean) => void;
  onKeepThread?: (project: ProjectRef, id: string) => void;
  detailBackLabel?: string;
  onDetailBack?: () => void;
};
const id = () => crypto.randomUUID();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function AssistantProjects({lane,backend,projects,availableProjects=projects,unavailableProjects=[],taskScopes,profiles=[],onEnsureCoordinator,onCreateWorkerThread,onOpenProject,onOpenNotebook,onOpenThread,compact=false,focusTask=null,onFocusHandled,onDetailChange,detailBackLabel='Projects',onDetailBack,onKeepThread}: AssistantProjectsProps) {
  const record = lane.assistant;
  const [dynamic,setDynamic] = useState<{ownerKey:string;scopes:AssistantProjectScope[]}>({ownerKey:'',scopes:[]});
  const [reviewRevision,setReviewRevision] = useState<number|null>(null);
  const [reviewChangesRevision,setReviewChangesRevision] = useState<number|null>(null);
  const [reviewChecksRevision,setReviewChecksRevision] = useState<number|null>(null);
  const [reviewChecks,setReviewChecks] = useState<string[]>([]);
  const [reviewOpen,setReviewOpen] = useState(false);
  const [snapshots,setSnapshots] = useState<Record<string,AssistantTaskSnapshot>>({});
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [filter,setFilter] = useState('assigned');
  const [selected,setSelected] = useState<{project:ProjectRef;taskId:string}|null>(null);
  const [dialog,setDialog] = useState<'assign'|'delegate'|null>(null);
  const [draft,setDraft] = useState<AssistantProjectBinding[]>([]);
  const [revision,setRevision] = useState(0);
  const [grantRecord,setGrantRecord] = useState<PersonalAssistantRecord|null>(null);
  const [pendingFolder,setPendingFolder] = useState<AssistantProjectItem|null>(null);
  const grantLifetime=useRef(0);
  useEffect(()=>{grantLifetime.current++;return()=>{grantLifetime.current++;};},[backend,lane.assistant?.id,lane.assistant?.hostId]);
  const [projectKey,setProjectKey] = useState('');
  const [worker,setWorker] = useState('');
  const [revisedWorker,setRevisedWorker] = useState('');
  const [answerValues,setAnswerValues] = useState<Record<string,string[]>>({});
  const [answerOther,setAnswerOther] = useState<Record<string,string>>({});
  const [brief,setBrief] = useState('');
  const [taskAccess,setTaskAccess] = useState<'read_only'|'isolated'>('read_only');
  const [criteria,setCriteria] = useState('');
  const [reviewed,setReviewed] = useState(false);
  const [excerpt,setExcerpt] = useState('');
  const [promotion,setPromotion] = useState(false);
  const [notice,setNotice] = useState('');
  const delegationId = useRef(id());
  const promotionId = useRef(id());
  const generation = useRef(0);
  const createdThreads = useRef<Record<string,string>>({});
  const ownerKey = JSON.stringify([record?.hostId,record?.id]);
  const effectiveScopes=[...new Map([...taskScopes,...(dynamic.ownerKey===ownerKey?dynamic.scopes:[])].map(scope=>[projectIdentityKey(scope.project),scope])).values()];
  const scopesKey = JSON.stringify(effectiveScopes.map(scope=>[scope.project,scope.owner]));
  const current = useRef({ownerKey,backend}); current.current={ownerKey,backend};
  const assignments = record?.projects ?? [];
  const binding = (project:ProjectRef) => assignments.find(item=>projectIdentityKey(item.project)===projectIdentityKey(project));
  async function refresh() {
    if(current.current.ownerKey!==ownerKey||current.current.backend!==backend)return;
    const token=++generation.current;
    const loaded:Record<string,AssistantTaskSnapshot>={}, failures:Record<string,string>={};
    await Promise.all(effectiveScopes.map(async scope=>{
      const key=projectIdentityKey(scope.project);
      try {
        if (!record || lane.offline || backend.demo) throw new Error('Connect the assistant’s machine to read live assignments.');
        if (scope.project.hostId!==record.hostId) throw new Error('This assignment is on another machine.');
        const snapshot=await backend.call<AssistantTaskSnapshot>('assistant_tasks_list',{owner:scope.owner});
        projectTasks(snapshot,scope.owner,scope.project,{hostId:record.hostId,assistantId:record.id}); loaded[key]=snapshot;
      } catch(cause) { failures[key]=message(cause); }
    }));
    if(token===generation.current&&current.current.ownerKey===ownerKey&&current.current.backend===backend){setSnapshots(before=>({...before,...loaded}));setErrors(failures);}
  }
  useEffect(()=>{setSelected(null);setDialog(null);setError('');setBusy(false);setPendingFolder(null);setGrantRecord(null);},[ownerKey,backend]);
  // Work's Review goes through openTask so the previous task's review state never carries over.
  const focusSnapshot=focusTask?(snapshots[projectIdentityKey(focusTask.project)]??effectiveScopes.find(scope=>projectIdentityKey(scope.project)===projectIdentityKey(focusTask.project))?.snapshot):undefined;
  useEffect(()=>{if(!focusTask)return;const task=focusSnapshot?.tasks.find(item=>item.id===focusTask.taskId);if(!task)return;openTask(focusTask.project,task);onFocusHandled?.();},[focusTask?.nonce,focusSnapshot]);
  useEffect(()=>{void refresh();let stop:(()=>void)|undefined;let active=true;
    if(backend.onAssistantTasksChanged) void backend.onAssistantTasksChanged(()=>{if(active)void refresh();}).then(unlisten=>{if(active)stop=unlisten;else unlisten();}).catch(()=>{});
    return()=>{active=false;generation.current++;stop?.();};
  },[ownerKey,backend,scopesKey,lane.offline]);
  const tasksFor=(project:ProjectRef) => {
    const scope=effectiveScopes.find(item=>projectIdentityKey(item.project)===projectIdentityKey(project));
    const snapshot=snapshots[projectIdentityKey(project)]??scope?.snapshot;
    if(!scope||!snapshot||!record)return [];
    return projectTasks(snapshot,scope.owner,project,{hostId:record.hostId,assistantId:record.id});
  };
  const allTasks=projects.flatMap(item=>tasksFor(item.project)).filter(task=>task.resultData?.deletedAtMs == null);
  const task=selected?tasksFor(selected.project).find(item=>item.id===selected.taskId):undefined;
  const scope=effectiveScopes.find(item=>projectIdentityKey(item.project)===projectKey);
  const chosen=projects.find(item=>projectIdentityKey(item.project)===projectKey);
  const snapshot=scope?snapshots[projectKey]:undefined;
  const savedWorkers=(snapshot?.routingThreads??[]).flatMap(thread=>thread.workers.map(profile=>({key:JSON.stringify([thread.id,profile.id]),threadId:thread.id,profile}))).filter(choice=>!choice.profile.media);
  const workers=onCreateWorkerThread?profiles.filter(profile=>!profile.media).map(profile=>({key:profile.id,threadId:savedWorkers.find(choice=>sameWorkerConfiguration(choice.profile,profile))?.threadId??'',profile})):savedWorkers;
  const offline=lane.offline||backend.demo||!record;
  async function run(action:()=>Promise<void>) {
    if(busy||offline)return;const captured=current.current;setBusy(true);setError('');
    try { await action(); } catch(cause) { if(current.current.ownerKey===captured.ownerKey&&current.current.backend===captured.backend)setError(message(cause)); }
    finally { if(current.current.ownerKey===captured.ownerKey&&current.current.backend===captured.backend)setBusy(false); }
  }
  async function allowProjectFolder() {
    if(!record||!pendingFolder||busy||offline||backend.supports?.('assistant_project_folder_grant_v1')!==true)return;
    const captured=current.current;const token=grantLifetime.current;const project=pendingFolder.project;
    const assertCurrent=()=>{
      if(token!==grantLifetime.current||current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed while allowing this folder.');
      const status=backend.host?.connection.get().status;
      if(backend.host&&(status?.kind!=='connected'||status.hostId!==record.hostId))throw new Error('The assistant machine identity changed. Reconnect before allowing this folder.');
    };
    await run(async()=>{
      assertCurrent();
      const result=await backend.call<{assistant:PersonalAssistantRecord}>('personal_workspace_configure',{assistantId:record.id,expectedRevision:revision,folderGrant:project});
      assertCurrent();const updated=result.assistant;
      if(updated.id!==record.id||updated.hostId!==record.hostId||!Number.isSafeInteger(updated.revision)||updated.revision<revision||!Array.isArray(updated.allowedFolders))throw new Error('The folder grant owner could not be verified. Reopen Assign projects before saving.');
      setGrantRecord(updated);setRevision(updated.revision);setPendingFolder(null);
    });
  }
  async function ensureCoordinator(project:ProjectRef) {
    const captured=current.current;
    const scope=onEnsureCoordinator?await onEnsureCoordinator(project):effectiveScopes.find(item=>projectIdentityKey(item.project)===projectIdentityKey(project));
    if(current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed while connecting its project.');
    if(!scope)return;
    if(projectIdentityKey(scope.project)!==projectIdentityKey(project))throw new Error('The coordinator returned a different project.');
    const snapshot=await backend.call<AssistantTaskSnapshot>('assistant_tasks_list',{owner:scope.owner});
    if(current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed while reading its project.');
    if(!record)throw new Error('The assistant is unavailable.');
    projectTasks(snapshot,scope.owner,project,{hostId:record.hostId,assistantId:record.id});
    setDynamic(before=>({ownerKey,scopes:[...(before.ownerKey===ownerKey?before.scopes:[]).filter(item=>projectIdentityKey(item.project)!==projectIdentityKey(project)),scope]}));
    setSnapshots(before=>({...before,[projectIdentityKey(project)]:snapshot}));
  }
  async function openDelegate(project?:ProjectRef) {
    const target=project??projects.find(item=>binding(item.project)?.tools!=='off')?.project;
    if(!target||!binding(target)||binding(target)?.tools==='off')return;
    await run(async()=>{await ensureCoordinator(target);setProjectKey(projectIdentityKey(target));setWorker('');setBrief('');setTaskAccess('read_only');setCriteria('');setError('');delegationId.current=id();setDialog('delegate');});
  }
  const workerName=(workerId:string) => profiles.find(profile=>profile.id===workerId)?.display_name || Object.values(snapshots).flatMap(snapshot=>snapshot.routingThreads??[]).flatMap(thread=>thread.workers).find(profile=>profile.id===workerId)?.display_name || 'Worker unavailable';
  const startup=task?.resultData?.startup && typeof task.resultData.startup === 'object' ? task.resultData.startup as {message?:string;workers?:unknown[]} : null;
  const startupWorkerReasons=(Array.isArray(startup?.workers)?startup.workers:[]).flatMap(worker=>{
    const blocked=worker&&typeof worker==='object'?(worker as {needsYou?:unknown;needs_you?:unknown}).needsYou??(worker as {needs_you?:unknown}).needs_you:null;
    if(!blocked||typeof blocked!=='object')return [];
    const detail=blocked as {profile_id?:string;profileId?:string;detail?:string};
    return typeof detail.detail==='string'?[`${workerName(detail.profileId??detail.profile_id??task?.workers[0]??'')}: ${detail.detail}`]:[];
  });
  const startupReason=startupWorkerReasons.length?startupWorkerReasons.join(' '):(task?.workers??[]).reduce((reason,id)=>reason.replaceAll(`${id}: `,`${workerName(id)}: `),startup?.message??'The owning machine could not start the selected worker.');
  function openTask(project:ProjectRef, task:AssistantTask) {setRevisedWorker('');onDetailChange?.(true);setReviewChangesRevision(null);setReviewChecksRevision(null);setSelected({project,taskId:task.id});setReviewRevision(null);setReviewChecks([]);setReviewOpen(false);setReviewed(false);setExcerpt(task.result??'');setPromotion(false);setNotice('');promotionId.current=id();}
  const taskRow=(project:ProjectRef,item:AssistantTask)=><button className="assistant-project-task" key={item.id} onClick={()=>openTask(project,item)}><span><strong>{item.brief}</strong><small>{lane.name} → {item.workers.map(workerName).join(', ')||'Worker not selected'}</small></span><span className="assistant-project-status">{taskDisplayStatus(item)}</span></button>;
  const revisedSavedWorkers=(selected?snapshots[projectIdentityKey(selected.project)]?.routingThreads??[]:[]).flatMap(thread=>thread.workers.filter(profile=>!profile.media).map(profile=>({key:JSON.stringify([thread.id,profile.id]),threadId:thread.id,profile})));
  const revisedChoices=onCreateWorkerThread?profiles.filter(profile=>!profile.media).map(profile=>({key:profile.id,threadId:revisedSavedWorkers.find(saved=>sameWorkerConfiguration(saved.profile,profile))?.threadId??'',profile})):revisedSavedWorkers;
  async function checkRevisedStartup() {
    if(!task||!selected)return;
    const choice=revisedChoices.find(choice=>choice.key===revisedWorker);if(!choice)return;
    const captured=current.current;
    await run(async()=>{
      const threadKey=JSON.stringify(['startup',captured.ownerKey,projectIdentityKey(selected.project),task.id,task.revision,choice.profile]);
      const threadId=choice.threadId||createdThreads.current[threadKey]||await onCreateWorkerThread?.(selected.project,choice.profile);
      if(!threadId)throw new Error('Choose an available saved worker chat.');
      if(current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed while checking this plan.');
      createdThreads.current[threadKey]=threadId;
      const result=await backend.call<AssistantTask>('assistant_task_action',assistantTaskActionArgs(task,'revise_startup',{mode:task.mode,destination:{threadId,workers:[choice.profile.id],newThread:false}}));
      if(result.id!==task.id)throw new Error('The host returned a different task.');
      await refresh();setRevisedWorker('');setNotice('Revised plan checked. Review its worker and unchanged access, then approve this revision to start.');
    });
  }
  const questionGroup=(value:unknown): value is {request:string;questions:Question[]} => !!value&&typeof value==='object'&&typeof (value as {request?:unknown}).request==='string'&&!!(value as {request:string}).request&&Array.isArray((value as {questions?:unknown}).questions)&&(value as {questions:unknown[]}).questions.length>0&&(value as {questions:unknown[]}).questions.every(question=>!!question&&typeof question==='object'&&typeof (question as Question).question==='string'&&Array.isArray((question as Question).options));
  const approvalGroup=(value:unknown): value is {request:string;action:{title:string;detail:string}} => !!value&&typeof value==='object'&&typeof (value as {request?:unknown}).request==='string'&&!!(value as {request:string}).request&&!!(value as {action?:unknown}).action&&typeof (value as {action:{title?:unknown}}).action.title==='string'&&typeof (value as {action:{detail?:unknown}}).action.detail==='string';
  const answerKey=(request:string,index:number)=>`${task?.id}:${request}:${index}`;
  const answersFor=(group:{request:string;questions:Question[]})=>group.questions.map((_,index)=>[...(answerValues[answerKey(group.request,index)]??[]),...(answerOther[answerKey(group.request,index)]?.trim()?[answerOther[answerKey(group.request,index)].trim()]:[])]);
  async function answerTaskWait(wait:unknown, approve?:boolean) {
    if(!task||!selected||!record)return;
    const target=task, project=selected.project, captured=current.current;
    const scope=effectiveScopes.find(scope=>projectIdentityKey(scope.project)===projectIdentityKey(project));
    const request=wait&&typeof wait==='object'?(wait as {request?:unknown}).request:undefined;
    if(!scope||typeof request!=='string'||!request)return;
    const answers=approve===undefined&&questionGroup(wait)?answersFor(wait):null;
    if(approve===undefined&&(!answers||answers.some(answer=>!answer.length)))return;
    await run(async()=>{
      const snapshot=await backend.call<AssistantTaskSnapshot>('assistant_tasks_list',{owner:scope.owner});
      if(current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed before this response could be sent.');
      const latest=projectTasks(snapshot,scope.owner,project,{hostId:record.hostId,assistantId:record.id}).find(task=>task.id===target.id);
      const waits=approve===undefined?latest?.resultData?.pendingQuestions:latest?.resultData?.pendingApprovals;
      if(!latest||latest.revision!==target.revision||latest.executionThreadId!==target.executionThreadId||!latest.executionThreadId||latest.resultData?.deletedAtMs!=null||!waits?.some(wait=>wait&&typeof wait==='object'&&(wait as {request?:unknown}).request===request))throw new Error('This task or worker question changed. Refresh before responding.');
      if(approve===undefined)await backend.roomAnswer(latest.executionThreadId,request,answers);
      else await backend.roomDecide(latest.executionThreadId,request,approve,false);
      await refresh();
    });
  }
  async function act(action:string, payload:Parameters<typeof assistantTaskActionArgs>[2]={}) {
    if(!task||!selected)return;
    await run(async()=>{const result=await backend.call<AssistantTask>('assistant_task_action',assistantTaskActionArgs(task,action,payload));if(result.id!==task.id)throw new Error('The host returned a different task.');await refresh();setReviewed(false);});
  }
  if(!record)return <p className="muted">Connect an assistant to manage its projects.</p>;
  return <div className="assistant-projects">
    {error&&<p role="alert" className="assistant-project-error">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {task&&selected?<article className="assistant-project-detail">
      {offline&&<p role="status">Machine offline. Showing the last cached task; reconnect before sending task commands.</p>}
      <button className="assistant-task-back" onClick={()=>{setSelected(null);onDetailChange?.(false);onDetailBack?.();}}>{`← ${detailBackLabel}`}</button>
      <header className="assistant-task-heading"><div><p className="assistant-task-phase">{task.status==='proposed'?'Review plan':task.status==='ready_for_review'?'Review result':task.status==='done'?'Completed task':'Task details'} · Revision {task.revision}</p><h2 className="assistant-project-title">{task.brief}</h2></div><span className="assistant-project-status" data-state={task.status}>{taskDisplayStatus(task)}</span></header>
      <section className="assistant-task-plan" aria-label="Task plan">
        <dl className="assistant-task-scope"><div><dt>Project</dt><dd>{projects.find(project=>projectIdentityKey(project.project)===projectIdentityKey(selected.project))?.name??selected.project.cwd}</dd></div><div><dt>Worker</dt><dd>{task.workers.map(workerName).join(', ')||'Worker not selected'}</dd></div><div><dt>Machine</dt><dd>{lane.hostName||record.hostId}</dd></div><div><dt>Access</dt><dd>{task.mode==='read_only'?'Read only':task.mode==='isolated'?'Separate copy':'Edit project folder'}</dd></div><div className="assistant-task-folder"><dt>Folder</dt><dd>{selected.project.cwd}</dd></div></dl>
        {task.status==='proposed'&&<div className="assistant-task-criteria"><h3>Review criteria</h3>{task.reviewCriteria.length?<ul>{task.reviewCriteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul>:<p>No additional review criteria.</p>}<p className="assistant-task-hint">The worker has not started. Approval applies to this exact plan revision.</p></div>}
      </section>
      {task.resultData?.deletedAtMs != null && <p role="status">Deleted task. Restoring keeps its recorded status and never starts work.</p>}
      {(startup || (task.status==='proposed'&&!!task.resultData?.startupPreflight)) && <section className="assistant-project-outcome"><h3>{startup?'Couldn’t start':'Review worker options'}</h3><p>{startup?startupReason:'Compatibility checked. Review this plan before starting the worker.'}</p><p>{task.attempts.length ? 'Previous attempts are preserved in task history.' : 'Execution has not started.'}</p><p>Choose a configured worker and check the revised plan. The machine verifies compatibility before a separate approval. The project, request and access mode stay the same.</p>{task.resultData?.deletedAtMs == null && ['needs_you','proposed'].includes(task.status) && task.attempts.length===0 && <div className="assistant-project-actions"><label>Revised task worker<select aria-label="Revised task worker" value={revisedWorker} disabled={busy||offline||backend.supports?.('assistant_task_revise_startup_v1')!==true} onChange={event=>setRevisedWorker(event.target.value)}><option value="">Choose a configured worker</option>{revisedChoices.map(choice=><option key={choice.key} value={choice.key}>{choice.profile.display_name||'Unnamed worker'}</option>)}</select></label><button className="primary assistant-task-primary" disabled={busy||offline||record.paused||!revisedWorker||backend.supports?.('assistant_task_revise_startup_v1')!==true} onClick={()=>void checkRevisedStartup()}>Check revised plan</button>{backend.supports?.('assistant_task_revise_startup_v1')!==true&&<p>Update this machine’s service to check a revised worker plan safely.</p>}</div>}<details><summary>Startup diagnostics</summary><pre>{JSON.stringify({startup:task.resultData?.startup,result:task.result},null,2)}</pre></details></section>}
      {task.result && !startup && <section className="assistant-task-result-body"><h3>{task.status === 'failed' || task.status === 'interrupted' ? "Couldn’t finish" : 'Result'}</h3><pre>{task.result}</pre></section>}
      {task.resultData?.deletedAtMs == null ? <><div className="assistant-task-commandbar">
        {task.status==='proposed'&&task.destination&&<button className="primary assistant-task-primary" disabled={busy||offline||record.paused||task.desiredState==='paused'} onClick={()=>void act('approve',{destination:task.destination!,newWorkerProfiles:[],mode:task.mode})}>{task.resultData?.startupPreflight?'Approve revised plan':'Approve and start'}</button>}
        {task.desiredState==='paused'&&<button className="primary assistant-task-primary" disabled={busy||offline||record.paused} onClick={()=>void act('resume')}>Resume task</button>}
        {['failed','interrupted'].includes(task.status)&&<button className="primary assistant-task-primary" disabled={busy||offline||record.paused||task.desiredState==='paused'} onClick={()=>void act('retry')}>Retry task</button>}
        <details className="assistant-task-actions-menu"><summary>Task actions</summary><div className="assistant-task-menu-content">
          {task.desiredState!=='paused'&&['proposed','needs_clarification','queued','running','needs_you'].includes(task.status)&&<button disabled={busy||offline} onClick={()=>void act('pause')}>Pause task</button>}
          {['proposed','needs_clarification'].includes(task.status)&&<button disabled={busy||offline} onClick={()=>void act('dismiss')}>Dismiss proposal</button>}
          {activeProjectTask(task)&&<button disabled={busy||offline} onClick={()=>void act('cancel')}>Cancel task</button>}
          {task.executionThreadId&&<button onClick={()=>onOpenThread?.(selected.project,task.executionThreadId!)}>Open worker thread</button>}
          {onOpenProject&&<button onClick={()=>onOpenProject(selected.project)}>Open project</button>}
          <button className="assistant-task-delete" disabled={busy||offline||!lane.taskLifecycle} onClick={()=>void run(async()=>{await lane.taskLifecycle!('delete',{source:'delegated',taskId:task.id,revision:task.revision});await refresh();})}>{['done','cancelled','failed','interrupted'].includes(task.status)?'Delete':'Cancel and delete'}</button>
        </div></details>
      </div>
      {task.status==='ready_for_review'&&<section className="assistant-task-review"><h3>Review result · revision {task.revision}</h3><details onToggle={event=>{setReviewOpen(event.currentTarget.open);setReviewRevision(event.currentTarget.open?task.revision:null);}}><summary>Inspect result, changes and checks</summary><p className="assistant-task-hint">Review the result above, then inspect the available evidence.</p><details onToggle={event=>{if(event.currentTarget.open)setReviewChangesRevision(task.revision);}}><summary>Changes</summary>{task.resultData?.reviewDiff?<pre>{task.resultData.reviewDiff}</pre>:<p>{task.mode==='read_only'?'Read-only task. No editable changes are expected.':'The worker did not report a diff. Inspect the result limitations before accepting.'}</p>}</details><details onToggle={event=>{if(event.currentTarget.open)setReviewChecksRevision(task.revision);}}><summary>Checks</summary><pre>{JSON.stringify(task.resultData?.checkResults??task.resultData?.checks??[],null,2)}</pre><p>Reported check output is evidence to review; a successful exit alone does not establish that the requested work is complete.</p></details></details>{task.reviewCriteria.map(criterion=><label key={criterion}><input type="checkbox" checked={reviewChecks.includes(criterion)} onChange={event=>setReviewChecks(before=>event.target.checked?[...before,criterion]:before.filter(item=>item!==criterion))}/>I reviewed: {criterion}</label>)}<button className="primary assistant-task-primary" disabled={busy||offline||!reviewOpen||reviewRevision!==task.revision||(task.mode!=='read_only'&&(reviewChangesRevision!==task.revision||reviewChecksRevision!==task.revision))||task.reviewCriteria.some(criterion=>!reviewChecks.includes(criterion))} onClick={()=>{if(task.mode==='read_only'||window.confirm(`Accept changes from revision ${task.revision}? This applies only the inspected task revision to ${selected.project.cwd}.`))void act(task.mode==='read_only'?'review':'accept');}}>{task.mode==='read_only'?'Mark reviewed':task.mode==='isolated'?'Accept changes':'Accept and mark done'}</button></section>}
      {task.status==='proposed'&&task.resultData?.startupPreflight&&<section><h3>Review revised plan · revision {task.revision}</h3><p>Worker: {task.workers.map(workerName).join(', ')}. Project: {selected.project.cwd}. Access: {task.mode.replaceAll('_',' ')}. Your original request and review criteria are preserved.</p><details><summary>Preflight evidence</summary><pre>{JSON.stringify(task.resultData.startupPreflight,null,2)}</pre></details></section>}
      {(task.resultData?.pendingQuestions??[]).map((wait,index)=>questionGroup(wait)?<section key={`question:${wait.request}`}><h3>Answer question</h3>{wait.questions.map((question,questionIndex)=>{const key=answerKey(wait.request,questionIndex);return <fieldset key={key}><legend>{question.header||`Question ${questionIndex+1}`}</legend><p>{question.question}</p>{question.options.map(option=><label key={option.label}><input type={question.multi_select?'checkbox':'radio'} name={key} checked={(answerValues[key]??[]).includes(option.label)} disabled={busy||offline} onChange={event=>setAnswerValues(before=>({...before,[key]:question.multi_select?event.target.checked?[...(before[key]??[]),option.label]:(before[key]??[]).filter(label=>label!==option.label):[option.label]}))}/>{option.label}{option.description&&<small>{option.description}</small>}</label>)}<label>Your answer<input aria-label={`Your answer ${questionIndex+1}`} value={answerOther[key]??''} disabled={busy||offline} onChange={event=>setAnswerOther(before=>({...before,[key]:event.target.value}))}/></label></fieldset>;})}<button className="primary assistant-task-primary" disabled={busy||offline||!task.executionThreadId||answersFor(wait).some(answer=>!answer.length)} onClick={()=>void answerTaskWait(wait)}>Send answers</button></section>:<p key={`old-question:${index}`}>This question uses older metadata. Open the worker thread to respond safely.</p>)}
      {(task.resultData?.pendingApprovals??[]).map((wait,index)=>approvalGroup(wait)?<section key={`approval:${wait.request}`}><h3>{wait.action.title}</h3><p>{wait.action.detail}</p><button className="primary assistant-task-primary" disabled={busy||offline||!task.executionThreadId} onClick={()=>void answerTaskWait(wait,true)}>Approve this action</button><button disabled={busy||offline||!task.executionThreadId} onClick={()=>void answerTaskWait(wait,false)}>Deny this action</button></section>:<p key={`old-approval:${index}`}>This approval uses older metadata. Open the worker thread to review it safely.</p>)}
      {task.result&&['ready_for_review','done'].includes(task.status)&&<section className="assistant-task-knowledge"><h3>Project knowledge</h3>{['ready_for_review','done'].includes(task.status)&&<button disabled={!lane.projectMemory?.stage||offline} onClick={()=>{setPromotion(true);setReviewed(false);}}>Review &amp; save to project</button>}</section>}
      {promotion&&<section className="assistant-project-outcome"><h3>Save reviewed worker note</h3><p>Choose an exact excerpt from the completed result. This saves a shared project note with source task and attempt.</p><textarea aria-label="Worker result excerpt" value={excerpt} onChange={event=>{setExcerpt(event.target.value);setReviewed(false);}}/><label><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I reviewed this excerpt and want to share it with this project.</label><div className="assistant-project-actions"><button disabled={busy||!reviewed||!excerpt.trim()||!task.result?.includes(excerpt.trim())||offline} onClick={()=>void run(async()=>{
        const attempt=task.attempts.at(-1);if(!attempt||!lane.projectMemory?.stage||!lane.projectMemory.promote)throw new Error('Completed task evidence is unavailable.');
        const staged=await lane.projectMemory.stage({project:selected.project,taskId:task.id,attempt:attempt.number,runId:attempt.runId,expectedTaskRevision:task.revision,text:excerpt.trim(),kind:'fact'});
        const receipt=await lane.projectMemory.promote({...staged,promotionId:promotionId.current});setPromotion(false);setNotice(`Saved project note ${receipt.noteId} · version ${receipt.noteVersion}.`);
      })}>Save to project notebook</button><button onClick={()=>setPromotion(false)}>Dismiss note</button></div></section>}
      <details><summary>Request, worker and review criteria</summary><div className="assistant-project-meta"><span>Assistant <strong>{lane.name}</strong></span><span>Workers <strong>{task.workers.map(workerName).join(', ')}</strong></span><span>Attempt <strong>{task.attempts.at(-1)?.number??'Not started'}</strong></span></div>
      <section><h3>Original request</h3><p>{task.originalRequest}</p><h3>Review criteria</h3>{task.reviewCriteria.length?<ul>{task.reviewCriteria.map((criterion,i)=><li key={i}>{criterion}</li>)}</ul>:<p>No review criteria recorded.</p>}</section>
      </details>
      <details><summary>Context available to this worker</summary>{(task.resultData as {delegationContext?:unknown}|null)?.delegationContext?<><p>Captured by the host when this proposal was created. Shared worker prompts exclude private assistant facts.</p><pre>{JSON.stringify((task.resultData as {delegationContext:unknown}).delegationContext,null,2)}</pre></>:<p className="muted">No captured worker context was returned by this host for this task.</p>}</details>
      <details><summary>Worker conversation and workspace</summary>{onKeepThread&&task.executionThreadId&&<button onClick={()=>onKeepThread(selected.project,task.executionThreadId!)}>Keep conversation in sidebar</button>}<pre>{JSON.stringify({taskId:task.id,thread:task.executionThreadId,workspace:task.resultData?.executionPath??'Not reported by host',mode:task.mode,revision:task.revision,workers:task.workers,attempts:task.attempts},null,2)}</pre></details>
      </> : <button disabled={busy||offline||!lane.taskLifecycle} onClick={()=>void run(async()=>{await lane.taskLifecycle!('restore',{source:'delegated',taskId:task.id,revision:task.revision});await refresh();})}>Restore</button>}
      <details className="assistant-task-history-disclosure"><summary>Task history</summary>{task.resultData?.taskHistory?.length?task.resultData.taskHistory.map((entry,i)=><div className="assistant-project-event" key={i}>{Number.isFinite(entry.atMs)&&<time>{new Date(entry.atMs).toLocaleString()}</time>}<p>{entry.text}</p></div>):<p className="muted">No task history reported by this host.</p>}</details>
    </article>:<>
      {!compact&&<div className="assistant-project-intro"><h2>{lane.name}’s projects</h2><p>Give each project a clear goal. Your assistants coordinate the workers and bring the results back here.</p></div>}
      {!compact&&<div className="assistant-project-overview"><span><strong>{assignments.length}</strong> projects</span><span><strong>{allTasks.filter(item=>['running','applying'].includes(item.status)).length}</strong> working</span><span><strong>{allTasks.filter(item=>['ready_for_review','needs_you'].includes(item.status)).length}</strong> need review</span></div>}
      <div className="assistant-project-toolbar">{!compact&&<select aria-label="Projects to show" value={filter} onChange={event=>setFilter(event.target.value)}><option value="assigned">Assigned to {lane.name}</option><option value="all">All projects</option></select>}<div className="assistant-project-actions"><button disabled={offline||!lane.configureWorkspace} onClick={()=>{const base=grantRecord&&grantRecord.id===record.id&&grantRecord.hostId===record.hostId&&grantRecord.revision>record.revision?grantRecord:record;setDraft(assignments.map(item=>({...item})));setRevision(base.revision);setGrantRecord(base);setPendingFolder(null);setDialog('assign');setError('');}}>Assign projects</button><button className="primary" disabled={offline||!assignments.some(item=>item.tools!=='off')} onClick={()=>openDelegate()}>Delegate a task</button></div></div>
      {(filter==='all'?availableProjects:projects).map(item=>{const tasks=tasksFor(item.project).filter(task=>task.resultData?.deletedAtMs == null);const key=projectIdentityKey(item.project);return <article className="assistant-project-card" key={key}><div className="assistant-project-top"><span className="assistant-project-glyph">▱</span><div><h3>{item.name}</h3><p>{item.project.cwd}</p></div><span className="assistant-project-status">{tasks.some(isWorkingTask)?`${tasks.filter(isWorkingTask).length} working`:tasks.some(task=>task.status==='running'&&task.desiredState==='paused')?'Paused':tasks.some(task=>task.status==='ready_for_review')?'Needs review':errors[key]?'Unavailable':binding(item.project)&&!snapshots[key]?'Not connected':'Ready'}</span></div><p>{item.goal||'No project goal recorded.'}</p><span className="assistant-project-owner">{binding(item.project)?lane.name:'Not assigned to this assistant'}</span>{item.unavailable&&<p role="status">{item.unavailable}</p>}{errors[key]&&<p role="status">{errors[key]}</p>}{!effectiveScopes.some(scope=>projectIdentityKey(scope.project)===key)&&binding(item.project)&&<p className="muted">Delegate a task to connect this project’s task coordinator.</p>}{tasks.filter(activeProjectTask).slice(0,3).map(task=>taskRow(item.project,task))}{!tasks.filter(activeProjectTask).length&&<p className="muted">No active assignments.</p>}<div className="assistant-project-actions"><button disabled={!!item.unavailable} onClick={()=>onOpenProject?.(item.project)}>Open project</button><button disabled={offline||!binding(item.project)||binding(item.project)?.tools==='off'||!!item.unavailable} onClick={()=>openDelegate(item.project)}>Delegate a task</button><button disabled={!binding(item.project)} onClick={()=>onOpenNotebook?.(item.project)}>Project notebook</button></div>{tasks.filter(item=>!activeProjectTask(item)).length>0&&<details><summary>Completed and previous assignments</summary>{tasks.filter(item=>!activeProjectTask(item)).map(task=>taskRow(item.project,task))}</details>}</article>;})}
      {!projects.length&&<p className="assistant-project-empty">No projects assigned yet. Choose Assign projects to give this assistant a place to work.</p>}
      <p className="assistant-project-note">Each worker uses its assignment and project notebook. Worker result excerpts become shared project knowledge only after explicit review.</p>
    </>}
    {dialog&&<div className="assistant-project-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label={dialog==='assign'?'Assign projects':'Delegate a project task'} className="assistant-project-dialog"><header><h2>{dialog==='assign'?'Assign projects':'Delegate a project task'}</h2><button disabled={busy} aria-label="Close dialog" onClick={()=>setDialog(null)}>×</button></header>{error&&<p role="alert">{error}</p>}
      {dialog==='assign'?<form onSubmit={event=>{event.preventDefault();void run(async()=>{await lane.configureWorkspace!({expectedRevision:revision,projects:draft});setDialog(null);});}}><p>Choose existing projects for this assistant. Allow a project’s exact folder below when it needs permission. Active work must finish or be cancelled before an assignment is removed.</p>{availableProjects.map(item=>{const key=projectIdentityKey(item.project);const saved=draft.find(binding=>projectIdentityKey(binding.project)===key);const folderBlocked=assignmentBlocked(grantRecord??record,item.project);const blocked=folderBlocked||item.unavailable;const canGrant=!!folderBlocked&&!item.unavailable&&item.project.hostId===record.hostId&&backend.supports?.('assistant_project_folder_grant_v1')===true;const active=tasksFor(item.project).some(activeProjectTask);return <div className="assistant-project-assignment" key={key}><label><input type="checkbox" checked={!!saved} disabled={busy||offline||(!saved&&!!blocked)||(!!saved&&active)} onChange={event=>setDraft(before=>event.target.checked?[...before,{project:item.project,tools:'ask'}]:before.filter(binding=>projectIdentityKey(binding.project)!==key))}/>{item.name}</label>{saved&&<select aria-label={`${item.name} project tools`} value={saved.tools} disabled={busy} onChange={event=>setDraft(before=>before.map(binding=>projectIdentityKey(binding.project)===key?{...binding,tools:event.target.value as AssistantProjectBinding['tools']}:binding))}><option value="ask">Ask first</option><option value="full">Full access</option><option value="off">Off</option></select>}<small>{active?'Finish or cancel active assignments before removing.':blocked||item.project.cwd}</small>{!saved&&canGrant&&<button type="button" disabled={busy||offline} onClick={()=>setPendingFolder(item)}>Allow this folder…</button>}{!saved&&folderBlocked&&!item.unavailable&&!canGrant&&item.project.hostId===record.hostId&&<small>Update this machine’s service, then reconnect to allow this project folder.</small>}</div>;})}{pendingFolder&&<div className="assistant-project-folder-confirm" role="group" aria-label="Confirm project folder access"><strong>Allow {lane.name} to access this folder and its subfolders?</strong><code>{pendingFolder.project.cwd}</code><p>This permission saves immediately. Your assignment draft stays open.</p><button type="button" disabled={busy||offline} onClick={allowProjectFolder}>Allow this folder</button><button type="button" disabled={busy} onClick={()=>setPendingFolder(null)}>Cancel folder access</button></div>}{unavailableProjects.map(item=><div className="assistant-project-assignment" key={item.id}><label><input type="checkbox" checked={false} disabled/>{item.name}</label><small role="status">{item.path} · {item.problem}</small></div>)}<button className="primary" disabled={busy||offline}>Save assignments</button></form>:<form onSubmit={event=>{event.preventDefault();void run(async()=>{
        const choice=workers.find(item=>item.key===worker);if(!chosen||!choice)throw new Error('Choose an assigned project and a worker.');
        if(!binding(chosen.project)||binding(chosen.project)?.tools==='off')throw new Error('Project tools are off for this assignment.');
        if(taskAccess==='isolated'&&record.profile?.access==='read')throw new Error('This assistant’s saved access permits read-only tasks.');
        const captured=current.current;
        const ensureCurrent=()=>{if(current.current.ownerKey!==captured.ownerKey||current.current.backend!==captured.backend)throw new Error('The assistant changed while saving this delegation.');};
        const threadKey=JSON.stringify([delegationId.current,projectKey,choice.profile]);
        const threadId=choice.threadId||createdThreads.current[threadKey]||await onCreateWorkerThread?.(chosen.project,choice.profile);ensureCurrent();
        if(threadId)createdThreads.current[threadKey]=threadId;
        await refresh();ensureCurrent();
        if(!threadId)throw new Error('Create a saved project chat for this worker first.');
        const proposal=await backend.call<{taskId:string}>('personal_project_delegate_ui',{assistantId:record.id,project:chosen.project,sourceEventId:'',delegationId:delegationId.current,brief:brief.trim(),destination:{threadId,workers:[choice.profile.id],newThread:false},mode:taskAccess,reviewCriteria:criteria.split('\n').map(line=>line.trim()).filter(Boolean),expectedRevision:record.revision});ensureCurrent();
        if(!proposal.taskId||!scope)throw new Error('The saved plan could not be identified. Your draft is kept; retry to reopen the same plan.');
        const saved=await backend.call<AssistantTaskSnapshot>('assistant_tasks_list',{owner:scope.owner});ensureCurrent();
        const proposedTask=projectTasks(saved,scope.owner,chosen.project,{hostId:record.hostId,assistantId:record.id}).find(task=>task.id===proposal.taskId);
        if(!proposedTask)throw new Error('The saved plan is not available in this assistant’s task snapshot. Your draft is kept; retry to reopen it.');
        setSnapshots(before=>({...before,[projectIdentityKey(chosen.project)]:saved}));setDialog(null);setNotice('');openTask(chosen.project,proposedTask);
      });}}><label>Owning assistant<input value={`${lane.name} · ${record.hostId}`} readOnly/></label><label>Project<select aria-label="Task project" value={projectKey} onChange={event=>{const key=event.target.value;const project=projects.find(item=>projectIdentityKey(item.project)===key);setWorker('');if(project)void run(async()=>{await ensureCoordinator(project.project);setProjectKey(key);});else setProjectKey(key);}}><option value="">Choose a project</option>{projects.filter(item=>binding(item.project)?.tools!=='off').map(item=><option key={projectIdentityKey(item.project)} value={projectIdentityKey(item.project)}>{item.name}</option>)}</select></label><label>Worker<select aria-label="Worker" value={worker} onChange={event=>setWorker(event.target.value)}><option value="">Choose a worker</option>{workers.map(item=><option key={item.key} value={item.key}>{item.profile.display_name}{onCreateWorkerThread?'':` · ${item.threadId}`}</option>)}</select></label>{!workers.length&&<p role="status">This host requires a saved project chat with a worker. Open the project, create a worker chat, and reconnect its task coordinator.</p>}<label>Task access<select aria-label="Task access" value={taskAccess} disabled={busy} onChange={event=>{if(event.target.value==='read_only'||(event.target.value==='isolated'&&record.profile?.access!=='read'))setTaskAccess(event.target.value as 'read_only'|'isolated');}}><option value="read_only">Read only</option><option value="isolated" disabled={record.profile?.access==='read'}>Separate copy</option></select></label><p className="assistant-project-note">{taskAccess==='read_only'?'Read-only tasks inspect and report. The worker cannot edit project files.':'Separate copy lets a compatible worker edit an isolated workspace. It requires the host’s existing worker, folder, and trust checks.'}</p><label>Brief<textarea aria-label="Task brief" value={brief} maxLength={16000} required onChange={event=>setBrief(event.target.value)}/></label><label>Review criteria (one per line)<textarea value={criteria} onChange={event=>setCriteria(event.target.value)}/></label><p className="assistant-project-note">Creates a durable proposal for human approval. The host verifies source request, worker, project access, folder permissions, and assistant revision.</p>{record.paused&&<p role="status">Resume this assistant before delegating.</p>}<button className="primary" disabled={busy||offline||record.paused||!worker||!brief.trim()||!chosen||!!chosen.unavailable||binding(chosen.project)?.tools==='off'}>Review plan</button></form>}
    </section></div>}
  </div>;
}
