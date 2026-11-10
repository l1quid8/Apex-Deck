import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RichDraftEditor } from './RichDraftEditor';
import { planSend, summaryLine, type Problem, type ThreadInfo } from './slicePlan';
import { threadIds, type Caret, type DraftDoc, type Token } from './sliceDraft';
import { freezeBatch } from './multiSend';
import { ComposerModeControls, ThreadComposerBox } from './ThreadComposer';
import type { PendingFile } from './threadSendApi';
import type { useMultiDraft } from './useMultiDraft';
import type { useMultiBatches } from './useMultiBatches';
import './MultiComposer.css';

export type ComposerThread = ThreadInfo & { project?: string; outside?: boolean };
export function replaceDraftRange(doc: DraftDoc, at: Caret, count: number, tokens: Token[]): DraftDoc {
  const next = doc.map(line => [...line]); const line = next[at.line] ?? [];
  const units = line.flatMap<Token>(token => token.kind === 'text' ? token.text.split('').map(text => ({kind:'text' as const,text})) : [token]);
  units.splice(Math.max(0, at.offset - count), count, ...tokens);
  const merged: Token[] = [];
  for (const token of units) {
    const last = merged.at(-1);
    if (last?.kind === 'text' && token.kind === 'text') last.text += token.text;
    else merged.push({...token});
  }
  next[at.line] = merged; return next;
}

// "To 3 threads · Null ×2, Jigga" reads like the single thread's To line:
// To, the count in bold, then who answers.
function SummaryText({ line }: { line: string }) {
  const head = /^To (\d+ threads?)(?: · ([\s\S]*))?$/.exec(line);
  if (!head) return <span>{line}</span>;
  return <>To{' '}<strong>{head[1]}</strong>{head[2] ? <>{' '}<span>· {head[2]}</span></> : null}</>;
}

function SendArrow() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

function PicturesIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /></svg>;
}

export function MultiComposer({ draft, batches, threads, files, onAttachFiles, onFlash, routeRequest }: {
  routeRequest?: {paneId:string;anchor:DOMRect;seq:number};
  draft: ReturnType<typeof useMultiDraft>;
  batches: ReturnType<typeof useMultiBatches>; threads: Map<string, ComposerThread>;
  files: Map<string, PendingFile>; onAttachFiles(files: File[], at: Caret): void;
  onFlash(paneIds: string[]): void;
}) {
  const [caret, setCaret] = useState<Caret | null>({line:0,offset:1});
  const [trigger, setTrigger] = useState<{kind:'#'|'@';query:string;rect:DOMRect;doc:DraftDoc} | null>(null);
  // A pane header's agent dropdown opens this thread's agent menu under the header.
  // A click from before this composer opened is old news, not a new request.
  const [route, setRoute] = useState<string | null>(null);
  const [routeAnchor, setRouteAnchor] = useState<DOMRect | null>(null);
  const seenRoute = useRef(routeRequest?.seq);
  const routeMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!routeRequest || routeRequest.seq === seenRoute.current) return;
    seenRoute.current = routeRequest.seq;
    setRoute(routeRequest.paneId); setRouteAnchor(routeRequest.anchor); setTrigger(null);
  }, [routeRequest]);
  useEffect(() => {
    if (!route) return;
    const away = (event: PointerEvent) => { if (!routeMenu.current?.contains(event.target as Node)) setRoute(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setRoute(null); } };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', escape); };
  }, [route]);
  const [flash, setFlash] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tray, setTray] = useState(false);
  useEffect(() => () => { if(timer.current)clearTimeout(timer.current); }, []);
  const metadata = new Map([...files].map(([id,file]) => [id,{...file,reading:!file.bytes}]));
  const plan = planSend({doc:draft.doc,threads,files:metadata,overrides:draft.overrides});
  const blocking = plan.problems.filter(p => p.kind !== 'empty');
  const selected = threadIds(draft.doc);
  const fileName = (id:string) => files.get(id) ?? null;
  const send = () => {
    const now = draft.current();
    if (!now.on || batches.failed.length) return;
    const checked = planSend({doc:now.doc,threads,files:metadata,overrides:now.overrides});
    if (!checked.slices.length || checked.problems.some(p => p.kind !== 'empty')) return;
    const empty = checked.problems.flatMap(p => p.kind === 'empty' ? [p.paneId] : []);
    if (empty.length) {
      setFlash(empty); onFlash(empty); if(timer.current)clearTimeout(timer.current);
      timer.current=setTimeout(()=>setFlash([]),1200); return;
    }
    const batch = freezeBatch(checked.slices, files, now.tldr);
    for (const slice of batch) slice.title = threads.get(slice.paneId)?.title ?? slice.paneId;
    draft.take(); batches.start(batch);
  };
  const pick = (tokens: Token[]) => {
    if(!caret || !trigger)return;
    if (JSON.stringify(draft.current().doc) !== JSON.stringify(trigger.doc)) { setTrigger(null); return; }
    const length=trigger.query.length+1;
    draft.setDoc(replaceDraftRange(draft.current().doc,caret,length,tokens));
    const added=tokens.reduce((n,t)=>n+(t.kind==='text'?t.text.length:1),0);
    setCaret({...caret,offset:caret.offset-length+added}); setTrigger(null);
  };
  const lines = caret ? draft.doc[caret.line] ?? [] : [];
  const lineThreads = lines.flatMap(t=>t.kind==='thread'?[threads.get(t.paneId)]:[]).filter(t=>t!==undefined);
  const agents = [...new Map(lineThreads.flatMap(t=>t.agents).map(a=>[a.id,a])).values()];
  const entries = trigger?.kind==='#' ? [...threads.values()].filter(t=>selected.includes(t.paneId) || !!trigger.query && `${t.title} ${t.project??''}`.toLowerCase().includes(trigger.query.toLowerCase())) : [];
  const disabledReason = batches.failed.length ? 'Retry or discard the failed batch first.' : blocking[0]?.kind === 'file-reading' ? `Reading ${files.get(blocking[0].fileId)?.name ?? 'file'}…` : blocking.length ? 'Resolve the problems above before sending.' : undefined;
  // Only the thread chips sit with the box: no thread rows. A blocked draft names its
  // first problem in the To line; the chips and pane headers show where.
  const problemText = (p: Problem) => `${p.kind.replaceAll('-',' ')}${'paneId' in p?`: ${threads.get(p.paneId)?.title??'Closed thread'}`:'line' in p?` on line ${p.line+1}`:''}`;
  const problem = blocking.find(p => p.kind !== 'file-reading');
  const count = `To ${plan.slices.length} ${plan.slices.length===1?'thread':'threads'}`;
  const summary = problem ? `${count} · ${problemText(problem)}` : summaryLine(plan.slices,threads,metadata,plan.problems);
  const routeThread = route && selected.includes(route) ? threads.get(route) : undefined;
  const pickAgent = (paneId: string, agent: ComposerThread['agents'][number]) => {
    // Unknown typed names must be visibly fixed; a hidden override cannot repair them.
    const names = plan.problems.flatMap(p => p.kind==='unknown-agent' && p.paneId===paneId ? [p.name] : []);
    if (names.length) draft.setDoc(draft.current().doc.map(line=>line.some(t=>t.kind==='thread'&&t.paneId===paneId)?line.map(t=>t.kind==='text'?{...t,text:t.text.replace(/@([\w-]+)/g,(whole,name)=>names.includes(name.toLowerCase())?'@'+agent.handle:whole)}:t):line));
    else draft.setOverride(paneId, agent.id);
    setRoute(null);
  };
  // The single thread's composer with tags in it: same To line, box, +, TL;DR pill and round Send.
  return <div className={`composer multi-composer${draft.tldr?' tldr':''}`} data-room-ready="true" onKeyDown={event=>{
    if(event.key==='Escape' && (trigger || route)){ event.preventDefault();event.stopPropagation();setTrigger(null);setRoute(null); }
    if(event.key==='Enter' && (event.target as Element).closest('.rich-draft-editor') && !event.shiftKey && !event.nativeEvent.isComposing && !trigger){ event.preventDefault(); if(!event.repeat)send(); }
  }}>
    <div className={`multi-summary${problem?' warn':''}`}><SummaryText line={summary} /></div>
    {routeThread && routeAnchor && createPortal(<div ref={routeMenu} role="menu" className="multi-route-menu" style={{left:Math.max(8,Math.min(routeAnchor.left,window.innerWidth-260)),top:routeAnchor.bottom}}>
      {routeThread.agents.map(agent=><button type="button" role="menuitem" key={agent.id} onClick={()=>pickAgent(routeThread.paneId,agent)}>{agent.name}</button>)}
    </div>, document.body)}
    <div className="composer-input">
      <input ref={fileInput} type="file" multiple hidden onChange={event=>{onAttachFiles([...event.target.files??[]],caret??{line:0,offset:0});event.target.value='';}}/>
      <ThreadComposerBox>
        {trigger&&<div role="listbox" aria-label={trigger.kind==='#'?'Threads':'Agents'} className="composer-menu multi-picker" onMouseDown={event=>event.preventDefault()}>
          {trigger.kind==='#'?entries.map((thread,index)=><div key={thread.paneId}>
            {index>0&&selected.includes(entries[index-1].paneId)&&!selected.includes(thread.paneId)&&<p>Other threads · adds to selection</p>}
            <button type="button" role="option" aria-selected={selected.includes(thread.paneId)} disabled={selected.includes(thread.paneId)||!thread.open} onClick={()=>pick([{kind:'thread',paneId:thread.paneId,hostId:thread.hostId}])}>{thread.title}<small>{thread.project}{thread.outside?' · In its own window':selected.includes(thread.paneId)?' · ✓ tagged':''}</small></button>
          </div>):agents.filter(a=>`${a.name} ${a.handle}`.toLowerCase().includes(trigger.query.toLowerCase())).map(a=><button type="button" role="option" aria-selected="false" key={a.id} onClick={()=>pick([{kind:'text',text:'@'+a.handle+' '}])}>{a.name}</button>)}
        </div>}
        {tray&&<div className="composer-menu multi-picker" role="menu" aria-label="Pictures" onMouseDown={event=>event.preventDefault()}>{[...files.values()].map(file=><button type="button" role="menuitem" key={file.id} disabled={!file.bytes} onClick={()=>{const at=caret??{line:0,offset:0};draft.setDoc(replaceDraftRange(draft.current().doc,at,0,[{kind:'file',fileId:file.id}]));setCaret({...at,offset:at.offset+1});setTray(false);}}>{file.label}: {file.name}</button>)}</div>}
        <div className="composer-tools"><button type="button" className="icon composer-plus" aria-label="Attach files" title="Attach files" onPointerDown={event=>event.preventDefault()} onClick={()=>fileInput.current?.click()}>+</button></div>
        <div className="composer-field">
          <RichDraftEditor doc={draft.doc} draftId={draft.draftId} caret={caret} onChange={(doc,next)=>{draft.setDoc(doc);setCaret(next);}}
            chip={token=>token.kind==='thread'?{label:'#'+(threads.get(token.paneId)?.title??'Closed thread'),title:threads.get(token.paneId)?.outside?`${threads.get(token.paneId)?.title} is in its own window. Send to it there.`:threads.get(token.paneId)?.title??'Closed thread',problem:!threads.get(token.paneId)?.open||plan.problems.some(p=>p.kind==='duplicate'&&p.paneId===token.paneId),flash:flash.includes(token.paneId)}:{label:token.kind==='file'?fileName(token.fileId)?.label??'Missing file':'',title:token.kind==='file'?fileName(token.fileId)?.name??'Missing file':'',busy:token.kind==='file'&&!fileName(token.fileId)?.bytes}}
            names={{thread:id=>threads.get(id)?.title??'Closed thread',file:id=>fileName(id)}} known={{thread:id=>threads.has(id),file:id=>files.has(id)}} onAttachFiles={onAttachFiles}
            onCaretChange={setCaret} onTriggerClose={()=>setTrigger(null)}
            onTrigger={(kind,query,rect)=>setTrigger({kind,query,rect,doc:draft.current().doc})} />
        </div>
        {files.size>0&&<button type="button" className="multi-pictures" aria-label={`${files.size} ${files.size===1?'picture':'pictures'}`} aria-expanded={tray} title="Pictures in this message" onPointerDown={event=>event.preventDefault()} onClick={()=>setTray(!tray)}><PicturesIcon />{files.size}</button>}
        <ComposerModeControls planOn={false} onPlan={()=>{}} tldr={draft.tldr} onTldr={()=>draft.setTldr(!draft.tldr)} />
        <button type="button" className={'round-send composer-send'+(flash.length?' shake':'')} aria-label="Send" disabled={!!disabledReason} title={disabledReason??'Send (↵)'} onClick={send}><SendArrow /></button>
      </ThreadComposerBox>
      {draft.lastRemoved&&<p className="multi-kept">Removed · <button type="button" onClick={draft.undoRemove}>Undo</button></p>}
    </div>
  </div>;
}
