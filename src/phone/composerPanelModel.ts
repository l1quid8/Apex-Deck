export type PanelDetent = "compact" | "expanded";

/** Resolve a picker result to the captured draft, following a send-time migration. */
export function attachmentTarget(capturedId: string, moved: Readonly<Record<string, string>>): string {
  let target = capturedId;
  const seen = new Set<string>();
  while (moved[target] && !seen.has(target)) {
    seen.add(target);
    target = moved[target];
  }
  return target;
}

/** A clipboard item may offer several encodings of the same attachment. */
export async function readClipboardFiles(): Promise<File[]> {
  const items = await navigator.clipboard.read();
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find(type => type.startsWith("image/"))
      ?? item.types.find(type => !type.startsWith("text/"));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type.split("/")[1]?.split("+")[0]?.replace(/[^a-z0-9-]/gi, "") || "bin";
    files.push(blob instanceof File ? blob : new File([blob], `Pasted-${files.length + 1}.${extension}`, { type }));
  }
  if (!files.length) throw new Error("No attachment found on the clipboard. Choose Files to attach a document.");
  return files;
}

export async function readCapturedFiles<T>(options: {
  capturedId: string | null;
  moved: Readonly<Record<string, string>>;
  files: File[] | (() => Promise<File[]>);
  makeAttachment(file: File): Promise<T>;
  onStart(): void;
  onAdd(targetId: string, files: T[]): void;
  onError(error: unknown): void;
  onFinish(): void;
}): Promise<void> {
  if (!options.capturedId || (Array.isArray(options.files) && options.files.length === 0)) return;
  options.onStart();
  try {
    const files = typeof options.files === "function" ? await options.files() : options.files;
    const attachments = await Promise.all(files.map(options.makeAttachment));
    options.onAdd(attachmentTarget(options.capturedId, options.moved), attachments);
  } catch (error) {
    options.onError(error);
  } finally {
    options.onFinish();
  }
}

/** Run draft migration only after the host has acknowledged its Plan setting. */
export async function withPlanAcknowledgement<T>(change: () => Promise<unknown>, continueAfterAck: () => Promise<T>): Promise<T> {
  await change();
  return continueAfterAck();
}

/** Apply this attempt's desired value to the exact room before continuing. */
export function setPlanBeforeContinuation<T>(roomId: string, enabled: boolean, setPlan: (roomId: string, enabled: boolean) => Promise<unknown>, continueAfterAck: () => Promise<T>): Promise<T> {
  return withPlanAcknowledgement(() => setPlan(roomId, enabled), continueAfterAck);
}

export function composerPlanDisabledReason(state: { pendingDraft: boolean; sending: boolean; online: boolean; readOnly: boolean; offlineReason: string }): string | null {
  if (state.sending) return "Wait for sending to finish.";
  if (!state.pendingDraft && !state.online) return state.offlineReason;
  if (!state.pendingDraft && state.readOnly) return "Plan mode needs chat access on this machine.";
  return null;
}

export function panelDrag(detent: PanelDetent, deltaY: number): PanelDetent | "dismiss" {
  if (deltaY <= -64) return "expanded";
  if (deltaY >= 64) return detent === "expanded" ? "compact" : "dismiss";
  return detent;
}
