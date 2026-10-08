/** Photos and files attached in the composer. They are saved with the app
 *  and sent as paths, so every agent opens them with its own tools and
 *  later turns do not resend the bytes. */

export interface Attachment {
  id: string;
  name: string;
  /** Where the desktop app saved it. Missing while it is still saving. */
  path?: string;
  /** An object URL for the thumbnail, for images only. */
  preview?: string;
  error?: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v)$/i;

export const isImage = (name: string) => IMAGE.test(name);

export const isVideo = (name: string) => VIDEO.test(name);

const VIDEO_TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/** The type a video plays as, from its extension. */
export const videoType = (name: string) => VIDEO_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "video/mp4";

/** Saved folders come back with a trailing slash. */
export const isFolder = (path: string) => path.endsWith("/");

/** A plain ASCII file name; pasted screenshots arrive as "image.png". */
export function attachmentName(name: string, type = ""): string {
  const clean = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(-80);
  if (clean && clean.includes(".")) return clean;
  const ext = type.startsWith("image/") ? type.slice(6).replace("jpeg", "jpg").replace(/\W.*/, "") : "";
  return `${clean || (ext ? "image" : "file")}${ext ? `.${ext}` : ""}`;
}

/** The message with one "Attached image|file|folder: <path>" line each. */
export function withAttachments(message: string, paths: string[]): string {
  const lines = paths.map((p) => `Attached ${isFolder(p) ? "folder" : isImage(p) ? "image" : isVideo(p) ? "video" : "file"}: ${p}`);
  return [message, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** The paths of the pictures a message attached, in order. */
export function attachedImages(message: string): string[] {
  return [...message.matchAll(/^Attached image: (.+)$/gm)].map((m) => m[1].trim());
}

/** The paths of the videos a message attached, in order. */
export function attachedVideos(message: string): string[] {
  return [...message.matchAll(/^Attached video: (.+)$/gm)].map((m) => m[1].trim());
}

/** The local files a reply links to or attaches, once each, in order.
 *  Code is skipped, since paths there are examples rather than results. */
function replyFiles(message: string): string[] {
  const prose = message.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
  const links = [...prose.matchAll(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))\)/g)].map((m) => m[1] ?? m[2]);
  const decoded = links.map((link) => { try { return decodeURI(link); } catch { return link; } });
  const found = [...decoded, ...attachedImages(prose), ...attachedVideos(prose)].filter((p) => p.startsWith("/"));
  return [...new Set(found)];
}

/** The local pictures a reply links to or attaches, once each, in order. */
export function replyImages(message: string): string[] {
  return replyFiles(message).filter(isImage);
}

/** The local videos a reply links to or attaches, once each, in order. */
export function replyVideos(message: string): string[] {
  return replyFiles(message).filter(isVideo);
}
