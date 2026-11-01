import type { Pane, Workspace } from "./types";
import { workspaceHost } from "./hostSession.ts";

export type PersonalViewContext = { hostId: string; focusedThreadId?: string; openThreadIds: string[] };

/** IDs are only hints. The host must resolve them against current project grants. */
export function assistantViewContext(input: {
  routeHostId: string; hostId: string; panes: readonly Pane[]; workspaces: readonly Workspace[];
  focusedPane: string | null; excluded?: ReadonlySet<string>;
}): PersonalViewContext {
  const eligible = new Set(input.workspaces.filter(w => !w.hidden && workspaceHost(w) === input.routeHostId).map(w => w.id));
  const ids = [...new Set(input.panes.filter(p => p.kind === "chat" && !p.closed && !p.archived && !input.excluded?.has(p.id) && eligible.has(p.workspaceId)).map(p => p.id))];
  const focusedThreadId = input.focusedPane && ids.includes(input.focusedPane) ? input.focusedPane : undefined;
  const openThreadIds = (focusedThreadId ? [focusedThreadId, ...ids.filter(id => id !== focusedThreadId)] : ids).slice(0, 64);
  return { hostId: input.hostId, ...(focusedThreadId ? { focusedThreadId } : {}), openThreadIds };
}
