import { useEffect, useState } from "react";
import type { Backend } from "./backend";

interface TrustInfo {
  /** The backend host's OS, which can differ from the renderer's. Older hosts omit it. */
  platform?: string;
  exists: boolean;
  trusted: boolean;
  epoch: string;
  trusted_at_ms: number;
  boot_id: string;
  accepted_folders?: { path: string; who: string | null; when_ms: number }[];
  raw?: unknown;
}

export function TrustHostSettings({ backend }: { backend: Backend }) {
  const [loaded, setLoaded] = useState<{ backend: Backend; info: TrustInfo } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    void (async () => {
      try {
        const result = await (backend as any).call?.("trust_status", {});
        if (!cancelled && result) setLoaded({ backend, info: result as TrustInfo });
      } catch {
        // An unavailable host supplies no trust policy or record state.
      }
    })();
    return () => { cancelled = true; };
  }, [backend]);

  const info = loaded?.backend === backend ? loaded.info : null;
  if (info?.platform !== "linux") return null;

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
