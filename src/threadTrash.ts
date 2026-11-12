import type { Backend } from './backend';
import type { ChatCatalog, ChatEntry } from './chatCatalog';
import type { Pane, Workspace } from './types';
import { workspaceHost } from './hostSession.ts';

/** Recovery includes talk and Work rooms, retaining the owning route even when ids collide. */
export function trashRows(catalog: ChatCatalog): ChatEntry[] {
  return Object.values(catalog.hosts).flatMap(host => host.rooms).filter(row => !!row.trashedAt && !row.movedTo)
    .sort((a,b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || a.title.localeCompare(b.title));
}
const paneTrashed = (pane: Pane, workspaces: readonly Workspace[], catalog: ChatCatalog): boolean => {
  if (pane.kind !== 'chat') return false;
  const route = (pane as Pane & {hostId?:string}).hostId ?? workspaceHost(workspaces.find(workspace => workspace.id === pane.workspaceId) ?? {id:'',name:'',path:''});
  return !!catalog.hosts[route]?.rooms.find(row => row.id === pane.id)?.trashedAt;
};
export function withoutTrashedPanes<T extends Pane>(panes: T[], workspaces: readonly Workspace[], catalog: ChatCatalog): T[] {
  return panes.filter(pane => !paneTrashed(pane, workspaces, catalog));
}
/** Preserve the saved thread, closing it so Restore never opens or resumes it. */
export function closeTrashedPanes(panes: Pane[], workspaces: readonly Workspace[], catalog: ChatCatalog): Pane[] {
  let changed = false;
  const next = panes.map(pane => {
    if (pane.closed || !paneTrashed(pane,workspaces,catalog)) return pane;
    changed = true;
    return {...pane,closed:true};
  });
  return changed ? next : panes;
}

/** The caller supplies the backend for row.hostId; there is no fallback to this Mac. */
export async function setThreadTrashed(backend: Pick<Backend,'supports'|'call'>, row: ChatEntry, trashed: boolean, online: boolean): Promise<ChatEntry> {
  if (!online) throw new Error('This machine is offline. Reconnect before changing Trash.');
  if (backend.supports?.('room_trash_v1') !== true) throw new Error('Update Apex Deck on this machine to use recoverable Trash.');
  const meta = await backend.call<{trashedAt?:number}>('room_set_trashed',{id:row.id,trashed});
  if (!meta || (trashed ? !(typeof meta.trashedAt === 'number' && Number.isFinite(meta.trashedAt) && meta.trashedAt > 0) : meta.trashedAt != null)) {
    throw new Error('The machine did not confirm the Trash change. Refresh its thread list before trying again.');
  }
  const {trashedAt:_old,...rest}=row;
  return {...rest,...(trashed?{trashedAt:meta.trashedAt}:{})};
}

export const TRASH_DELIVERY_HOLDS_KEY='apex-deck.desktop-trash-delivery-holds.v1';
const deliveryKey=(host:string,room:string)=>JSON.stringify([host,room]);
/** A restore is never permission to replay queued messages, including after relaunch. */
export class TrashDeliveryHolds {
  private held: Set<string>;
  private failed=false;
  private storage: Pick<Storage,'getItem'|'setItem'>;
  constructor(storage: Pick<Storage,'getItem'|'setItem'>) {
    this.storage=storage;
    const value:unknown=JSON.parse(storage.getItem(TRASH_DELIVERY_HOLDS_KEY)??'[]');
    if (!Array.isArray(value) || !value.every(key=>{
      if (typeof key!=='string') return false;
      try {const pair:unknown=JSON.parse(key);return Array.isArray(pair)&&pair.length===2&&pair.every(part=>typeof part==='string'&&part.length>0);}catch{return false;}
    })) throw new Error('Saved Trash delivery holds could not be read. Sending is paused to protect queued messages.');
    this.held=new Set(value);
  }
  blocked(host:string,room:string):boolean {return this.failed||this.held.has(deliveryKey(host,room));}
  private save(next:Set<string>):void {
    try {this.storage.setItem(TRASH_DELIVERY_HOLDS_KEY,JSON.stringify([...next]));this.held=next;}
    catch {this.failed=true;throw new Error('Trash delivery holds could not be saved. Sending is paused to protect queued messages.');}
  }
  hold(host:string,room:string):void {
    if (this.failed) throw new Error('Trash delivery holds need checking before sending can resume.');
    const key=deliveryKey(host,room);if(this.held.has(key))return;
    this.save(new Set([...this.held,key]));
  }
  observe(catalog:ChatCatalog):void {for(const row of trashRows(catalog))this.hold(row.hostId,row.id);}
  resume(host:string,room:string):void {
    if (this.failed) throw new Error('Trash delivery holds need checking before sending can resume.');
    const key=deliveryKey(host,room);if(!this.held.has(key))return;
    const next=new Set(this.held);next.delete(key);this.save(next);
  }
}
