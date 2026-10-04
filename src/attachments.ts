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

export const isImage = (name: string) => IMAGE.test(name);

/** A plain ASCII file name; pasted screenshots arrive as "image.png". */
export function attachmentName(name: string, type = ""): string {
  const clean = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(-80);
  if (clean && clean.includes(".")) return clean;
  const ext = type.startsWith("image/") ? type.slice(6).replace("jpeg", "jpg").replace(/\W.*/, "") : "";
  return `${clean || (ext ? "image" : "file")}${ext ? `.${ext}` : ""}`;
}

/** The message with one "Attached image: <path>" line per file. */
export function withAttachments(message: string, paths: string[]): string {
  const lines = paths.map((p) => `Attached ${isImage(p) ? "image" : "file"}: ${p}`);
  return [message, lines.join("\n")].filter(Boolean).join("\n\n");
}
