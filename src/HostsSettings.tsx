import { useEffect, useState, useSyncExternalStore } from "react";

import type { Backend, HostEntry, HostsApi } from "./backend";
import { ipcWords as words } from "./electronShell";
import { ConnectionDialog } from "./ConnectionDialog";

// Settings → Hosts: this Mac, and other machines running apex-daemon that
// Deck reaches with ssh. Each server's threads stay on it; Edit… changes how
// Deck reaches a server, never which machine it is.

export function HostsSettings({ backend, hosts }: { backend: Backend; hosts: HostsApi }) {
  const [list, setList] = useState<HostEntry[]>([]);
  const [name, setName] = useState("");
  const [ssh, setSsh] = useState("");
  const [command, setCommand] = useState("apex-daemon");
  const [problem, setProblem] = useState("");
  /** The server whose connection is being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    hosts.list().then(setList, () => setList([]));
  }, [hosts]);
  const add = async () => {
    setProblem("");
    try {
      setList(await hosts.add({ name, ssh, command }));
      setName("");
      setSsh("");
      setCommand("apex-daemon");
    } catch (error) {
      setProblem(words(error));
    }
  };
  return (
    <div className="settings-card hosts">
      {list.map(host => <HostRow key={host.id} backend={backend} host={host} edit={hosts.update ? () => setEditing(host.id) : undefined} remove={() => hosts.remove(host.id).then(setList, e => setProblem(words(e)))} />)}
      {editing && <ConnectionDialog mode={{ kind: "edit", hostId: editing }} hosts={list} api={hosts} onClose={() => setEditing(null)} onSaved={(next) => { setList(next); setEditing(null); }} />}
      <form className="host-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <strong>Add a host</strong>
        <small className="muted">
          The machine needs apex-daemon running (see docs/daemon-ubuntu.md) and an SSH key this Mac already uses for it.
          Run <code>ssh {ssh.trim() || "vps"}</code> once in Terminal first so its host key is known; Deck never asks for a password.
        </small>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="vps" maxLength={40} /></label>
        <label>SSH destination<input className="mono" value={ssh} onChange={(e) => setSsh(e.target.value)} placeholder="me@vps.example.com or a ~/.ssh/config Host" spellCheck={false} autoCapitalize="off" /></label>
        <label>Daemon command<input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} autoCapitalize="off" /></label>
        {problem && <span className="error" role="alert">{problem}</span>}
        <div><button type="submit" className="primary" disabled={!name.trim() || !ssh.trim() || backend.demo}>Add host</button></div>
      </form>
    </div>
  );
}

function HostRow({ backend, host, edit, remove }: { backend: Backend; host: HostEntry; edit?: () => void; remove(): void }) {
  const c = backend.machines?.connection(host.id);
  const state = useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.get ?? (() => null));
  return <div className="settings-row"><div className="settings-label"><strong>{host.name} · {state?.status.kind ?? "connected"}</strong><small className="mono">{host.remote ? `ssh ${host.ssh} ${host.command} --stdio --attach` : "The daemon on this Mac"}</small></div><span className="host-actions"><button onClick={() => { backend.machines?.get(host.id); c?.retryNow(); }}>Retry</button>{host.remote && edit && <button onClick={edit}>Edit…</button>}{host.remote && <button className="ghost" onClick={remove}>Remove</button>}</span></div>;
}
