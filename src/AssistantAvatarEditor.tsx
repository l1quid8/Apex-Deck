import { useEffect, useReducer, useState } from 'react';
import { Avatar } from './Avatar';
import { createAppearance } from './identicon';
import type { AssistantLook } from './assistantIdentity';
import { avatarOwnerKey, createAvatarEditor, reduceAvatarEditor, type AvatarDraftOwner, type AssistantAvatarApi, type AvatarOption, type AvatarSelection } from './assistantAvatar';
export type AssistantAvatarEditorProps = {owner:AvatarDraftOwner;appearance:AssistantLook & {seed:string;color:string};onAppearanceChange:(look:AssistantLook & {seed:string;color:string})=>void;onApply:(selection:AvatarSelection)=>void;api?:AssistantAvatarApi;disabled?:boolean};
/** Mount keyed by the immutable owner. Applying selects a form draft; Save/Create
 * is still the only persistent mutation. Closing unmounts and discards the draft. */
export function AssistantAvatarEditor(props:AssistantAvatarEditorProps){return <OwnedEditor key={avatarOwnerKey(props.owner)} {...props}/>;}
function OwnedEditor({owner,appearance,onAppearanceChange,onApply,api,disabled}:AssistantAvatarEditorProps){
 const [state,dispatch]=useReducer(reduceAvatarEditor,undefined,()=>createAvatarEditor(owner,crypto.randomUUID()));
 const [prompt,setPrompt]=useState('');const [options,setOptions]=useState<AvatarOption[]>([]);const [optionIndex,setOptionIndex]=useState(0);const [reason,setReason]=useState('Loading supported image models…');const [image,setImage]=useState<string>();const [tab,setTab]=useState<'pixel'|'image'>('pixel');
 const ownerKey=avatarOwnerKey(owner);
 useEffect(()=>{let active=true;setOptions([]);if(!api){setReason('This host does not support avatar generation. Pixel editing is available.');return;}api.options(owner).then(r=>{if(active){setOptions(r.options);setReason(r.reason??'');}}).catch(e=>{if(active)setReason(String(e));});return()=>{active=false;};},[api,ownerKey]);
 useEffect(()=>{if(!api||state.status!=='pending'||!state.generationId)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;const id=state.generationId;const poll=()=>{api.status(owner,id).then(job=>{if(!disposed){dispatch({type:'result',job});if(job.state==='pending')timer=setTimeout(poll,900);}}).catch(e=>{if(!disposed)dispatch({type:'result',job:{owner,generationId:id,editorToken:state.editorToken,state:'error',error:String(e)}});});};timer=setTimeout(poll,900);return()=>{disposed=true;clearTimeout(timer);};},[api,state.status,state.generationId,state.editorToken,ownerKey]);
 useEffect(()=>{let disposed=false;let url:string|undefined;setImage(undefined);if(api&&state.candidate&&state.generationId){api.asset({owner,generationId:state.generationId,assetId:state.candidate.assetId,sha256:state.candidate.sha256}).then(blob=>{if(disposed)return;url=URL.createObjectURL(blob);setImage(url);}).catch(()=>{});}return()=>{disposed=true;if(url)URL.revokeObjectURL(url);};},[api,state.candidate,state.generationId,ownerKey]);
 const option=options[optionIndex];
 const generate=()=>{if(!api||!option)return;const generationId=crypto.randomUUID();const editorToken=crypto.randomUUID();dispatch({type:'generate',generationId,editorToken});api.generate({owner,generationId,editorToken,providerProfileId:option.providerProfileId,modelId:option.modelId,prompt}).then(job=>dispatch({type:'result',job})).catch(e=>dispatch({type:'result',job:{owner,generationId,editorToken,state:'error',error:String(e)}}));};
 const cancel=()=>{dispatch({type:'cancel'});if(api&&state.generationId)void api.cancel(owner,state.generationId).catch(()=>{});};
 const pixel=()=>{cancel();dispatch({type:'pixel'});onAppearanceChange({...appearance,kind:'pixel',image:undefined});onApply({kind:'pixel'});};
 return <div className="assistant-avatar-editor"><div role="tablist" aria-label="Avatar style"><button type="button" role="tab" aria-selected={tab==='pixel'} onClick={()=>setTab('pixel')}>Pixel pattern</button><button type="button" role="tab" aria-selected={tab==='image'} onClick={()=>setTab('image')}>Generate with AI</button></div>
 {tab==='pixel'?<div><Avatar seed={appearance.seed} color={appearance.color}/><button type="button" disabled={disabled} onClick={pixel}>Use pixel pattern</button><button type="button" disabled={disabled} onClick={()=>{pixel();onAppearanceChange({...appearance,seed:createAppearance().seed,kind:'pixel',image:undefined});}}>New pattern</button><button type="button" disabled={disabled} onClick={pixel}>Reset to pixel</button></div>:<div>
 {options.length>0?<label>Image model<select value={optionIndex} onChange={e=>setOptionIndex(Number(e.target.value))} disabled={disabled||state.status==='pending'}>{options.map((o,i)=><option value={i} key={`${o.providerProfileId}:${o.modelId}`}>{o.label}</option>)}</select></label>:<p>{reason}</p>}
 {option&&<p>{option.estimatedCostMicros===null?'Cost unknown; the provider may charge.':`Estimated $${(option.estimatedCostMicros/1e6).toFixed(3)} per generation`}</p>}
 <label>Describe the avatar<textarea value={prompt} maxLength={4000} onChange={e=>setPrompt(e.target.value)} disabled={disabled||state.status==='pending'}/></label>
 <button type="button" disabled={disabled||!api||!option||!prompt.trim()||state.status==='pending'} onClick={generate}>{state.generationId?'Regenerate':'Generate'}</button>
 {state.status==='pending'&&<p role="status">Generating preview…</p>}{state.error&&<p role="alert">{state.error}</p>}
 {state.candidate&&<div>{image?<img src={image} alt="Generated avatar preview" width={128} height={128}/>:<p>Preview unavailable</p>}<button type="button" disabled={disabled||!image} onClick={()=>{if(state.candidate&&state.generationId){dispatch({type:'apply'});onAppearanceChange({...appearance,kind:'image',image:state.candidate});onApply({kind:'image',generationId:state.generationId,assetId:state.candidate.assetId});}}}>Apply</button></div>}
 {(state.status==='pending'||state.status==='preview')&&<button type="button" onClick={cancel}>Cancel</button>}
 {state.selection?.kind==='image'&&<p>Image selected. Save or Create to keep it.</p>}
 </div>}</div>;
}
