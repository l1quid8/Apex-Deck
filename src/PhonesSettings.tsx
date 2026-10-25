import { useEffect, useMemo, useState } from "react";

import type { Backend, RemoteAccessApi } from "./backend";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { PairPhoneSheet } from "./PairPhoneSheet";
import { TIERS, devicesApi, lastSeenText, shortId, threadsText, type PairedDevice, type Tier } from "./pairedDevices";
import { pairingApi, parseAddresses, phonesStatus, type RemoteInfo } from "./pairing";

// Settings → Phones: Pair phone, whether phones can connect at all, each
// paired phone with its access level and Revoke, and under Advanced the
// endpoint ID, UDP port and advertised addresses. Turning connections on or
// off is live in the daemon; nothing restarts.

const wordsOf = (e: unknown) => String(e instanceof Error ? e.message : e);

export function PhonesSettings({ backend }: { backend: Backend }) {
  const remote = backend.remoteAccess;
  const devicesCall = useMemo(() => devicesApi(backend), [backend]);
  const pairCall = useMemo(() => pairingApi(backend), [backend]);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState<Question | null>(null);
  const [pairing, setPairing] = useState(false);
  const [addresses, setAddresses] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const fail = (e: unknown) => setProblem(wordsOf(e));
  const showInfo = (next: RemoteInfo) => { setInfo(next); setAddresses(next.advertise.join(", ")); };

  const loadDevices = () => devicesCall.list().then((r) => { setDevices(r.devices); setProblem(""); return r.devices; }, (e) => { fail(e); return null; });
  const loadAccess = (r: RemoteAccessApi) => Promise.all([
    r.get().then((a) => setOn(a.on), fail),
    pairCall.info().then(showInfo, fail),
  ]);
  useEffect(() => { void loadDevices(); }, [devicesCall]);
  useEffect(() => { if (remote) void loadAccess(remote); }, [remote, pairCall]);

  const turn = async (next: boolean) => {
    if (!remote) return;
    setProblem("");
    setSavedNote("");
    setBusy(true);
    try {
      setOn((await remote.set(next)).on);
      showInfo(await pairCall.info());
    } catch (e) {
      fail(e);
      void loadAccess(remote).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  // After the last phone goes, ask once whether to close connections too.
  const askAfterLast = () => setAsking({
    title: "No phones are paired",
    body: "Turn off phone connections too?",
    action: "Turn off",
    cancel: "Keep on",
    onConfirm: () => void turn(false),
  });
  const setTier = (device: PairedDevice, tier: Tier) => devicesCall.setTier(device.endpointId, tier).then(loadDevices, fail);
  const revoke = (device: PairedDevice) => setAsking({
    title: `Revoke ${device.label}?`,
    body: "It's disconnected now and can never connect again with this pairing. Anything it already started keeps running.",
    action: "Revoke",
    onConfirm: () => {
      setAsking(null);
      void devicesCall.revoke(device.endpointId).then(loadDevices, (e) => { fail(e); return null; }).then((left) => {
        if (left?.length === 0 && on) askAfterLast();
      });
    },
  });

  const saveAddresses = () => {
    setProblem("");
    setSavedNote("");
    pairCall.advertise(parseAddresses(addresses)).then(
      ({ advertise }) => {
        setAddresses(advertise.join(", "));
        setInfo((old) => (old ? { ...old, advertise } : old));
        setSavedNote(advertise.length ? "Saved. New pairing codes carry these addresses." : "Cleared.");
      },
      // A `bad_address` refusal names the input and the expected shape.
      fail,
    );
  };

  const status = on === null || devices === null ? null : phonesStatus(on, devices.length);
  const changed = info ? addresses.trim() !== info.advertise.join(", ") : addresses.trim() !== "";
  return (<>
    <div className="settings-actions phones-status">
      <button onClick={() => setPairing(true)}>Pair phone</button>
      {remote && <div className="phones-status-text" role="status">
        <span>{status?.line ?? "…"}</span>
        {status?.note && <small>{status.note}</small>}
      </div>}
      {remote && status?.action && <button className="ghost" disabled={busy} onClick={() => void turn(status.action === "Turn on")}>{busy ? (status.action === "Turn on" ? "Turning on…" : "Turning off…") : status.action}</button>}
    </div>
    <div className="settings-card paired-devices">
      {devices?.length === 0 && <div className="settings-row"><div className="settings-label"><strong>No phones yet</strong><small className="muted">Pair phone shows a code to scan with the iPhone camera.</small></div></div>}
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
    </div>
    {remote && on && info && <details className="settings-card phones-advanced">
      <summary>Advanced</summary>
      <div className="settings-row">
        <div className="settings-label">
          <strong>Endpoint ID</strong>
          <small>How phones find this Mac. It stays the same across restarts.</small>
          <small className="mono muted" title={info.endpoint_id ?? undefined}>{info.endpoint_id ?? "…"}</small>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-label">
          <strong>UDP port</strong>
          <small>Picked on first start, then kept. Forward it on your router for a direct connection from outside.</small>
        </div>
        <span className="mono">{info.port ?? "Not chosen yet"}</span>
      </div>
      <div className="settings-row remote-addresses">
        <div className="settings-label">
          <strong>Advertised addresses</strong>
          <small>Optional. A public name or address with that port forwarded to this Mac, like myhome.ddns.net:41641. New pairing codes carry it, and paired phones learn it when they connect.</small>
          <input aria-label="Advertised addresses" placeholder="myhome.ddns.net:41641" spellCheck={false} value={addresses} onChange={(e) => { setAddresses(e.target.value); setSavedNote(""); }} onKeyDown={(e) => { if (e.key === "Enter" && changed) saveAddresses(); }} />
          {savedNote && <small className="muted" role="status">{savedNote}</small>}
        </div>
        <button disabled={!changed} onClick={saveAddresses}>Save</button>
      </div>
    </details>}
    {asking && <ConfirmDialog question={asking} onCancel={() => setAsking(null)} />}
    {pairing && <PairPhoneSheet backend={backend} onClose={() => { setPairing(false); void loadDevices(); if (remote) void loadAccess(remote); }} onPaired={() => void loadDevices()} />}
  </>);
}
