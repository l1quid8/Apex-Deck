import { useEffect, useRef, useState } from "react";
import type { PhoneHost } from "../phoneBackend";

/** Host preferences are explicitly targeted, never saved as phone preferences. */
export function CodeModeSettings({ hosts }: { hosts: PhoneHost[] }) {
  const [id, setId] = useState(hosts[0]?.machine.id ?? "");
  const host = hosts.find(item => item.machine.id === id);
  const target = useRef(host);
  target.current = host;
  const [mode, setMode] = useState<"auto" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [, refresh] = useState(0);
  useEffect(() => host?.connection.subscribe(() => refresh(value => value + 1)), [host]);
  const connected = host?.connection.get().status.kind === "connected";
  const access = host?.access();
  const allowed = host && (!access || (access.tier === "full" && access.threads === "all"));
  useEffect(() => {
    let current = true;
    let changed = false;
    let stop: (() => void) | undefined;
    setMode(null);
    setStatus("");
    if (host && connected && allowed) {
      void host.backend.onSettingsChanged?.(raw => {
        changed = true;
        if (current) {
          setMode((raw as { apexCodeMode?: unknown } | null)?.apexCodeMode === "off" ? "off" : "auto");
          setStatus("");
        }
      }).then(off => { if (current) stop = off; else off(); }).catch(() => {});
      void host.backend.settingsLoad().then(raw => {
        if (!current || changed) return;
        setMode((raw as { apexCodeMode?: unknown } | null)?.apexCodeMode === "off" ? "off" : "auto");
      }).catch(error => { if (current) setStatus(String(error)); });
    }
    return () => { current = false; stop?.(); };
  }, [host, connected, allowed, reload]);
  async function save(next: "auto" | "off") {
    if (!host || !connected || !allowed || busy) return;
    setBusy(true);
    setStatus(`Saving on ${host.machine.name}…`);
    try {
      const result = await host.backend.call<{ mode: "auto" | "off" }>("settings_code_mode_set", { enabled: next === "auto" });
      if (target.current !== host) return;
      if (result.mode !== next) throw new Error("The machine did not confirm this change.");
      setMode(result.mode);
      setStatus(`${host.machine.name} confirmed ${next === "auto" ? "Auto" : "Off"}.`);
    } catch (error) {
      if (target.current !== host) return;
      setStatus(`Could not confirm the save. Refresh to check the machine. ${String(error)}`);
    } finally { setBusy(false); }
  }
  return <section className="ph-list" aria-labelledby="machine-general-title">
    <h3 id="machine-general-title">General · machine settings</h3>
    <label className="ph-srow">Machine
      <select aria-label="Machine for General settings" value={id} disabled={busy} onChange={event => setId(event.target.value)}>
        {!hosts.some(item => item.machine.id === id) && <option value="">Choose a machine</option>}
        {hosts.map(item => <option key={item.machine.id} value={item.machine.id}>{item.machine.name}</option>)}
      </select>
    </label>
    <label className="ph-srow"><span className="ph-grow"><strong>Apex Code Mode</strong><small>Let supported API models, Claude Code and Codex batch tool calls and filter results to reduce context use.</small></span>
      <select aria-label="Apex Code Mode" value={mode ?? ""} disabled={!connected || !allowed || mode === null || busy} onChange={event => void save(event.target.value === "off" ? "off" : "auto")}>
        {mode === null && <option value="">Unavailable</option>}
        <option value="auto">Auto</option><option value="off">Off</option>
      </select>
    </label>
    <p>Applies to all agents on the selected machine. Off stops active batches and pending batch approvals; completed writes stay in place. Ordinary tools remain available.</p>
    <p role="status">{!host ? "Pair and select a machine." : !connected ? `${host.machine.name} is disconnected. Nothing will be queued.` : !allowed ? `Full access is required on ${host.machine.name}, with access to all threads.` : status || (mode === null ? "Loading machine settings…" : `Saved on ${host.machine.name}, not this phone.`)}</p>
    <button type="button" disabled={!host || !connected || !allowed || busy} onClick={() => setReload(value => value + 1)}>Refresh machine settings</button>
  </section>;
}
