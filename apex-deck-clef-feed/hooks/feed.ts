export function parseFeed(text: string): any[] {
  return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; } catch { return []; } });
}
export function sameTargets(a: string[] = [], b: string[] = []): boolean {
  const aa = new Set(a), bb = new Set(b); return aa.size === bb.size && [...aa].every(id => bb.has(id));
}
export function routingRows(rows: any[]): any[] { return rows.filter(r => r.kind !== 'thinking'); }
export function totals(rows: any[]) {
  rows = routingRows(rows);
  const usable = rows.filter(r => !r.stale && r.result);
  return {checked:rows.length, usable:usable.length, agree:usable.filter(r=>sameTargets(r.suggested_targets ?? [],r.deck_targets ?? [])).length,
    errors:rows.filter(r=>'error' in r).length, stale:rows.filter(r=>r.stale).length,
    latency:usable.length ? usable.reduce((s,r)=>s+(Number.isFinite(r.result.latency_ms)?r.result.latency_ms:0),0)/usable.length : 0,
    cost:usable.reduce((s,r)=>s+(Number.isFinite(r.result.usage?.cost)?r.result.usage.cost:0),0)};
}
export function pickName(ids: string[] = []): string { return ids.length ? ids.map(id=>'@'+id).join(' + ') : 'nobody'; }
export function roomFile(id: string): string { return [...new TextEncoder().encode(id)].map(b=>b.toString(16).padStart(2,'0')).join('')+'.json'; }
export function snippet(room: any,row: any): string | null {
  const msg=room?.snapshot?.transcript?.[row.message_index];
  if(msg?.speaker?.kind !== 'human' || typeof msg.text !== 'string') return null;
  const at=typeof msg.at==='number'?msg.at:typeof msg.at==='string'?Date.parse(msg.at):NaN;
  if(!Number.isFinite(at)||!Number.isFinite(row.at_ms)||row.at_ms-at<0||row.at_ms-at>300000) return null;
  return msg.text.split(/\r?\n/).find((line:string)=>line.trim())?.trim().slice(0,60)||null;
}
export function providerName(provider: string): string { return ({jev:'TypeSafe / Jev',openrouter:'OpenRouter / Clef',cloudflare:'Cloudflare / Clef'} as Record<string,string>)[provider] ?? 'Unknown provider'; }
