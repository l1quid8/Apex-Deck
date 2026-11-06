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

export function TrustHostSettings({ backend }: { backend: Backend }) {
  const [info, setInfo] = useState<TrustInfo | null>(null);

  const load = async () => {
    try {
      const result = await (backend as any).call?.("trust_status", {});
      if (result) setInfo(result as TrustInfo);
    } catch {
      setInfo({ exists: false, trusted: false, epoch: "", trusted_at_ms: 0, boot_id: "" });
    }
  };

  useEffect(() => { void load(); }, [backend]);

  if (!info) return <div className="settings-row"><span className="muted">Loading trust status…</span></div>;

  return (
    <div className="settings-card trust-host">
      <div className="settings-row">
        <div className="settings-label">
          <strong>Host trust</strong>
          {info.trusted
            ? <small>Trusted on {new Date(info.trusted_at_ms).toLocaleString()} · Boot {info.boot_id.slice(0, 8)}… · Epoch {info.epoch.slice(0, 8)}…</small>
            : <small className="muted">Not trusted yet — run “apex-daemon trust-host” from this account&apos;s own shell or SSH session. Only then can a paired device press Allow. Deck can&apos;t check this machine for you.</small>}
          {info.accepted_folders && info.accepted_folders.length > 0 && (
            <small>Accepted tainted folders: {info.accepted_folders.map(f => f.path).join(", ")}</small>
          )}
          <small className="mono muted">host-trust.json · {info.exists ? "present" : "missing"}</small>
        </div>
      </div>
      <div className="settings-row">
        <small className="muted">A rebuild or new Linux user is the only clean answer if you don&apos;t trust what has run here. Reboot after trust if you can; otherwise trust with --no-reboot.</small>
      </div>
    </div>
  );
}
