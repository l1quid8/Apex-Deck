import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { dividers, resize, type Divider, type LayoutNode, type Rect } from "./layout";

// Drawing a layout tree and letting the mouse change it. The tree itself,
// and every rule about what a change does, is in layout.ts.

/** Space between neighbouring panes, in pixels. */
export const GAP = 8;

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
