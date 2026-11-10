import { useEffect, useRef, useState } from "react";
import type { ItemState } from "./turnQueue.ts";
export interface QueueRef {
  queue: string;
  id: number;
}
export interface PendingFile {
  id: string;
  label: string;
  name: string;
  bytes: Uint8Array | null;
  previewUrl: string | null;
}
export interface SlicePayload {
  text: string;
  routing: string;
  files: PendingFile[];
  to: string[] | null;
  tldr: boolean;
}
export interface ThreadSendApi {
  paneId: string;
  hostId: string;
  queue: string;
  canPickAgent: boolean;
  agents(): { id: string; handle: string; name: string }[];
  defaultTargets(): Promise<string[]>;
  submit(p: SlicePayload): QueueRef;
  command(name: "compact" | "curate" | "curate_undo"): QueueRef;
  status(ref: QueueRef): ItemState;
  watch(
    ref: QueueRef,
    cb: (state: ItemState, error?: unknown) => void,
  ): () => void;
  retry(ref: QueueRef): "retried" | "gone";
  remove(ref: QueueRef): void;
  giveUp(ref: QueueRef): void;
  unsent(): number;
  suspend(reason: string): () => void;
  draft(): { text: string; tldr: boolean; attachments: number; quotes: number };
  clearDraft(): void;
}
export function ownerRefusal(
  op: "pop out" | "move",
  title: string,
  now: { outside: boolean; moving: boolean },
): string | null {
  if (op === "move" && now.outside)
    return `Close ${title}'s external pane to return it to Deck first.`;
  if (op === "pop out" && now.moving)
    return `Wait until ${title} has moved, then open it in a new window.`;
  return null;
}
export function leaveRefusal(
  api: ThreadSendApi | undefined,
  title: string,
  then: "pop it out" | "move it",
): string | null {
  return api && api.unsent() > 0
    ? `Wait until ${title} has sent what's waiting, or remove it, then ${then}.`
    : null;
}
/** Stable registry; hidden ownership is read at every lookup and reconciled after render. */
export function useSendApis(hidden: (paneId: string) => boolean) {
  const current = useRef(hidden);
  current.current = hidden;
  const [registry] = useState(() => {
    const values = new Map<string, ThreadSendApi>();
    const listeners = new Set<() => void>();
    const visibility = new Map<string, boolean>();
    const publish = () => listeners.forEach((cb) => cb());
    return {
      register(paneId: string, api: ThreadSendApi | null) {
        if (api) {
          if (values.get(paneId) === api) return;
          values.set(paneId, api);
          visibility.set(paneId, current.current(paneId));
        } else {
          if (!values.delete(paneId)) return;
          visibility.delete(paneId);
        }
        publish();
      },
      get(paneId: string) {
        return current.current(paneId) ? undefined : values.get(paneId);
      },
      subscribe(cb: () => void) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      refresh() {
        let changed = false;
        for (const id of values.keys()) {
          const next = current.current(id);
          if (visibility.get(id) !== next) {
            visibility.set(id, next);
            changed = true;
          }
        }
        if (changed) publish();
      },
    };
  });
  useEffect(() => registry.refresh());
  return registry;
}
