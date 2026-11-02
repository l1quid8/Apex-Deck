/** Every copy button goes through here, so a refused clipboard fails the same way everywhere. */

export interface CopyRoutes {
  /** The desktop shell's own clipboard, which needs no page permission. */
  native?: (text: string) => Promise<unknown>;
  clipboard?: { writeText(text: string): Promise<void> };
  /** The old selection copy, for a page the Clipboard API refuses. */
  legacy?: (text: string) => boolean;
}

const liveRoutes = (): CopyRoutes => ({
  native: window.apexDeck?.clipboard?.writeText,
  clipboard: navigator.clipboard,
  legacy: selectionCopy,
});

function selectionCopy(text: string): boolean {
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(box);
  box.select();
  try { return document.execCommand("copy"); }
  catch { return false; }
  finally { box.remove(); }
}

/** True only when something took the text. Checks pass stubs; they never reach the real clipboard. */
export async function copyText(text: string, routes: CopyRoutes = liveRoutes()): Promise<boolean> {
  if (routes.native) {
    try { await routes.native(text); return true; }
    catch { /* falls through to the page's own routes */ }
  }
  if (routes.clipboard) {
    try { await routes.clipboard.writeText(text); return true; }
    catch { /* falls through */ }
  }
  return routes.legacy?.(text) ?? false;
}

/** copyText for code that takes a clipboard. It throws as a refused clipboard would. */
export const deckClipboard = {
  async writeText(text: string) {
    if (!await copyText(text)) throw new Error("Couldn't reach the clipboard.");
  },
};

/** A message as it reads on screen: no `>` quote markers. Code is left exactly as written. */
export function plainCopy(markdown: string): string {
  let fence = "", quoted = false;
  return markdown.split("\n").map((line) => {
    const unquoted = line.replace(/^ {0,3}(?:> ?)+/, "");
    if (fence && !quoted) { if (unquoted === line && closes(line, fence)) fence = ""; return line; }
    if (fence) { const code = line.replace(/^ {0,3}> ?/, ""); if (closes(code, fence)) fence = ""; return code; }
    const open = /^\s*(`{3,}|~{3,})/.exec(unquoted)?.[1];
    if (open) { fence = open; quoted = unquoted !== line; }
    return unquoted;
  }).join("\n");
}
const closes = (line: string, fence: string) => line.trim().startsWith(fence);
