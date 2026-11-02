import type { Access, ParticipantConfig } from "./types";

const RANK: Record<Access, number> = { read: 0, ask: 1, edits: 2, full: 3 };

/** Lowering access is usually urgent, so Apply now leads; raising can wait for the reply. */
export function applyNowFirst(from: Access, to: Access): boolean {
  return RANK[to] < RANK[from];
}

/** Antigravity has no read-only mode, so restarting it would promise a limit it doesn't keep. */
export function canApplyAccessNow(config: ParticipantConfig): boolean {
  return !(config.backend.kind === "agent" && config.backend.tool === "gemini");
}
