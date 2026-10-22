import { createAppearance, legacyAppearance, type AgentAppearance } from "./identicon.ts";

/** The durable assistant owner. Display names and legacy labels are never identity. */
export type AssistantRef = { hostId: string; assistantId: string };

/** `cwd` has already been canonicalized by the project host, never by the client. */
export type ProjectRef = { hostId: string; workspaceId: string; cwd: string };

/** An assignment does not grant access to a machine or folder. */
export type AssistantProjectBinding = { project: ProjectRef; tools: "ask" | "full" | "off" };

/** A non-secret reference to normalized image bytes stored on the assistant host. */
export type AssistantAvatarAsset = {
  assetId: string;
  sha256: string;
  mime: "image/png";
  width: number;
  height: number;
};

export type AssistantLook = {
  color?: string;
  shape?: string;
  seed?: string;
  kind?: "pixel" | "image";
  image?: AssistantAvatarAsset;
};

export type AssistantAppearance = AssistantLook & AgentAppearance & { kind: "pixel" | "image" };

function field(ref: unknown, name: string): string {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    throw new TypeError("Identity must be an object");
  }
  const value = (ref as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid identity ${name}`);
  }
  return value;
}

/** JSON tuples avoid collisions when an identifier itself contains a separator. */
export function assistantIdentityKey(ref: AssistantRef): string {
  return JSON.stringify([field(ref, "hostId"), field(ref, "assistantId")]);
}

export function projectIdentityKey(ref: ProjectRef): string {
  const hostId = field(ref, "hostId");
  const workspaceId = field(ref, "workspaceId");
  const cwd = field(ref, "cwd");
  if (!cwd.startsWith("/")) throw new TypeError("Project cwd must be an absolute host-canonical path");
  return JSON.stringify([hostId, workspaceId, cwd]);
}

/** Call when creating an editor draft, then persist the result on explicit save. */
export function createAssistantAppearance(used: AgentAppearance[] = []): AssistantAppearance {
  return { ...createAppearance(used), kind: "pixel" };
}

/** Read without generating a new pattern. Includes the pixel fallback even when
 * an image is selected or unavailable, and all retained look fields for saves. */
export function assistantAppearance(ref: AssistantRef, look: AssistantLook = {}): AssistantAppearance {
  const fallback = legacyAppearance(assistantIdentityKey(ref));
  return {
    ...look,
    seed: look.seed ?? fallback.seed,
    color: look.color ?? fallback.color,
    kind: look.kind ?? "pixel",
  };
}
