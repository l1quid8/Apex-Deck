import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

// A ⋯ or right-click menu: keyboard first, with shortcut labels, separators
// and one level of submenu (Copy ›). Arrow keys move, → opens a submenu and
// ← closes it, Escape closes and gives focus back to what opened the menu.

export interface MenuEntry {
  key: string;
  label: string;
  disabled?: boolean;
  /** Why it is turned off, for its tooltip. */
  reason?: string;
  danger?: boolean;
  /** A separator line comes before it. */
  separated?: boolean;
  /** Its shortcut as printed, such as "⌥⌘R". */
  keys?: string;
  /** Muted words at the right: what will be copied, say. */
  side?: string;
  icon?: ReactNode;
  /** Opens these instead of acting. */
  submenu?: MenuEntry[];
  /** The current choice: a ✓ at the right. */
  checked?: boolean;
  /** Not an action: a muted line of words. */
  note?: boolean;
  onSelect?: () => void;
}

/** Where a menu opens: under a button (right edges lined up), or at the pointer. */
export type MenuAnchor = { rect: DOMRect } | { x: number; y: number };

const WIDTH = 230;

function placeAt(anchor: MenuAnchor): CSSProperties {
  // right and bottom are cleared: .pane-menu's own rules pin it to its button.
  const at = { position: "fixed", right: "auto", bottom: "auto" } as const;
  if ("rect" in anchor) {
    const left = Math.max(8, Math.min(anchor.rect.right, window.innerWidth - 8) - WIDTH);
    return { ...at, top: anchor.rect.bottom + 4, left };
  }
  return { ...at, top: anchor.y, left: anchor.x };
}

/** Keep a fixed element inside the window once its size is known. */
function useInsideWindow(ref: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - 8 - box.height)}px`;
    if (box.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - 8 - box.width)}px`;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

const enabledItems = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)') ?? [])];

function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const items = enabledItems(event.currentTarget);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
}

function Items({ entries, open, onOpen, onPick }: { entries: MenuEntry[]; open: string | null; onOpen(key: string | null, el?: HTMLElement): void; onPick(entry: MenuEntry): void }) {
  return <>{entries.map((entry) => (
    <Fragment key={entry.key}>
      {entry.separated && <span className="pane-menu-sep" role="separator" />}
      {entry.note ? <span className="menu-note">{entry.label}</span> : <button role="menuitem" className={[entry.danger ? "danger-text" : "", entry.submenu && open === entry.key ? "hl" : ""].filter(Boolean).join(" ") || undefined}
        disabled={entry.disabled} title={entry.reason || undefined} data-key={entry.key}
        aria-haspopup={entry.submenu ? "menu" : undefined} aria-expanded={entry.submenu ? open === entry.key : undefined}
        onMouseEnter={(event) => onOpen(entry.submenu ? entry.key : null, event.currentTarget)}
        onClick={(event) => { event.stopPropagation(); if (entry.submenu) onOpen(entry.key, event.currentTarget); else onPick(entry); }}>
        {entry.icon}
        <span className="label">{entry.label}</span>
        {entry.side && <span className="sub">{entry.side}</span>}
        {entry.keys && <span className="keys">{entry.keys}</span>}
        {entry.checked && <span className="check" aria-label="current">✓</span>}
        {entry.submenu && <span className="more" aria-hidden="true">›</span>}
      </button>}
    </Fragment>
  ))}</>;
}

/**
 * A menu drawn at `anchor`. `onClose` runs for Escape, a click outside, or
 * after an item acts; focus then goes back to `opener` when it still exists.
 */
export function MenuList({ id, entries, anchor, label, opener, onClose }: { id: string; entries: MenuEntry[]; anchor: MenuAnchor; label?: string; opener?: HTMLElement | null; onClose(): void }) {
  const root = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<{ key: string; rect: DOMRect } | null>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  const close = (refocus: boolean) => {
    closing.current();
    if (refocus && opener?.isConnected) opener.focus();
  };
  useInsideWindow(root, [anchor]);
  useInsideWindow(sub, [open?.key]);
  useEffect(() => { enabledItems(root.current)[0]?.focus(); }, []);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || sub.current?.contains(target) || opener?.contains(target)) return;
      closing.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closing.current();
      if (opener?.isConnected) opener.focus();
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away, true); window.removeEventListener("keydown", key); };
  }, [opener]);
  const pick = (entry: MenuEntry) => { close(true); entry.onSelect?.(); };
  const openSub = (key: string | null, el?: HTMLElement) => setOpen(key && el ? { key, rect: el.getBoundingClientRect() } : null);
  const submenu = open ? entries.find((e) => e.key === open.key)?.submenu : undefined;
  return <>
    <span ref={root} className="pane-menu deck-menu" role="menu" aria-label={label} data-menu={id} style={placeAt(anchor)}
      onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(event); }
        else if (event.key === "Escape") { event.preventDefault(); close(true); }
        else if (event.key === "ArrowRight") {
          const at = document.activeElement as HTMLElement | null;
          const key = at?.dataset.key;
          if (key && entries.find((e) => e.key === key)?.submenu) {
            event.preventDefault();
            openSub(key, at!);
            requestAnimationFrame(() => enabledItems(sub.current)[0]?.focus());
          }
        }
      }}>
      <Items entries={entries} open={open?.key ?? null} onOpen={openSub} onPick={pick} />
    </span>
    {submenu && open && (
      <span ref={sub} className="pane-menu deck-menu pane-submenu" role="menu" data-menu={`${id}:${open.key}`}
        style={{ position: "fixed", right: "auto", bottom: "auto", top: open.rect.top - 4, left: open.rect.right + 4 }}
        onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(event); }
          else if (event.key === "Escape") { event.preventDefault(); close(true); }
          else if (event.key === "ArrowLeft") {
            event.preventDefault();
            const parent = root.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(open.key)}"]`);
            setOpen(null);
            parent?.focus();
          }
        }}>
        <Items entries={submenu} open={null} onOpen={() => {}} onPick={pick} />
      </span>
    )}
  </>;
}
