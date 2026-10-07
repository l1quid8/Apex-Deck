import { useEffect, useMemo, useState } from "react";

import type { Backend } from "./backend";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { TIERS, devicesApi, lastSeenText, shortId, threadsText, type PairedDevice, type Tier } from "./pairedDevices";

// Settings → Paired devices: each phone allowed in from outside this network,
// its access level, and Revoke, which cuts it off at once and for good.

export function PairedDevicesSettings({ backend }: { backend: Backend }) {
  const api = useMemo(() => devicesApi(backend), [backend]);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState<Question | null>(null);
  const refresh = () => api.list().then((r) => { setDevices(r.devices); setProblem(""); }, (e) => setProblem(String(e instanceof Error ? e.message : e)));
  useEffect(() => { void refresh(); }, [api]);
  const fail = (e: unknown) => setProblem(String(e instanceof Error ? e.message : e));
  const setTier = (device: PairedDevice, tier: Tier) => api.setTier(device.endpointId, tier).then(refresh, fail);
  const revoke = (device: PairedDevice) => setAsking({
    title: `Revoke ${device.label}?`,
    body: "It's disconnected now and can never connect again with this pairing. Anything it already started keeps running.",
    action: "Revoke",
    onConfirm: () => { setAsking(null); void api.revoke(device.endpointId).then(refresh, fail); },
  });
  return (
    <div className="settings-card paired-devices">
      {devices?.length === 0 && <div className="settings-row"><div className="settings-label"><strong>No paired devices</strong><small className="muted">Pairing a phone by QR code arrives in a later update.</small></div></div>}
      {devices?.map((device) => (
        <div key={device.endpointId} className="settings-row">
          <div className="settings-label">
            <strong>{device.label}</strong>
            <small className="muted">Added {new Date(device.addedAt).toLocaleDateString()} · {lastSeenText(device.lastSeen)} · {threadsText(device.threads)}</small>
            <small className="mono muted" title={device.endpointId}>{shortId(device.endpointId)}</small>
            <small className="muted">{TIERS.find((t) => t.id === device.tier)?.note}</small>
          </div>
          <span className="host-actions">
            <select aria-label={`Access for ${device.label}`} value={device.tier} onChange={(e) => void setTier(device, e.target.value as Tier)}>
              {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <button className="ghost" onClick={() => revoke(device)}>Revoke</button>
          </span>
        </div>
      ))}
      {problem && <div className="settings-row"><span className="error" role="alert">{problem}</span></div>}
      {asking && <ConfirmDialog question={asking} onCancel={() => setAsking(null)} />}
    </div>
  );
}
