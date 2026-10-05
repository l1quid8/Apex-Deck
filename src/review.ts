// Ask for review: the thread's change as a patch file for one of its bots.
// These are plain functions so the menu, the file names and the composer
// stay in step and can be tested on their own.

import type { AgentTool, DiffFile, ParticipantBackend, ParticipantConfig } from "./types";

/** Over this many lines, one file per patch is offered instead of one big file. */
export const LARGE_REVIEW_LINES = 2000;

/** "6 files · +73 −16" for what Changes lists. */
export function filesLine(files: DiffFile[]): string {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${files.length === 1 ? "1 file" : `${files.length} files`} · +${added} −${removed}`;
}

/** The menu's first line: "Since this thread started · 6 files · +73 −16". */
export function reviewScope(files: DiffFile[]): string {
  return `Since this thread started · ${filesLine(files)}`;
}

/** The patches Changes shows, in its order, each ending in a newline. Files
 *  Changes lists without a patch (only the models' reported edit is known)
 *  are left out. */
export function reviewPatches(files: DiffFile[]): string[] {
  return files.filter((f) => f.patch.trim() !== "").map((f) => (f.patch.endsWith("\n") ? f.patch : `${f.patch}\n`));
}

/** Every patch joined into one file, or null when there is no patch to send. */
export function reviewPatch(files: DiffFile[]): string | null {
  const patches = reviewPatches(files);
  return patches.length > 0 ? patches.join("") : null;
}

/** How many lines a patch has. */
export function patchLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Whether a patch this long gets the "One file per patch" choice. */
export function offersSplit(lines: number): boolean {
  return lines > LARGE_REVIEW_LINES;
}

/** "3,412 lines in one file", shown when one file would be over the limit. */
export function sizeLine(lines: number): string {
  return `${lines.toLocaleString("en-US")} lines in one file`;
}

/** One more than the highest review number in `texts`: the thread's sent
 *  messages and the files already attached to the composer. */
export function nextReviewNumber(texts: string[]): number {
  let highest = 0;
  for (const text of texts) {
    for (const match of text.matchAll(/review-since-start-(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** "review-since-start-3.patch", or with one file per patch
 *  "review-since-start-3-1.patch", "review-since-start-3-2.patch", … */
export function reviewFileNames(n: number, count: number): string[] {
  if (count <= 1) return [`review-since-start-${n}.patch`];
  return Array.from({ length: count }, (_, i) => `review-since-start-${n}-${i + 1}.patch`);
}

/** The composer after picking a reviewer. The request leads, so its mention
 *  picks who answers; a draft you already typed stays below it. */
export function reviewDraft(handle: string, draft: string): string {
  const ask = `@${handle} Review this change.`;
  return draft.trim() ? `${ask}\n\n${draft}` : ask;
}

const TOOL_NAMES: Record<AgentTool, string> = { claude_code: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok" };

/** The tool a bot runs on, as the menu names it. */
export function toolName(backend: ParticipantBackend): string {
  if (backend.kind === "agent") return TOOL_NAMES[backend.tool];
  if (backend.kind === "open_ai_compatible") return "API";
  if (backend.kind === "cli") return "Command";
  return "Scripted";
}

/**
 * Whether a bot can open a file in Deck's attachments folder. Claude Code,
 * Gemini CLI and Grok are given the folder (`--add-dir`,
 * `--include-directories`, `--allow Read(...)`);
 * Codex's sandbox reads files anywhere, even at read only (checked with
 * `codex sandbox`); a custom command runs as you with no sandbox. API models
 * only see the conversation's text, and scripted bots read nothing.
 */
export function canReadAttachments(backend: ParticipantBackend): boolean {
  return backend.kind === "agent" || backend.kind === "cli";
}

/** One row of the Ask for review menu. */
export interface Reviewer {
  id: string;
  name: string;
  /** "Gemini CLI · Read only", or just "Claude Code" for a bot that can edit. */
  label: string;
  /** Muted words at the row's end, e.g. "Can edit files". Empty when there is nothing to say. */
  note: string;
}

/** The thread's bots for the Ask for review menu: read-only bots first, then the rest, each in room order. */
export function reviewerRows(participants: ParticipantConfig[]): Reviewer[] {
  const rows = participants.map((p) => {
    const canEdit = p.access !== "read";
    const tool = toolName(p.backend);
    const note = [canReadAttachments(p.backend) ? "" : "Can't read attachments", canEdit ? "Can edit files" : ""].filter(Boolean).join(" · ");
    return { canEdit, row: { id: p.id, name: p.display_name, label: canEdit ? tool : `${tool} · Read only`, note } };
  });
  return [...rows.filter((r) => !r.canEdit), ...rows.filter((r) => r.canEdit)].map((r) => r.row);
}
