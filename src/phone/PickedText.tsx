// The desktop's Add to chat / More details over text picked inside one message (ChatPane's
// pickSelection). iPhone has no mouse-up, so this follows the selection as it changes, sits on the
// side of the text that iPhone's own Copy menu leaves free, and hides while the chat scrolls.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SelectionActions } from "../SelectionActions";
import { selectionSpot } from "./messageTools";

type Picked = { seq: number; text: string; x: number; y: number; side: "above" | "below" };

/** How long after a press on the buttons the picked text is kept, for the tap's click to land. */
const PRESS_MS = 600;

export function PickedText(props: {
  /** The scrolling chat, holding each finished message as a `.ph-msg` inside its `[data-seq]`. */
  chat: RefObject<HTMLElement | null>;
  /** A sheet covers the thread. */
  covered: boolean;
  /** A bot can answer More details. */
  canExplain: boolean;
  onAdd(seq: number, text: string): void;
  onExplain(seq: number, text: string): void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const half = useRef(110);
  // iPhone may drop the selection under a tap on the buttons before their click; keep what was picked until it lands.
  const pressing = useRef(false);

  /** The text picked inside one finished message, and where its buttons go; null for anything else. */
  const read = (): Picked | null => {
    const chat = props.chat.current;
    const frame = chat?.parentElement;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!chat || !frame || !selection || !text || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const inside = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".ph-msg") ?? null;
    const message = inside(range.startContainer);
    if (!message || message !== inside(range.endContainer) || !chat.contains(message)) return null;
    const seq = Number(message.closest("[data-seq]")?.getAttribute("data-seq"));
    if (!Number.isFinite(seq)) return null;
    const spot = selectionSpot(range.getBoundingClientRect(), chat.getBoundingClientRect(), frame.getBoundingClientRect(), half.current);
    return spot && { seq, text, ...spot };
  };

  useEffect(() => {
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (pressing.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPicked(read()));
    };
    // Like iPhone's own menu: gone while the chat moves, back where the text is once it stops.
    const scrolled = () => {
      setPicked(null);
      clearTimeout(settle);
      settle = setTimeout(() => setPicked(read()), 150);
    };
    const down = (event: PointerEvent) => { pressing.current = !!(event.target as Element | null)?.closest?.(".selection-actions"); };
    const up = () => {
      if (!pressing.current) return;
      setTimeout(() => { if (!pressing.current) return; pressing.current = false; setPicked(read()); }, PRESS_MS);
    };
    const chat = props.chat.current;
    document.addEventListener("selectionchange", changed);
    chat?.addEventListener("scroll", scrolled, { passive: true });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      document.removeEventListener("selectionchange", changed);
      chat?.removeEventListener("scroll", scrolled);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    // Reads only refs, so one set of listeners serves the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Placed first with a guess at the width; placed again once it has been measured.
  useLayoutEffect(() => {
    const width = bubble.current?.offsetWidth;
    if (!width || Math.abs(width / 2 - half.current) < 1) return;
    half.current = width / 2;
    setPicked(read());
  });

  const act = (run: (seq: number, text: string) => void) => {
    const now = picked;
    pressing.current = false;
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    if (now) run(now.seq, now.text);
  };

  if (!picked || props.covered) return null;
  return <SelectionActions ref={bubble} x={picked.x} y={picked.y} side={picked.side} canExplain={props.canExplain}
    onAdd={() => act(props.onAdd)} onExplain={() => act(props.onExplain)} />;
}
