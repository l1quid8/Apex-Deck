import type { AssistantRef } from '../assistantIdentity.ts';
const ACTIVE_ASSISTANT_CALL=new Set(['warming','listening','hearing','waiting','thinking','speaking','needs-attention']);
const same=(a:AssistantRef|null|undefined,b:AssistantRef|null|undefined)=>!!a&&!!b&&a.hostId===b.hostId&&a.assistantId===b.assistantId;
/** A view is not a call owner. Keep the live owner registered even after its
 * float closes/replaces; the selected main chat already registers itself. */
export function assistantVoiceKeeperOwner(input:{voice:{status:string;scope?:{hostId:string;roomId:string;participantId?:string}};available:readonly {ref:AssistantRef;archivedAt?:number}[];selected?:AssistantRef|null;floating?:AssistantRef|null}):AssistantRef|null{
 const {voice,available,selected,floating}=input;
 const eligible=(ref:AssistantRef|null|undefined)=>ref&&available.some(row=>row.archivedAt==null&&same(row.ref,ref));
 let owner:AssistantRef|null=null;
 if(ACTIVE_ASSISTANT_CALL.has(voice.status)){
   const scope=voice.scope;
   if(!scope?.roomId.startsWith('assistant:'))return null;
   const id=scope.roomId.slice('assistant:'.length);
   if(!id||(scope.participantId!=null&&scope.participantId!==id))return null;
   owner={hostId:scope.hostId,assistantId:id};
   if(!eligible(owner))return null;
 }else if(eligible(floating))owner=floating!;
 return owner&&!same(owner,selected)?{...owner}:null;
}
