import type { AssistantRef } from './assistantIdentity.ts';
import type { ParticipantConfig, ModelChoice } from './types.ts';
export type AssistantSection = 'conversation' | 'projects' | 'activity' | 'memory' | 'settings';
export type MainView = { kind: 'workspace' } | { kind: 'assistant'; assistant: AssistantRef; section: AssistantSection };
export type AssistantNavigation = {kind:'open';assistant:AssistantRef} | {kind:'section';section:AssistantSection} | {kind:'back'} | {kind:'workspace'};
/** Navigation owns only the main canvas. Global Dashboard/Tasks panel state is retained verbatim. */
export function assistantNavigation<T extends {mainView:MainView}>(state:T,event:AssistantNavigation):T {
 const mainView:MainView = event.kind==='workspace' ? {kind:'workspace'} : event.kind==='open' ? {kind:'assistant',assistant:{...event.assistant},section:'conversation'} : state.mainView.kind==='assistant' ? {...state.mainView,section:event.kind==='back'?'conversation':event.section} : state.mainView;
 return {...state,mainView};
}
export function textModels<T extends ModelChoice & {kind?:string|null}>(models:T[]):T[] { return models.filter(m=>!m.kind || m.kind==='text'); }
export function reconcileEffort(effort:string|null, model:ModelChoice|undefined):string|null {
 const levels=model?.efforts;return levels?.length ? (effort && levels.includes(effort) ? effort : levels[0]) : null;
}
export function runtimeProfile(base:ParticipantConfig,name:string,model:string,access:ParticipantConfig['access'],effort:string|null):ParticipantConfig {
 const backend=base.backend.kind==='agent'||base.backend.kind==='open_ai_compatible'?{...base.backend,model}:base.backend;
 return {...base,display_name:name.trim(),backend,access,effort};
}
export function validateAssistantDraft(d:{name:string;color:string;profile:Pick<ParticipantConfig,'backend'|'access'>|undefined;model:ModelChoice|undefined;effort:string|null;providerReady:boolean}):string|null {
 if(!d.name.trim() || [...d.name.trim()].length>64 || /[\x00-\x1f\x7f]/.test(d.name)) return 'Enter an assistant name of 1–64 characters.';
 if(!/^#[\da-fA-F]{6}$/.test(d.color)) return 'Choose an avatar color with six hexadecimal digits.';
 if(!d.providerReady || !d.profile) return 'Choose a compatible configured provider with available credentials.';
 if(!d.model) return 'Choose an offered text model from this provider.';
 if(d.effort && !d.model.efforts?.includes(d.effort)) return 'Choose a supported reasoning level.';
 return null;
}
export function rosterMessage(rows:readonly unknown[],hosts:readonly {state:string;problem?:string}[]):string|null {
 if(rows.length)return null;
 const problem=hosts.find(h=>h.problem)?.problem;if(problem)return problem;
 if(hosts.some(h=>h.state==='offline'))return 'Assistant machines are offline. Reconnect to load Your team.';
 return 'No assistants yet. Add a teammate to get started.';
}
