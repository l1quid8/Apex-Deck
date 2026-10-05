import { useEffect, useState } from "react";

import type { Backend, HostEntry, HostsApi } from "./backend";

// Settings → Hosts: this Mac, and other machines running apex-daemon that
// Deck reaches with ssh. Switching reloads the window on the chosen host.

export function HostsSettings({ backend, hosts }: { backend: Backend; hosts: HostsApi }) {
  const [list, setList] = useState<HostEntry[]>([]);
  const [current, setCurrent] = useState("");
  const [name, setName] = useState("");
  const [ssh, setSsh] = useState("");
  const [command, setCommand] = useState("apex-daemon");
  const [problem, setProblem] = useState("");
  useEffect(() => {
    hosts.list().then(setList, () => setList([]));
    hosts.current().then((host) => setCurrent(host.id), () => setCurrent(""));
  }, [hosts]);
  const words = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
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
      {list.map((host) => (
        <div key={host.id} className="settings-row">
          <div className="settings-label">
            <strong>{host.name}{host.id === current && <span className="host-current"> · Connected</span>}</strong>
            <small className="mono">{host.remote ? `ssh ${host.ssh} ${host.command} --stdio --attach` : "The daemon on this Mac"}</small>
          </div>
          <span className="host-actions">
            {host.id !== current && <button onClick={() => void hosts.use(host.id)}>Connect</button>}
            {host.remote && <button className="ghost" onClick={() => hosts.remove(host.id).then(setList, (e) => setProblem(words(e)))}>Remove</button>}
          </span>
        </div>
      ))}
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
