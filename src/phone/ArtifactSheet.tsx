// Artifacts on the phone: the thread's list, then one version of one of them.
//
// Read-only on purpose. The Mac decides what becomes an artifact and writes the
// file; opening a version here only reads it, and reading needs ReadOnly on the
// thread (crates/apex-daemon/src/authority.rs). So a phone that can see a
// conversation can see what its replies produced, whatever its access level.
//
// A page or drawing runs in the Mac's double sandbox (artifactFrame.ts), the same
// document the desktop panel shows it in: scripts may run, the network and the
// phone may not be reached. Markdown is text, as on the Mac.

import { useEffect, useState } from "react";
import type { Backend } from "../backend";
import { pickVersion, readArtifacts, type ArtifactFile } from "../artifacts";
import { frameDocument } from "../artifactFrame";
import { artifactListNote, artifactRows, versionLook, versionWords } from "./artifactList";
import { ChevronLeft, ChevronRight } from "./icons";
import "./phone-artifacts.css";

type Loaded = { state: "loading" } | { state: "failed"; words: string } | { state: "ready"; file: ArtifactFile };

/** What went wrong, without a wall of text or a bare [object Object]. */
function trouble(error: unknown): string {
  const words = error instanceof Error ? error.message : String(error);
  return words.trim().slice(0, 160) || "Something went wrong.";
}

export function PhoneArtifacts(props: { backend: Backend; room: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [view, setView] = useState<{ artifactId: string | null; n: number | null } | null>(null);
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    props.backend.artifactsLoad(props.room).then(
      (raw) => { if (live) setLoaded({ state: "ready", file: readArtifacts(raw) }); },
      (error) => { if (live) setLoaded({ state: "failed", words: trouble(error) }); },
    );
    return () => { live = false; };
  }, [props.backend, props.room, tries]);

  if (loaded.state === "loading") return <p className="ph-meta" role="status">Looking for artifacts…</p>;
  if (loaded.state === "failed") {
    return (
      <div className="ph-art-problem" role="status">
        <p>Couldn't read this thread's artifacts. {loaded.words}</p>
        <button type="button" className="ph-plain" onClick={() => setTries((count) => count + 1)}>Try again</button>
      </div>
    );
  }

  // A version asked for that the file no longer has (or never had) falls back to the
  // newest one, as the Mac's panel does; nothing to show means the list.
  const shown = view ? pickVersion(loaded.file, view.artifactId, view.n) : null;

  if (shown) {
    const source = shown.version.source;
    const look = versionLook(shown.artifact.kind);
    const total = shown.artifact.versions.length;
    return (
      <div className="ph-art-one">
        <button type="button" className="ph-art-back" onClick={() => setView(null)}>
          <ChevronLeft size={16} /><span>All {loaded.file.artifacts.length === 1 ? "artifact" : "artifacts"}</span>
        </button>
        <h4 className="ph-art-title">{shown.artifact.title}</h4>
        <div className="ph-art-bar">
          <button type="button" className="ph-icon" aria-label="Older version" disabled={shown.version.n <= 1}
            onClick={() => setView({ artifactId: shown.artifact.id, n: shown.version.n - 1 })}><ChevronLeft size={18} /></button>
          <span className="ph-art-version">v{shown.version.n}</span>
          <button type="button" className="ph-icon" aria-label="Newer version" disabled={shown.version.n >= total}
            onClick={() => setView({ artifactId: shown.artifact.id, n: shown.version.n + 1 })}><ChevronRight size={18} /></button>
          <span className="ph-grow" />
          <div className="ph-art-tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Preview</button>
            <button type="button" role="tab" aria-selected={tab === "source"} onClick={() => setTab("source")}>Source</button>
          </div>
        </div>
        <div className="ph-art-body" role="tabpanel">
          {tab === "source" || look === "text"
            ? <pre className="ph-art-source">{source}</pre>
            : <iframe className="ph-art-frame" title={`${shown.artifact.title}, version ${shown.version.n}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={frameDocument(shown.artifact.kind === "svg" ? "svg" : "html", source)} />}
        </div>
        <p className="ph-meta ph-art-foot">{versionWords(shown.artifact, shown.version, Date.now())}{look === "frame" && tab === "preview" ? " · Runs sandboxed" : ""}</p>
      </div>
    );
  }

  const rows = artifactRows(loaded.file, Date.now());
  const note = artifactListNote(rows.length);
  return (
    <div className="ph-art-list">
      {note
        ? <p className="ph-sheet-text">{note}</p>
        : rows.map((row) => (
          <button key={row.id} type="button" className="ph-art-row" onClick={() => { setTab("preview"); setView({ artifactId: row.id, n: null }); }}>
            <span className="ph-grow">
              <strong>{row.title}</strong>
              <small>{[row.kind, row.versions, row.when].join(" · ")}</small>
              {row.path && <small className="ph-path">{row.path}</small>}
            </span>
            <ChevronRight size={18} />
          </button>
        ))}
    </div>
  );
}
