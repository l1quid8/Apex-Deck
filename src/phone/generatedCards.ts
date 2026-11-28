import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { GeneratedCard } from "../../shared/generatedCard.mjs";

type Rect = { x: number; y: number; width: number; height: number };
export type CardGeometry = { bounds: Rect; clip: Rect; viewport: Rect; scrollTop: number };
type CardEvent = { runId: string; type: "ready" | "resize" | "discuss" | "fault" | "suspended" | "resumed" | "scroll"; deltaY?: number; height?: number; text?: string };
interface NativeCards {
  capability(): Promise<{ enabled: boolean }>;
  mount(request: CardGeometry & { runId: string; hostId: string; threadId: string; messageId: string; card: GeneratedCard }): Promise<void>;
  layout(request: CardGeometry & { runId: string }): Promise<void>;
  dispose(request: { runId: string }): Promise<void>;
  addListener(name: "cardEvent", receive: (event: CardEvent) => void): Promise<PluginListenerHandle>;
}

export const nativeCards = Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("ApexGeneratedCards")
  ? registerPlugin<NativeCards>("ApexGeneratedCards") : null;

/** The native view keeps its full layout while UIKit clips it to the chat scrollport. */
export function cardGeometry(slot: HTMLElement): CardGeometry | null {
  const chat = slot.closest(".ph-chat");
  if (!chat || !slot.isConnected || document.visibilityState !== "visible" || slot.closest("[inert], [hidden]")
      || (window.visualViewport?.scale ?? 1) !== 1) return null;
  const rect = slot.getBoundingClientRect();
  const viewport = chat.getBoundingClientRect();
  const x = Math.ceil(Math.max(0, rect.left, viewport.left));
  const y = Math.ceil(Math.max(0, rect.top, viewport.top));
  const right = Math.floor(Math.min(innerWidth, rect.right, viewport.right));
  const bottom = Math.floor(Math.min(innerHeight, rect.bottom, viewport.bottom));
  if (right - x < 2 || bottom - y < 2) return null;
  // Native siblings paint above all DOM. Withdraw them for any modal or floating menu.
  for (const overlay of document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], .ph-sheet-back, .modal-backdrop')) {
    if (overlay.getClientRects().length && getComputedStyle(overlay).visibility !== "hidden") return null;
  }
  for (const [cx, cy] of [[x, y], [right - 1, y], [x, bottom - 1], [right - 1, bottom - 1], [(x + right) / 2, (y + bottom) / 2]]) {
    if (!slot.contains(document.elementFromPoint(cx, cy))) return null;
  }
  return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, clip: { x, y, width: right - x, height: bottom - y },
    viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }, scrollTop: chat.scrollTop };
}
