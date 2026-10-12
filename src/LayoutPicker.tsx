import { useEffect, useRef, useState } from "react";
import type { Layout } from "./types";

type Preset = "grid" | Layout;
const choices: { id: Preset; label: string; detail: string }[] = [
  { id: "grid", label: "Even grid", detail: "Give every pane equal space" },
  { id: "top", label: "Focus top", detail: "One wide pane above" },
  { id: "left", label: "Focus left", detail: "One tall pane beside the rest" },
];

function Preview({ kind }: { kind: Preset }) {
  return <span className={`layout-preview layout-preview-${kind}`} aria-hidden="true">
    {kind === "grid" ? <><i /><i /><i /><i /></> : kind === "top" ? <><i /><i /><i /></> : <><i /><i /><i /></>}
  </span>;
}

export function LayoutPicker({ value, disabled, onSelect }: { value: Preset; disabled: boolean; onSelect(value: Preset): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = choices.find((choice) => choice.id === value)?.label ?? "Even grid";

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", keys); };
  }, [open]);

  return <div className="layout-picker" ref={root}>
    <button ref={trigger} className={`icon layout-picker-trigger${open ? " active" : ""}`} aria-label={`Pane layout: ${label}`} title={`Pane layout · ${label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
      <span className="layout-picker-caret" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="layout-picker-popover" role="menu" aria-label="Pane layout">
      <div className="layout-picker-heading">Arrange panes</div>
      {choices.map((choice) => <button key={choice.id} className={`layout-choice${value === choice.id ? " selected" : ""}`} role="menuitemradio" aria-checked={value === choice.id}
        onClick={() => { onSelect(choice.id); setOpen(false); trigger.current?.focus(); }}>
        <Preview kind={choice.id} />
        <span className="layout-choice-copy"><strong>{choice.label}</strong><small>{choice.detail}</small></span>
        {value === choice.id && <span className="layout-choice-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
