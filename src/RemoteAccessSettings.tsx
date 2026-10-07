import { useEffect, useMemo, useState } from "react";

import type { Backend, RemoteAccessApi, RemoteAccessState } from "./backend";
import { pairingApi, parseAddresses, type RemoteInfo } from "./pairing";

// Settings → Remote access: whether paired phones may reach this Mac from
// anywhere (the daemon serves `--remote`), its endpoint ID and UDP port, and
// addresses to put in new pairing codes for a direct connection.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RemoteAccessSettings({ backend, remote }: { backend: Backend; remote: RemoteAccessApi }) {
  const api = useMemo(() => pairingApi(backend), [backend]);
  const [access, setAccess] = useState<RemoteAccessState | null>(null);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [addresses, setAddresses] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [problem, setProblem] = useState("");
  const fail = (e: unknown) => setProblem(String(e instanceof Error ? e.message : e));
  const showInfo = (next: RemoteInfo) => { setInfo(next); setAddresses(next.advertise.join(", ")); };

  useEffect(() => {
    remote.get().then(setAccess, fail);
    api.info().then(showInfo, fail);
  }, [api, remote]);

  /** After a restart the window reconnects by itself; ask until the daemon answers with the new state. */
  const settle = async (on: boolean) => {
    for (let i = 0; i < 40; i++) {
      try {
        const next = await api.info();
        if (next.enabled === on || i >= 39) { showInfo(next); return; }
      } catch {
        // Still reconnecting.
      }
      await wait(500);
    }
  };

  const toggle = async (on: boolean) => {
    setProblem("");
    setSavedNote("");
    setRestarting(true);
    try {
      const next = await remote.set(on);
      setAccess(next);
      if (next.owned) await settle(on);
      else api.info().then(showInfo, () => {});
    } catch (e) {
      // The old setting was put back; show it, and the daemon's words.
      fail(e);
      remote.get().then(setAccess, () => {});
      api.info().then(showInfo, () => {});
    } finally {
      setRestarting(false);
    }
  };

  const saveAddresses = () => {
    setProblem("");
    setSavedNote("");
    api.advertise(parseAddresses(addresses)).then(
      ({ advertise }) => {
        setAddresses(advertise.join(", "));
        setInfo((old) => (old ? { ...old, advertise } : old));
        setSavedNote(advertise.length ? "Saved. New pairing codes carry these addresses." : "Cleared.");
      },
      // A `bad_address` refusal names the input and the expected shape.
      fail,
    );
  };

  const on = access?.on ?? false;
  const mismatch = access !== null && info !== null && !restarting && info.enabled !== access.on;
  const changed = info ? addresses.trim() !== info.advertise.join(", ") : addresses.trim() !== "";
  return (
    <div className="settings-card remote-access">
      <div className="settings-row">
        <div className="settings-label">
          <strong>Allow paired phones to connect from anywhere</strong>
          <small>Off by default. When on, phones you pair reach this Mac over the internet through Apex's relay, or directly when they can. Only phones you approve get in. Changing this restarts Deck's background service; open threads reconnect by themselves.</small>
          {restarting && <small className="muted" role="status">Restarting the background service…</small>}
          {mismatch && !access?.owned && <small className="muted" role="status">Deck didn't start the background service that's running, so it keeps its own setting until it restarts. Start it with <span className="mono">apex-daemon serve --remote</span> to turn this on now.</small>}
          {mismatch && access?.owned && <small className="error" role="alert">The background service is running with Remote access {info?.enabled ? "on" : "off"}.</small>}
        </div>
        <input type="checkbox" role="switch" aria-label="Allow paired phones to connect from anywhere" disabled={access === null || restarting} checked={on} onChange={(e) => void toggle(e.target.checked)} />
      </div>
      <div className="settings-row">
        <div className="settings-label">
          <strong>Endpoint ID</strong>
          <small>How phones find this Mac. It stays the same across restarts.</small>
          <small className="mono muted" title={info?.endpoint_id ?? undefined}>{info?.endpoint_id ? info.endpoint_id : info ? "Shown while remote access is on" : "…"}</small>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-label">
          <strong>UDP port</strong>
          <small>Picked on first start, then kept. Forward this port on your router for a direct connection from outside.</small>
        </div>
        <span className="mono">{info?.port ?? "Not chosen yet"}</span>
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
      {problem && <div className="settings-row"><span className="error" role="alert">{problem}</span></div>}
    </div>
  );
}
