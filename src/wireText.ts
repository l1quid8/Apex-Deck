import { withAttachments } from "./attachments.ts";
import { withTldr } from "./tldr.ts";
export function composeWire(
  body: string,
  paths: string[],
  tldr: boolean,
): string {
  return withTldr(withAttachments(body, paths), tldr);
}
