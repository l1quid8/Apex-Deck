import { useHostConnection } from "./useHostConnection";
import { useEffect, useState } from "react";

import type { Backend } from "./backend";
import { statusWords } from "./connection";

/** Shown across the top while the window has lost its host. */
export function ConnectionBanner({ backend }: { backend: Backend }) {
  const { status, name: host } = useHostConnection(backend);
  const [, setNow] = useState(0);
  useEffect(() => {
    // Count down to the next try.
    if (status.kind !== "reconnecting") return;
    const timer = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  if (status.kind === "connected") return null;
  const reason = status.kind === "reconnecting" || status.kind === "failed" ? status.reason : "";
  return (
    <div className={`connection-banner ${status.kind}`} role="status" aria-live="polite">
      <div className="connection-words">
        <strong>{statusWords(status, host, Date.now())}</strong>
        {reason && <small className="mono">{reason}</small>}
      </div>
      {(status.kind === "reconnecting" || status.kind === "failed") && <button onClick={() => backend.host?.connection.retryNow()}>Try now</button>}
      <small>Send is off until it reconnects; nothing is queued.</small>
    </div>
  );
}
