import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConnectionSetupApi, ConnectionSetupReview, HostConnectionFields, HostEntry, HostPairingState } from "./backend";
import { ipcWords as words } from "./electronShell";

export function AddHostSheet({ api, hosts, fill, onClose, onSaved }: {
  api: ConnectionSetupApi; hosts: HostEntry[]; fill?: Partial<HostConnectionFields>;
  onClose(): void; onSaved(list: HostEntry[], message: string): void;
}) {
  const [page, setPage] = useState<"choose" | "ssh" | "pair">("choose");
  const [ssh, setSsh] = useState(fill?.ssh ?? "");
  const [name, setName] = useState(fill?.name ?? "");
  const [port, setPort] = useState(fill?.port?.toString() ?? "");
  const [command, setCommand] = useState(fill?.command ?? "apex-daemon");
  const [review, setReview] = useState<ConnectionSetupReview | null>(null);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [invitation, setInvitation] = useState("");
  const [pair, setPair] = useState<HostPairingState>({ kind: "idle" });
  const [pairActive, setPairActive] = useState(false);
  const dialog = useRef<HTMLFormElement>(null);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const callbacks = useRef({ onClose, onSaved });
  callbacks.current = { onClose, onSaved };
  useEffect(() => {
    const previous = document.activeElement;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      sequence.current++;
      void api.cancel().catch(() => {});
      void api.pairCancel().catch(() => {});
      window.removeEventListener("keydown", key, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [api]);
  useEffect(() => {
    if (!pairActive) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.pairStatus();
        if (!live) return;
        setPair(next);
        if (next.kind === "done") {
          setPairActive(false);
          callbacks.current.onSaved(next.hosts, "Host paired and connection verified. Access is managed on the host.");
          return;
        }
        if (next.kind === "failed") { setPairActive(false); return; }
        timer = setTimeout(() => void poll(), 350);
      } catch (error) { if (live) { setPair({ kind: "failed", message: words(error) }); setPairActive(false); } }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, pairActive]);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>((page === "ssh" && !review) || page === "pair" ? 'input' : 'button')?.focus(); }, [page, review]);

  const reset = (next: typeof page) => {
    sequence.current++;
    void api.cancel().catch(() => {});
    void api.pairCancel().catch(() => {});
    setPairActive(false); setPair({ kind: "idle" });
    setReview(null); setProblem(""); setPage(next);
  };
  const pairHost = () => run("Opening the host invitation…", async () => {
    const ticket = sequence.current;
    await api.pairStart(invitation.trim());
    if (ticket !== sequence.current) { void api.pairCancel().catch(() => {}); return; }
    setPair({ kind: "dialing" }); setPairActive(true);
  });
  const run = async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const ticket = ++sequence.current;
    setBusy(label); setProblem("");
    try { await action(); }
    catch (error) { if (ticket === sequence.current) { setReview(null); setProblem(words(error)); } }
    finally { busyRef.current = false; if (ticket === sequence.current) setBusy(""); }
  };
  const check = () => run("Checking SSH sign-in and machine identity…", async () => {
    const p = port.trim() === "" ? undefined : Number(port);
    if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("Enter a port from 1 to 65535, or leave it blank to use SSH configuration.");
    const label = name.trim() || ssh.trim().split("@").at(-1) || "";
    if (label.toLowerCase() === "this mac" || hosts.some(host => host.name.toLowerCase() === label.toLowerCase())) throw new Error(`Another host is already called ${label}.`);
    const ticket = sequence.current;
    const result = await api.check({ ssh: ssh.trim(), name: name.trim(), command: command.trim() || "apex-daemon", port: p });
    if (ticket === sequence.current) setReview(result);
  });
  const trust = () => run("Checking SSH with the trusted fingerprint…", async () => {
    const ticket = sequence.current;
    const result = await api.trust(review!.ticket);
    if (ticket === sequence.current) setReview(result);
  });
  const finish = () => run(review?.kind === "install" ? "Installing Deck and verifying the host connection…" : "Starting Deck if needed and verifying the host connection…", async () => {
    const ticket = sequence.current;
    const result = await api.finish(review!.ticket);
    if (ticket === sequence.current) callbacks.current.onSaved(result, `Connected ${name.trim() || ssh.trim()}. Pick a folder on it from Projects › +.`);
  });
  const title = page === "choose" ? "Add host" : page === "pair" ? "Pair an existing host" : review?.kind === "trust" ? "Trust this machine?" : review?.kind === "install" ? "Set up Deck on this host" : review?.kind === "ready" ? "Deck is ready" : "Connect over SSH";
  return createPortal(<div className="confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={dialog} className="confirm connection-dialog add-host-sheet" role="dialog" aria-modal="true" aria-labelledby="add-host-title" aria-busy={!!busy || pair.kind === "dialing" || pair.kind === "verifying"} onSubmit={event => { event.preventDefault(); if (!busy && page === "ssh") void (review?.kind === "trust" ? trust() : review ? finish() : check()); else if (!busy && page === "pair" && !pairActive && invitation.trim()) void pairHost(); }}>
      <strong id="add-host-title">{title}</strong>
      {page === "choose" && <>
        <p className="muted">Connect this desktop to another Mac or Linux server.</p>
        <button type="button" className="conn-route" onClick={() => reset("ssh")}><strong>Remote SSH →</strong><small>Use your SSH key. Deck checks the machine and guides setup.</small></button>
        <button type="button" className="conn-route" onClick={() => reset("pair")}><strong>QR code / pairing link →</strong><small>Deck already running there? Pair from its invitation.</small></button>
        <p className="muted">Connecting your iPhone? Keep using Pair a phone in Settings › Phones.</p>
      </>}
      {page === "pair" && <>
        <p className="muted">On the other machine, open Deck’s pairing invitation and copy its link here. Pair a phone in Settings › Phones also creates invitations for desktops. For a server, use <code>apex-daemon pair</code>.</p>
        <label>Pairing link<input value={invitation} disabled={!!busy || pairActive} onChange={event => { setInvitation(event.target.value); setPair({ kind: "idle" }); setProblem(""); }} placeholder="apexdeck://pair?p=…" autoComplete="off" spellCheck={false} autoCapitalize="off" /></label>
        <p className="muted">The host chooses this desktop’s access and which threads it can see. This flow uses a pasted link; it does not open a camera.</p>
        {pair.kind === "code" && <div className="conn-review" role="status"><strong>{pair.hostName} wants to pair</strong><p>Compare code <b className="mono">{pair.code.replace(/(.{3})(?=.)/g, "$1 ")}</b> on the other machine, then approve this desktop there.</p></div>}
        {(pair.kind === "dialing" || pair.kind === "verifying") && <p role="status">{pair.kind === "dialing" ? "Connecting to the invitation’s host…" : "Host approved. Verifying the paired connection…"}</p>}
        {pair.kind === "failed" && <p className="conn-test bad" role="alert">{pair.message}</p>}
      </>}
      {page === "ssh" && !review && <>
        <p className="muted">Use an SSH destination or saved alias. Deck uses your existing SSH key and configuration. No Terminal visit is needed for a direct connection.</p>
        <label>SSH destination<input value={ssh} disabled={!!busy} onChange={event => setSsh(event.target.value)} placeholder="me@server.example.com or build-box" autoComplete="off" autoCapitalize="off" spellCheck={false} required /></label>
        <label>Name (optional)<input value={name} disabled={!!busy} onChange={event => setName(event.target.value)} maxLength={40} placeholder="Uses the host name" autoComplete="off" /></label>
        <label>Port (optional)<input value={port} disabled={!!busy} onChange={event => setPort(event.target.value)} type="number" min="1" max="65535" step="1" placeholder="SSH configuration or 22" /></label>
        <details><summary>Advanced</summary><label>Daemon command<input value={command} disabled={!!busy} onChange={event => setCommand(event.target.value)} spellCheck={false} autoCapitalize="off" autoComplete="off" /></label></details>
      </>}
      {review?.kind === "trust" && <>
        <p className="muted">First connection to {ssh}{port ? `:${port}` : ""}. Compare this fingerprint with the machine’s trusted record before continuing. Changed keys stop setup.</p>
        <div className="conn-review"><strong>SSH host key · {review.algorithm}</strong><code className="conn-cmd">{review.fingerprint}</code></div>
        <p className="muted">Trust saves this public key in Deck’s SSH known hosts. Nothing is installed.</p>
      </>}
      {review && review.kind !== "trust" && <>
        <ol className="conn-steps"><li>SSH sign-in checked</li><li>Machine identity checked</li><li>{review.kind === "ready" ? "Existing Deck installation found" : "Deck installation needed"}</li></ol>
        <div className="conn-review"><strong>{review.kind === "ready" ? "Use the existing installation" : "Install Deck for this account"}</strong><p>{review.kind === "ready" ? "Connect starts the host service if needed, then verifies the daemon identity before adding this host." : "Deck downloads and checks the Linux release, installs it in ~/.local/bin, starts the host service, then verifies the connection. Installation begins only when you continue."}</p></div>
        {review.os === "Linux" && <p className="muted">Servers without a persistent user service may stop Deck at sign-out. Closing this window stops setup; installation already started may remain on the server.</p>}
      </>}
      {busy && <div className="conn-test" role="status"><span className="conn-spin" aria-hidden="true" />{busy}</div>}
      {problem && <p className="conn-test bad" role="alert">{problem}</p>}
      <div className="confirm-actions">
        {page !== "choose" && <button type="button" className="conn-left" disabled={!!busy} onClick={() => reset(review ? "ssh" : "choose")}>Back</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        {page === "ssh" && <button type="submit" className="primary" disabled={!!busy || !ssh.trim()}>{review?.kind === "trust" ? "Trust and continue" : review?.kind === "install" ? "Install and connect" : review ? "Connect host" : "Check connection"}</button>}
        {page === "pair" && <button type="submit" className="primary" disabled={!!busy || pairActive || !invitation.trim()}>Pair host</button>}
      </div>
    </form>
  </div>, document.body);
}
