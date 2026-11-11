// The phone's Worktrees pane: what each row says, and who may open the pane. The Mac's Worktrees tab
// (RightWorktrees.tsx) does the same jobs with the same commands; this file only words them for a phone.
import type { RemoteAccess } from "../phoneRules";
import type { Worktree } from "../types";

/** The Mac lists worktrees only for Full access to every thread (authority.rs), so other phones get no pane. */
export function canManageWorktrees(access: RemoteAccess | null | undefined): boolean {
  return !access || (access.tier === "full" && access.threads === "all");
}

/** A path as the phone shows it: the home folder as ~, and long paths cut from the left. */
export function shortPath(path: string, max = 46): string {
  const home = path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  return home.length > max ? `…${home.slice(-(max - 1))}` : home;
}

/** A worktree's folder by its last two names, "…/apex-deck-worktrees/feat-x": the rest is the project's. */
export function tailPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : shortPath(path);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export type WorktreeDot = "busy" | "on" | "wait" | "off" | "";
export interface WorktreeRowView {
  dot: WorktreeDot; name: string; tag: string | null;
  /** The tag is about this thread, so it shows in mint. */
  here: boolean; line: string; warn: string | null;
}

const COPY_STATE: Record<NonNullable<Worktree["copy"]>["state"], string> = {
  working: "Working", folding: "Folding back", reconciling: "Fixing a clash", needs_you: "Needs you", folded: "Folded",
};

/** One row of the pane. `thread` is the open thread's id; `mounted` the folder its agents work in. */
export function worktreeRow(item: Worktree, thread: string, mounted: string): WorktreeRowView {
  const copy = item.copy;
  if (copy) {
    const here = copy.thread === thread;
    const files = item.changes == null ? "… changed files" : plural(item.changes, "changed file");
    const words = [here ? null : copy.threadTitle || copy.thread, COPY_STATE[copy.state], files].filter(Boolean).join(" · ");
    return {
      dot: copy.state === "needs_you" ? "wait" : copy.state === "working" || copy.state === "reconciling" ? "busy" : "on",
      name: `${copy.bot}’s copy`, tag: here ? "This thread" : null, here, line: words,
      warn: copy.state === "needs_you" ? copy.reason || null : null,
    };
  }
  const isMounted = samePath(item.path, mounted);
  const name = item.branch ?? (item.head ? `detached · ${item.head.slice(0, 8)}` : "detached");
  const tag = isMounted ? "Mounted here" : item.prunable ? "Missing" : item.task ? "Assistant task" : item.locked ? "Locked"
    : item.changes ? plural(item.changes, "change") : null;
  return {
    dot: item.prunable ? "off" : item.main || isMounted ? "on" : "",
    name, tag, here: isMounted,
    line: item.prunable ? "Its folder is gone" : item.main ? `Main · ${shortPath(item.path)}` : tailPath(item.path),
    warn: null,
  };
}

export function samePath(a: string, b: string): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  return a !== "" && trim(a) === trim(b);
}

/** What the row's sheet offers. The Mac's ⋯ menu, without Open folder: Finder is on the Mac, not here. */
export function worktreeActions(item: Worktree, mounted: string) {
  const isMounted = samePath(item.path, mounted);
  const own = !item.main && !item.task && !item.copy;
  return {
    mount: !item.prunable && !item.task && !item.copy,
    mounted: isMounted,
    discard: item.copy?.state === "needs_you",
    prune: own && !item.locked && !isMounted,
    remove: own && !item.prunable && !item.locked && !isMounted,
  };
}

/** Where a new worktree goes unless the person changes it: <project>-worktrees/<branch>, beside the project. */
export function newWorktreeFolder(root: string, branch: string): string {
  const clean = root.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  const cut = clean.lastIndexOf("/");
  return `${clean.slice(0, cut)}/${clean.slice(cut + 1)}-worktrees/${branch.trim().replaceAll("/", "-")}`;
}

/** The project's checked-out branch, for New worktree's "Start from"; HEAD when it can't tell. */
export function startFrom(items: Worktree[]): string {
  return items.find((item) => item.main)?.branch ?? "HEAD";
}

/** The Mac said the folder has changes nobody committed and wants a second, forced, ask. */
export function hasChanges(reason: unknown): boolean {
  return String((reason as Error)?.message ?? reason).startsWith("has-changes:");
}

/** How many replies came in below where you're reading, for the ↓ button: bot messages after `seen`. */
export function newBelow(messages: { seq: number; speaker: { kind: string } }[], seen: number | null): number {
  if (seen === null) return 0;
  return messages.filter((message) => message.seq > seen && message.speaker.kind === "bot").length;
}
