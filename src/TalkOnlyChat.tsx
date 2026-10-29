import { useMemo, useRef, useState } from 'react';
import { ChatPane, type ThreadMenuRequest } from './ChatPane';
import { ThreadName } from './ThreadName';
import { MenuList, type MenuEntry } from './Menu';
import { MoveToWorkDialog } from './DesktopChatsUI';
import { chatThreadBackend } from './chatThreadBackend';
import { chatKey, sendBlock, type DesktopChats } from './desktopChats';
import { chatDeliveryStatus } from './chatDelivery';
import { promoteWait } from './chatPromote';
import { type ChatEntry, type ChatProfile } from './chatCatalog';
import type { AgentInfo, ParticipantConfig, RoomSnapshot, RoomState } from './types';
import type { AppSettings } from './settings';

interface Props {
  row: ChatEntry; chats: DesktopChats; settings: AppSettings; agents: AgentInfo[];
  profiles: ParticipantConfig[]; onProfilesChange(profiles: ParticipantConfig[]): void;
  draft: string; onDraft(text: string): void; onClose(): void;
  onOpenChat(id: string): void;
  onOpenWork(source: ChatEntry, id: string, work?: ChatEntry): void;
}

/** A chat's host chrome only. Transcript, actions, chips and composer are the real thread screen. */
export function TalkOnlyChat(props: Props) {
  const {row, chats, settings, onClose, onOpenWork} = props;
  const live = useRef(props); live.current = props;
  const key = chatKey({hostId:row.hostId,room:row.id});
  const raw = chats.backendOf(row.hostId);
  const machine = {id:row.hostId,name:chats.machineName(row.hostId)};
  const online = chats.online(row.hostId);
  const ticket = chats.promoteTicket(row);
  const blocked = sendBlock(row, machine, chats.rooms[row.hostId], !!ticket) ?? chats.deliveryProblem;
  const [moving,setMoving] = useState(false);
  const movingRef = useRef(false); movingRef.current = moving;
  const [bots,setBots] = useState<ParticipantConfig[]>([]);
  const [adding,setAdding] = useState<ChatProfile[] | null>(null);
  const [problem,setProblem] = useState('');
  const [status,setStatus] = useState('');
  const [menu,setMenu] = useState<HTMLElement | null>(null);
  const [request,setRequest] = useState<{id:string;action:ThreadMenuRequest}>();
  const [rename,setRename] = useState(0);
  const [maximized,setMaximized] = useState(false);
  const act = (work: Promise<unknown>) => { void work.catch(error => setProblem(String(error))); };
  const backend = useMemo(() => raw ? chatThreadBackend(raw, {
    room:row.id,
    online:()=>live.current.chats.online(row.hostId),
    blocked:()=>sendBlock(live.current.row, machine, live.current.chats.rooms[row.hostId], movingRef.current || !!live.current.chats.promoteTicket(live.current.row)),
    historyBlocked:()=>promoteWait(live.current.chats.delivery?.snapshot().chats[key]?.outbox, row.hostId, row.id, machine.name)
      ? 'Wait for queued or uncertain messages to settle before changing chat history.' : null,
    cached:()=>{
      const snapshot = live.current.chats.delivery?.snapshot().chats[key]?.snapshot;
      return snapshot ? {snapshot,active:[],approvals:[]} : null;
    },
    remember:(state:RoomState)=>{ setBots(state.snapshot.participants); live.current.chats.remember(live.current.row,state.snapshot); },
    send:text=>live.current.chats.send(live.current.row,text),
    profile:id=>live.current.row.profiles[id] ?? live.current.profiles.find(p=>p.id===id)?.id,
  }) : null, [raw,key]);
  const send = (text:string) => { live.current.chats.send(live.current.row,text); };
  const addBot = () => act(chats.profiles(row.hostId).then(list=>setAdding(list.filter(p=>p.ok && !bots.some(bot=>row.profiles[bot.id]===p.profile.id)))));
  const command = (action:ThreadMenuRequest) => setRequest({id:crypto.randomUUID(),action});
  const fork = async (title:string,upto:number | null) => {
    if (!raw || !online) throw Error('Connect to the machine before copying a chat.');
    const state = await backend!.roomState!(row.id);
    const id = `chat-${crypto.randomUUID()}`;
    // chat_import gives the copy its own chat metadata and profile mappings. Never create a Work room.
    const result = await raw.call<{id:string;room:RoomSnapshot;skipped:unknown[]}>('chat_import', {
      id,move_id:crypto.randomUUID(),title,
      participants:state.snapshot.participants.map(bot=>{
        const profile = row.profiles[bot.id];
        if (!profile) throw Error(`The saved profile for ${bot.display_name} is unknown. Refresh the original chat before copying it.`);
        return {profile,id:bot.id,display_name:bot.display_name,
        ...((bot.backend.kind==='agent'||bot.backend.kind==='open_ai_compatible') ? {model:bot.backend.model,effort:bot.effort} : {}),speed:bot.speed};}),
      entries:state.snapshot.transcript.filter(message=>upto===null || message.seq<upto),options:state.snapshot.options,
    });
    if (result.skipped?.length) setProblem('The copied chat has bots that need setup on this machine.');
    await chats.refresh(row.hostId);
    // App opens by machine+room, and resolves the fresh catalog on its next render.
    live.current.onOpenChat(result.id);
    return title;
  };
  const entries:MenuEntry[] = [
    {key:'rename',label:'Rename…',disabled:!online || !!row.promotedTo,onSelect:()=>setRename(n=>n+1)},
    {key:'move',label:'Move to a Work thread…',disabled:!online || !!row.promotedTo,onSelect:()=>setMoving(true)},
    {key:'fork',label:'Copy into a new chat',separated:true,disabled:!online,onSelect:()=>command('fork')},
    {key:'export',label:'Export…',onSelect:()=>command('export')},
    {key:'pdf',label:'Share as PDF…',onSelect:()=>command('share_pdf')},
    {key:'copy',label:'Copy',submenu:[{key:'markdown',label:'Markdown',onSelect:()=>command('copy_markdown')},{key:'reply',label:'Last reply',onSelect:()=>command('copy_reply')}]},
    {key:'archive',label:row.archived?'Unarchive':'Archive',separated:true,disabled:!online,onSelect:()=>act(chats.updateMeta(row,{archived:!row.archived}))},
    {key:'close',label:'Close',onSelect:onClose},
  ];
  const pending = chats.delivery?.snapshot().chats[key];
  const delivery = <>{pending?.outbox.filter(item=>item.accepted!=='done').map(item=>{
    const status=chatDeliveryStatus(item,machine);
    return <div className="chat-delivery-row" key={item.id}><span>{item.text}</span><small>{status.line}</small>{status.canRetry && <button className="ghost" onClick={()=>chats.retry(row,item.id)}>Retry</button>}</div>;
  })}</>;
  return <section className={`pane focused talk-only-pane${maximized?' talk-only-maximized':''}`} data-pane-id={row.id} data-host-id={row.hostId} aria-label={`Chat: ${row.title}`}>
    <div className="pane-head">
      <span className={`dot ${online?'idle':'failed'}`} />
      <span className="pane-ws">Chat</span>
      <ThreadName className="pane-title" title={row.title} label="Chat name" renameRequest={rename} onRename={title=>act(chats.updateMeta(row,{title}))} />
      <span className="pane-host">{machine.name}</span><span className="pane-folder">{status}</span><span className="spacer" /><span className="pane-counts" />
      {!row.promotedTo && <button className="ghost small" disabled={!online || !bots.length} onClick={()=>setMoving(true)}>Move to a Work thread</button>}
      <button className="icon small" title={maximized?'Restore layout':'Maximize'} aria-label={maximized?'Restore layout':'Maximize pane'} onClick={()=>setMaximized(v=>!v)}>{maximized?'▣':'□'}</button>
      <button className="icon small" aria-label={`More actions for ${row.title}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={e=>setMenu(e.currentTarget)}>⋯</button>
      <button className="icon small" aria-label={`Close ${row.title}`} onClick={onClose}>×</button>
    </div>
    {menu && <MenuList id={`chat:${key}`} entries={entries} anchor={{rect:menu.getBoundingClientRect()}} opener={menu} onClose={()=>setMenu(null)} />}
    {row.promotedTo && <p className="desktop-chat-banner">Moved to a Work thread. This chat is kept as it was. <button className="ghost" onClick={()=>onOpenWork(row,row.promotedTo!)}>Open the Work thread</button></p>}
    {!row.promotedTo && ticket && <p className="desktop-chat-banner">A move to a Work thread wasn't confirmed. <button className="ghost" onClick={()=>setMoving(true)}>Finish or start over</button></p>}
    {!online && <p className="desktop-chat-banner">Reconnecting to {machine.name}. Messages wait here and go when it's back.</p>}
    {moving && <MoveToWorkDialog row={row} bots={bots} chats={chats} onClose={()=>setMoving(false)} onMoved={work=>{setMoving(false);onOpenWork(row,work.id,work);}} />}
    {adding && <div className="desktop-chat-banner">{adding.length ? adding.map(item=><button key={item.profile.id} onClick={()=>{setAdding(null);act(chats.addBot(row,item.profile.id));}}>{item.profile.display_name}</button>) : 'No other saved bots on this machine.'}<button className="ghost" onClick={()=>setAdding(null)}>Cancel</button></div>}
    {problem && <p className="chat-problem" role="status">{problem}</p>}
    <div className="pane-body">{backend ? <ChatPane key={key} talkOnly attach pane={{id:row.id,kind:'chat',workspaceId:'',title:row.title}} cwd="" backend={backend}
      chatDraft={props.draft} onChatDraft={props.onDraft} onChatSend={send} chatBlocked={blocked} chatReadOnly={!!row.promotedTo || !!ticket || moving} onChatAddBot={online?addBot:undefined} chatDelivery={delivery} onChatParticipants={setBots}
      agents={props.agents} profiles={props.profiles} onProfilesChange={props.onProfilesChange} disabledProviders={settings.disabledProviders} focused onActivity={()=>{}} onStatus={(_id,s)=>setStatus(s.text)}
      onFork={fork} menuRequest={request} onMenuDone={()=>setRequest(undefined)} onCopy={text=>act(navigator.clipboard.writeText(text))}
      chipParts={settings.botChips} confirmSteer={settings.confirmSteer} landingTexture={settings.landingTexture} codeRunButtons={false} /> : <p role="status">The chat's machine is unavailable.</p>}</div>
  </section>;
}
