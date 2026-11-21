import { useEffect, useState, type ReactNode } from "react";
import type { PhoneHost } from "../phoneBackend";
import { downLine, isPaired, type LinkView, type Machine, type PairedMachine } from "../phoneRules";
import type { Route } from "./remotePlugin";
import { CodeModeSettings } from "./CodeModeSettings";
import type { PhoneComputerStatus } from "./ComputerUseSettings";
import { ChevronRight } from "./icons";

const words = (error: unknown) => String(error instanceof Error ? error.message : error);

export function MachinePage({
  machine,
  host,
  link,
  route,
  icon,
  missing,
  covered,
  ucuStatus,
  ucuStatusError,
  onOpenComputerUse,
  onEdit,
  onUnpair,
  onRetry,
  onRepair,
  onForgetSignIn,
  onError,
}: {
  machine: Machine;
  host: PhoneHost | null;
  link: LinkView | null;
  route: Route | null;
  icon: ReactNode;
  missing: string[];
  covered: boolean;
  ucuStatus: PhoneComputerStatus | null;
  ucuStatusError: string;
  onOpenComputerUse(): void;
  onEdit(id: string, next: Machine): void;
  onUnpair(id: string): void;
  onRetry(id: string): void;
  onRepair?(machine: PairedMachine): Promise<void>;
  onForgetSignIn?(machine: PairedMachine): void;
  onError(message: string): void;
}) {
  const paired = isPaired(machine);
  const online = link?.status === "online";
  const [editing, setEditing] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [edit, setEdit] = useState({ name: machine.name, url: paired ? "" : machine.url, token: "", id: machine.kind === "server" ? machine.id : "" });

  useEffect(() => {
    setEditing(false);
    setConfirmUnpair(false);
  }, [machine.id]);

  const state = !link
    ? "Connecting…"
    : link.status === "online"
      ? route === "direct" ? "Connected · Direct" : route === "relayed" ? "Connected · Relayed" : "Connected"
      : link.problem
        ? "Can't connect"
        : link.status === "offline"
          ? "Offline"
          : "Connecting…";

  // Show Unified Computer Use on Macs (including offline Macs so users see the offline note)
  // and hide it whenever a host reports `available: false` (e.g. Linux).
  const showUcu = ucuStatus ? ucuStatus.available : machine.kind === "mac";
  const ucuDetail = !online
    ? "Reconnect to view or change app permissions."
    : !ucuStatus
      ? ucuStatusError ? "Couldn't check status" : "Checking…"
      : !ucuStatus.enabled
        ? "Off"
        : ucuStatus.skipAppPrompts
          ? "On · Skip prompts for Full-access agents"
          : "On · Ask for each app";

  return (
    <main className="ph-content" inert={covered}>
      <h2>{icon} {machine.name}</h2>
      <p className="ph-intro">
        <i className={`ph-dot${link?.status === "online" ? " on" : link?.status === "offline" ? " off" : ""}`} />
        {state}
      </p>
      {link && link.status !== "online" && link.status !== "connecting" && (
        <p className={link.problem ? "ph-red" : "ph-muted"}>{downLine(link)}</p>
      )}
      {link && link.status === "offline" && !link.problem && (
        <button type="button" className="ph-wide" onClick={() => onRetry(machine.id)}>Retry now</button>
      )}

      {editing ? (
        <form
          className="ph-group ph-padded ph-form"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const id = machine.kind === "mac" ? "local" : edit.id.trim();
              onEdit(machine.id, paired
                ? { ...machine, id, name: edit.name }
                : { id, name: edit.name, kind: machine.kind, url: edit.url, token: edit.token });
              setEditing(false);
            } catch (error) {
              onError(words(error));
            }
          }}
        >
          <h3>Edit connection</h3>
          <label className="ph-label">Name<input value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} required autoCapitalize="words" /></label>
          {machine.kind === "server" && (
            <label className="ph-label">
              Id
              <input value={edit.id} onChange={(event) => setEdit({ ...edit, id: event.target.value })} required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <small>{missing.length > 0 ? `The id your Mac uses for it: ${missing.join(" or ")}` : "The id your Mac uses for this server"}</small>
            </label>
          )}
          {!paired && (
            <label className="ph-label">Address<input value={edit.url} onChange={(event) => setEdit({ ...edit, url: event.target.value })} required inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
          )}
          {!paired && (
            <label className="ph-label">
              Daemon token
              <input type="password" value={edit.token} onChange={(event) => setEdit({ ...edit, token: event.target.value.trim() })} placeholder="Leave empty to keep the saved token" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <small>Paste a new token only if it changed.</small>
            </label>
          )}
          <button type="submit" className="primary ph-wide">Save</button>
          <button type="button" className="ph-plain ph-wide" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          {showUcu && (
            <div className="ph-list">
              <button type="button" className="ph-srow ph-preference" onClick={onOpenComputerUse}>
                <span className="ph-grow">
                  <strong>Unified Computer Use</strong>
                  <small>{ucuDetail}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            </div>
          )}

          <CodeModeSettings host={host} />

          <div className="ph-list">
            <button
              type="button"
              className="ph-srow ph-preference"
              onClick={() => {
                setEdit({ name: machine.name, url: paired ? "" : machine.url, token: "", id: machine.kind === "server" ? machine.id : "" });
                setConfirmUnpair(false);
                setEditing(true);
              }}
            >
              <span className="ph-grow"><strong>Edit connection</strong></span>
              <ChevronRight size={15} />
            </button>
            {paired && machine.setup?.kept && onRepair && (
              <button type="button" className="ph-srow ph-preference" onClick={() => void onRepair(machine).catch((e: unknown) => onError(words(e)))}>
                <span className="ph-grow"><strong>Repair with saved sign-in…</strong></span>
                <ChevronRight size={15} />
              </button>
            )}
            {paired && machine.setup?.kept && onForgetSignIn && (
              <button type="button" className="ph-srow ph-preference" onClick={() => onForgetSignIn(machine)}>
                <span className="ph-grow"><strong>Forget saved sign-in</strong></span>
              </button>
            )}
            {!confirmUnpair && (
              <button type="button" className="ph-srow ph-preference" onClick={() => setConfirmUnpair(true)}>
                <span className="ph-grow"><strong className="ph-red">Unpair…</strong></span>
              </button>
            )}
          </div>

          {confirmUnpair && (
            <div className="ph-group ph-padded">
              <p className="ph-muted">Its threads stay on {machine.name}. You can pair it again later.</p>
              <button type="button" className="danger ph-wide" onClick={() => onUnpair(machine.id)}>Unpair {machine.name}</button>
              <button type="button" className="ph-plain ph-wide" onClick={() => setConfirmUnpair(false)}>Cancel</button>
            </div>
          )}

          <p className="ph-foot">
            {paired ? `${machine.setup ? "Set up over SSH" : "Paired by QR code"} · ${machine.hostEndpointId.slice(0, 12)}…` : machine.url}
            {machine.kind === "server" ? ` · id ${machine.id}` : ""}
          </p>
        </>
      )}
    </main>
  );
}
