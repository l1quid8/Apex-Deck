// What Copy › puts on the clipboard, and the write that admits failure.

import type { Message } from "./types";
import type { CopyKind } from "./paneMenu.ts";

/** How a toast names each kind of copy. */
export const COPIED: Record<CopyKind, string> = {
  markdown: "the thread as Markdown",
  reply: "the last reply",
  path: "the folder path",
  id: "the thread ID",
};

/** The newest bot message's text; "" when no bot has replied. */
export function lastReply(transcript: Message[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) if (transcript[i].speaker.kind === "bot") return transcript[i].text;
  return "";
}

/** A server folder as `destination:path`, the way scp and rsync write it; a Mac folder as it is. */
export function folderCopyText(path: string, ssh?: string): string {
  return path && ssh ? `${ssh}:${path}` : path;
}

/** True only when the clipboard took the text. Checks pass a stub; nothing here reaches for the real one. */
export async function writeClipboard(text: string, clipboard?: { writeText(text: string): Promise<void> }): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
