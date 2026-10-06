import { useEffect, useRef, useState } from "react";
import type { HostEntry, HostsApi } from "./backend";
import { classifyIdentity } from "./hostFacts.ts";
import { ipcWords as words } from "./electronShell";

// Edit connection… and Add a server: the same fields as Settings › Hosts.
// A server stays one machine. Changing how Deck reaches it is checked
// against the host ID its apex-daemon reports, so no thread ever moves;
// a different machine can only be added as a new server.

export type ConnectionMode =
  | { kind: "edit"; hostId: string }
  | { kind: "add"; fill?: { name?: string; ssh?: string; command?: string } };

type Test =
  | { state: "testing" }
  | { state: "ok" | "bad"; text: string; different?: boolean };

const DEFAULT_COMMAND = "apex-daemon";
/** The host part of an SSH destination, as a name for a new server. */
const hostPart = (ssh: string) => ssh.trim().split("@").pop()!.split(":")[0];

export function ConnectionDialog({ mode: start, hosts: known, api, uses = "", onClose, onSaved }: {
  mode: ConnectionMode;
  hosts: HostEntry[];
  api: HostsApi;
  /** What the server holds, such as "2 threads and 1 project"; "" for none. */
  uses?: string;
  onClose(): void;
  onSaved(list: HostEntry[], words: string): void;
}) {
  const [mode, setMode] = useState<ConnectionMode>(start);
  const [hosts, setHosts] = useState<HostEntry[]>(known);
  const editing = mode.kind === "edit" ? hosts.find((h) => h.id === mode.hostId) : undefined;
  const fill = mode.kind === "add" ? mode.fill ?? {} : {};
  const [name, setName] = useState(editing?.name ?? fill.name ?? "");
  const [ssh, setSsh] = useState(editing?.ssh ?? fill.ssh ?? "");
  const [command, setCommand] = useState(editing?.command ?? fill.command ?? DEFAULT_COMMAND);
  const [test, setTest] = useState<Test | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const asked = useRef(0);
  const first = useRef<HTMLInputElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;

  // Check names against the hosts saved now, not when the list was last read.
  useEffect(() => { api.list().then(setHosts, () => {}); }, [api]);
  useEffect(() => {
    first.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closing.current(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const add = mode.kind === "add";
  const label = editing?.name ?? name;
  const cmd = command.trim() || DEFAULT_COMMAND;
  const moved = !!editing && (ssh.trim() !== editing.ssh || cmd !== editing.command);
  const lower = name.trim().toLowerCase();
  const taken = !!lower && hosts.some((h) => h.id !== editing?.id && h.name.toLowerCase() === lower);
  const edit = (set: (value: string) => void) => (value: string) => { set(value); setTest(null); setProblem(""); asked.current++; };

  const differentWords = () => `${ssh.trim()} is a different machine: its apex-daemon reports another host ID. ${uses ? `${label}'s ${uses} can't move there, so this address isn't saved.` : "This address isn't saved."} You can add it as a new server instead.`;

  const runTest = async () => {
    const ticket = ++asked.current;
    setTest({ state: "testing" });
    try {
      const probe = await api.check!({ ssh: ssh.trim(), command: cmd });
      if (ticket !== asked.current) return;
      const found = classifyIdentity(hosts, editing?.id ?? null, probe.daemonHostId);
      const version = probe.version ? `apex-daemon ${probe.version}` : "an apex-daemon older than 0.5.1";
      if (found.kind === "same") setTest({ state: "ok", text: moved ? `Connected, and it's the same machine: apex-daemon there reports ${label}'s host ID.` : `Connected. ${version} is running on ${label}.` });
      else if (found.kind === "bind") setTest({ state: "ok", text: `Connected. Deck hasn't reached ${label} before, so Save remembers this machine as ${label}.` });
      else if (found.kind === "new") setTest({ state: "ok", text: `Connected. ${version} is running there.` });
      else if (found.kind === "known") setTest({ state: "bad", text: `${ssh.trim()} is ${found.name}, which Deck already has.${editing ? ` ${label} keeps its own address.` : ""}` });
      else setTest({ state: "bad", different: true, text: differentWords() });
    } catch (error) {
      if (ticket === asked.current) setTest({ state: "bad", text: `Couldn't reach ${ssh.trim()}: ${words(error)}` });
    }
  };

  const save = async () => {
    if (saving || taken) return;
    setSaving(true);
    setProblem("");
    try {
      if (add) {
        const list = await api.add({ name: name.trim(), ssh: ssh.trim(), command: cmd });
        onSaved(list, `Added ${name.trim()}. Pick a folder on it from Projects › +.`);
        return;
      }
      if (moved) setTest({ state: "testing" });
      const result = await api.update!(editing!.id, { name: name.trim(), ssh: ssh.trim(), command: cmd });
      if (result.ok) {
        onSaved(result.hosts, moved ? `Saved. It's still the same machine${uses ? `, so ${name.trim()}'s ${uses} stay where they are` : ""}.` : `Saved ${name.trim()}'s connection.`);
        return;
      }
      if (result.reason === "different") setTest({ state: "bad", different: true, text: differentWords() });
      else { setTest(null); setProblem(result.words); }
      api.list().then(setHosts, () => {});
    } catch (error) {
      setTest(null);
      setProblem(words(error));
    } finally {
      setSaving(false);
    }
  };

  const insteadAdd = () => {
    setMode({ kind: "add", fill: { name: hostPart(ssh), ssh: ssh.trim(), command: cmd } });
    setName(hostPart(ssh));
    setTest(null);
    setProblem("");
  };

  const title = add ? "Add a server" : `Edit connection · ${label}`;
  const testing = test?.state === "testing";
  return (
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="confirm connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <strong id="connection-title">{title}</strong>
        <p className="muted">{add
          ? <>The machine needs apex-daemon running (see docs/daemon-ubuntu.md) and an SSH key this Mac already uses for it. Run <code>ssh {ssh.trim() || "vps"}</code> once in Terminal first so its host key is known; Deck never asks for a password.</>
          : <>Deck reaches {label} over SSH with a key this Mac already uses. It never asks for a password.</>}</p>
        <label>Name<input ref={first} data-field="name" readOnly={saving} value={name} onChange={(event) => edit(setName)(event.target.value)} placeholder="vps" maxLength={40} autoComplete="off" /></label>
        {taken && <small className="conn-taken" role="alert">Another server is already called {name.trim()}.</small>}
        <label>SSH destination<input className="mono" data-field="ssh" readOnly={saving} value={ssh} onChange={(event) => edit(setSsh)(event.target.value)} placeholder="me@vps.example.com or a ~/.ssh/config Host" spellCheck={false} autoCapitalize="off" autoComplete="off" /></label>
        <label>Daemon command<input className="mono" data-field="command" readOnly={saving} value={command} onChange={(event) => edit(setCommand)(event.target.value)} spellCheck={false} autoCapitalize="off" autoComplete="off" /></label>
        <small className="conn-cmd mono">ssh {ssh.trim() || "…"} {cmd} --stdio --attach</small>
        {moved && !test && <p className="conn-retarget"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          <span>{uses ? `${label} has ${uses}. ` : ""}Save checks that this still reaches the same machine. A different machine can be added as a new server instead, so no thread moves.</span></p>}
        {test && <div className={`conn-test ${test.state}`} role="status">{testing ? <><span className="conn-spin" aria-hidden="true" />{saving ? `Checking that ${ssh.trim()} is still ${label}…` : `Connecting to ${ssh.trim()}…`}</> : test.text}</div>}
        {problem && <div className="conn-test bad" role="alert">{problem}</div>}
        <div className="confirm-actions">
          {!add && api.check && <button type="button" className="conn-left" data-act="test" disabled={testing || !ssh.trim()} onClick={() => void runTest()}>Test connection</button>}
          <button type="button" data-act="cancel" onClick={onClose}>Cancel</button>
          {test?.state === "bad" && test.different
            ? <button type="button" className="primary" data-act="instead" onClick={insteadAdd}>Add as a new server</button>
            : <button type="submit" className="primary" data-act="save" disabled={saving || testing || taken || !name.trim() || !ssh.trim() || (!add && !api.update)}>{add ? "Add server" : "Save"}</button>}
        </div>
      </form>
    </div>
  );
}
