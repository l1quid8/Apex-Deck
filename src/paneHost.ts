import type { Pane, Workspace } from "./types";
import { workspaceHost } from "./hostSession.ts";

export function paneDestination(pane: Pick<Pane, "workspaceId">, workspaces: readonly Workspace[]): { workspace: Workspace; hostId: string } {
  const workspace = workspaces.find(w => w.id === pane.workspaceId);
  if (!workspace) throw new Error("This thread's workspace is unavailable.");
  return { workspace, hostId: workspaceHost(workspace) };
}
