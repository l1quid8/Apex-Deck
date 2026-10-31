import { useEffect, useRef, useState } from "react";

import { Check, Lock, X } from "./icons";
import { goodPort, MAX_KEY_BYTES, readKey, sshFormError, sshRequest, sshTarget, type SetupEvent, type SshForm, type SshKey, type SshSetup } from "./sshSetup";

const words = (error: unknown) => String(error).replace(/^Error: /, "");

interface Line { id: string; text: string; failed?: boolean }

/**
 * Remote SSH on Add a machine: the form, then a list that runs by itself.
 * Secrets live in this component's state only, so leaving it drops them.
 * `setup` is null until this build can sign in over SSH; Connect then says so.
 */
export function RemoteSsh({ setup, onCancel, onDone }: { setup: SshSetup | null; onCancel?: () => void; onDone(): void }) {
  const [form, setForm] = useState<SshForm>({ label: "", host: "", user: "", port: "22", password: "", key: null, passphrase: "", keep: false });
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [paired, setPaired] = useState(false);
  const [end, setEnd] = useState<{ failed: boolean; message: string } | null>(null);
  const run = useRef<{ cancel(): void } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => run.current?.cancel(), []);

  const target = sshTarget(form);
  const change = (next: Partial<SshForm>) => { setError(""); setForm({ ...form, ...next }); };
  const typed = form.host.trim();
  const cleaned = target.host !== "" && target.host !== typed;

  const importKey = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      if (file.size > MAX_KEY_BYTES) throw new Error("That file is too big to be a private key.");
      const key: SshKey = readKey(file.name, await file.text());
      setForm((current) => ({ ...current, key, passphrase: "" }));
    } catch (failure) { setError(words(failure)); }
  };

  const heard = (event: SetupEvent) => {
    if (event.kind === "step") setLines((list) => [...(list ?? []).filter((line) => line.id !== event.id), { id: event.id, text: event.text }]);
    else if (event.kind === "paired") setPaired(true);
    else if (event.kind === "done") { run.current = null; setEnd({ failed: false, message: event.message }); }
    else {
      run.current = null;
      setLines((list) => [...(list ?? []).filter((line) => line.id !== event.id), { id: event.id, text: event.label, failed: true }]);
      setEnd({ failed: true, message: event.message });
    }
  };

  const connect = () => {
    const wrong = sshFormError(form);
    if (wrong) { setError(wrong); return; }
    if (!setup) { setError("Remote SSH isn't in this build yet. Use a QR code for now."); return; }
    setError("");
    setLines([]);
    setPaired(false);
    setEnd(null);
    run.current = setup(sshRequest(form), heard);
  };

  if (lines) {
    const failed = end?.failed === true;
    const name = form.label.trim() || target.host;
    const status = end?.message ?? (paired ? "Paired and saved. Safe to close now." : `Setting up ${name}… If this stops before pairing, nothing is added to this phone. Connect again and it picks up where it left off, never adding a second copy.`);
    return <>
      <div className="ph-list">
        {lines.map((line) => <div key={line.id} className="ph-srow"><span className="ph-srow-icon">{line.failed ? <span className="ph-red"><X size={16} /></span> : <Check size={16} />}</span><span className={`ph-grow${line.failed ? " ph-red" : ""}`}>{line.text}</span></div>)}
      </div>
      <p className={`ph-sheet-text${failed ? " ph-red" : " ph-quiet"}`} role={failed ? "alert" : "status"}>{status}</p>
      {failed
        ? <button type="button" className="primary ph-wide" onClick={() => setLines(null)}>Back</button>
        : <button type="button" className="primary ph-wide" disabled={!paired} onClick={onDone}>Done</button>}
    </>;
  }

  return <form onSubmit={(event) => { event.preventDefault(); connect(); }}>
    <p className="ph-sheet-text">For a server you can SSH into. Tap Connect and the phone does the rest: installs or updates Deck if needed, pairs, then signs out. Chats use the paired link, not SSH.</p>
    <label className="ph-label">Label (optional)<input value={form.label} onChange={(event) => change({ label: event.target.value })} placeholder="My Remote VPS" autoCapitalize="words" /><small>Shown in Chats. Blank uses the machine's own name.</small></label>
    <label className="ph-label">IP or host<input value={form.host} onChange={(event) => change({ host: event.target.value })} placeholder="203.0.113.10 or server.example.com" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />{cleaned && <small>SSH uses the bare host, so this connects to <b>{target.host}</b>{target.fromHost && goodPort(target.port) ? <> on port <b>{target.port}</b></> : null}.</small>}</label>
    <div className="ph-row2">
      <label className="ph-label">User<input value={form.user} onChange={(event) => change({ user: event.target.value })} placeholder="demo" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
      <label className="ph-label ph-port">Port<input value={target.port} disabled={target.fromHost} onChange={(event) => change({ port: event.target.value.replace(/\D/g, "") })} inputMode="numeric" />{target.fromHost && <small>From the address</small>}</label>
    </div>
    <label className="ph-label">Password (optional)<input type="password" value={form.password} onChange={(event) => change({ password: event.target.value })} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>For password sign-in, and for admin rights (sudo). Without it, Deck installs just for this user and Codex can't chat there (it needs bubblewrap, which needs sudo). A key is safer for signing in.</small></label>
    <span className="ph-label">Private key</span>
    {form.key
      ? <div className="ph-group ph-srow"><span className="ph-srow-icon">{form.key.locked ? <Lock size={16} /> : <Check size={16} />}</span><span className="ph-grow"><strong>{form.key.name}</strong><small>OpenSSH · {form.key.type} · {form.key.locked ? "locked with a passphrase" : "no passphrase"}</small></span><button type="button" className="ph-plain" onClick={() => change({ key: null, passphrase: "" })}>Remove</button></div>
      : <>
        <input ref={picker} className="ph-hidden-file" type="file" tabIndex={-1} aria-hidden="true" onChange={(event) => { void importKey(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" className="ph-wide" onClick={() => picker.current?.click()}>Import private key from Files</button>
        <small className="ph-muted">The phone can't see your computer's ~/.ssh. AirDrop or save the key (id_ed25519) into Files first.</small>
      </>}
    {form.key?.locked && <label className="ph-label ph-after-key">Private key passphrase<input type="password" value={form.passphrase} onChange={(event) => change({ passphrase: event.target.value })} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><small>This key is locked, so the passphrase is needed. Keys without one skip this box. Unlocks the key on this phone only; never sent to the server.</small></label>}
    {(form.key || form.password) && <>
      <span className="ph-label ph-after-key">After setup</span>
      <div className="ph-segment" role="radiogroup" aria-label="After setup">
        <button type="button" role="radio" aria-checked={!form.keep} onClick={() => change({ keep: false })}>Forget sign-in</button>
        <button type="button" role="radio" aria-checked={form.keep} onClick={() => change({ keep: true })}>Keep with Face ID</button>
      </div>
      <p className="ph-muted">{form.keep ? "Key, passphrase and password stay in this phone's Keychain and open only with Face ID. Use them to repair the pairing later." : "Deck's imported copy of the key, the passphrase and the password are wiped from this phone once setup ends. Nothing is saved. Your original key file in Files is not touched."}</p>
    </>}
    {error && <p className="ph-sheet-text ph-red" role="alert">{error}</p>}
    <button type="submit" className="primary ph-wide">Connect</button>
    {onCancel && <button type="button" className="ph-plain ph-wide" onClick={onCancel}>Cancel</button>}
  </form>;
}
