import type { Access } from "./types";

const RANK: Record<Access, number> = { read: 0, ask: 1, edits: 2, full: 3 };

/** Lowering access is usually urgent, so Apply now leads; raising can wait for the reply. */
export function applyNowFirst(from: Access, to: Access): boolean {
  return RANK[to] < RANK[from];
}
