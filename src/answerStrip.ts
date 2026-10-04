// What the attention list offers for a thread's open approval cards.
//
// Routine approvals can be answered from the list: a command, or a small
// edit whose whole diff fits. Anything else (a larger edit, an MCP tool
// call, a tool's own permission question, or a card whose content wasn't
// reported) needs the thread, where the card shows everything. "Always
// allow" is never offered in the list.

import { cardLabel, cardTitle, type OpenCard } from "./approvals.ts";
import { urgency, type Signal } from "./attention.ts";
import type { ProposedAction } from "./types";

/** Edits with more changed lines than this are answered in the thread. */
export const STRIP_EDIT_LINES = 20;

/** Lines added and removed in an edit's diff. File-name lines (+++ and ---) don't count. */
export function editCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** "+8 −2", as the list writes an edit's size. */
export function sizeText(diff: string): string {
  const { added, removed } = editCounts(diff);
  return `+${added} −${removed}`;
}

/** What an edit card changes, from its title: "Edit src/a.ts" gives "src/a.ts", "Edit 3 files" gives "3 files". */
function editTarget(title: string): string {
  return title.replace(/^\S+\s+/, "");
}

export type StripView =
  | { kind: "command"; label: string; command: string }
  | { kind: "edit"; label: string; summary: string; diff: string }
  | { kind: "open"; label: string };

/** How the list offers a card: answered in place, or only opened. */
export function stripView(action: ProposedAction): StripView {
  const label = cardLabel(action.kind);
  if (action.kind === "command") {
    const command = action.detail.trim();
    // Codex sends "(command not given)" when it doesn't say (codex_server.rs).
    if (command && !command.startsWith("(command not given)")) return { kind: "command", label, command };
  }
  if (action.kind === "edit") {
    const { added, removed } = editCounts(action.detail);
    const changed = added + removed;
    if (changed >= 1 && changed <= STRIP_EDIT_LINES) return { kind: "edit", label, summary: `+${added} −${removed} · ${editTarget(action.title)}`, diff: action.detail };
  }
  return { kind: "open", label };
}

/** The muted line under a strip naming the thread's next card, or null when it has no other. */
export function nextLine(cards: readonly OpenCard[]): string | null {
  const next = cards[1];
  if (!next) return null;
  const size = next.action.kind === "edit" ? ` · ${sizeText(next.action.detail)}` : "";
  return `Next in this thread: ${cardTitle(next.action)}${size}`;
}

/**
 * The list's rows: most urgent first, newest first within a kind. A row
 * answered from the list stays (in its place) until the list closes, even
 * once its flag has gone, so its strip can say "No approvals waiting".
 */
export function listRows<T extends { paneId: string; signal: Signal }>(items: readonly T[], answered: readonly T[]): T[] {
  const live = new Set(items.map((item) => item.paneId));
  return [...items, ...answered.filter((item) => !live.has(item.paneId))]
    .sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at);
}

/**
 * Where focus goes after a card in `answered`'s strip is answered: that
 * thread's next card, else the next thread below with cards (wrapping
 * round), else its own strip, which then reads "No approvals waiting".
 */
export function nextStripPane(rows: readonly { paneId: string; cards?: readonly OpenCard[] }[], answered: string): string {
  const at = rows.findIndex((row) => row.paneId === answered);
  const ordered = at < 0 ? rows : [...rows.slice(at), ...rows.slice(0, at)];
  return ordered.find((row) => (row.cards?.length ?? 0) > 0)?.paneId ?? answered;
}
