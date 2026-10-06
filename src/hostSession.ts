import type { AppSession, Pane, Workspace } from "./types";
import { loadedPanes, paneSection, restoredLayouts } from "./closing.ts";
import { sync, type LayoutNode } from "./layout.ts";

export function workspaceHost(workspace: Workspace): string { return workspace.hostId ?? "local"; }
export function workspaceFamily(workspace: Workspace): string {
  return workspace.family ?? (workspace.path.replace(/\/+$/, "").split("/").pop() || workspace.name);
}
export function normalizeWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap(v => {
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id || ids.has(v.id) || typeof v.path !== "string" || typeof v.name !== "string") return [];
    if (v.hostId != null && (typeof v.hostId !== "string" || !v.hostId)) return [];
    ids.add(v.id);
    const w: Workspace = { id: v.id, name: v.name, path: v.path };
    if (v.hidden === true) w.hidden = true;
    if (v.hostId && v.hostId !== "local") w.hostId = v.hostId;
    w.family = typeof v.family === "string" && v.family ? v.family : workspaceFamily(w);
    return [w];
  });
}

/** Validate untrusted server data before scheduling a React state update. */
export function prepareHostSession(remote: unknown): Pick<AppSession, "version" | "workspaces" | "panes"> | null {
  if (remote === null) return null;
  if (!remote || typeof remote !== "object") throw new Error("Unreadable server session.");
  const r = remote as Partial<AppSession>;
  if (r.version !== 1 || !Array.isArray(r.workspaces) || !Array.isArray(r.panes)) throw new Error("Unreadable server session.");
  const workspaces = normalizeWorkspaces(r.workspaces);
  if (workspaces.length !== r.workspaces.length) throw new Error("Malformed server workspaces.");
  return { version: 1, workspaces, panes: loadedPanes(r.panes, workspaces.map(w => w.id)) };
}

/** One atomic document: records and their migration marker are saved together. */
export function mergeHostSession(local: AppSession, hostId: string, remote: unknown): { session: AppSession; conflicts: string[] } {
  if (!hostId || hostId === "local") throw new Error("A saved server is required for import.");
  if (local.importedHostSessions?.includes(hostId)) return { session: local, conflicts: [] };
  const conflicts: string[] = [];
  const workspaces = [...local.workspaces]; const panes = [...local.panes];
  if (remote !== null) {
    const r = prepareHostSession(remote)!;
    const imported = r.workspaces;
    const taken = new Set(workspaces.map(w => w.id));
    const map = new Map<string, string>();
    for (const w of imported) {
      let id = w.id;
      if (taken.has(id)) { conflicts.push(id); let n = 1; do { id = `${hostId}:${w.id}:${n++}`; } while (taken.has(id)); }
      taken.add(id); map.set(w.id, id);
      workspaces.push({ ...w, id, hostId });
    }
    const ids = new Set(panes.map(p => p.id));
    for (const p of loadedPanes(r.panes, imported.map(w => w.id))) {
      if (ids.has(p.id)) { conflicts.push(p.id); continue; }
      ids.add(p.id);
      panes.push({ ...p, workspaceId: map.get(p.workspaceId)!, closed: true });
    }
  }
  return { session: { ...local, workspaces, panes, importedHostSessions: [...(local.importedHostSessions ?? []), hostId] }, conflicts };
}

export function migrateCanvasLayouts(session: AppSession): AppSession {
  if (session.canvasVersion === 1) return session;
  const visible: Pane[] = session.panes.filter(p => !p.closed && session.workspaces.some(w => w.id === p.workspaceId && !w.hidden));
  const legacy = restoredLayouts(session.layouts, visible);
  const layouts: Record<string, LayoutNode> = {};
  for (const section of ["threads", "code"] as const) {
    const tree = sync(legacy[`:${section}`] ?? legacy[`${session.activeWorkspace}:${section}`] ?? null, visible.filter(p => paneSection(p) === section).map(p => p.id));
    if (tree) layouts[`:${section}`] = tree;
  }
  return { ...session, layouts, canvasVersion: 1 };
}
