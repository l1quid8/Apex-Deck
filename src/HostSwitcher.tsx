import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { HostEntry, HostsApi } from "./backend";
import { connection } from "./connection";
import { ipcWords as words } from "./electronShell";

// The top of the rail: which machine this window runs on, and the others.
// Picking one moves this window there; New window opens it beside this one,
// so this Mac and a server can be open side by side.

export function HostSwitcher({ hosts, onManage }: { hosts: HostsApi; onManage: () => void }) {
  const { status, host } = useSyncExternalStore(connection.subscribe, connection.get);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<HostEntry[]>([]);
  const [current, setCurrent] = useState("");
  const [problem, setProblem] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Read afresh each time: hosts are added in Settings, and windows open and close.
    setProblem("");
    hosts.list().then(setList, () => setList([]));
    hosts.current().then((entry) => setCurrent(entry.id), () => setCurrent(""));
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [open, hosts]);

  const run = (action: Promise<void>) => action.then(() => close(false), (error) => setProblem(words(error)));
  const state = status.kind === "connected" ? "connected" : status.kind === "failed" ? "failed" : "waiting";

  return (
    <div className="host-switch" ref={root}>
      <button ref={button} className="host-switch-button" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
        title="The machine this window runs on" aria-label={`Host: ${host}. Change host`}>
        <span className={`host-dot ${state}`} aria-hidden="true" />
        <span className="host-switch-name">{host}</span>
        <span className="host-switch-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="host-menu" aria-label="Hosts">
          {list.map((entry) => {
            const here = entry.id === current;
            const elsewhere = !here && entry.open;
            return (
              <div key={entry.id} className={`host-menu-row ${here ? "current" : ""}`}>
                <button className="host-menu-pick" disabled={here} aria-current={here ? "true" : undefined}
                  title={here ? "This window" : elsewhere ? `Show the window on ${entry.name}` : `Move this window to ${entry.name}`}
                  onClick={() => void run(hosts.use(entry.id))}>
                  <span className="host-menu-check" aria-hidden="true">{here ? "✓" : ""}</span>
                  <span className="host-menu-words">
                    <span>{entry.name}</span>
                    <small>{here ? "This window" : elsewhere ? "Open in another window" : entry.remote ? entry.ssh : "Your Mac"}</small>
                  </span>
                </button>
                {!here && !elsewhere && (
                  <button className="ghost host-menu-new" onClick={() => void run(hosts.openWindow(entry.id))}
                    title={`Open ${entry.name} in a new window`} aria-label={`Open ${entry.name} in a new window`}>
                    New window
                  </button>
                )}
              </div>
            );
          })}
          {problem && <span className="error" role="alert">{problem}</span>}
          <span className="pane-menu-sep" role="separator" />
          <button className="host-menu-manage" onClick={() => { close(false); onManage(); }}>Add or manage hosts…</button>
        </div>
      )}
    </div>
  );
}
