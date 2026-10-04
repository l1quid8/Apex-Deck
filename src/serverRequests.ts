export const normalizeServer = (name: string) => name.toLowerCase().replace(/[-_.\s]/g, '');
export const serverToken = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
/** Preserve offsets while hiding Markdown code and escaped characters. */
export function proseMask(text: string): string {
  const out = text.split('');
  let delimiter = 0;
  for (let i = 0; i < text.length;) {
    if (!delimiter && text[i] === '\\') { out[i++] = ' '; if (i < text.length) out[i++] = ' '; continue; }
    if (text[i] === '`') {
      let end = i; while (text[end] === '`') end++;
      const count = end - i;
      for (let j = i; j < end; j++) out[j] = ' ';
      if (!delimiter) delimiter = count; else if (delimiter === count) delimiter = 0;
      i = end; continue;
    }
    if (delimiter) out[i] = ' ';
    i++;
  }
  return out.join('');
}
export function parseServerRequests(text: string): {name:string;start:number;end:number}[] {
  const masked = proseMask(text), seen = new Set<string>(), found = [];
  for (const m of masked.matchAll(/(^|\s)!([A-Za-z0-9._-]+)/g)) {
    const start = m.index! + m[1].length;
    // A masked escape/code boundary must not manufacture whitespace.
    if (start && !/\s/.test(text[start - 1])) continue;
    const name = m[2], key = normalizeServer(name);
    if (key && !seen.has(key)) { found.push({name,start,end:start+name.length+1}); seen.add(key); }
  }
  return found;
}
export function resolveServerRequests(names: string[], known: string[]) {
  const matched: string[] = [], unknown: string[] = [];
  for (const name of names) {
    const match = known.find(x => normalizeServer(x) === normalizeServer(name));
    if (match) { if (!matched.includes(match)) matched.push(match); } else unknown.push(name);
  }
  return {matched,unknown};
}
