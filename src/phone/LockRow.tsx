// Settings → Lock. One switch for the whole app: the iPhone asks for Face ID (or the passcode) when
// Apex Deck opens, and again when it has been out of sight for a minute. The asking is native — see
// AppLock.swift — so this row only turns it on and says what it will do.

import { useEffect, useState } from "react";
import { lockPresent, lockStatus, setLockEnabled, watchLock, type LockStatus } from "./appLock";

export function LockRow() {
  // A browser preview and any build from before the lock existed have no plugin: no switch, rather
  // than a switch that does nothing.
  const present = lockPresent();
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!present) return;
    let live = true;
    void lockStatus().then((now) => { if (live) setStatus(now); });
    const stop = watchLock((now) => { if (live) setStatus(now); });
    return () => {
      live = false;
      void stop.then((off) => off()).catch(() => {});
    };
  }, [present]);

  if (!present) return null;
  const on = status?.enabled === true;
  const available = status?.available === true;
  const detail = !status
    ? "Checking this iPhone…"
    : !available
      ? "Add a passcode to this iPhone first. A lock needs one to fall back on."
      : on
        ? "Asks when Apex Deck opens, and after a minute away."
        : "Off. Anyone holding this unlocked iPhone can open Apex Deck.";

  const toggle = async () => {
    if (!status || busy || !available) return;
    setBusy(true);
    setProblem("");
    const next = await setLockEnabled(!on);
    setStatus(next);
    setBusy(false);
    if (next.enabled === on) setProblem("The lock didn't change. Try again.");
  };

  return (
    <div className="ph-srow ph-preference ph-lock-row">
      <span className="ph-grow">
        <strong>Lock with Face ID</strong>
        <small>{detail}</small>
        {problem && <small className="ph-lock-problem" role="alert">{problem}</small>}
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label="Lock Apex Deck with Face ID"
        className={`ph-composer-switch${on ? " on" : ""}`} disabled={busy || !available || !status} onClick={toggle}>
        <span />
      </button>
    </div>
  );
}
