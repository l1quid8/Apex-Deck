// A view of the owner's actual conversation, context and single voice session.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createAssistantFloatDragGuard, type AssistantFloatAction, type AssistantFloatPresentation, type AssistantFloatState } from "./assistantFloat";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { DEFAULT_APPEARANCE, type AppearanceSettings, type AppearanceValues } from "./themes";
import { useAppearance } from "./useAppearance";
import "./assistant-float.css";

function FloatIcon({name}:{name:'mic'|'chat'|'more'|'up'|'end'}){
  if(name==='more')return <span aria-hidden="true">⋯</span>;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{name==='mic'?<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>:name==='chat'?<><path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z"/><path d="M8 8h8M8 12h5"/></>:name==='up'?<path d="m6 12 6-6 6 6M12 6v14"/>:<path d="M4 15c4-6 12-6 16 0l-2 3-4-2v-3h-4v3l-4 2Z"/>}</svg>;
}
export function AssistantFloat({token}:{token:string}){
  const bridge=window.apexDeck?.popout;
  const [state,setState]=useState<AssistantFloatState|null>(null);
  const [appearance,setAppearance]=useState<AppearanceValues|AppearanceSettings>(DEFAULT_APPEARANCE);
  const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[more,setMore]=useState(false);
  const [localPresentation,setLocalPresentation]=useState<AssistantFloatPresentation|null>(null);
  const box=useRef<HTMLTextAreaElement>(null),log=useRef<HTMLDivElement>(null),avatar=useRef<HTMLButtonElement>(null),contextButton=useRef<HTMLButtonElement>(null),moreButton=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null),menu=useRef<HTMLDivElement>(null);
  const guard=useRef(createAssistantFloatDragGuard());
  const drag=useRef<{id:number;x:number;y:number;lastX:number;lastY:number;moved:boolean}|null>(null);
  useAppearance(appearance as any);
  useEffect(()=>{document.documentElement.classList.add('assistant-float-document');return()=>document.documentElement.classList.remove('assistant-float-document')},[]);
  useEffect(()=>{
    if(!bridge)return;
    const apply=(patch:{float?:AssistantFloatState;appearance?:AppearanceValues|AppearanceSettings})=>{
      if(patch.appearance)setAppearance(patch.appearance);
      if(!patch.float?.ref||!Array.isArray(patch.float.lines))return;
      const next=patch.float;setState(next);setLocalPresentation(current=>next.presentation===current?null:current);
      if(document.activeElement!==box.current||!next.draft)setDraft(next.draft);
    };
    const off=bridge.onUpdate(apply as any);void bridge.snapshot(token).then(s=>apply(s as any)).catch(()=>{});return off;
  },[bridge,token]);
  const presentation=localPresentation??state?.presentation??'pill';
  const act=(action:AssistantFloatAction)=>{void bridge?.sendAction(token,action as any)};
  const present=(next:AssistantFloatPresentation)=>{setMore(false);setLocalPresentation(next);act({type:'assistant-present',presentation:next})};
  useLayoutEffect(()=>{void bridge?.assistantLayout?.(token,more&&presentation==='pill'?'menu':presentation)},[bridge,token,presentation,more]);
  useEffect(()=>{if(presentation==='threads')search.current?.focus();else if(presentation==='chat')box.current?.focus();else avatar.current?.focus()},[presentation]);
  const latestLine=state?.lines.at(-1);
  useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight})},[presentation,state?.lines.length,latestLine?.id,latestLine?.text,latestLine?.approval]);
  useEffect(()=>{if(!more)return;menu.current?.querySelector<HTMLButtonElement>('button')?.focus();const outside=(e:PointerEvent)=>{if(!menu.current?.contains(e.target as Node)&&!moreButton.current?.contains(e.target as Node))setMore(false)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[more]);
  const send=()=>{const text=draft.trim();if(!text)return;setDraft('');act({type:'assistant-send',text,requestId:crypto.randomUUID()})};
  const onDragStart=(e:ReactPointerEvent)=>{
    const target=e.target as Element;
    if(e.button!==0||!target.closest('.assistant-float-bar'))return;
    if(target.closest('button,input,textarea')&&!target.closest('.assistant-float-avatar'))return;
    const x=e.screenX===0&&e.screenY===0?e.clientX:e.screenX,y=e.screenX===0&&e.screenY===0?e.clientY:e.screenY;guard.current.pointerDown();drag.current={id:e.pointerId,x,y,lastX:x,lastY:y,moved:false};
  };
  const onDragMove=(e:ReactPointerEvent)=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;const x=e.screenX===0&&e.screenY===0?e.clientX:e.screenX,y=e.screenX===0&&e.screenY===0?e.clientY:e.screenY;if(!d.moved&&Math.hypot(x-d.x,y-d.y)<5)return;if(!d.moved)e.currentTarget.setPointerCapture(e.pointerId);d.moved=true;guard.current.dragged();e.preventDefault();const dx=x-d.lastX,dy=y-d.lastY;d.lastX=x;d.lastY=y;if(dx||dy)void bridge?.moveAssistant?.(token,{dx,dy})};
  const onDragEnd=(e:ReactPointerEvent)=>{if(drag.current?.id===e.pointerId)drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)};
  const closeExpanded=()=>{if(more){setMore(false);moreButton.current?.focus()}else if(presentation==='threads'){present('pill');requestAnimationFrame(()=>contextButton.current?.focus())}else if(presentation==='chat')present('pill')};
  const context=state?.context;
  const active=context?.threads.find(t=>t.id===context.activeThreadId);
  const title=active?.title??state?.currentThread?.title;
  const threads=(context?.threads??[]).filter(t=>(t.title+' '+(t.projectName??'')+' '+(t.closed?'closed':'')).toLowerCase().includes(query.toLowerCase()));
  const followed=context?.followedThreadIds??[];
  const look=state?.look??{seed:state?.ref.assistantId??'assistant',color:'#b4a0ff'};
  const minimized=presentation==='minimized';
  return <div className={`assistant-float${minimized?' is-minimized':''}`} data-presentation={presentation} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();closeExpanded()}}}>
    <div className="assistant-float-stack">
      {!minimized&&presentation==='chat'&&<section className="assistant-float-chat" aria-label={`${state?.name??'Assistant'} conversation`}>
        <header><strong>{state?.name??'Assistant'}</strong><button type="button" aria-label="Collapse conversation" onClick={()=>present('pill')}>⌄</button></header>
        <div className="assistant-float-log" ref={log} role="log" aria-live="polite">
          {!state?.lines.length&&<p className="assistant-float-empty">Talk it through with {state?.name??'your assistant'}.</p>}
          {state?.lines.map(line=><div key={line.id} className="assistant-float-message" data-role={line.role}>{line.approval?<p>{line.text||'Your approval is needed.'}</p>:<Markdown text={line.text} onOpen={()=>act({type:'assistant-details'})}/>}{(line.approval||line.problem)&&<button type="button" onClick={()=>act({type:'assistant-details'})}>Review in Deck</button>}</div>)}
        </div>
        {(state?.error||state?.offline)&&<p className="assistant-float-problem" role="alert">{state.error||`${state.name}'s machine is offline.`}</p>}
        <form className="assistant-float-composer" onSubmit={e=>{e.preventDefault();send()}}><textarea ref={box} rows={2} aria-label={`Message ${state?.name??'assistant'}`} value={draft} placeholder={`Message ${state?.name??'assistant'}…`} onChange={e=>{setDraft(e.target.value);act({type:'assistant-draft',text:e.target.value})}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}/><button type="submit" aria-label="Send message" disabled={!draft.trim()||state?.offline}><FloatIcon name="up"/></button></form>
      </section>}
      {!minimized&&<div className="assistant-float-context" role="status">
        <span>Following {followed.length}</span><span className="separator">|</span><span className="assistant-float-context-title">{title?`Here: ${title}`:'Choose context'}</span>
      </div>}
      {!minimized&&presentation==='threads'&&<section id="assistant-float-threads" className="assistant-float-picker" aria-label="Followed threads" onKeyDown={e=>{if(e.key!=='Tab')return;const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input')];if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus()}}}>
        <div className="assistant-float-picker-top"><span>Active context</span><button type="button" className="assistant-follow-view" onClick={()=>act({type:'assistant-active-thread',threadId:null})}>Follow my view</button><button type="button" disabled={!context?.canCreateThread||state?.creatingThread} onClick={()=>act({type:'assistant-new'})}>{state?.creatingThread?'Creating…':'+ New chat'}</button></div>
        <input ref={search} aria-label="Search permitted open and closed threads" placeholder="Search all threads, including closed…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&threads[0])act({type:'assistant-active-thread',threadId:threads[0].id})}}/>
        <div className="assistant-float-thread-list">{threads.map(thread=><div className="assistant-float-thread" key={thread.id}><button type="button" className="assistant-float-follow" aria-label={`${followed.includes(thread.id)?'Stop following':'Follow'} ${thread.title}`} aria-pressed={followed.includes(thread.id)} onClick={()=>act({type:'assistant-follow',threadIds:followed.includes(thread.id)?followed.filter(id=>id!==thread.id):[...followed,thread.id]})}>{followed.includes(thread.id)?'✓':'+'}</button><button type="button" className="assistant-float-use-thread" aria-current={context?.activeThreadId===thread.id?'true':undefined} onClick={()=>act({type:'assistant-active-thread',threadId:thread.id})}><span>{thread.title}</span><small>{thread.projectName??''}{thread.closed?' · Closed':thread.status?` · ${thread.status}`:''}</small><em>{context?.activeThreadId===thread.id?'●':'Use here'}</em></button></div>)}{!threads.length&&<p className="assistant-float-empty">{context?.threads.length?'No matching threads.':'No permitted threads are available.'}</p>}</div>
        <p className="assistant-float-picker-foot">Follow for updates. Active resolves “this” and “here.”</p>
        {state?.error&&<p className="assistant-float-problem" role="alert">{state.error}</p>}
      </section>}
      <div className="assistant-float-bar" onPointerDown={onDragStart}>
        <button type="button" ref={avatar} className="assistant-float-avatar" aria-label={minimized?'Restore assistant pill':`Open ${state?.name??'assistant'} conversation`} title="Drag to move; click to open" onClick={e=>{if(guard.current.consumeClick(e.detail))return;present(minimized?'pill':'chat')}} onKeyDown={e=>{if(e.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();void bridge?.moveAssistant?.(token,{dx:e.key==='ArrowLeft'?-12:e.key==='ArrowRight'?12:0,dy:e.key==='ArrowUp'?-12:e.key==='ArrowDown'?12:0})}}}>
          {state?.avatarImageUrl?<img src={state.avatarImageUrl} alt=""/>:<Avatar seed={look.seed} color={look.color} size="sm"/>}
        </button>
        {!minimized&&<><div className="assistant-float-identity"><strong>{state?.name??'Assistant'}</strong><small>{!state?'Connecting…':state.call?(state.call.muted?'Mic paused':'Listening'):state.paused?'Work paused':'Here with you'}</small></div><button type="button" className="assistant-float-action" disabled={!state||state.offline} aria-label={state?.call?(state.call.muted?'Resume microphone':'Pause microphone'):`Call ${state?.name??'assistant'}`} aria-pressed={!!state?.call&&!state.call.muted} onClick={()=>state?.call?act({type:'assistant-mute',muted:!state.call.muted}):act({type:'assistant-call'})}><FloatIcon name="mic"/></button><button type="button" className="assistant-float-action" aria-label="Open conversation" onClick={()=>present(presentation==='chat'?'pill':'chat')}><FloatIcon name="chat"/></button><button type="button" ref={moreButton} className="assistant-float-action assistant-float-more" aria-label="More assistant controls" aria-haspopup="menu" aria-expanded={more} onClick={()=>setMore(!more)}><FloatIcon name="more"/></button></>}
      </div>
      {!minimized&&<button type="button" ref={contextButton} className="assistant-float-thread-toggle" aria-label={presentation==='threads'?'Collapse followed threads':'Expand followed threads'} aria-expanded={presentation==='threads'} aria-controls="assistant-float-threads" onClick={()=>present(presentation==='threads'?'pill':'threads')}>{presentation==='threads'?'⌄':'⌃'}</button>}
      {!minimized&&more&&<div className="assistant-float-menu" ref={menu} role="menu" onKeyDown={e=>{const keys=['ArrowDown','ArrowUp','Home','End'];if(keys.includes(e.key)){e.preventDefault();const items=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')],i=items.indexOf(document.activeElement as HTMLButtonElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus()}if(e.key==='Tab')setMore(false)}}>
        <button type="button" role="menuitemcheckbox" aria-checked={!!state?.alwaysOnTop} disabled={!state} onClick={()=>{setMore(false);act({type:'assistant-pin',on:!state?.alwaysOnTop});moreButton.current?.focus()}}>Keep on top</button><button type="button" role="menuitem" onClick={()=>present('threads')}>Followed threads</button><button type="button" role="menuitem" onClick={()=>present('minimized')}>Minimize to avatar</button><button type="button" role="menuitem" onClick={()=>{setMore(false);act({type:'assistant-hide'})}}>Hide {state?.name??'assistant'}</button>{state?.call&&<button type="button" role="menuitem" onClick={()=>{setMore(false);act({type:'assistant-end'})}}>End voice</button>}<button type="button" role="menuitem" onClick={()=>act({type:'assistant-details'})}>Open in Deck</button>
      </div>}
    </div>
  </div>;
}
