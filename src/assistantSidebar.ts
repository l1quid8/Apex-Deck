import type { Pane } from './types';
import type { AssistantRegistryState, AssistantVisiblePane } from './assistantRegistry';
export const assistantThreadKey=(pane:Pick<Pane,'id'|'workspaceId'>&{hostId?:string})=>JSON.stringify([pane.hostId??'local',pane.workspaceId,pane.id]);
/** Hide only chats with recorded task ownership; titles never decide lineage.
 * Existing human destination chats are not converted into task-owned chats. */
export function assistantSidebarPanes(panes:readonly AssistantVisiblePane[],registry:AssistantRegistryState,kept:ReadonlySet<string>):AssistantVisiblePane[]{
 const named=new Set(Object.values(registry.owners).flatMap(o=>o.snapshot?.tasks.filter(t=>!!t.lineage?.assistant).map(t=>JSON.stringify([o.owner.hostId,o.owner.workspaceId,t.id]))??[]));
 return panes.filter(p=>kept.has(assistantThreadKey(p))||(!p.assistantDraftFor&&(!p.assistantTaskId||!named.has(JSON.stringify([p.hostId??'local',p.workspaceId,p.assistantTaskId])))));
}
