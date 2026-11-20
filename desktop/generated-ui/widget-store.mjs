import fs from 'node:fs';
import path from 'node:path';
import { normalizeWidgetState } from '../../shared/generatedWidgetState.mjs';

const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const validImage = image => typeof image === 'string' && image.length <= 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image);
/** Host-owned, local-only bounded LRU. No paths or identities arrive from a sandbox. */
export class WidgetStore {
  entries = new Map();
  timer = null;
  dirty = false;
  constructor(directory = null, { maxEntries = 128, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.directory = directory; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    if (!directory) return;
    try {
      const file = path.join(directory, 'widgets.json');
      if (fs.statSync(file).size > maxBytes) return;
      const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(entries) || entries.length > maxEntries) return;
      for (const [key, value] of entries) {
        if (!validKey(key) || !value || typeof value !== 'object') continue;
        try { this.entries.set(key, { widgetState: normalizeWidgetState(value.widgetState), image: validImage(value.image) ? value.image : null }); } catch {}
      }
      this.trim();
    } catch { /* Missing/corrupt cache is an empty cache, never executable data. */ }
  }
  get(key) {
    if (!validKey(key)) throw new TypeError('Invalid widget identity');
    const entry = this.entries.get(key);
    if (!entry) return { widgetState: null, image: null };
    this.entries.delete(key); this.entries.set(key, entry);
    return {widgetState: normalizeWidgetState(entry.widgetState), image: entry.image};
  }
  saveState(key, value) { const state = normalizeWidgetState(value); this.update(key, {widgetState: state}); }
  saveImage(key, image) { if (!validImage(image)) throw new TypeError('Invalid widget snapshot'); this.update(key, {image}); }
  update(key, patch) {
    const entry = this.get(key);
    const next = {...entry, ...patch};
    if (next.image === entry.image && JSON.stringify(next.widgetState) === JSON.stringify(entry.widgetState)) return;
    this.entries.set(key, next); this.trim(); this.dirty = true;
    if (this.directory && !this.timer) { this.timer = setTimeout(() => this.flush(), 100); this.timer.unref?.(); }
  }
  trim() {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += (entry.image?.length ?? 0) + Buffer.byteLength(JSON.stringify(entry.widgetState)) + 128;
    // Evict old pixels before settings: image pressure must not reset controls.
    for (const entry of this.entries.values()) {
      if (bytes <= this.maxBytes) break;
      if (entry.image) { bytes -= entry.image.length; entry.image = null; }
    }
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const key = this.entries.keys().next().value;
      const value = this.entries.get(key); this.entries.delete(key);
      bytes -= (value.image?.length ?? 0) + Buffer.byteLength(JSON.stringify(value.widgetState)) + 128;
    }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.directory || !this.dirty) return;
    const file = path.join(this.directory, 'widgets.json'), temporary = file + '.tmp';
    try {
      fs.mkdirSync(this.directory, {recursive:true,mode:0o700});
      fs.writeFileSync(temporary, JSON.stringify([...this.entries]), {mode:0o600});
      fs.renameSync(temporary,file); this.dirty = false;
    } catch { /* Memory snapshot remains available if local persistence fails. */ }
  }
}
