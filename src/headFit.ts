export type HeadPartId = "dot" | "project" | "title" | "host" | "status" | "server" | "counts" | "maximize" | "menu" | "close";

/** Parts arrive with the title at its minimum width, after its text has shrunk. */
export function headFit(width: number, parts: { id: HeadPartId; width: number }[]): Set<HeadPartId> {
  const hidden = new Set<HeadPartId>();
  const available = Number.isFinite(width) ? Math.max(0, width) : 0;
  const used = () => {
    const visible = parts.filter(part => !hidden.has(part.id));
    return 16 + visible.reduce((sum, part) => sum + Math.max(0, part.width), 0) + Math.max(0, visible.length - 1) * 4;
  };
  for (const id of ["status", "server", "host", "counts", "project", "maximize", "menu"] as const) {
    if (used() <= available) break;
    if (parts.some(part => part.id === id)) hidden.add(id);
  }
  return hidden;
}
