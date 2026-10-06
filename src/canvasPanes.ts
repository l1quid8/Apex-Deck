import type { AppSection, Pane, Workspace } from "./types";
import { paneSection } from "./closing.ts";
export function canvasPanes(panes: Pane[], workspaces: Workspace[], deleting: ReadonlySet<string>, section: AppSection): Pane[] {
  const listed = new Set(workspaces.filter(w => !w.hidden).map(w => w.id));
  return panes.filter(p => listed.has(p.workspaceId) && !p.closed && !deleting.has(p.id) && paneSection(p) === section);
}
