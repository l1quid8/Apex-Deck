// Add to chat / More details, floated over text picked inside one message. The desktop shows them
// above the text; the phone picks a `side`, the one iPhone's own Copy menu leaves free.
// The buttons keep the selection when pressed, so the picked text is still there when they act.

import type { Ref } from "react";

export function SelectionActions(props: {
  x: number; y: number; side?: "above" | "below";
  /** A bot can answer More details. */
  canExplain: boolean;
  onAdd(): void; onExplain(): void;
  ref?: Ref<HTMLSpanElement>;
}) {
  return <span ref={props.ref} className={`selection-actions${props.side ? ` ${props.side}` : ""}`} role="toolbar" aria-label="Selected text" style={{ left: props.x, top: props.y }}>
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={props.onAdd}>Add to chat</button>
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={props.onExplain} disabled={!props.canExplain}>More details</button>
  </span>;
}
