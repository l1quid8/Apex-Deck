import { useHostConnection } from "./useHostConnection";
import { useEffect, useState } from "react";

import type { Backend } from "./backend";
import { statusWords } from "./connection";
import { buildNotice, helperNotice } from "./hostFacts.ts";

/** Shown across the top while the window has lost its host, or while its service is a different build than this app. */
export function ConnectionBanner({ backend }: { backend: Backend }) {
  const { status, name: host, helper, build } = useHostConnection(backend);
  const [, setNow] = useState(0);
  useEffect(() => {
    // Count down to the next try.
    if (status.kind !== "reconnecting") return;
    const timer = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  if (status.kind === "connected") {
    const mismatch = buildNotice(host, __APP_BUILD__, build) ?? helperNotice(host, __APP_VERSION__, helper);
    if (!mismatch) return null;
    return (
      <div className="connection-banner mismatch" role="status" aria-live="polite">
        <div className="connection-words">
          <strong>Different builds</strong>
          <small>{mismatch}</small>
        </div>
      </div>
    );
  }
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
