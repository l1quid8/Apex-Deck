import { useEffect, useRef, useState } from "react";

import { ago, label, summarize, urgency, type Signal } from "./attention";

export interface AttentionItem {
  paneId: string;
  title: string;
  /** The workspace the pane belongs to. */
  workspace: string;
  /** "Code" or "Threads". */
  where: string;
  signal: Signal;
}

interface Props {
  items: AttentionItem[];
  /** Go to the pane. */
  onOpen: (paneId: string) => void;
}

/**
 * Everything that wants attention, in one list, reachable from anywhere in
 * the app. It only appears when there is something in it. The most urgent
 * items come first, and choosing one goes to its pane.
 */
export function AttentionMenu({ items, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  if (items.length === 0) return null;
  const { worst } = summarize(items.map((item) => item.signal));
  const how = (kind: Signal["kind"]) => items.filter((item) => item.signal.kind === kind).length;
  const summary = [
    how("needs_input") > 0 && `${how("needs_input")} need${how("needs_input") === 1 ? "s" : ""} you`,
    how("failed") > 0 && `${how("failed")} failed`,
    how("done") > 0 && `${how("done")} ready`,
  ]
    .filter(Boolean)
    .join(" · ");
  const sorted = [...items].sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at);
  const now = Date.now();

  return (
    <div className="attention" ref={root}>
      <button className={`attention-button ${worst ?? ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <span className={`dot ${worst ?? ""}`} />
        {summary}
      </button>
      {open && (
        <div className="attention-list" role="menu">
          {sorted.map((item) => (
            <button
              key={item.paneId}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpen(item.paneId);
              }}
            >
              <span className={`dot ${item.signal.kind}`} />
              <span className="attention-what">
                <strong>{item.title}</strong>
                <span>{item.signal.note || label(item.signal.kind)}</span>
              </span>
              <span className="attention-where">
                <span>
                  {item.workspace} · {item.where}
                </span>
                <span>{ago(item.signal.at, now)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
