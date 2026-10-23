import { useEffect, useMemo, useRef } from 'react';
import type { Backend } from '../backend';
import type { PersonalLane, PersonalAssistantRecord } from '../personalAssistant';
import { createPersonalVoiceBridge } from './personalBridge';
import { registerVoiceThread, unregisterVoiceThread, scopeKey } from './coordinator';
import { preferenceFor, readVoiceSettings } from './settings';
import { useVoiceHint, useVoiceSlot, type VoiceWho } from './VoiceCallControls';
import type { VoiceSettings } from './types';

export function useAssistantVoice({lane,backend,settings,onSettings,onFocus}:{lane?:PersonalLane|null;backend?:Backend;settings?:VoiceSettings;onSettings?:(settings:VoiceSettings)=>void;onFocus?:()=>void}) {
 const config=readVoiceSettings(settings), record=lane?.assistant, hostId=lane?.ref?.hostId??record?.hostId??'', id=lane?.ref?.assistantId??record?.id??'';
 const roomId=`assistant:${id}`;
 const available=!!record&&!lane?.offline&&!!lane?.sendRequest&&!!lane?.cancelReply&&!!backend;
 const candidates=available?[{hostId,roomId,participantId:id,profileId:`assistant:${id}`,name:lane!.name,roomTitle:lane!.name,agentVoice:record.profile?.voice,aliases:preferenceFor(config,hostId,`assistant:${id}`,roomId,id).aliases}]:[];
 const live=useRef({lane,backend,config,onSettings,onFocus});live.current={lane,backend,config,onSettings,onFocus};
 const bridge=useMemo(()=>available?createPersonalVoiceBridge({scope:{hostId,roomId,participantId:id},send:(text,request)=>live.current.lane!.sendRequest!(text,request),stop:event=>live.current.lane!.cancelReply!(event),read:()=>live.current.backend!.call<PersonalAssistantRecord>('personal_get',{assistantId:id})}):null,[available,hostId,id,roomId,backend]);
 useEffect(()=>{if(!bridge)return;const key=scopeKey({hostId,roomId});return()=>{unregisterVoiceThread(key);bridge.dispose();};},[bridge,hostId,roomId]);
 useEffect(()=>{if(!bridge)return;registerVoiceThread(scopeKey({hostId,roomId}),{candidates,settings:config,save:s=>live.current.onSettings?.(s),focus:()=>live.current.onFocus?.(),bridge:()=>bridge});});
 useEffect(()=>{if(bridge&&record)bridge.update(record);},[bridge,record]);
 const who:VoiceWho=()=>({seed:record?.look?.seed??id,color:record?.look?.color??'#71e6b5'});
 const props={settings:config,candidates,who};
 return {...props,hint:useVoiceHint(props),slot:useVoiceSlot(props)};
}
