import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Backend } from "./backend";
import { Markdown } from "./Markdown";
import { KIND_LABEL, ago, exportName, newestFirst, pickVersion, type ArtifactFile, type ArtifactKind } from "./artifacts";
import { frameDocument } from "./artifactFrame";
import { compact, lineDiff } from "./lineDiff";

// The artifacts panel: beside the conversation, over it in a narrow thread,
// or over the whole deck in full window. See the spec, 2.3.

export type ArtifactTab = "preview" | "source" | "changes";

/** What the panel shows. A null `artifactId` or `n` means the newest. */
export interface PanelView {
  artifactId: string | null;
  n: number | null;
  tab: ArtifactTab;
  full: boolean;
  /** The list of the thread's artifacts, instead of one. */
  list: boolean;
}

export const DEFAULT_VIEW: PanelView = { artifactId: null, n: null, tab: "preview", full: false, list: false };

interface Props {
  file: ArtifactFile;
  view: PanelView;
  onView: (view: PanelView) => void;
  onClose: () => void;
  /** Over the conversation, for a narrow thread. */
  overlay: boolean;
  nameOf: (participantId: string) => string;
  colorOf: (participantId: string) => string;
  onOpenLink: (target: string, reveal?: boolean) => void;
  backend: Backend;
  /** Why changes here aren't being saved, if they aren't. */
  problem: string;
}

const TABS: { id: ArtifactTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "source", label: "Source" },
  { id: "changes", label: "Changes" },
];

const icon = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);
const CORNERS = icon(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>);
const COPY = icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>);
const SAVE = icon(<><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
const EXTERNAL = icon(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
const KIND_ICON: Record<ArtifactKind, ReactNode> = {
  html: icon(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M10 13l-2 2 2 2" /><path d="M14 13l2 2-2 2" /></>),
  svg: icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></>),
  markdown: icon(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M8 13h8" /><path d="M8 17h6" /></>),
};

export function ArtifactsPanel({ file, view, onView, onClose, overlay, nameOf, colorOf, onOpenLink, backend, problem }: Props) {
  const root = useRef<HTMLElement>(null);
  const picked = pickVersion(file, view.artifactId, view.n);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState("");
  const [wandered, setWandered] = useState(false);
  /** Bumped to put an artifact back after it navigated its frame away. */
  const [reloads, setReloads] = useState(0);
  const loads = useRef(0);
  const frameKey = picked ? `${picked.artifact.id}:${picked.version.n}:${reloads}` : "";

  useEffect(() => { loads.current = 0; }, [frameKey]);
  useEffect(() => {
    setWandered(false);
    setFailed("");
  }, [picked?.artifact.id, picked?.version.n]);

  // Esc leaves full window; in a narrow thread, with focus in the panel, it closes the panel.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (view.full) {
        event.preventDefault();
        onView({ ...view, full: false });
      } else if (overlay && root.current?.contains(document.activeElement)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, overlay, onView, onClose]);

  const set = (change: Partial<PanelView>) => onView({ ...view, ...change });
  const classes = ["artifacts-panel", overlay && !view.full ? "overlay" : "", view.full ? "full-window" : ""].filter(Boolean).join(" ");

  if (!picked || view.list) {
    return (
      <aside ref={root} className={classes} aria-label="Artifacts">
        <div className="artifacts-head">
          <div>
            <strong>Artifacts</strong>
            <span className="artifacts-meta">{file.artifacts.length === 1 ? "1 in this thread" : `${file.artifacts.length} in this thread`}</span>
          </div>
          {picked && <button className="icon small" onClick={() => set({ list: false })} aria-label="Back to the artifact" title="Back">‹</button>}
          <button className="icon small" onClick={onClose} aria-label="Close artifacts" title="Close">×</button>
        </div>
        <div className="artifacts-body">
          {file.artifacts.length === 0 ? (
            <p className="artifacts-empty">Nothing here yet. Click Open as artifact on a code block in any reply.</p>
          ) : (
            <div className="artifacts-list">
              {newestFirst(file).map((artifact) => {
                const latest = artifact.versions[artifact.versions.length - 1];
                return (
                  <button key={artifact.id} aria-current={artifact.id === picked?.artifact.id ? "true" : undefined} onClick={() => set({ artifactId: artifact.id, n: null, list: false })}>
                    <span className="artifacts-kind">{KIND_ICON[artifact.kind]}</span>
                    <span className="artifacts-row">
                      <strong>{artifact.title}</strong>
                      <span className="artifacts-meta">{KIND_LABEL[artifact.kind]} · v{latest.n} · {latest.by ? nameOf(latest.by) : "someone"} · {ago(latest.at, Date.now())}</span>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {problem && <div className="artifacts-foot"><span role="alert">{problem}</span></div>}
      </aside>
    );
  }

  const { artifact, version } = picked;
  const total = artifact.versions.length;
  const previous = artifact.versions.find((v) => v.n === version.n - 1);
  const who = version.by ? nameOf(version.by) : "someone";
  const name = exportName(artifact, version.n);
  const copy = () => {
    navigator.clipboard?.writeText(version.source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  const run = (action: Promise<unknown>) => { action.catch((error) => setFailed(`Couldn't do that: ${String(error)}`)); };
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      setWandered(true);
      setReloads((n) => n + 1);
    }
  };
  const note = problem || failed || (wandered ? "This artifact tried to open another page. It was put back." : "");

  return (
    <aside ref={root} className={classes} aria-label={`Artifact: ${artifact.title}`}>
      <div className="artifacts-head">
        <div>
          <button className="artifacts-title" onClick={() => set({ list: true })} title="All artifacts in this thread">{artifact.title} ▾</button>
          <span className="artifacts-meta">{KIND_LABEL[artifact.kind]} · v{version.n} of {total} · by {who}</span>
        </div>
        <button className="icon small" onClick={() => set({ full: !view.full })} aria-label={view.full ? "Back to the thread" : "Full window"} title={view.full ? "Back to the thread (Esc)" : "Full window (Esc to go back)"}>
          {view.full ? "▣" : CORNERS}
        </button>
        {!view.full && <button className="icon small" onClick={onClose} aria-label="Close artifacts" title="Close">×</button>}
      </div>
      <div className="artifacts-bar">
        <div className="artifacts-tabs" role="tablist" aria-label="View">
          {TABS.map((tab) => (
            <button key={tab.id} role="tab" aria-selected={view.tab === tab.id} onClick={() => set({ tab: tab.id })}>{tab.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="icon small" disabled={version.n <= 1} onClick={() => set({ artifactId: artifact.id, n: version.n - 1 })} aria-label="Older version" title="Older version">‹</button>
        <span className="artifacts-version">v{version.n}</span>
        <button className="icon small" disabled={version.n >= total} onClick={() => set({ artifactId: artifact.id, n: version.n + 1 })} aria-label="Newer version" title="Newer version">›</button>
        <span className="artifacts-sep" aria-hidden="true" />
        <button className="icon small" onClick={copy} aria-label="Copy source" title={copied ? "Copied" : "Copy source"}>{copied ? "✓" : COPY}</button>
        <button className="icon small" onClick={() => run(backend.artifactSave(name, version.source))} aria-label="Save to folder" title="Save to folder…">{SAVE}</button>
        <button className="icon small" onClick={() => run(backend.artifactOpenExternal(name, version.source))} aria-label="Open in browser" title="Open in browser">{EXTERNAL}</button>
      </div>
      <div className="artifacts-body" role="tabpanel">
        {view.tab === "preview" && (artifact.kind === "markdown" ? (
          <div className="artifact-doc"><Markdown text={version.source} onOpen={onOpenLink} /></div>
        ) : (
          <iframe key={frameKey} title={`${artifact.title}, version ${version.n}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={frameDocument(artifact.kind, version.source)} onLoad={onFrameLoad} />
        ))}
        {view.tab === "source" && <Source text={version.source} />}
        {view.tab === "changes" && (previous ? <Changes before={previous.source} after={version.source} /> : <p className="artifacts-empty">First version. Nothing to compare yet.</p>)}
      </div>
      <div className="artifacts-foot">
        <span className="dot" style={version.by ? { background: colorOf(version.by) } : undefined} aria-hidden="true" />
        <span>v{version.n} by {who} · {ago(version.at, Date.now())}</span>
        <span className="spacer" />
        {note ? <span role="alert">{note}</span> : artifact.kind !== "markdown" && <span title="It can't reach your files, the network or the app.">Runs sandboxed</span>}
      </div>
    </aside>
  );
}

function Source({ text }: { text: string }) {
  return (
    <pre className="artifact-source">
      {text.split("\n").map((line, i) => <span key={i} className="line"><span className="n">{i + 1}</span>{line || " "}</span>)}
    </pre>
  );
}

function Changes({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => compact(lineDiff(before, after)), [before, after]);
  return (
    <pre className="artifact-changes">
      {rows.map((row, i) => ("skipped" in row ? (
        <span key={i} className="gap">⋯ {row.skipped} unchanged {row.skipped === 1 ? "line" : "lines"}</span>
      ) : (
        <span key={i} className={`line ${row.sign === "+" ? "add" : row.sign === "-" ? "del" : "same"}`}>
          <span className="sign">{row.sign === "-" ? "−" : row.sign}</span>
          {row.text || " "}
        </span>
      )))}
    </pre>
  );
}
