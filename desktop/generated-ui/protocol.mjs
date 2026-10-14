import { createHash } from 'node:crypto';
import { readGeneratedCard } from '../../shared/generatedCard.mjs';

export const PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_BYTES = 8192;
const base = ['protocolVersion', 'runId', 'revisionDigest', 'type'];
export const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function revisionDigest(card, identity, versions) {
  // Explicit key order makes equivalent validated objects canonical; every
  // field is included, including prose and exact code bytes.
  const payload = ['schemaVersion', 'kind', 'cardId', 'title', 'summary', 'html', 'css', 'js', 'fallback'].map(key => [key, card[key]]);
  return createHash('sha256').update(JSON.stringify({ payload, identity: ['threadId', 'seq', 'cardId', 'hostId'].map(key => [key, identity[key]]), versions })).digest('hex');
}
export function readRuntimeMessage(value, binding, ports = []) {
  try {
    if (ports.length || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RUNTIME_BYTES
        || value.protocolVersion !== 1 || value.runId !== binding.runId || value.revisionDigest !== binding.revisionDigest) return { ok: false };
    const extra = value.type === 'pong' ? ['nonce'] : value.type === 'resize' ? ['height'] : value.type === 'discuss' ? ['text'] : value.type === 'fault' ? ['code'] : [];
    if (!['bootstrap', 'ready', 'pong', 'resize', 'discuss', 'fault'].includes(value.type) || !exactKeys(value, [...base, ...extra])) return { ok: false };
    if (value.type === 'fault' && value.code !== 'message-flood') return { ok: false };
    if (value.type === 'pong' && (typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce))) return { ok: false };
    if (value.type === 'resize' && (typeof value.height !== 'number' || !Number.isFinite(value.height))) return { ok: false };
    if (value.type === 'discuss' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000)) return { ok: false };
    return { ok: true, message: value.type === 'resize' ? { ...value, height: Math.min(800, Math.max(200, Math.ceil(value.height))) } : value };
  } catch { return { ok: false }; }
}
export class MessageBudget {
  start = null; count = 0; strikes = 0; floodWindows = 0; lastResize = -Infinity;
  accept(type, now) {
    if (this.start === null || now - this.start >= 1000) {
      this.floodWindows = this.count > 30 ? this.floodWindows + 1 : 0;
      this.start = now; this.count = 0; this.strikes = 0;
    }
    if (++this.count > 30) return ++this.strikes > 30 || this.floodWindows > 0 ? 'stop' : 'drop';
    if (type === 'resize') {
      if (now - this.lastResize < 100) return 'drop';
      this.lastResize = now;
    }
    return 'accept';
  }
}
export function readRunRequest(value) {
  if (!exactKeys(value, ['requestId', 'source', 'identity', 'bounds']) || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.requestId) || typeof value.source !== 'string'
      || !exactKeys(value.identity, ['threadId', 'seq', 'cardId', 'hostId'])) return { ok: false, reason: 'Invalid generated run request.' };
  const { identity } = value;
  if (['threadId', 'hostId'].some(key => typeof identity[key] !== 'string' || !identity[key] || identity[key].length > 200)
      || !Number.isSafeInteger(identity.seq) || identity.seq < 0) return { ok: false, reason: 'Invalid generated card identity.' };
  const parsed = readGeneratedCard(value.source);
  if (!parsed.ok || !parsed.card || parsed.card.cardId !== identity.cardId) return { ok: false, reason: parsed.reason || 'The generated card identity does not match.' };
  return { ok: true, requestId: value.requestId, card: parsed.card, identity: { ...identity }, bounds: value.bounds };
}
