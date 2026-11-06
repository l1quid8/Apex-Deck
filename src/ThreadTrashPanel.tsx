import { useState } from 'react';
import type { ChatEntry } from './chatCatalog';
import { chatKey, type DesktopChats } from './desktopChats';
import { trashRows } from './threadTrash';

/** A recovery door, shared by talk and Work rooms. Restoring never opens a room. */
export function ThreadTrash({chats,onRestore}:{chats:DesktopChats;onRestore(row:ChatEntry):Promise<void>}) {
  const rows=trashRows(chats.catalog);
  const [limit,setLimit]=useState(50);
  const [busy,setBusy]=useState<string|null>(null);
  const [problem,setProblem]=useState('');
  return <details className="thread-trash rail-foot" aria-label="Thread Trash">
    <summary>Trash ({rows.length})</summary>
    <p className="muted rail-empty">Restore keeps the conversation and leaves it closed.</p>
    {problem&&<p role="status" className="chat-problem">{problem}</p>}
    <div style={{maxHeight:240,overflowY:'auto'}}>
      {!rows.length&&<p className="muted rail-empty">Trash is empty.</p>}
      {rows.slice(0,limit).map(row=>{
        const key=chatKey({hostId:row.hostId,room:row.id});
        const online=chats.online(row.hostId);
        const supported=chats.backendOf(row.hostId)?.supports?.('room_trash_v1')===true;
        const reason=!online?'Reconnect to restore this thread.':!supported?'Update Apex Deck on this machine to restore threads.':undefined;
        return <div className="rail-foot-item" key={key}>
          <span><strong>{row.title}</strong><small style={{display:'block'}}>{chats.machineName(row.hostId)} · {row.kind==='work'?'Work':'Chat'}</small></span>
          <button type="button" className="ghost" disabled={!!reason||busy!==null} title={reason} aria-label={`Restore ${row.title} on ${chats.machineName(row.hostId)}`} onClick={()=>{
            setBusy(key);setProblem('');
            void onRestore(row).catch(error=>setProblem(error instanceof Error?error.message:String(error))).finally(()=>setBusy(null));
          }}>{busy===key?'Restoring…':'Restore'}</button>
        </div>;
      })}
      {rows.length>limit&&<button type="button" className="ghost" onClick={()=>setLimit(was=>was+50)}>Show more ({rows.length-limit})</button>}
    </div>
  </details>;
}
