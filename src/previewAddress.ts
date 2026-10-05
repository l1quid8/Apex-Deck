// Addresses for the Preview pane: what you type in its address field, and the
// local servers a terminal says it started. See the spec, section 1.

/** Terminal escape sequences: colours, titles and the like. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Whether a host is this computer. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK.has(name) || name.endsWith(".localhost");
}

/**
 * The address to load for what was typed, or null when it isn't a web
 * address. "3000" and "localhost:3000" are local servers over http; other
 * bare names get https. Only http and https load, so javascript:, file: and
 * data: never do.
 */
export function normalizeAddress(input: string): string | null {
  let text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^\d{2,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.startsWith("[") ? text.slice(0, text.indexOf("]") + 1) : text.split(/[/:?#]/)[0];
    const local = isLocalHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    text = `${local ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  // Backticks encoded onto the end are a code span's closing mark that an
  // older build kept, quoted back into the chat; no page ends in them.
  return url.href.replace(/(?:%60)+$/i, "");
}

/** Whether two addresses are pages on the same server: same scheme, host and port. */
export function sameServer(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** "localhost:5173" or "github.com"; "" for something that isn't an address. */
export function hostLabel(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return "";
  }
}

const SERVER = /(?<![a-z0-9])https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/giu;

/** Local server addresses in text already stripped of escapes, with where each ends. */
function matches(plain: string): { address: string; end: number }[] {
  const found: { address: string; end: number }[] = [];
  for (const match of plain.matchAll(SERVER)) {
    // Sentence punctuation and markdown emphasis (**, _, ~~) at the end are not part of it.
    const address = normalizeAddress(match[0].replace(/[.,;:!*_~]+$/, ""));
    if (address) found.push({ address, end: (match.index ?? 0) + match[0].length });
  }
  return found;
}

/** Local server addresses in terminal output, once each, in order. LAN and internet addresses are left out. */
export function findServerUrls(output: string): string[] {
  const found: string[] = [];
  for (const { address } of matches(output.replace(ESCAPES, ""))) if (!found.includes(address)) found.push(address);
  return found;
}

/**
 * Watches one run of a terminal's output for local server addresses. Output
 * arrives in chunks that can cut an address in two, so the end of each chunk
 * is kept, and an address that runs to the very end of what has arrived waits
 * for the next chunk.
 */
export class ServerWatch {
  private tail = "";
  private seen = new Set<string>();

  /** Addresses that appeared for the first time with this chunk. */
  feed(chunk: string): string[] {
    const text = this.tail + chunk;
    this.tail = text.slice(-256);
    const plain = text.replace(ESCAPES, "");
    const fresh: string[] = [];
    for (const { address, end } of matches(plain)) {
      if (end >= plain.length || this.seen.has(address)) continue;
      this.seen.add(address);
      fresh.push(address);
    }
    return fresh;
  }

  /** Forget everything, for a new run of the program. */
  reset(): void {
    this.tail = "";
    this.seen.clear();
  }
}
