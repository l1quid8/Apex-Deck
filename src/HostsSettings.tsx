import { useEffect, useState, useSyncExternalStore } from "react";

import type { Backend, HostEntry, HostsApi } from "./backend";
import { ipcWords as words } from "./electronShell";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { ConnectionDialog, type ConnectionMode } from "./ConnectionDialog";
import { DOT_WORDS, hostLine } from "./hostFacts.ts";

// Settings → Hosts: this Mac, and other machines running apex-daemon that
// Deck reaches with ssh. Each server's threads stay on it; Edit… changes how
// Deck reaches a server, never which machine it is. Add host opens the same
// window Edit… does.

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function HostsSettings({ backend, hosts }: { backend: Backend; hosts: HostsApi }) {
  const [list, setList] = useState<HostEntry[]>([]);
  /** The add or edit window, when one is open. */
  const [dialog, setDialog] = useState<ConnectionMode | null>(null);
  const [asking, setAsking] = useState<Question | null>(null);
  /** Why the last action on a host failed, shown on that host's line. */
  const [problem, setProblem] = useState<{ hostId: string; words: string } | null>(null);
  useEffect(() => {
    hosts.list().then(setList, () => setList([]));
  }, [hosts]);
  const remove = (host: HostEntry) => {
    setProblem(null);
    setAsking({
      title: `Remove ${host.name}?`,
      body: "Deck stops connecting to it. Nothing on that machine is deleted, and you can add it again later.",
      action: "Remove",
      onConfirm: () => {
        setAsking(null);
        hosts.remove(host.id).then(setList, (error) => setProblem({ hostId: host.id, words: words(error) }));
      },
    });
  };
  const open = (mode: ConnectionMode) => { setProblem(null); setDialog(mode); };
  const hasRemote = list.some((host) => host.remote);
  return (<>
    <div className="settings-actions">
      <button disabled={backend.demo} onClick={() => open({ kind: "add" })}>+ Add host</button>
      <span>Deck reaches other machines over SSH. It never asks for a password.</span>
    </div>
    <div className="settings-card hosts">
      {list.map((host) => (
        <HostItem key={host.id} backend={backend} host={host} problem={problem?.hostId === host.id ? problem.words : ""} clearProblem={() => setProblem(null)}
          edit={hosts.update ? () => open({ kind: "edit", hostId: host.id }) : undefined} remove={() => remove(host)} />
      ))}
      {!hasRemote && (
        <div className="hosts-empty">
          <span className="hdot blank" />
          <div className="hosts-text">
            <strong>No other machines yet</strong>
            <small>Add a Linux server or another Mac that runs apex-daemon.</small>
          </div>
          <button className="sm" disabled={backend.demo} onClick={() => open({ kind: "add" })}>+ Add host</button>
        </div>
      )}
    </div>
    {dialog && <ConnectionDialog mode={dialog} hosts={list} api={hosts} onClose={() => setDialog(null)} onSaved={(next) => { setList(next); setDialog(null); }} />}
    {asking && <ConfirmDialog question={asking} onCancel={() => setAsking(null)} />}
  </>);
}

function HostItem({ backend, host, problem, clearProblem, edit, remove }: { backend: Backend; host: HostEntry; problem: string; clearProblem(): void; edit?: () => void; remove(): void }) {
  const c = backend.machines?.connection(host.id);
  const state = useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.get ?? (() => null));
  const line = hostLine(host.name, state, { version: __APP_VERSION__, build: __APP_BUILD__ }, time);
  const retry = () => { clearProblem(); backend.machines?.get(host.id); c?.retryNow(); };
  const label = line.action === "connect" ? "Connect" : "Retry";
  const tone = line.tone === "plain" ? "" : ` ${line.tone}`;
  return (
    <div className="hosts-item">
      <span className={`hdot ${line.dot}`} role="img" aria-label={DOT_WORDS[line.dot]} title={`${host.name}: ${DOT_WORDS[line.dot]}`} />
      <div className="hosts-text">
        <span className="hosts-name">{host.name}</span>
        {host.remote && <span className="hosts-addr" title={`ssh ${host.ssh} ${host.command} --stdio --attach`}>{host.ssh}</span>}
        <span className={`hosts-state${tone}`}>{line.text}</span>
        {line.why && <span className="hosts-why">{line.why}</span>}
        {line.notice && <span className="hosts-state warn">{line.notice}</span>}
        {problem && <div className="hosts-problem" role="alert">{problem}</div>}
      </div>
      {(line.action || host.remote) && (
        <div className="hosts-buttons">
          {line.action && <button className="sm" onClick={retry}>{label}</button>}
          {host.remote && edit && <button className="sm" onClick={edit}>Edit…</button>}
          {host.remote && <button className="sm ghost" onClick={remove}>Remove</button>}
        </div>
      )}
    </div>
  );
}
