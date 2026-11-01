import fs from 'node:fs';
import path from 'node:path';

const validBounds = (b) => b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
const keyOf = (r) => `${r.kind}:${r.id}`;

/** Desktop-only placement data. Snapshots, credentials and live terminal IDs are never saved here. */
export class PopoutLayoutStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) for (const record of saved) this.keep(record);
    } catch { /* First launch or a damaged layout: panes remain available in Deck. */ }
  }

  keep(record) {
    if (!record || !['pane', 'tab'].includes(record.kind) || typeof record.id !== 'string' || !record.id || !validBounds(record.bounds)) return;
    const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(record.bounds[k])]));
    bounds.width = Math.max(360, bounds.width);
    bounds.height = Math.max(240, bounds.height);
    const next = { kind: record.kind, id: record.id, bounds, maximized: record.maximized === true };
    this.records.set(keyOf(next), next);
  }

  list() { return [...this.records.values()]; }
  get(kind, id) { return this.records.get(keyOf({ kind, id })); }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.list()));
      fs.renameSync(temp, this.file);
    } catch (error) { console.warn(`Could not save external window layout: ${error.message}`); }
  }

  set(record) {
    const before = JSON.stringify(this.list());
    this.keep(record);
    if (JSON.stringify(this.list()) !== before) this.save();
  }

  remove(kind, id) {
    if (this.records.delete(keyOf({ kind, id }))) this.save();
  }

  /** Called after the owner has loaded its session; unavailable items never reopen. */
  restore({ panes, tabs }) {
    const available = new Set([
      ...(Array.isArray(panes) ? panes : []).map(id => keyOf({ kind: 'pane', id })),
      ...(Array.isArray(tabs) ? tabs : []).map(id => keyOf({ kind: 'tab', id })),
    ]);
    for (const [key] of this.records) if (!available.has(key)) this.records.delete(key);
    this.save();
    return this.list().map(({ kind, id }) => ({ kind, id }));
  }
}

/** Fit saved geometry to the display with the largest overlap, or the primary display. */
export function fitPopoutBounds(bounds, workAreas) {
  if (!validBounds(bounds) || workAreas.length === 0) return null;
  let area = workAreas[0], most = 0;
  for (const candidate of workAreas) {
    const overlap = Math.max(0, Math.min(bounds.x + bounds.width, candidate.x + candidate.width) - Math.max(bounds.x, candidate.x))
      * Math.max(0, Math.min(bounds.y + bounds.height, candidate.y + candidate.height) - Math.max(bounds.y, candidate.y));
    if (overlap > most) { most = overlap; area = candidate; }
  }
  const width = Math.min(area.width, Math.max(360, Math.round(bounds.width)));
  const height = Math.min(area.height, Math.max(240, Math.round(bounds.height)));
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width, height,
  };
}

/** Save while the window is open so reboot/forced exit cannot erase the last placement. */
export function trackPopoutWindow(win, identity, store, preserveOnClose) {
  const save = () => {
    if (!win.isDestroyed()) store.set({ ...identity, bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  save();
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'leave-full-screen']) win.on(event, save);
  win.on('closed', () => {
    if (!preserveOnClose()) store.remove(identity.kind, identity.id);
  });
}
