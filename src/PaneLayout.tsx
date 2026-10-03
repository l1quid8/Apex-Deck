import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { dividers, dropArea, edgeAt, moveLeaf, rects, resize, type Divider, type Edge, type LayoutNode, type Rect } from "./layout";

// Drawing a layout tree and letting the mouse change it. The tree itself,
// and every rule about what a change does, is in layout.ts.

/** Space between neighbouring panes, in pixels. */
export const GAP = 14;

/**
 * Where a pane sits. Panes are placed by position rather than nested inside
 * one another, so rearranging the layout only moves them: a terminal is
 * never taken out of the page and restarted.
 */
export function paneStyle(rect: Rect): CSSProperties {
  return {
    position: "absolute",
    left: `calc(${rect.x * 100}% + ${GAP / 2}px)`,
    top: `calc(${rect.y * 100}% + ${GAP / 2}px)`,
    width: `calc(${rect.w * 100}% - ${GAP}px)`,
    height: `calc(${rect.h * 100}% - ${GAP}px)`,
  };
}

/** The pointer's place in the layout area, as fractions of it. */
function pointIn(area: HTMLElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const box = area.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
}

interface DividersProps {
  tree: LayoutNode | null;
  area: RefObject<HTMLDivElement | null>;
  onChange: (tree: LayoutNode) => void;
  /** Told when a drag starts and ends, so panes can ignore the pointer. */
  onActive: (active: boolean) => void;
}

/** The draggable lines between panes. */
export function Dividers({ tree, area, onChange, onActive }: DividersProps) {
  const [held, setHeld] = useState<string | null>(null);
  if (!tree) return null;

  const keyOf = (d: Divider) => `${d.path.join(".")}/${d.index}`;
  const drag = (d: Divider) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (held !== keyOf(d) || !area.current) return;
    const point = pointIn(area.current, event.clientX, event.clientY);
    if (point) onChange(resize(tree, d, d.dir === "row" ? point.x : point.y));
  };
  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setHeld(null);
    onActive(false);
  };

  return (
    <>
      {dividers(tree).map((d) => {
        const style: CSSProperties =
          d.dir === "row"
            ? { left: `calc(${d.at * 100}% - ${GAP / 2}px)`, top: `calc(${d.parent.y * 100}% + ${GAP / 2}px)`, width: GAP, height: `calc(${d.parent.h * 100}% - ${GAP}px)` }
            : { top: `calc(${d.at * 100}% - ${GAP / 2}px)`, left: `calc(${d.parent.x * 100}% + ${GAP / 2}px)`, height: GAP, width: `calc(${d.parent.w * 100}% - ${GAP}px)` };
        return (
          <div
            key={keyOf(d)}
            className={`divider ${d.dir} ${held === keyOf(d) ? "held" : ""}`}
            style={style}
            role="separator"
            aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
            title="Drag to resize"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setHeld(keyOf(d));
              onActive(true);
            }}
            onPointerMove={drag(d)}
            onPointerUp={release}
            onPointerCancel={release}
          />
        );
      })}
    </>
  );
}

/** How far the pointer must travel before a press on a title bar becomes a
 *  drag, so an ordinary click does not move anything. */
const DRAG_THRESHOLD = 6;

interface Drop {
  target: string;
  edge: Edge;
}

interface PaneDrag {
  /** The pane being dragged, once the drag has really started. */
  dragging: string | null;
  /** Where it would land if released now. */
  preview: Rect | null;
  /** Call from a pane title bar's pointer-down handler. */
  begin: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Dragging a pane by its title bar onto another pane. Dropping on a side
 * puts it there and splits the space; dropping on the middle swaps the two.
 * Escape, or releasing outside any pane, leaves things as they were.
 */
export function usePaneDrag(tree: LayoutNode | null, area: RefObject<HTMLDivElement | null>, onChange: (tree: LayoutNode) => void): PaneDrag {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  // The listeners below outlive the render that attached them.
  const latest = useRef({ tree, onChange });
  latest.current = { tree, onChange };
  const press = useRef<{ id: string; x: number; y: number; active: boolean; drop: Drop | null } | null>(null);
  const [pressed, setPressed] = useState(0);

  useEffect(() => {
    if (!press.current) return;
    const stop = () => {
      press.current = null;
      setDragging(null);
      setDrop(null);
      setPressed(0);
    };
    const move = (event: PointerEvent) => {
      const state = press.current;
      const tree = latest.current.tree;
      if (!state || !tree || !area.current) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
        state.active = true;
        setDragging(state.id);
      }
      const point = pointIn(area.current, event.clientX, event.clientY);
      let next: Drop | null = null;
      if (point) {
        for (const [id, rect] of rects(tree)) {
          const inside = point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
          if (inside && id !== state.id) next = { target: id, edge: edgeAt(rect, point.x, point.y) };
        }
      }
      state.drop = next;
      setDrop((old) => (old?.target === next?.target && old?.edge === next?.edge ? old : next));
    };
    const up = () => {
      const state = press.current;
      const { tree, onChange } = latest.current;
      if (state?.active && state.drop && tree) onChange(moveLeaf(tree, state.id, state.drop.target, state.drop.edge));
      stop();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && stop();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", key);
    };
  }, [pressed, area]);

  const target = drop && tree ? rects(tree).get(drop.target) : undefined;
  return {
    dragging,
    preview: dragging && drop && target ? dropArea(target, drop.edge) : null,
    begin: (id, event) => {
      // Buttons in the title bar keep working, and only the main button drags.
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, a")) return;
      press.current = { id, x: event.clientX, y: event.clientY, active: false, drop: null };
      setPressed((n) => n + 1);
    },
  };
}
