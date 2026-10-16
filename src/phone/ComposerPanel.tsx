import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Camera, ChevronRight, Files, Folder, Image, Laptop, Plan, Plug, X } from "./icons";
import { panelDrag, type PanelDetent } from "./composerPanelModel";

export type ComposerAttachment = { id: string; name: string; bytes: Uint8Array; type?: string };
export type ComposerPanelProps = {
  onClose(): void;
  onPickerStart(kind: "camera" | "photos" | "files"): void;
  onPick(kind: "camera" | "photos" | "files", files: File[]): void;
  files: ComposerAttachment[];
  onRemoveFile(id: string): void;
  onTools(): void;
  project: string;
  machine: string;
  onProject(): void;
  onMachine(): void;
  plan: boolean;
  planPending: boolean;
  planDisabledReason: string | null;
  onPlanChange(on: boolean): void;
  planError: string | null;
};

type Picker = "camera" | "photos" | "files";

export function ComposerPanel(props: ComposerPanelProps) {
  const [detent, setDetent] = useState<PanelDetent>("compact");
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [previews, setPreviews] = useState<{ id: string; url: string }[]>([]);
  const suppressGripClick = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const inputs = { camera: cameraRef, photos: photosRef, files: filesRef };
  useEffect(() => {
    returnFocusRef.current = document.querySelector<HTMLElement>(".ph-add") ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      // The + button is the stable destination when the chat stays mounted.
      const trigger = returnFocusRef.current?.matches(".ph-add") ? returnFocusRef.current : document.querySelector<HTMLElement>(".ph-add");
      window.setTimeout(() => trigger?.focus({ preventScroll: true }), 0);
    };
  }, []);
  useEffect(() => {
    const next = props.files.flatMap((file) => {
      if (!/\.(png|jpe?g|gif|webp|heic|avif)$/i.test(file.name)) return [];
      const extType: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg" };
      const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
      const type = file.type || extType[extension] || "application/octet-stream";
      return [{ id: file.id, url: URL.createObjectURL(new Blob([file.bytes.slice().buffer as ArrayBuffer], { type })) }];
    });
    setPreviews(next);
    return () => next.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [props.files]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((item) => item.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const pick = (kind: Picker) => {
    props.onPickerStart(kind);
    inputs[kind].current?.click();
  };
  const dragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragStart === null) return;
    const delta = event.clientY - dragStart;
    const result = panelDrag(detent, delta);
    setDragStart(null);
    if (Math.abs(delta) >= 64) {
      suppressGripClick.current = true;
      window.setTimeout(() => { suppressGripClick.current = false; }, 0);
    }
    if (result === "dismiss") props.onClose(); else setDetent(result);
  };
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(event.clientY);
  };
  const read = (kind: Picker, event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (selected.length) props.onPick(kind, selected);
  };

  return <div className="ph-composer-backdrop" onClick={props.onClose}>
    <section ref={panelRef} className={`ph-composer-panel ${detent}`} role="dialog" aria-modal="true" aria-label="Add to message" onClick={(event) => event.stopPropagation()}>
      <header className="ph-composer-header" onPointerDown={(event) => { const target = event.target as HTMLElement; if (event.currentTarget === target || target.closest("h2")) startDrag(event); }} onPointerUp={dragEnd} onPointerCancel={() => setDragStart(null)}>
        <button ref={closeRef} type="button" className="ph-composer-close" aria-label="Close Add to message" onClick={props.onClose}><X size={20} /></button>
        <h2>Add to message</h2>
        <button type="button" className="ph-composer-photos" onClick={() => pick("photos")}>Photos</button>
        <button type="button" className="ph-composer-grip" aria-label={detent === "compact" ? "Expand panel" : "Collapse panel"} onPointerDown={startDrag} onClick={() => { if (suppressGripClick.current) return; setDetent(detent === "compact" ? "expanded" : "compact"); }}><span /></button>
      </header>
      <div className="ph-composer-scroll">
        <div className="ph-composer-media" aria-label="Media attachments">
          <button type="button" className="ph-composer-media-tile" onClick={() => pick("camera")}><Camera size={25} /><strong>Camera</strong></button>
          <button type="button" className="ph-composer-media-tile" onClick={() => pick("photos")}><Image size={25} /><strong>Photos</strong></button>
          {previews.map((preview) => <div className="ph-composer-preview" key={preview.id}><img src={preview.url} alt="Selected image" /><button type="button" aria-label={`Remove ${props.files.find((file) => file.id === preview.id)?.name ?? "image"}`} onClick={() => props.onRemoveFile(preview.id)}>×</button></div>)}
        </div>
        <div className="ph-composer-group">
          <button type="button" className="ph-composer-row" onClick={() => pick("files")}><span className="ph-composer-icon"><Files size={20} /></span><strong>Files</strong><ChevronRight size={18} /></button>
          <button type="button" className="ph-composer-row" onClick={props.onTools}><span className="ph-composer-icon"><Plug size={20} /></span><strong>Tools</strong><ChevronRight size={18} /></button>
        </div>
        <div className="ph-composer-group">
          <button type="button" className="ph-composer-row" onClick={props.onProject}><span className="ph-composer-icon"><Folder size={20} /></span><span className="ph-composer-copy"><strong>Project</strong><small>{props.project}</small></span><ChevronRight size={18} /></button>
          <button type="button" className="ph-composer-row" onClick={props.onMachine}><span className="ph-composer-icon"><Laptop size={20} /></span><span className="ph-composer-copy"><strong>Machine</strong><small>{props.machine}</small></span><ChevronRight size={18} /></button>
          <div className="ph-composer-row ph-composer-plan-row"><span className="ph-composer-icon"><Plan size={20} /></span><span className="ph-composer-copy"><strong>Plan mode</strong>{props.planError && <small className="ph-composer-error" role="alert">{props.planError}</small>}{props.planDisabledReason && <small>{props.planDisabledReason}</small>}</span><button type="button" role="switch" aria-checked={props.plan} aria-label="Plan mode" disabled={props.planPending || Boolean(props.planDisabledReason)} onClick={() => props.onPlanChange(!props.plan)} className={`ph-composer-switch${props.plan ? " on" : ""}`}><span /></button></div>
        </div>
        {props.files.length > 0 && <div className="ph-composer-attachments" aria-label="Attached files">
          {props.files.map((file) => <div className="ph-composer-attachment" key={file.id}><Files size={17} /><strong title={file.name}>{file.name}</strong><button type="button" aria-label={`Remove ${file.name}`} onClick={() => props.onRemoveFile(file.id)}>×</button></div>)}
          <p>Sends with your next message</p>
        </div>}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => read("camera", event)} />
        <input ref={photosRef} type="file" accept="image/*" multiple hidden onChange={(event) => read("photos", event)} />
        <input ref={filesRef} type="file" multiple hidden onChange={(event) => read("files", event)} />
      </div>
    </section>
  </div>;
}
