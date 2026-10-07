import type { ToolServer } from "./types";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { boxKeyGoesToMenu, clickCloses, menuItems, type MenuItem, type Trigger } from "./composerMenu";

export type ComposerMenuHandle = { key: (event: React.KeyboardEvent) => boolean };
export const ComposerMenu = forwardRef<ComposerMenuHandle, {
  participants: { id: string; display_name: string }[];
  servers: (ToolServer & {agent: string})[];
  serverStatus?: string;
  /** Commands the running mods registered. */
  mods?: { mod: string; name: string; description: string }[];
  trigger: Trigger | null;
  choose: (item: MenuItem, trigger: Trigger | null) => void;
  /** The thread's Plan switch, so the menu offers Plan or Stop planning. */
  planOn?: boolean;
}>(({ participants, servers, serverStatus, mods = [], trigger, choose, planOn = false }, ref) => {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const signature = trigger ? `${trigger.kind}:${trigger.start}:${trigger.end}:${trigger.query}` : null;
  const typing = !!trigger && signature !== dismissed && !open;
  const visible = open || typing;
  const entries = menuItems(open ? null : trigger, participants, servers, mods, planOn).filter(item => !open || `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()));
  const close = () => { setOpen(false); setDismissed(signature); };
  const pick = (item: MenuItem) => { close(); choose(item, open ? null : trigger); };
  useEffect(() => { setSelected(0); }, [signature, query]);
  useEffect(() => {
    if (open) search.current?.focus();
    if (!visible) return;
    const dismiss = (event: PointerEvent) => {
      if (clickCloses(open, Boolean(root.current?.contains(event.target as Node)), event.target instanceof HTMLTextAreaElement)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [visible, open, signature]);
  const key = (event: React.KeyboardEvent) => {
    if (!visible || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); close(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setSelected(i => entries.length ? (i + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length : 0); return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && entries.length) {
      event.preventDefault(); pick(entries[Math.min(selected, entries.length - 1)]); return true;
    }
    return false;
  };
  /** Keys from the message box. Typing there closes a menu opened with "+",
   *  and the key does what it would anyway: Enter sends. */
  const boxKey = (event: React.KeyboardEvent) => {
    if (boxKeyGoesToMenu(open)) return key(event);
    if (!visible) return false;
    close();
    if (event.key === "Escape") { event.preventDefault(); return true; }
    return false;
  };
  useImperativeHandle(ref, () => ({ key: boxKey }));
  return <div className="composer-tools" ref={root}>
    <button type="button" className="icon composer-plus" aria-label="Files, tools, commands and mentions" aria-expanded={visible} aria-haspopup="dialog"
      onClick={() => { if (visible) close(); else { setOpen(true); setQuery(""); setSelected(0); } }}>+</button>
    {visible && <div className="composer-menu" role="dialog" aria-label="Commands and mentions" onKeyDown={key}>
      {open && <input ref={search} aria-label="Find command or participant" placeholder="Find a tool, command or @name…" value={query} onChange={e => setQuery(e.target.value)} />}
      <div role="listbox" aria-label="Available commands and mentions">
        {entries.map((item, index) => <button type="button" role="option" aria-selected={index === selected} key={item.kind === "server" ? `${item.agent}:${item.label}` : item.label}
          onPointerDown={e => e.preventDefault()} onPointerMove={() => setSelected(index)} onClick={() => pick(item)}>
          <span>{item.label}</span><small>{item.detail}</small>
        </button>)}
        {!entries.length && <div className="muted">{trigger?.kind === "server" ? serverStatus || "No matching servers, apps or plugins" : "No matches"}</div>}
      </div>
    </div>}
  </div>;
});
