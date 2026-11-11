// The pictures a message carries, on the phone: a thumbnail per picture, a
// tile that says why when one can't load, and a full-screen view on tap.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { pathBase } from "../paths";
import { pictureError } from "./pictureRules";

interface Props {
  paths: string[];
  read: (path: string) => Promise<ArrayBuffer>;
  /** Why none of them can load here, or null. */
  blocked: string | null;
}

export function PhonePictures({ paths, read, blocked }: Props) {
  const [open, setOpen] = useState<{ url: string; name: string } | null>(null);
  if (!paths.length) return null;
  return <div className="ph-pictures">
    {paths.map((path) => <Picture key={path} path={path} read={read} blocked={blocked} onOpen={setOpen} />)}
    {open && <PictureViewer {...open} onClose={() => setOpen(null)} />}
  </div>;
}

function Picture({ path, read, blocked, onOpen }: { path: string; read: Props["read"]; blocked: string | null; onOpen(view: { url: string; name: string }): void }) {
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const name = pathBase(path);
  useEffect(() => {
    if (blocked) return;
    let made: string | null = null;
    let live = true;
    setState(null);
    read(path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes]));
      setState({ url: made });
    }, (error) => { if (live) setState({ error: pictureError(error) }); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, read, blocked, attempt]);
  if (blocked || (state && "error" in state)) {
    const why = blocked ?? (state as { error: string }).error;
    return <div className="ph-picture-missing" role="note">
      <strong>{name}</strong>
      <span>{why}</span>
      {!blocked && <button type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
    </div>;
  }
  if (!state) return <div className="ph-picture-loading" aria-label={`Loading ${name}`} />;
  return <button type="button" className="ph-picture" aria-label={`Open ${name}`} onClick={() => onOpen({ url: state.url, name })}>
    <img src={state.url} alt={name} />
  </button>;
}

/** The picture filling the screen. A tap on the picture shows it at full size; Done or a tap around it closes. */
function PictureViewer({ url, name, onClose }: { url: string; name: string; onClose(): void }) {
  const [actual, setActual] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  // data-no-swipe: React events bubble out of a portal, so panning here must not switch threads.
  return createPortal(<div className="ph-viewer" data-no-swipe role="dialog" aria-modal="true" aria-label={name} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ph-viewer-bar">
      <span>{name}</span>
      <button type="button" onClick={onClose}>Done</button>
    </div>
    <div className={`ph-viewer-body${actual ? " actual" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <img src={url} alt={name} onClick={() => setActual(!actual)} />
    </div>
  </div>, document.body);
}
