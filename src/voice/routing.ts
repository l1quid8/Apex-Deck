import type {VoiceCandidate} from './types.ts';
type Candidate = Pick<VoiceCandidate,'hostId'|'roomId'|'participantId'|'name'|'aliases'>;
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[.,!?]+$/,'').trim();
export function resolveCallCommand<T extends Candidate>(text:string,candidates:readonly T[]):{kind:'text';text:string}|{kind:'end'}|{kind:'switch';candidate:T;text:string}|{kind:'ambiguous';candidates:T[];text:string}|{kind:'unknown';text:string} {
 const raw=text.trim(); if(normalize(raw)==='stop listening')return {kind:'end'};
 const command=/^call\s+(.+)$/i.exec(raw); if(!command)return {kind:'text',text:raw};
 const matches=candidates.flatMap(candidate=>[candidate.name,...candidate.aliases].flatMap(name=>{
  const n=normalize(name); const c=normalize(command[1]);
  return n && (c===n || c.startsWith(n+' '))?[{candidate,length:n.length}]:[];
 }));
 const longest=Math.max(0,...matches.map(m=>m.length));
 const found=[...new Set(matches.filter(m=>m.length===longest).map(m=>m.candidate))];
 const rest=command[1].slice(longest).replace(/^[\s,.:;!?]+/,'').trim();
 return found.length===1?{kind:'switch',candidate:found[0],text:rest}:found.length?{kind:'ambiguous',candidates:found,text:rest}:{kind:'unknown',text:raw};
}
