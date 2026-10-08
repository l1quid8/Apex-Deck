// Fork from one message on the phone: how much history it keeps, the new thread's pane, and a short preview of a message.

import type { Pane } from "../types";

/** A fork from message `seq` keeps that message and everything before it, so it ends just after it. */
export function forkUpto(seq: number): number {
  return seq + 1;
}

/** The pane for a thread forked from message `seq` of `source`: same project, its own title, and where it came from. */
export function forkedPane(source: Pane, id: string, seq: number, hostName: string): Pane {
  return {
    id,
    workspaceId: source.workspaceId,
    kind: "chat",
    title: `${source.title} (fork)`,
    fork: { from: source.id, title: source.title, host: hostName, at: forkUpto(seq) },
  };
}

/** A message as one line, cut to `max` characters (ellipsis included) when it runs longer. */
export function messagePreview(text: string, max = 80): string {
  const line = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...line];
  if (chars.length <= max) return line;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}
