/** The @handle the room will match: lower-case letters, digits, dash, underscore, dot. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/\.+$/, "");
}
