import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { PhoneHost } from "../phoneBackend";
import { Check, ChevronRight } from "./icons";

export interface PhoneComputerStatus {
  available: boolean;
  enabled: boolean;
  skipAppPrompts?: boolean;
  appPromptsWarning?: string | null;
  reason?: string;
}

const words = (error: unknown) => String(error instanceof Error ? error.message : error);

/** Reads `computer_status` for the focused machine whenever it connects or returns to foreground. */
export function usePhoneComputerStatus(host: PhoneHost | null, online: boolean) {
  const [snapshot, setSnapshot] = useState<{ host: PhoneHost; status: PhoneComputerStatus } | null>(null);
  const [statusError, setStatusError] = useState("");
  const hostRef = useRef(host);
  hostRef.current = host;
  const seq = useRef(0);

  const setStatus = useCallback((status: PhoneComputerStatus) => {
    if (!host || hostRef.current !== host) return;
    // An acknowledged write supersedes status reads dispatched before it.
    seq.current += 1;
    setSnapshot({ host, status });
    setStatusError("");
  }, [host]);

  const refresh = useCallback(async (): Promise<PhoneComputerStatus | null> => {
    if (!host || hostRef.current !== host || host.connection.get().status.kind !== "connected") return null;
    const call = ++seq.current;
    try {
      const next = await host.backend.call<PhoneComputerStatus>("computer_status", {});
      if (seq.current !== call || hostRef.current !== host) return null;
      setSnapshot({ host, status: next });
      setStatusError("");
      return next;
    } catch (e) {
      if (seq.current === call && hostRef.current === host) {
        setSnapshot(null);
        setStatusError(words(e));
      }
      return null;
    }
  }, [host]);

  useEffect(() => {
    seq.current += 1;
    setSnapshot(null);
    setStatusError("");
  }, [host, online]);

  useEffect(() => {
    if (!host || !online) return;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [host, online, refresh]);

  return { status: online && snapshot?.host === host ? snapshot.status : null, statusError, refresh, setStatus };
}

export function PhoneComputerUseScreen({
  machineName,
  icon,
  host,
  online,
  status,
  statusError = "",
  onStatus,
  onRefresh,
  onOpenAppPermissions,
  covered = false,
}: {
  machineName: string;
  icon?: ReactNode;
  host: PhoneHost | null;
  online: boolean;
  status: PhoneComputerStatus | null;
  statusError?: string;
  onStatus(next: PhoneComputerStatus): void;
  onRefresh(): Promise<PhoneComputerStatus | null>;
  onOpenAppPermissions(): void;
  covered?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const skip = status?.skipAppPrompts === true;
  const enabled = status?.enabled === true;
  const available = status?.available === true;

  const setEnabled = async (next: boolean) => {
    if (!host || !online || !available || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await host.backend.call<PhoneComputerStatus>("computer_set_enabled", { enabled: next });
      onStatus(updated);
    } catch (e) {
      await onRefresh();
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  const enableDetail = skip
    ? "Let supported agents use Mac apps. Full-access agents skip app prompts. Other agents ask before each app."
    : "Let supported agents request access to Mac apps. Each app needs your permission before an agent can read or control it.";

  const appPermissionsDetail = !online
    ? "Reconnect to view or change app permissions."
    : !status
      ? statusError ? "Couldn't check app permissions." : "Checking…"
      : !enabled
        ? `${skip ? "Skip prompts for Full-access agents" : "Ask for each app"} · Turn on Unified Computer Use to change this.`
        : skip
          ? "Skip prompts for Full-access agents"
          : "Ask for each app";

  const canOpenPermissions = online && available && enabled && !busy;

  return (
    <main className="ph-content" inert={covered}>
      <h2>Unified Computer Use</h2>
      <p className="ph-intro">{icon} {machineName}</p>
      <div className="ph-list">
        <div className="ph-srow ph-preference ph-lock-row">
          <span className="ph-grow">
            <strong>Enable Unified Computer Use</strong>
            <small>{enableDetail}</small>
            {online && status?.reason && <small role="status">{status.reason}</small>}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable Unified Computer Use"
            className={`ph-composer-switch${enabled ? " on" : ""}`}
            disabled={busy || !online || !available}
            onClick={() => void setEnabled(!enabled)}
          >
            <span />
          </button>
        </div>
        <button
          type="button"
          className="ph-srow ph-preference"
          disabled={!canOpenPermissions}
          onClick={onOpenAppPermissions}
        >
          <span className="ph-grow">
            <strong>App permissions</strong>
            <small>{appPermissionsDetail}</small>
          </span>
          {canOpenPermissions && <ChevronRight size={15} />}
        </button>
      </div>
      {(status?.appPromptsWarning || error || statusError) && (
        <p className="ph-banner bad ph-red" role="alert">{status?.appPromptsWarning || error || statusError}</p>
      )}
      {online && statusError && <button type="button" className="ph-wide" onClick={() => void onRefresh()}>Retry status</button>}
    </main>
  );
}

export function PhoneAppPermissionsScreen({
  machineName,
  icon,
  host,
  online,
  status,
  statusError = "",
  onStatus,
  onRefresh,
  covered = false,
  Sheet,
}: {
  machineName: string;
  icon?: ReactNode;
  host: PhoneHost | null;
  online: boolean;
  status: PhoneComputerStatus | null;
  statusError?: string;
  onStatus(next: PhoneComputerStatus): void;
  onRefresh(): Promise<PhoneComputerStatus | null>;
  covered?: boolean;
  Sheet: ComponentType<{ title: string; onClose(): void; children: ReactNode; variant?: "app-permissions" }>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [promptsError, setPromptsError] = useState("");
  // Host is the sole authority: checkmark stays on Ask until the Mac replies.
  const skip = status?.skipAppPrompts === true;
  const ask = status !== null && !skip;
  const locked = busy || !online || !status?.available || !status.enabled;

  useEffect(() => {
    if (locked || skip) setConfirmSkip(false);
  }, [locked, skip]);

  const setAppPrompts = async (nextSkip: boolean) => {
    if (!host || !online || busy) return;
    setConfirmSkip(false);
    setBusy(true);
    setPromptsError("");
    try {
      const updated = await host.backend.call<PhoneComputerStatus>("computer_set_app_prompts", { skip: nextSkip });
      onStatus(updated);
    } catch (e) {
      const current = await onRefresh();
      if (!current?.appPromptsWarning) setPromptsError(words(e) || "App permissions could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <main className="ph-content" inert={covered || confirmSkip}>
        <h2 id="phone-app-permissions">App permissions</h2>
        <p className="ph-intro">{icon} {machineName}</p>
        <p className="ph-intro">
          {online ? "Choose when agents ask before using Mac apps." : "Reconnect to view or change app permissions."}
        </p>
        <div className="ph-list" role="group" aria-label="App permissions">
          <button
            type="button"
            className="ph-srow ph-preference"
            aria-pressed={ask}
            disabled={locked}
            onClick={() => { if (skip) void setAppPrompts(false); else setConfirmSkip(false); }}
          >
            <span className="ph-grow">
              <strong>Ask for each app</strong>
              <small>Agents request permission before using an app.</small>
            </span>
            {ask && <span className="ph-srow-icon" aria-hidden="true"><Check size={20} /></span>}
          </button>
          <button
            type="button"
            className="ph-srow ph-preference"
            aria-pressed={skip}
            disabled={locked}
            onClick={() => { if (!skip) setConfirmSkip(true); }}
          >
            <span className="ph-grow">
              <strong>Skip prompts for Full-access agents</strong>
              <small>Other agents still ask before using an app.</small>
            </span>
            {skip && <span className="ph-srow-icon" aria-hidden="true"><Check size={20} /></span>}
          </button>
        </div>
        <p className="ph-list-note" role="status">
          {!online
            ? "Reconnect to view or change app permissions."
            : busy
              ? `Waiting for ${machineName}…`
              : skip
                ? "Switching to Ask for each app stops active computer-use turns."
                : `App permissions apply to agents on ${machineName}.`}
        </p>
        {(status?.appPromptsWarning || promptsError || statusError) && (
          <p className="ph-banner bad ph-red" role="alert">{status?.appPromptsWarning || promptsError || statusError}</p>
        )}
        {online && statusError && <button type="button" className="ph-wide" onClick={() => void onRefresh()}>Retry status</button>}
      </main>
      {confirmSkip && !skip && !locked && (
        <Sheet title={`Skip app prompts on ${machineName}?`} onClose={() => setConfirmSkip(false)} variant="app-permissions">
          <p className="ph-sheet-text">
            Any agent with Full access can open and control Mac apps without asking first, including typing, shortcuts and clicks. Protected apps (System Settings, Keychain, Passwords, sign-in windows) and password fields still apply. Stopping an agent&rsquo;s output stops its computer use. App content goes to that agent&rsquo;s model provider.
          </p>
          <button type="button" className="danger ph-wide" onClick={() => void setAppPrompts(true)}>Skip prompts</button>
          <button type="button" className="ph-plain ph-wide" onClick={() => setConfirmSkip(false)}>Cancel</button>
        </Sheet>
      )}
    </>
  );
}
