import { useEffect, useState } from "react";
import type { Backend } from "./backend";

export function CodeModeControl({ backend }: { backend: Backend }) {
  const [mode, setMode] = useState<"auto" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const apply = (raw: unknown) => {
      if (live) setMode((raw as { apexCodeMode?: unknown } | null)?.apexCodeMode === "off" ? "off" : "auto");
    };
    let changed = false;
    void backend.onSettingsChanged?.(raw => { changed = true; apply(raw); if (live) setStatus(""); }).then(off => { if (live) stop = off; else off(); }).catch(() => {});
    void backend.settingsLoad().then(raw => { if (!changed) apply(raw); }).catch(error => { if (live) setStatus(`Could not load: ${String(error)}`); });
    return () => { live = false; stop?.(); };
  }, [backend, reload]);
  async function save(next: "auto" | "off") {
    setBusy(true); setStatus("Saving…");
    try {
      const result = await backend.call<{ mode: "auto" | "off" }>("settings_code_mode_set", { enabled: next === "auto" });
      if (result.mode !== next) throw new Error("The machine did not confirm this change.");
      setMode(result.mode); setStatus(`Saved · ${result.mode === "auto" ? "Auto" : "Off"}`);
    } catch (error) { setStatus(`Could not confirm the save. Refresh to check. ${String(error)}`); }
    finally { setBusy(false); }
  }
  return <div>
    <select aria-label="Apex Code Mode" value={mode ?? ""} disabled={busy || mode === null} onChange={event => void save(event.target.value === "off" ? "off" : "auto")}>
      {mode === null && <option value="">Loading…</option>}
      <option value="auto">Auto</option><option value="off">Off</option>
    </select>
    <span role="status">{status}</span>
    {status.startsWith("Could not") && <button type="button" disabled={busy} onClick={() => { setStatus(""); setReload(value => value + 1); }}>Refresh</button>}
  </div>;
}
