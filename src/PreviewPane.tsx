import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { Backend, BrowserState } from "./backend";
import { loadFailure, type LoadError } from "./browserPage";
import { BrowserView } from "./BrowserView";
import { hostLabel, normalizeAddress } from "./previewAddress";
import type { Pane, PreviewProbe } from "./types";

// A web page beside your terminals or threads. In the Electron app it's a
// real browser docked in the pane (BrowserView). Elsewhere it's a frame, and
// the desktop side looks at the address before the page loads (preview.rs),
// so a stopped server or a site that refuses frames gets words instead of a
// blank box. See the spec, section 1.

/** A local server a terminal printed or a thread's bot mentioned, for the empty page. */
export interface ServerChoice {
  address: string;
  /** The terminal's or thread's name. */
  source: string;
  sourceId: string;
}

interface Props {
  pane: Pane;
  backend: Backend;
  /** False while the pane's section is off screen: polling stops and full window ends. */
  visible: boolean;
  /** Something that isn't a menu or dialog is drawn over the deck (Settings); a docked page steps aside. */
  behind?: boolean;
  servers: ServerChoice[];
  /** The terminal or thread this page's address came from, while it is still open. A thread counts as running. */
  source: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  /** Hosts you chose to always open in your browser. */
  openExternally: string[];
  onOpenExternallyChange: (hosts: string[]) => void;
  onAddress: (paneId: string, address: string, servedBy?: string) => void;
  /** The muted words for the pane head. */
  onStatus: (paneId: string, text: string) => void;
  onStartSource: () => void;
  onShowSource: () => void;
  onOpenInBrowser: (address: string) => void;
}

type Look = { kind: "checking" } | PreviewProbe | { kind: "invalid"; reason: string };

const RETRY_MS = 2000;
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";

const svg = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);
const RELOAD = svg(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>);
const BACK = svg(<path d="M15 5l-7 7 7 7" />);
const FORWARD = svg(<path d="M9 5l7 7-7 7" />);
const CORNERS = svg(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>);

export function PreviewPane({ pane, backend, visible, behind = false, servers, source, openExternally, onOpenExternallyChange, onAddress, onStatus, onStartSource, onShowSource, onOpenInBrowser }: Props) {
  const address = pane.url ?? "";
  const host = address ? hostLabel(address) : "";
  const [typed, setTyped] = useState(address);
  const [error, setError] = useState("");
  const [look, setLook] = useState<Look>({ kind: "checking" });
  /** Bumped by Reload: a new frame, and a new look first. */
  const [frame, setFrame] = useState(0);
  const [full, setFull] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  /** The address the browser was last opened for by itself, so it opens once. */
  const openedFor = useRef("");
  /** The docked browser, in the Electron app. */
  const docked = backend.browser;
  const [page, setPage] = useState<BrowserState | null>(null);
  /** Why the docked page won't load, kept while it tries again. */
  const [failed, setFailed] = useState<LoadError | null>(null);
  const pageState = useCallback((state: BrowserState) => {
    setPage(state);
    setFailed((previous) => loadFailure(previous, state));
  }, []);

  // Keep the field in step when the address changes from outside, e.g. a terminal's chip.
  useEffect(() => {
    setTyped(address);
    setError("");
  }, [address]);

  // Look before loading, once per address and per Reload. The docked browser loads it itself.
  useEffect(() => {
    if (!address || docked) return;
    let live = true;
    setLook({ kind: "checking" });
    backend.previewProbe(address).then(
      (result) => { if (live) setLook(result); },
      (reason) => { if (live) setLook({ kind: "invalid", reason: String(reason) }); },
    );
    return () => { live = false; };
  }, [backend, docked, address, frame]);

  // While nothing answers and the pane is on screen, look again every 2 s.
  useEffect(() => {
    if (look.kind !== "unreachable" || !visible || !address) return;
    let live = true;
    const timer = setTimeout(() => {
      backend.previewProbe(address).then((result) => { if (live) setLook(result); }, () => {});
    }, RETRY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [look, visible, backend, address]);

  // Hosts you chose to always open in your browser: open it once per address,
  // when a look finds it refused. Ticking the box itself opens nothing.
  const external = useRef(openExternally);
  external.current = openExternally;
  useEffect(() => {
    if (look.kind === "refused" && external.current.includes(host) && openedFor.current !== address) {
      openedFor.current = address;
      onOpenInBrowser(address);
    }
  }, [look, host, address, onOpenInBrowser]);

  // A docked page that failed to load: try again every 2 s while it's on screen.
  useEffect(() => {
    if (!docked || !failed || !visible || !address) return;
    const timer = setTimeout(() => void docked.navigate(pane.id, address), RETRY_MS);
    return () => clearTimeout(timer);
  }, [docked, failed, visible, address, pane.id, page]);
  useEffect(() => {
    setPage(null);
    setFailed(null);
  }, [address]);
  // The field follows the page as you click around in it.
  useEffect(() => { if (page?.url && !page.url.startsWith("data:") && !page.error) setTyped(page.url); }, [page?.url, page?.error]);

  const status = docked ? (!address ? "No page yet" : failed ? "Can't connect" : page?.loading ? "Loading…" : source ? `From ${source.title}` : page?.title ?? "")
    : !address ? "No page yet"
    : look.kind === "checking" ? "Checking…"
    : look.kind === "ok" ? (source ? `From ${source.title}` : "")
    : look.kind === "refused" ? "Won't load here"
    : "Can't connect";
  useEffect(() => { onStatus(pane.id, status); }, [onStatus, pane.id, status]);

  // Full window ends when the pane leaves the screen, and on Esc. Esc pressed
  // inside the page stays with the page; ▣ always works.
  useEffect(() => { if (!visible) setFull(false); }, [visible]);
  useEffect(() => {
    if (!full) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFull(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [full]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeAddress(typed);
    if (!next) {
      setError("That isn't a web address. Try e.g. localhost:3000.");
      return;
    }
    setError("");
    if (next === address) reload();
    else onAddress(pane.id, next);
  };

  const reload = () => {
    if (docked) void docked.navigate(pane.id, address);
    else setFrame((n) => n + 1);
  };

  return (
    <div className={full ? "preview full-window" : "preview"}>
      <div className="preview-bar">
        {full && <span className="preview-full-title">{pane.title}</span>}
        {docked && <>
          <button className="icon small" disabled={!page?.canGoBack} onClick={() => void docked.back(pane.id)} aria-label="Back" title="Back">{BACK}</button>
          <button className="icon small" disabled={!page?.canGoForward} onClick={() => void docked.forward(pane.id)} aria-label="Forward" title="Forward">{FORWARD}</button>
        </>}
        <button className="icon small" disabled={!address} onClick={reload} aria-label="Reload" title="Reload">{RELOAD}</button>
        <form onSubmit={submit}>
          <input ref={field} aria-label="Address" value={typed} placeholder="e.g. localhost:3000" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setTyped(event.target.value)} />
        </form>
        <button className="icon small" disabled={!address} onClick={() => setFull((on) => !on)} aria-label={full ? "Back to the deck" : "Full window"} title={full ? "Back to the deck (Esc)" : "Full window (Esc to go back)"}>
          {full ? "▣" : CORNERS}
        </button>
        <button className="small" disabled={!address} onClick={() => onOpenInBrowser(address)}>Open in browser</button>
      </div>
      {error && <p className="preview-error" role="alert">{error}</p>}
      <div className="preview-body">
        {!address && <EmptyPage servers={servers} onPick={(server) => onAddress(pane.id, server.address, server.sourceId)} />}
        {docked && address && (
          <BrowserView pane={pane.id} url={address} browser={docked} visible={visible && !behind && !failed} onState={pageState} />
        )}
        {docked && address && failed && (
          <div className="preview-notice" role="status">
            <h2>Nothing is answering at {host}.</h2>
            <p>
              {source?.kind === "terminal" && !source.running ? `${source.title} has stopped. The page comes back by itself once the server answers again.`
                : `${failed.description || "The page didn't load"}. It comes back by itself once the server answers.`}
            </p>
            {source && (
              <div className="preview-actions">
                {source.kind === "terminal" && !source.running && <button className="primary" onClick={onStartSource}>Start {source.title} again</button>}
                <button onClick={onShowSource}>{source.kind === "chat" ? "Show thread" : "Show terminal"}</button>
              </div>
            )}
            <span className="preview-retry">Checking every 2 s</span>
          </div>
        )}
        {!docked && address && look.kind === "ok" && (
          <iframe key={frame} src={address} title={`Preview of ${host}`} sandbox={SANDBOX} referrerPolicy="no-referrer" />
        )}
        {!docked && address && look.kind === "checking" && <p className="preview-checking" role="status">Checking {host}…</p>}
        {!docked && address && (look.kind === "unreachable" || look.kind === "invalid") && (
          <div className="preview-notice" role="status">
            <h2>Nothing is answering at {host}.</h2>
            <p>
              {look.kind === "invalid" ? look.reason
                : source?.kind === "terminal" && !source.running ? `${source.title} has stopped. The page comes back by itself once the server answers again.`
                : "The page comes back by itself once the server answers."}
            </p>
            {source && (
              <div className="preview-actions">
                {source.kind === "terminal" && !source.running && <button className="primary" onClick={onStartSource}>Start {source.title} again</button>}
                <button onClick={onShowSource}>{source.kind === "chat" ? "Show thread" : "Show terminal"}</button>
              </div>
            )}
            {look.kind === "unreachable" && <span className="preview-retry">Checking every 2 s</span>}
          </div>
        )}
        {!docked && address && look.kind === "refused" && (
          <div className="preview-notice" role="status">
            <h2>{host} won't load inside the deck.</h2>
            <p>The site tells browsers not to show it inside other apps. Most sites with a sign-in do this.</p>
            <div className="preview-actions">
              <button className="primary" onClick={() => onOpenInBrowser(address)}>Open in browser</button>
              <button onClick={() => field.current?.select()}>Change address</button>
            </div>
            <label className="preview-always">
              <input
                type="checkbox"
                checked={openExternally.includes(host)}
                onChange={(event) => onOpenExternallyChange(event.target.checked ? [...openExternally, host] : openExternally.filter((h) => h !== host))}
              />
              Always open {host} in my browser
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPage({ servers, onPick }: { servers: ServerChoice[]; onPick: (server: ServerChoice) => void }) {
  return (
    <div className="preview-empty">
      <h2>Open a page.</h2>
      <p>{servers.length > 0 ? "Pick a server from a terminal or thread, or type an address above." : "Type an address above. Servers your terminals start, and ones bots mention, show up here."}</p>
      {servers.length > 0 && (
        <>
          <span className="preview-label">Servers in this workspace</span>
          <div className="preview-servers">
            {servers.map((server) => (
              <button key={`${server.sourceId} ${server.address}`} onClick={() => onPick(server)}>
                <span className="dot working" aria-hidden="true" />
                <span className="preview-server"><span className="mono">{hostLabel(server.address)}</span><small>{server.source}</small></span>
                <span className="preview-open">Open</span>
              </button>
            ))}
          </div>
        </>
      )}
      <p className="preview-foot">Pages from the internet often refuse to load inside another app. Those open in your browser instead.</p>
    </div>
  );
}
