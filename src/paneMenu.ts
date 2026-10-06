// The ⋯ menus: a pane's (on its head and its sidebar row) and a project's.
// Which items they have, in what order, and when each one is turned off.
// App and the sidebar draw them and run the chosen action.

import type { PaneKind } from "./types";
import { threadKeys } from "./shortcuts.ts";

export type PaneMenuAction = "rename" | "pin" | "mark_unread" | "share_pdf" | "copy" | "start" | "copy_path" | "copy_address" | "close" | "fork" | "export" | "archive" | "delete";

export interface PaneMenuItem {
  action: PaneMenuAction;
  label: string;
  disabled: boolean;
  /** Why it is turned off, for its tooltip. "" when it isn't. */
  reason: string;
  /** Drawn in danger text: it removes something. */
  danger: boolean;
  /** A separator line comes before it. */
  separated: boolean;
  /** Its shortcut as printed, such as "⌥⌘R". */
  keys?: string;
  /** It opens a submenu (Copy ›) instead of acting. */
  submenu?: boolean;
}

/** What the menu needs to know about a terminal. Threads need none of it. */
export interface TerminalMenuState {
  running: boolean;
  installed: boolean;
  /** The tool's name, such as "Codex", for "Codex isn't installed". */
  tool: string;
  /** The workspace folder; "" when it has none, as in the browser preview. */
  folder: string;
}

const item = (action: PaneMenuAction, label: string, extra: Partial<PaneMenuItem> = {}): PaneMenuItem => ({
  action, label, disabled: false, reason: "", danger: false, separated: false, ...extra,
});

export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState, preview: { address: string } = { address: "" }, options: { pinned?: boolean; unread?: boolean; mac?: boolean } = {}): PaneMenuItem[] {
  if (kind === "chat") {
    // Codex's thread menu and shortcuts, with Deck's Share as PDF, Fork, Export and Delete.
    const keys = threadKeys(options.mac ?? false);
    return [
      item("rename", "Rename", { keys: keys.rename }),
      item("pin", options.pinned ? "Unpin" : "Pin", { keys: keys.pin }),
      item("mark_unread", options.unread ? "Mark as read" : "Mark as unread", { keys: keys.mark_unread }),
      item("share_pdf", "Share as PDF", { separated: true }),
      item("copy", "Copy", { submenu: true }),
      item("fork", "Fork"),
      item("export", "Export"),
      item("archive", "Archive", { separated: true, keys: keys.archive }),
      item("delete", "Delete…", { danger: true }),
    ];
  }
  const pin = item("pin", options.pinned ? "Unpin" : "Pin to top");
  if (kind === "preview") {
    return [
      item("rename", "Rename"),
      pin,
      item("copy_address", "Copy address", { disabled: !preview.address, reason: preview.address ? "" : "No page yet." }),
      item("close", "Close", { separated: true }),
    ];
  }
  const startReason = terminal.running ? "It's still running." : terminal.installed ? "" : `${terminal.tool} isn't installed.`;
  return [
    item("rename", "Rename"),
    pin,
    item("start", "Start again", { disabled: startReason !== "", reason: startReason }),
    item("copy_path", "Copy folder path", { disabled: !terminal.folder, reason: terminal.folder ? "" : "This workspace has no folder." }),
    item("close", "Close", { separated: true }),
  ];
}

/** What Copy › can put on the clipboard. */
export type CopyKind = "markdown" | "reply" | "path" | "id";

export interface CopyItem {
  kind: CopyKind;
  label: string;
  /** Shown muted at the right: what will be copied, when it is short. */
  side: string;
  disabled: boolean;
  reason: string;
}

/** Copy ›. `path` is the folder as it will be copied, with its server's SSH destination for a server. */
export function copyMenuItems({ hasReply, path, id }: { hasReply: boolean; path: string; id: string }): CopyItem[] {
  return [
    { kind: "markdown", label: "Copy as Markdown", side: "", disabled: false, reason: "" },
    { kind: "reply", label: "Copy last reply", side: "", disabled: !hasReply, reason: hasReply ? "" : "No reply yet." },
    { kind: "path", label: "Copy folder path", side: path, disabled: !path, reason: path ? "" : "This project has no folder." },
    { kind: "id", label: "Copy thread ID", side: id, disabled: false, reason: "" },
  ];
}

export type ProjectMenuAction = "pin" | "edit" | "connection" | "reveal" | "archive" | "remove";

export interface ProjectMenuItem {
  action: ProjectMenuAction;
  label: string;
  disabled: boolean;
  reason: string;
  danger: boolean;
  separated: boolean;
}

/** A project's ⋯ menu. A server's connection is fixed from its project, not from Settings. */
export function projectMenuItems(project: { pinned?: boolean; remote: boolean; path: string; threads: number }): ProjectMenuItem[] {
  const row = (action: ProjectMenuAction, label: string, extra: Partial<ProjectMenuItem> = {}): ProjectMenuItem =>
    ({ action, label, disabled: false, reason: "", danger: false, separated: false, ...extra });
  return [
    row("pin", project.pinned ? "Unpin" : "Pin"),
    row("edit", "Edit…"),
    project.remote
      ? row("connection", "Edit connection…", { separated: true })
      : row("reveal", "Reveal in Finder", { separated: true, disabled: !project.path, reason: project.path ? "" : "This project has no folder." }),
    row("archive", "Archive threads", { separated: true, disabled: project.threads === 0, reason: project.threads ? "" : "No threads to archive." }),
    row("remove", "Remove project…", { separated: true, danger: true }),
  ];
}
