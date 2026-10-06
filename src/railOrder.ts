/** Rail order only: pinned rows stay at the top, and everything else keeps its order. */
export function pinnedFirst<T extends { pinned?: boolean }>(panes: T[]): T[] {
  return [...panes.filter((pane) => pane.pinned === true), ...panes.filter((pane) => pane.pinned !== true)];
}
