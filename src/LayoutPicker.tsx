import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PaneLayoutMode } from "./paneArrangement";

const choices: { id: PaneLayoutMode; label: string; detail: string }[] = [
  { id: "horizontal", label: "Horizontal", detail: "Wide rows, scroll down" },
  { id: "vertical", label: "Vertical", detail: "Tall columns, scroll sideways" },
  { id: "grid", label: "Even grid", detail: "Give every pane equal space" },
  { id: "left", label: "Focus left", detail: "One tall pane on the left" },
  { id: "right", label: "Focus right", detail: "One tall pane on the right" },
];

function Preview({ kind }: { kind: PaneLayoutMode }) {
  return <span className={`layout-preview layout-preview-${kind}`} aria-hidden="true">
    <i /><i /><i />{kind === "grid" && <i />}
  </span>;
}

export function LayoutPicker({ value, disabled, onSelect }: { value: PaneLayoutMode; disabled: boolean; onSelect(value: PaneLayoutMode): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const openingIndex = useRef(0);
  const search = useRef({ text: "", at: 0 });
  const menuOpen = open && !disabled;
  const label = choices.find((choice) => choice.id === value)?.label ?? "Even grid";

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!menuOpen) return;
    items.current[openingIndex.current]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [menuOpen]);

  function openMenu(index: number) {
    if (disabled) return;
    openingIndex.current = index;
    search.current = { text: "", at: 0 };
    setOpen(true);
    if (menuOpen) items.current[index]?.focus();
  }

  function select(index: number) {
    onSelect(choices[index].id);
    setOpen(false);
    trigger.current?.focus();
  }

  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    const current = items.current.findIndex((item) => item === document.activeElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (current + 1) % choices.length;
    else if (event.key === "ArrowUp") next = (current - 1 + choices.length) % choices.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = choices.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    } else if (event.key === "Tab") {
      // Let the browser move focus before hiding the focused menu item.
      window.setTimeout(() => setOpen(false), 0);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      if (current >= 0) {
        event.preventDefault();
        event.stopPropagation();
        select(current);
      }
      return;
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const letter = event.key.toLowerCase();
      const now = Date.now();
      const previous = now - search.current.at < 500 ? search.current.text : "";
      const text = previous === letter ? letter : previous + letter;
      search.current = { text, at: now };
      for (let step = 1; step <= choices.length; step++) {
        const index = (current + step) % choices.length;
        if (choices[index].label.toLowerCase().startsWith(text)) { next = index; break; }
      }
    }
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      items.current[next]?.focus();
    }
  }

  return <div className="layout-picker" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className={`icon layout-picker-trigger${menuOpen ? " active" : ""}`} aria-label={`Pane layout: ${label}`} title={`Pane layout · ${label}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={disabled}
      onClick={() => { if (menuOpen) setOpen(false); else openMenu(Math.max(0, choices.findIndex((choice) => choice.id === value))); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.key === "ArrowDown" ? 0 : choices.length - 1);
        }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
      <span className="layout-picker-caret" aria-hidden="true">⌄</span>
    </button>
    <div className="layout-picker-popover" role="menu" aria-label="Pane layout" hidden={!menuOpen} onKeyDown={menuKey}>
      <div className="layout-picker-heading">Arrange panes</div>
      {choices.map((choice, index) => <button key={choice.id} ref={(item) => { items.current[index] = item; }} className={`layout-choice${value === choice.id ? " selected" : ""}`} role="menuitemradio" aria-checked={value === choice.id} tabIndex={-1}
        onClick={() => select(index)}>
        <Preview kind={choice.id} />
        <span className="layout-choice-copy"><strong>{choice.label}</strong><small>{choice.detail}</small></span>
        {value === choice.id && <span className="layout-choice-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>
  </div>;
}
