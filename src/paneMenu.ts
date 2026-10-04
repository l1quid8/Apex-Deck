// The ⋯ menu on a pane head: which items it has, in what order, and when
// each one is turned off. App draws it and runs the chosen action.

import type { PaneKind } from "./types";

export type PaneMenuAction = "rename" | "start" | "copy_path" | "copy_address" | "close" | "fork" | "export" | "delete";

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

export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState, preview: { address: string } = { address: "" }): PaneMenuItem[] {
  if (kind === "chat") {
    return [item("rename", "Rename"), item("fork", "Fork"), item("export", "Export"), item("delete", "Delete thread…", { danger: true, separated: true })];
  }
  if (kind === "preview") {
    return [
      item("rename", "Rename"),
      item("copy_address", "Copy address", { disabled: !preview.address, reason: preview.address ? "" : "No page yet." }),
      item("close", "Close", { separated: true }),
    ];
  }
  const startReason = terminal.running ? "It's still running." : terminal.installed ? "" : `${terminal.tool} isn't installed.`;
  return [
    item("rename", "Rename"),
    item("start", "Start again", { disabled: startReason !== "", reason: startReason }),
    item("copy_path", "Copy folder path", { disabled: !terminal.folder, reason: terminal.folder ? "" : "This workspace has no folder." }),
    item("close", "Close", { separated: true }),
  ];
}
