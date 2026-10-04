import { useEffect, useRef, useState } from "react";

import { newMenuItems, type NewMenuItem } from "./newPaneItems";
import { providerEnabled } from "./providers";
import type { AgentInfo, AppSection } from "./types";

interface Props {
  section: AppSection;
  label: string;
  disabled: boolean;
  agents: AgentInfo[];
  disabledProviders: string[];
  /** With no panes open the full picker is already on screen, so the button just shows it. */
  hasPanes: boolean;
  onShowPicker: () => void;
  onPick: (item: NewMenuItem) => void;
  onManageProviders: () => void;
  /** Bumped by the keyboard shortcut to open the menu. */
  openRequest?: number;
}

/**
 * + New, as a menu over the deck. Typing filters, the arrow keys move,
 * Enter opens, and Escape closes and puts focus back on the button.
 */
export function NewMenu({ section, label, disabled, agents, disabledProviders, hasPanes, onShowPicker, onPick, onManageProviders, openRequest }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = newMenuItems(section, agents, (key) => providerEnabled(key, disabledProviders), query);
  const choosable = items.filter((item) => item.installed);

  const show = () => {
    if (disabled) return;
    if (!hasPanes) return onShowPicker();
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => { if (openRequest) show(); }, [openRequest]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => { setActive((index) => Math.min(index, Math.max(0, choosable.length - 1))); }, [choosable.length]);

  const pick = (item: NewMenuItem) => { close(false); onPick(item); };

  return (
    <div className="new-menu" ref={root}>
      <button ref={button} className="primary" onClick={() => (open ? close() : show())} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="new-menu-list" role="menu" aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, choosable.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (event.key === "Enter" && choosable[active]) { event.preventDefault(); pick(choosable[active]); }
          }}>
          <input autoFocus className="new-menu-filter" aria-label="Filter" placeholder={section === "threads" ? "Open a thread…" : "Open a terminal…"} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
          {items.length === 0 && <p className="muted new-menu-empty">Nothing matches.</p>}
          {items.map((item) =>
            item.installed ? (
              <button key={item.key} role="menuitem" className={choosable[active]?.key === item.key ? "active" : undefined} onMouseEnter={() => setActive(choosable.indexOf(item))} onClick={() => pick(item)}>
                <strong>{item.label}</strong>
                <span className={item.agent ? "mono" : undefined}>{item.detail}</span>
                {choosable[active]?.key === item.key && <span className="new-menu-enter" aria-hidden="true">↵</span>}
              </button>
            ) : (
              <div key={item.key} className="new-menu-missing">
                <span>{item.label} · not installed</span>
                <button className="link" onClick={() => { close(false); onManageProviders(); }}>Hide in Settings</button>
              </div>
            ),
          )}
          <div className="new-menu-foot"><span>↵ open · Esc close</span></div>
        </div>
      )}
    </div>
  );
}
