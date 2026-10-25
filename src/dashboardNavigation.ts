import { addLeaf, leafIds, moveLeaf, type LayoutNode } from "./layout.ts";

/** Reuse a session's leaf; selected destinations trade positions, never identities. */
export function placeDashboardPane(tree: LayoutNode | null, id: string, targetId?: string): LayoutNode {
  const ids = leafIds(tree);
  if (targetId && !ids.includes(targetId)) throw new Error("That pane is no longer available.");
  const opened = tree && ids.includes(id) ? tree : addLeaf(tree, id);
  return targetId ? moveLeaf(opened, id, targetId, "center") : opened;
}
