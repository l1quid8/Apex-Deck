import { useEffect, useState } from 'react';
import type { PersonalApprovalOptions, PersonalLane, PersonalTask } from './personalAssistant.ts';

type ApprovalLane = Pick<PersonalLane, 'assistant' | 'offline' | 'approvalOptions' | 'decideAlways'>;
/** Persistent permission is a separate, explicitly scoped confirmation. */
export function PersonalAlwaysPermission({lane,task,disabled=false}:{lane:ApprovalLane;task:PersonalTask;disabled?:boolean}) {
  const decision=task.decision;
  const key=JSON.stringify([lane.assistant?.hostId,lane.assistant?.id,decision?.id,decision?.paramsHash,lane.assistant?.permissions?.revision]);
  const supported=Boolean(lane.approvalOptions&&lane.decideAlways&&decision?.status==='open'&&['approve','spend'].includes(decision.kind));
  const [result,setResult]=useState<{key:string;options?:PersonalApprovalOptions;error?:string}|null>(null);
  const [showing,setShowing]=useState<string|null>(null);
  const [selection,setSelection]=useState<{key:string;index:number}|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [failure,setFailure]=useState<{key:string;message:string}|null>(null);
  useEffect(()=>{
    if(!supported||lane.offline||!decision)return;
    let active=true;
    void lane.approvalOptions!(decision.id,decision.paramsHash).then(options=>{
      if(!active)return;
      if(options.decisionId!==decision.id||options.paramsHash!==decision.paramsHash)throw new Error('The approval changed. Refresh it before deciding.');
      setResult({key,options});
    }).catch(error=>{if(active)setResult({key,error:error instanceof Error?error.message:String(error)});});
    return()=>{active=false;};
  },[key,supported,lane.offline]);
  if(!supported)return null;
  const options=result?.key===key?result.options:undefined;
  const choice=options?.scopes[selection?.key===key?selection.index:0];
  const locked=disabled||lane.offline||busy===key;
  const destructive=options?.capability==='threadDelete';
  const confirm=async()=>{
    if(locked||!options||!choice)return;
    setBusy(key);setFailure(null);
    try {await lane.decideAlways!(options,choice.scope);setShowing(before=>before===key?null:before);}
    catch(error){setFailure({key,message:error instanceof Error?error.message:String(error)});}
    finally{setBusy(before=>before===key?null:before);}
  };
  const reason=result?.key===key?(result.error??options?.reason):undefined;
  return <div className="personal-always-permission">
    <button type="button" disabled={locked||!options?.scopes.length} title={reason??(!options?'Checking available permission scopes':undefined)} onClick={()=>{setShowing(key);setSelection({key,index:0});setFailure(null);}}>Always allow…</button>
    {reason&&<small role="status">{reason}</small>}
    {showing===key&&options&&choice&&<section role="group" aria-label="Always allow confirmation">
      <strong>{options.label}</strong>
      <label>Permission scope <select aria-label="Always allow scope" value={selection?.key===key?selection.index:0} disabled={locked} onChange={event=>setSelection({key,index:Number(event.target.value)})}>{options.scopes.map((item,index)=><option value={index} key={JSON.stringify(item.scope)}>{item.label}</option>)}</select></label>
      <p>Save Always allow for future matching actions in this scope, and allow this action now.</p>
      {destructive&&<p>Future matching deletions can permanently remove history. Permanent deletion cannot be undone.</p>}
      <p>Existing narrower rules, project and runtime access, app approvals and budget limits still apply. Existing capability-by-capability delegation limits stay in force. Revoke this permission in Rules.</p>
      <button type="button" className="primary" disabled={locked} onClick={confirm}>{destructive?'Always allow permanent deletion in this scope':'Save Always allow and allow this action'}</button>
      <button type="button" disabled={locked} onClick={()=>setShowing(null)}>Cancel</button>
    </section>}
    {failure?.key===key&&<p role="alert">{failure.message}</p>}
  </div>;
}
