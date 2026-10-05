import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { SIDEBAR_DEFAULT, SIDEBAR_LIMITS, SIDEBAR_STEP, clampWidth, dragWidth, type Sidebar } from "./sidebars";

interface SidebarHandleProps {
  which: Sidebar;
  /** The width the user chose, or null for the default. */
  width: number | null;
  /** Read the sidebar's width on screen when a drag starts. */
  measure: () => number;
  onChange: (width: number | null) => void;
  /** Told when a drag starts and ends, so panes can ignore the pointer. */
  onActive: (active: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

/** The draggable edge of a sidebar. Double-click puts back the default width. */
export function SidebarHandle({ which, width, measure, onChange, onActive, className = "", style }: SidebarHandleProps) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [held, setHeld] = useState(false);
  const label = which === "rail" ? "Resize workspaces" : "Resize thread details";
  const { min, max } = SIDEBAR_LIMITS[which];
  const now = width ?? SIDEBAR_DEFAULT[which];

  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    start.current = null;
    setHeld(false);
    onActive(false);
  };

  return (
    <div
      className={`sidebar-handle ${which}-edge ${held ? "held" : ""} ${className}`}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: measure() };
        setHeld(true);
        onActive(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        onChange(dragWidth(which, start.current.width, event.clientX - start.current.x));
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(event) => {
        const grow = which === "rail" ? "ArrowRight" : "ArrowLeft";
        const shrink = which === "rail" ? "ArrowLeft" : "ArrowRight";
        if (event.key === grow) onChange(clampWidth(which, (width ?? measure()) + SIDEBAR_STEP));
        else if (event.key === shrink) onChange(clampWidth(which, (width ?? measure()) - SIDEBAR_STEP));
        else if (event.key === "Home") onChange(min);
        else if (event.key === "End") onChange(max);
        else return;
        event.preventDefault();
      }}
    />
  );
}
