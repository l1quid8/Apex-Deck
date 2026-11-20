/** JSON-only snapshots. Also embedded in the fixed child bootstrap. */
export function normalizeWidgetState(value) {
  let nodes = 0;
  const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 512 || depth > 16) throw new TypeError('Widget state is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Widget state must be JSON');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new TypeError('Widget state must be plain JSON');
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) throw new TypeError('Widget state must be JSON');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new TypeError('Widget state must be a dense JSON array');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new TypeError('Widget state arrays must contain indices only');
      if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError('Widget state must contain data only');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 4096) throw new TypeError('Widget state exceeds 4096 UTF-8 bytes');
  return JSON.parse(json);
}
