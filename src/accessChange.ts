import type { Access } from "./types";

const RANK: Record<Access, number> = { read: 0, ask: 1, edits: 2, full: 3 };

/** Lowering access is usually urgent, so Apply now leads; raising can wait for the reply. */
export function applyNowFirst(from: Access, to: Access): boolean {
  return RANK[to] < RANK[from];
}

/** The Access choices a bot can take, least first. Grok and Muse have no Ask mode. */
export function accessOptions(tool: string | null): { value: Access; text: string; title: string }[] {
  return [
    { value: "read", text: "Read-only", title: "Read files. No edits or commands." },
    ...(tool === "grok" || tool === "muse" ? [] : [{ value: "ask" as const, text: "Ask", title: "Ask before edits and commands." }]),
    { value: "edits", text: "Edit", title: "Edit files; ask before commands where supported." },
    { value: "full", text: "Full", title: "Full access." },
  ];
}
