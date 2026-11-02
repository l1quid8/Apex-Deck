import { useEffect, useState } from "react";
import type { Backend } from "./backend";

interface TrustInfo {
  exists: boolean;
  trusted: boolean;
  epoch: string;
  trusted_at_ms: number;
  boot_id: string;
  accepted_folders?: { path: string; who: string | null; when_ms: number }[];
  raw?: unknown;
}

const words = (e: unknown) => String(e instanceof Error ? e.message : e);

export function TrustHostSettings({ backend }: { backend: Backend }) {
  const [info, setInfo] = useState<TrustInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      // @ts-ignore trust_status is new, may not exist on old daemon
      const result = await (backend as any).call?.("trust_status", {}) ?? await (backend as any).call?.("trust_status");
      if (result) setInfo(result as TrustInfo);
      else throw new Error("No trust status");
    } catch {
      // Fallback: try via backend.call directly if available as pairedDevices pattern
      try {
        const r = await (backend as any).call?.("trust_status", {});
        setInfo(r as TrustInfo);
      } catch (e) {
        setInfo({ exists: false, trusted: false, epoch: "", trusted_at_ms: 0, boot_id: "" });
      }
    }
  };

  useEffect(() => { void load(); }, [backend]);

  const trustNow = async () => {
    setBusy(true); setError("");
    try {
      await (backend as any).call?.("trust_run", { no_reboot: true });
      await load();
    } catch (e) { setError(words(e)); }
    finally { setBusy(false); }
  };

  if (!info) return <div className="settings-row"><span className="muted">Loading trust status…</span></div>;

  return (
    <div className="settings-card trust-host">
      <div className="settings-row">
        <div className="settings-label">
          <strong>Host trust</strong>
          {info.trusted
            ? <small>Trusted on {new Date(info.trusted_at_ms).toLocaleString()} · Boot {info.boot_id.slice(0, 8)}… · Epoch {info.epoch.slice(0, 8)}…</small>
            : <small className="muted">Not trusted yet — paired devices with old epoch cannot act. Run “apex-daemon trust-host” on this machine or tap Trust below. Trust records who and when; withdrawing stops Full bots there.</small>}
          {info.accepted_folders && info.accepted_folders.length > 0 && (
            <small>Accepted tainted folders: {info.accepted_folders.map(f => f.path).join(", ")}</small>
          )}
          <small className="mono muted">host-trust.json · {info.exists ? "present" : "missing"}</small>
        </div>
        <span className="host-actions">
          {!info.trusted && <button className="primary" disabled={busy} onClick={trustNow}>{busy ? "Trusting…" : "Trust this machine"}</button>}
        </span>
      </div>
      {error && <div className="settings-row"><span className="error" role="alert">{error}</span></div>}
      <div className="settings-row">
        <small className="muted">Deck can&apos;t check this machine for you. Only continue if you trust what has run on this account. A rebuild or new Linux user is the only clean answer. Reboot after trust if you can; otherwise use --no-reboot.</small>
      </div>
    </div>
  );
}
