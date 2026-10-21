import type {VoicePreferences, VoiceSettings} from './types.ts';
export const DEFAULT_VOICE = 'am_michael';
export const voicePreferenceKey = (hostId:string, profileId:string, roomId?:string, participantId?:string) => JSON.stringify(roomId && participantId ? [hostId,profileId,roomId,participantId] : [hostId,profileId]);
export function readVoiceSettings(raw:unknown):VoiceSettings {
 const r = raw && typeof raw==='object' ? raw as Record<string,unknown> : {};
 const preferences:Record<string,VoicePreferences> = Object.create(null);
 if (r.preferences && typeof r.preferences==='object') for(const [key,value] of Object.entries(r.preferences).slice(0,1000)) {
  if (!value || typeof value!=='object' || ['__proto__','constructor','prototype'].includes(key)) continue;
  const p=value as Record<string,unknown>;
  preferences[key]={voice:typeof p.voice==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(p.voice) ? p.voice : DEFAULT_VOICE, aliases:Array.isArray(p.aliases)?p.aliases.filter((x):x is string=>typeof x==='string' && !!x.trim()).slice(0,16).map(x=>x.trim().slice(0,64)):[]};
 }
 return {enabled:r.enabled===true,silenceMs:typeof r.silenceMs==='number'&&Number.isFinite(r.silenceMs)?Math.min(2000,Math.max(300,Math.round(r.silenceMs))):700,preferences};
}
export function preferenceFor(s:VoiceSettings,host:string,profile:string,room?:string,participant?:string):VoicePreferences {
 return s.preferences[voicePreferenceKey(host,profile,room,participant)]??s.preferences[voicePreferenceKey(host,profile)]??{voice:DEFAULT_VOICE,aliases:[]};
}
export const validateVoice = (voice:string,catalog:readonly string[])=>catalog.includes(voice);
