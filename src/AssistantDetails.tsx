import { useMemo, useState } from 'react';
import type { Backend } from './backend';
import type { PersonalLane } from './personalAssistant';
import { assistantAppearance } from './assistantIdentity';
import { assistantStatus } from './assistantStatus';
import type { AssistantSection } from './assistantWorkspaceModel';
import { assistantOutputs, outputKindLabel, outputMark, outputName, outputsLine } from './assistantOutputs';
import type { AssistantTask } from './assistantTaskModel';
import { Avatar } from './Avatar';
import { createAssistantAvatarApi } from './assistantAvatar';
import './assistant-details.css';

/** An assistant's own sidebar. One column, folds that open in place, and the
 *  files it actually produced listed from the review patches its tasks recorded. */
export function AssistantDetails({lane,backend,tasks=[],onClose,onNavigate,onOpenBrowser}:{
 lane:PersonalLane;
 backend?:Backend;
 /** The tasks this assistant owns; only their recorded review patches are read. */
 tasks?:AssistantTask[];
 onClose:()=>void;
 onNavigate:(section:AssistantSection)=>void;
 onOpenBrowser?:()=>void;
}) {
 const record=lane.assistant;
 const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);
 const avatarApi=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 const status=assistantStatus({offline:!!lane.offline,paused:!!record?.paused,personalTasks:record?.tasks??[],delegatedTasks:tasks});
 const outputs=useMemo(()=>assistantOutputs(tasks),[tasks]);
 const [folded,setFolded]=useState<Record<string,boolean>>({});
 const [shownPath,setShownPath]=useState<string|null>(null);
 const fold=(id:string)=><button type="button" className="assistant-details-fold" aria-expanded={!folded[id]} aria-controls={`assistant-details-${id}`} onClick={()=>setFolded(all=>({...all,[id]:!all[id]}))}>
  <span aria-hidden="true" className="assistant-details-arrow" data-open={!folded[id]}>›</span>{id==='outputs'?'Outputs':'Browser'}
 </button>;
 return <aside className="assistant-details" id="assistant-details" aria-label={`${lane.name} details`}>
  <header className="assistant-details-head">
   <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={avatarApi} size="md"/>
   <div><strong>{lane.name}</strong><p className="assistant-details-sub" data-state={status.state}>{status.label}</p></div>
   <button type="button" className="assistant-details-close" aria-label="Close details" onClick={onClose}>×</button>
  </header>
  <section className="assistant-details-card">
   {fold('browser')}
   {!folded.browser&&<div id="assistant-details-browser" className="assistant-details-fold-body">
    <button type="button" className="assistant-details-browser" disabled={!onOpenBrowser||!lane.browserView} title={!lane.browserView?'This machine does not expose the assistant browser.':undefined} onClick={()=>onOpenBrowser?.()}>
     <span>Browser</span><small>{lane.browserView? 'Opens in a tab beside these details' : 'Not available on this machine'}</small>
    </button>
   </div>}
  </section>
  <section className="assistant-details-card">
   {fold('outputs')}
   {!folded.outputs&&<div id="assistant-details-outputs" className="assistant-details-fold-body">
    {outputs.length===0
     ? <p className="assistant-details-empty">No files yet. When a task records a review patch, the files it made appear here.</p>
     : <>
       <p className="assistant-details-total">{outputsLine(outputs)}</p>
       <ul className="assistant-outputs">
        {outputs.map((file)=>{
         const {name,folder}=outputName(file.path);
         const open=shownPath===file.path;
         return <li key={file.path}>
          <button type="button" className="assistant-output" aria-expanded={open} aria-controls={`assistant-output-${file.path}`} onClick={()=>setShownPath(open?null:file.path)}>
           <span className="assistant-output-mark" data-kind={file.kind} title={outputKindLabel(file.kind)}>{outputMark(file.kind)}</span>
           <span className="assistant-output-name"><strong>{name}</strong>{folder&&<small>{folder}</small>}</span>
           <span className="assistant-output-count"><span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span></span>
          </button>
          {open&&<div id={`assistant-output-${file.path}`} className="assistant-output-patch">
           <p className="assistant-details-note">{outputKindLabel(file.kind)} by {file.taskIds.length===1?'1 task':`${file.taskIds.length} tasks`}{file.patch.trim()===''?' · no patch recorded':''}</p>
           {file.patch.trim()!==''&&<pre tabIndex={0} aria-label={`${name} patch`}>{file.patch}</pre>}
          </div>}
         </li>;
        })}
       </ul>
       <p className="assistant-details-note">From the review patches this assistant’s tasks recorded. Files changed by commands alone are not listed.</p>
      </>}
   </div>}
  </section>
  <footer className="assistant-details-footer">
   <button type="button" onClick={()=>onNavigate('memory')}>Memory</button>
   <button type="button" onClick={()=>onNavigate('projects')}>Projects &amp; access</button>
   <button type="button" onClick={()=>onNavigate('settings')}>Settings</button>
  </footer>
 </aside>;
}
