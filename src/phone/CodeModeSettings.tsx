import { useEffect, useRef, useState } from "react";
import type { PhoneHost } from "../phoneBackend";

/** Host preferences are explicitly targeted to one machine, never saved as phone preferences. */
export function CodeModeSettings({ host }: { host: PhoneHost | null }) {
  const target = useRef(host);
  target.current = host;
  const [mode, setMode] = useState<"auto" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [, refresh] = useState(0);
  useEffect(() => host?.connection.subscribe(() => refresh(value => value + 1)), [host]);
  const connected = host?.connection.get().status.kind === "connected";
  useEffect(() => {
    let current = true;
    let changed = false;
    let stop: (() => void) | undefined;
    setMode(null);
    setStatus("");
    if (host && connected) {
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
  }, [host, connected, reload]);
  async function save(next: "auto" | "off") {
    if (!host || !connected || busy) return;
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
  return (
    <section className="ph-list" aria-labelledby="machine-code-mode-title">
      <label className="ph-srow">
        <span className="ph-grow">
          <strong id="machine-code-mode-title">Apex Code Mode</strong>
          <small>Let supported API models, Claude Code and Codex batch tool calls and filter results to reduce context use.</small>
        </span>
        <select aria-label="Apex Code Mode" value={mode ?? ""} disabled={!connected || mode === null || busy} onChange={event => void save(event.target.value === "off" ? "off" : "auto")}>
          {mode === null && <option value="">Unavailable</option>}
          <option value="auto">Auto</option>
          <option value="off">Off</option>
        </select>
      </label>
      <p className="ph-list-note">Applies to all agents on {host?.machine.name ?? "this machine"}. Off stops active batches and pending batch approvals; completed writes stay in place. Ordinary tools remain available.</p>
      <p className="ph-list-note" role="status">{!host ? "Pair a machine first." : !connected ? `${host.machine.name} is disconnected. Nothing will be queued.` : status || (mode === null ? "Loading machine settings…" : `Saved on ${host.machine.name}, not this phone.`)}</p>
      <button type="button" className="ph-wide" disabled={!host || !connected || busy} onClick={() => setReload(value => value + 1)}>Refresh machine settings</button>
    </section>
  );
}
