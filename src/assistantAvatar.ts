import type { AssistantRef, AssistantAvatarAsset } from './assistantIdentity.ts';
import type { Backend } from './backend.ts';
export type AvatarDraftOwner = {kind:'assistant';assistant:AssistantRef}|{kind:'creation';hostId:string;draftId:string};
export type AvatarSelection = {kind:'image';generationId:string;assetId:string}|{kind:'pixel'};
export type AvatarJob = {owner:AvatarDraftOwner;generationId:string;editorToken:string;state:'pending'|'preview'|'error'|'cancelled';candidate?:AssistantAvatarAsset;error?:string};
export type AvatarOption = {providerProfileId:string;modelId:string;label:string;estimatedCostMicros:number|null};
export type AvatarEditorState = {owner:AvatarDraftOwner;editorToken:string;generationId?:string;status:'idle'|'pending'|'preview'|'error'|'cancelled';candidate?:AssistantAvatarAsset;selection?:AvatarSelection;error?:string};
export const avatarOwnerKey=(o:AvatarDraftOwner)=>JSON.stringify(o.kind==='assistant'?['assistant',o.assistant.hostId,o.assistant.assistantId]:['creation',o.hostId,o.draftId]);
export function createAvatarEditor(owner:AvatarDraftOwner,editorToken:string):AvatarEditorState{return {owner,editorToken,status:'idle'};}
export type AvatarEditorEvent={type:'generate';generationId:string;editorToken:string}|{type:'result';job:AvatarJob}|{type:'apply'}|{type:'cancel'}|{type:'pixel'};
export function reduceAvatarEditor(s:AvatarEditorState,e:AvatarEditorEvent):AvatarEditorState{
 switch(e.type){
 case 'generate':return {...s,generationId:e.generationId,editorToken:e.editorToken,status:'pending',candidate:undefined,error:undefined};
 case 'result':if(s.status!=='pending'||avatarOwnerKey(s.owner)!==avatarOwnerKey(e.job.owner)||s.generationId!==e.job.generationId||s.editorToken!==e.job.editorToken)return s;
 return {...s,status:e.job.state,candidate:e.job.state==='preview'?e.job.candidate:undefined,error:e.job.error};
 case 'apply':return s.status==='preview'&&s.candidate&&s.generationId?{...s,selection:{kind:'image',generationId:s.generationId,assetId:s.candidate.assetId}}:s;
 case 'cancel':return {...s,status:'cancelled',candidate:undefined};
 case 'pixel':return {...s,status:'idle',candidate:undefined,selection:{kind:'pixel'}};
 }
}
export type AssistantAvatarApi={options(owner:AvatarDraftOwner):Promise<{options:AvatarOption[];reason?:string}>;generate(input:{owner:AvatarDraftOwner;generationId:string;editorToken:string;providerProfileId:string;modelId:string;prompt:string}):Promise<AvatarJob>;status(owner:AvatarDraftOwner,generationId:string):Promise<AvatarJob>;cancel(owner:AvatarDraftOwner,generationId:string):Promise<AvatarJob>;asset(input:{assistantId?:string;owner?:AvatarDraftOwner;generationId?:string;assetId:string;sha256:string}):Promise<Blob>};
export function createAssistantAvatarApi(backend:Backend):AssistantAvatarApi|undefined{
 if(!backend.supports?.('assistant_avatar_generation_v1'))return undefined;
 return {options:owner=>backend.call('personal_avatar_options',{owner}),generate:input=>backend.call('personal_avatar_generate',input),status:(owner,generationId)=>backend.call('personal_avatar_status',{owner,generationId}),cancel:(owner,generationId)=>backend.call('personal_avatar_cancel',{owner,generationId}),asset:async input=>{
 const result=await backend.call<{base64:string}>('personal_avatar_asset',input);
 const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));
 return new Blob([bytes],{type:'image/png'});
 }};
}
