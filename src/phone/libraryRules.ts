import type { LibraryItem } from "../backend";
import type { RemoteAccess } from "../phoneRules";

/** A picture's caption: the bot and the date, plus the time when asked. A missing bot name reads "A bot". */
export function libraryCaption(item: LibraryItem, withTime: boolean): string {
  const who = item.by?.trim() || "A bot";
  const when = new Date(item.created);
  return `${who} · ${withTime ? when.toLocaleString() : when.toLocaleDateString()}`;
}

/** The line shown when the Library can't load. Access problems get a plain fix; anything else shows the message. */
export function libraryErrorLine(error: unknown, machine: string): string {
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "").trim();
  if (/full access|not allowed|\btier\b|refused/i.test(message)) {
    return `The Library needs Full access to all threads on ${machine}. Change this phone's access in ${machine}'s Settings → Paired devices.`;
  }
  return `Couldn't load the Library from ${machine}: ${message}`;
}

/** Grid columns for the picture tiles: three on a wide screen, two otherwise. */
export function gridColumns(width: number): number {
  return width >= 600 ? 3 : 2;
}

/**
 * The biggest picture the phone asks for. The link to the phone carries at most
 * 8 MiB in one message and a picture travels as base64, a third bigger, so a
 * larger one would end the connection instead of showing.
 */
export const PHONE_PICTURE_MAX = 6_000_000;

/** Whether a picture fits through the phone's link. An older Mac doesn't send the size; those aren't risked. */
export function fitsOnPhone(item: LibraryItem): boolean {
  return item.bytes !== undefined && item.bytes <= PHONE_PICTURE_MAX;
}

/** Why a picture isn't shown on the phone, or null when it is. */
export function notShownReason(item: LibraryItem, machine = "the Mac"): string | null {
  if (item.bytes === undefined) return `Update Deck on ${machine} to show this here`;
  return fitsOnPhone(item) ? null : "Too big for the phone";
}

/** The Mac only lists the Library for Full access to all threads. A WebSocket pair has no access and keeps it. */
export function canSeeLibrary(access: RemoteAccess | null | undefined): boolean {
  return !access || (access.tier === "full" && access.threads === "all");
}
