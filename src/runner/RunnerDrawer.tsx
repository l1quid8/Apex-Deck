import { useEffect, useId, useState, type RefObject } from 'react';
import type { RunnerSnapshot, RunnerLimits, RunnerActionTag } from './types.ts';
import { validateLimits } from './types.ts';
import { runnerView } from './viewModel.ts';
import './runner.css';

export interface RunnerDrawerProps {
  snapshot: RunnerSnapshot | null;
  hostNowOffsetMs: number;
  onAction(action: RunnerActionTag, limits?: RunnerLimits): void;
  onReviewChanges(): void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  platform: 'desktop' | 'phone';
  endRequest?: number;
  showRequest?: number;
  onEndCancel?():void;
}
export function RunnerDrawer({snapshot, hostNowOffsetMs, onAction, onReviewChanges, composerRef, platform, endRequest=0, showRequest=0, onEndCancel}: RunnerDrawerProps) {
  const [open,setOpen]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const [now,setNow]=useState(Date.now());
  const id=useId();
  useEffect(()=>{setConfirm(false);setOpen(false);},[snapshot?.id]);
  useEffect(()=>{if(showRequest)setOpen(true);},[showRequest]);
  useEffect(()=>{if(endRequest){setConfirm(true);setOpen(true);}},[endRequest]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const input=composerRef.current;
    const close=()=>{setOpen(false);setConfirm(false);onEndCancel?.();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(open||confirm)){event.preventDefault();event.stopImmediatePropagation();close();composerRef.current?.focus({preventScroll:true});}};
    input?.addEventListener('input',close);
    document.addEventListener('keydown',key,true);
    return()=>{input?.removeEventListener('input',close);document.removeEventListener('keydown',key,true);};
  },[open,confirm,composerRef]);
  const view=runnerView(snapshot,now+hostNowOffsetMs);
  if(!snapshot||!view)return null;
  const terminal=['completed','ended'].includes(snapshot.phase);
  const label=snapshot.kind==='goal'?'Goal':'Loop';
  const action=(tag:RunnerActionTag)=>{if(tag==='end'){setConfirm(true);setOpen(true);}else onAction(tag);};
  const controls=terminal?<><button type="button" onClick={onReviewChanges}>Review changes</button><button type="button" onClick={()=>onAction('dismiss')} aria-label="Dismiss runner summary">×</button></>:<>
    {view.limitHit?<button type="button" onClick={()=>setOpen(true)}>Edit limits</button>:<button type="button" onClick={()=>action(view.paused?'resume':'pause')}>{view.paused?'Resume':'Pause'}</button>}
  </>;
  return <div className={`runner-drawer-container ${platform}${open?' open':''}${view.needsYou||view.limitHit?' needs-you':''}`}>
    <div className="runner-strip">
      <button type="button" className="runner-disclosure" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>
        <span className={`runner-dot ${view.running?'running':'paused'}`} aria-hidden>●</span><strong>{label}</strong><span className="runner-metric">{view.metric||view.stateLabel}</span><span className="runner-objective-short">{view.objective}</span><span aria-hidden>{open?'▾':'▴'}</span>
      </button>{controls}
    </div>
    <span className="runner-live-region" role="status">{label}: {view.stateLabel}</span>
    {open&&<section id={id} className="runner-details" aria-label={`${label} details`}>
      <h4>{label}</h4><p className="runner-full-objective">{view.objective}</p>
      {snapshot.kind==='loop'&&<p>Every {snapshot.intervalSeconds}s · {view.metric}</p>}
      {snapshot.checkpoint?.criteria.length ? <ul className="runner-criteria">{snapshot.checkpoint.criteria.map(c=><li key={c.id}>{c.status==='done'?'✓':c.status==='failed'?'✗':'○'} {c.id}<small>{c.evidence.join(' · ')}</small></li>)}</ul>:null}
      <p>{snapshot.checkpoint?.done||'Preparing the first step.'}</p>
      {snapshot.checkpoint?.next&&<p>Next: {snapshot.checkpoint.next}</p>}
      {snapshot.checkpoint?.blocker&&<p>Blocked: {snapshot.checkpoint.blocker}</p>}
      {snapshot.checkResults?.map(c=><details key={`${c.attemptId}:${c.id}`}><summary>{c.passed?'✓':'✗'} Check: {c.id}</summary><pre>{c.output}</pre></details>)}
      <p>Working: {snapshot.workers.join(', ')}{snapshot.checker?` · Checker: ${snapshot.checker}`:''}</p>
      <p>{snapshot.usage.turns}/{snapshot.limits.maxTurns??30} {snapshot.kind==='loop'?'runs':'turns'} · {snapshot.usage.invocations}/{snapshot.limits.maxInvocations??120} calls · {snapshot.usage.costMicros==null||snapshot.usage.unknownCostTurns>0?'Cost unavailable':`$${(snapshot.usage.costMicros/1e6).toFixed(2)} / $${(snapshot.limits.maxCostMicros??0)/1e6}`} · {Math.max(0,Math.floor((now+hostNowOffsetMs-snapshot.startedAt)/60000))}m / {snapshot.limits.lifetimeMs/60000}m</p>
      <p className="runner-note">{snapshot.reason!=='none'?`Reason: ${snapshot.reason.replaceAll('_',' ')}. `:''}{snapshot.phase==='completed'?'Completion reported by workers; see evidence and checks.':''}{snapshot.pendingRequestId?'Answer the pending request in chat. Resume keeps unresolved requests waiting.':''}</p>
      {!terminal&&<RunnerLimitEditor key={`${snapshot.id}:${snapshot.limits.lifetimeMs}:${snapshot.limits.maxTurns}:${snapshot.limits.maxCostMicros}`} limits={snapshot.limits} applyLabel={view.limitHit?'Apply and resume':'Apply limits'} onApply={limits=>onAction('update_limits',limits)}/>}
      <div className="runner-details-actions">{confirm?<><span>End this {snapshot.kind}?</span><button type="button" onClick={()=>{setConfirm(false);onAction('end');}}>End {label.toLowerCase()}</button><button type="button" onClick={()=>{setConfirm(false);onEndCancel?.();}}>Cancel</button></>:<>{controls}{!terminal&&<button type="button" onClick={()=>action('end')}>End {label.toLowerCase()}</button>}</>}</div>
    </section>}
  </div>;
}
export function RunnerLimitEditor({limits,onApply,applyLabel='Apply limits'}:{limits:RunnerLimits;onApply(limits:RunnerLimits):void;applyLabel?:string}){
  const [next,setNext]=useState(limits);const [error,setError]=useState('');const id=useId();
  return <div className="runner-limits"><div className="runner-limit-fields">{([
    ['maxTurns','Turns / runs',next.maxTurns??30,1,1000],['maxInvocations','Total calls',next.maxInvocations??120,1,1000],['lifetimeMs','Lifetime (minutes)',next.lifetimeMs/60000,1,1440],['maxCostMicros','Spend cap ($, best effort)',(next.maxCostMicros??5000000)/1e6,.01,1000],
  ] as const).map(([key,label,value,min,max])=><label key={key} htmlFor={`${id}-${key}`}>{label}<input id={`${id}-${key}`} type="number" min={min} max={max} step={key==='maxCostMicros'?'.01':'1'} value={Number.isFinite(value)?value:''} onChange={e=>{const n=e.currentTarget.valueAsNumber;setNext(v=>({...v,[key]:key==='lifetimeMs'?n*60000:key==='maxCostMicros'?Math.round(n*1e6):n}));}}/></label>)}</div><button type="button" onClick={()=>{try{validateLimits(next);setError('');onApply(next);}catch(e){setError(String(e));}}}>{applyLabel}</button>{error&&<p role="alert">{error}</p>}</div>;
}
