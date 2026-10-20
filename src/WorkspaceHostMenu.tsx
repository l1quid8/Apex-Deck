import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Backend, HostEntry } from "./backend";
export function WorkspaceHostMenu({ backend, choose, manage }: { backend: Backend; choose(hostId: string): Promise<void>; manage(): void }) {
  const [open, setOpen] = useState(false); const [hosts, setHosts] = useState<HostEntry[]>([]); const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The rail scrolls (and Glass has a backdrop filter), so even a fixed child
  // can be clipped there. Portal to the body and clamp the measured popup.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!menu.current || !button.current) return;
      const anchor = button.current.getBoundingClientRect();
      const box = menu.current.getBoundingClientRect();
      menu.current.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      menu.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - box.height - 8))}px`;
    };
    place();
    const resize = new ResizeObserver(place);
    if (menu.current) resize.observe(menu.current);
    if (root.current?.parentElement) resize.observe(root.current.parentElement);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { resize.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, hosts]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [open]);
  const show = async () => {
    setOpen(v => !v); setError("");
    try { setHosts(await backend.hosts?.list() ?? [{ id: "local", name: "This Mac", remote: false }]); }
    catch (e) { setError(String(e)); }
  };
  return <span ref={root} className="workspace-host-menu" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
    <button ref={button} className="icon" data-add-workspace aria-label="Add workspace" title="Add a folder on a machine" aria-haspopup="menu" aria-expanded={open} onClick={() => void show()}>+</button>
    {open && createPortal(<div ref={menu} data-machine-menu className="workspace-machine-menu" role="menu" aria-label="Add a workspace on">
      <strong>Add a workspace on</strong>
      {hosts.map((host, index) => <button key={host.id} autoFocus={index === 0} role="menuitem" data-host-id={host.id} onClick={() => { setOpen(false); void choose(host.id).catch(e => setError(String(e))); }}>{host.name}</button>)}
      <p className="muted">Each folder is a separate copy. Edits stay on that machine until you push or pull.</p>
      {backend.hosts && <button autoFocus={hosts.length === 0} role="menuitem" onClick={() => { setOpen(false); manage(); }}>Add / manage servers…</button>}
    </div>, document.body)}
    {error && <span className="error" role="alert">{error}</span>}
  </span>;
}
