import { useEffect, useRef, useState } from "react";
import type { Backend, HostEntry } from "./backend";
export function WorkspaceHostMenu({ backend, choose, manage }: { backend: Backend; choose(hostId: string): Promise<void>; manage(): void }) {
  const [open, setOpen] = useState(false); const [hosts, setHosts] = useState<HostEntry[]>([]); const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", outside); return () => window.removeEventListener("mousedown", outside);
  }, [open]);
  const show = async () => {
    setOpen(v => !v); setError("");
    try { setHosts(await backend.hosts?.list() ?? [{ id: "local", name: "This Mac", remote: false }]); }
    catch (e) { setError(String(e)); }
  };
  return <span ref={root} className="workspace-host-menu" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
    <button className="icon" data-add-workspace aria-label="Add workspace" title="Add a folder on a machine" aria-haspopup="menu" aria-expanded={open} onClick={() => void show()}>+</button>
    {open && <div data-machine-menu className="workspace-machine-menu" role="menu">
      <strong>Add a workspace on</strong>
      {hosts.map(host => <button key={host.id} role="menuitem" data-host-id={host.id} onClick={() => { setOpen(false); void choose(host.id).catch(e => setError(String(e))); }}>{host.name}</button>)}
      <p className="muted">Each folder is a separate copy. Edits stay on that machine until you push or pull.</p>
      {backend.hosts && <button role="menuitem" onClick={() => { setOpen(false); manage(); }}>Add / manage servers…</button>}
    </div>}
    {error && <span className="error" role="alert">{error}</span>}
  </span>;
}
