import { useEffect, useState, useSyncExternalStore } from "react";

import type { Backend } from "./backend";
import { connection, statusWords } from "./connection";

/** Shown across the top while the window has lost its host. */
export function ConnectionBanner({ backend }: { backend: Backend }) {
  const { status, host } = useSyncExternalStore(connection.subscribe, connection.get);
  const [, setNow] = useState(0);
  useEffect(() => {
    // Count down to the next try.
    if (status.kind !== "reconnecting") return;
    const timer = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  if (status.kind === "connected" || status.kind === "connecting") return null;
  const reason = status.kind === "reconnecting" || status.kind === "failed" ? status.reason : "";
  return (
    <div className={`connection-banner ${status.kind}`} role="status" aria-live="polite">
      <div className="connection-words">
        <strong>{statusWords(status, host, Date.now())}</strong>
        {reason && <small className="mono">{reason}</small>}
      </div>
      {(status.kind === "reconnecting" || status.kind === "failed") && <button onClick={() => connection.retryNow()}>Try now</button>}
      {status.kind === "failed" && backend.hosts && host !== "This Mac" && <button onClick={() => void backend.hosts?.use("local")}>Use This Mac</button>}
    </div>
  );
}
