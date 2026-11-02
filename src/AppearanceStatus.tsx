// The page's status: what Deck is using, what the preview shows, and the actions
// that move between them. Apply changes Deck. Save only stores a preset.

import { useEffect, useRef, useState, type FormEvent } from "react";

import { deckLabel, displayName, editedKeys, modeName, presetNameError, revertKeys, baseValuesOf } from "./appearanceDraft";
import { HUES } from "./AppearanceControls";
import { BUILTIN_SKINS, accentHex, builtinFor, effectiveLightFromMode, type AppearanceValues, type SkinFile } from "./themes";
import type { AppSettings } from "./settings";
import type { AppearanceStudioState } from "./useAppearanceDraft";

export type Naming = { rename?: string };
type Key = keyof AppearanceValues;

const EDIT_NAME: Partial<Record<Key, string>> = {
  hue: "Accent", accentColor: "Exact accent", radius: "Corners", density: "Density", reply: "Reply text", edges: "Panel edges", flat: "Solid panels", blur: "Frost",
  opacity: "Opacity", glow: "Glow", backdrop: "Backdrop", backdropPattern: "Pattern", glowColors: "Glow colors", glowCount: "Glows", glowSize: "Glow size",
};
function shown(key: Key, values: AppearanceValues): string {
  const value = values[key];
  if (key === "radius" || key === "blur") return `${value}px`;
  if (key === "opacity" || key === "glow" || key === "backdrop") return `${value}%`;
  if (key === "glowSize") return `${value ?? 100}%`;
  if (key === "density") return value === 1 ? "Roomy" : "Compact";
  if (key === "reply") return value === "serif" ? "Serif" : value === "sans" ? "Sans" : "Theme's own";
  if (key === "hue") return HUES.find(([, hue]) => hue === value)?.[0] ?? `Hue ${value}`;
  if (key === "accentColor") return value === undefined ? "Adaptive" : String(value);
  if (key === "edges") return value === "strong" ? "Strong" : "Soft";
  if (key === "flat") return value ? "On" : "Off";
  if (key === "glowColors") return Array.isArray(value) ? `${value.length} picked` : "From accent";
  if (key === "backdropPattern") return value === undefined ? "Blobs" : String(value)[0].toUpperCase() + String(value).slice(1);
  return String(value ?? "Default");
}

export function StudioStatus({ studio, settings, systemDark, light, askName }: { studio: AppearanceStudioState; settings: AppSettings; systemDark: boolean; light: boolean; askName: (naming: Naming) => void }) {
  const { draft, pending } = studio;
  const saved = settings.appearance?.saved ?? [];
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const keys = editedKeys(draft, saved);
  const name = displayName(draft.source);
  const presetName = draft.source.kind === "saved" ? draft.source.name : null;
  const applied = settings.appearance?.current.appearance ?? BUILTIN_SKINS[0].appearance;
  const deckLight = effectiveLightFromMode(settings.appearance?.colorMode, systemDark, applied.light);
  const nothing = keys.length === 0 && pending.length === 0;

  useEffect(() => { if (nothing) setOpen(false); }, [nothing]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!pop.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      opener.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const toggle = (button: HTMLButtonElement) => { opener.current = button; setOpen((was) => !was); };
  /** A row's Revert leaves with the row, so move focus somewhere that stays. */
  const refocus = () => requestAnimationFrame(() => {
    (document.querySelector<HTMLElement>(".studio-pending-btn, .studio-changes-btn") ?? document.querySelector<HTMLElement>('.studio-tabs [aria-selected="true"]'))?.focus();
  });
  const leaveFocus = () => requestAnimationFrame(() => document.querySelector<HTMLElement>(".studio-editor")?.focus());
  const base = baseValuesOf(draft, saved);

  return <section className="studio-status" aria-label="What Deck is using, and what you are previewing">
    <div className="studio-id-copy">
      <div className="studio-id-text">
        <p className="studio-id-line studio-deck-line"><span className="studio-id-tag">In Deck</span><span className="studio-id-dot" aria-hidden="true" style={{ background: accentHex({ ...applied, light: deckLight }) }} /><strong>{deckLabel(settings, systemDark)}</strong></p>
        <p className="studio-id-line studio-preview-line">
          <span className="studio-id-tag">Preview</span><span className="studio-id-dot" aria-hidden="true" style={{ background: accentHex({ ...draft.values, light }) }} />
          <strong>{name}</strong> <span className="studio-sep" aria-hidden="true">·</span> <span className="studio-id-state">{modeName(draft.colorMode, systemDark)}</span> <span className="studio-sep" aria-hidden="true">·</span>{" "}
          {keys.length > 0
            ? <button type="button" className="studio-link-btn studio-state-btn studio-changes-btn" aria-expanded={open} onClick={(event) => toggle(event.currentTarget)}>Unsaved changes ({keys.length})</button>
            : <span className="studio-id-state">{presetName ? "Saved preset" : "Built-in"}</span>}{" "}
          <span className="studio-sep" aria-hidden="true">·</span>{" "}
          {pending.length > 0
            ? <button type="button" className="studio-link-btn studio-state-btn studio-pending-btn" aria-expanded={open} onClick={(event) => toggle(event.currentTarget)}>{pending.length} not applied</button>
            : <span className="studio-id-state">Matches Deck</span>}
        </p>
      </div>
      {open && <div className="studio-popover" ref={pop}>
        {pending.length > 0 && <div className="studio-pop-section">
          <p className="studio-pop-title">Not applied yet</p>
          <p className="studio-pop-note">Deck stays as it is until you apply, and this draft stays if you leave. Saving a preset doesn't apply it.</p>
          <ul className="studio-pending-list">
            {pending.map((row) => <li key={row.label}><span>{row.label}</span><em>{row.from} → {row.to}</em>
              <button type="button" className="studio-link-btn" aria-label={`Revert ${row.label} to ${row.from}`} onClick={() => { studio.revert(row.label); refocus(); }}>Revert</button></li>)}
          </ul>
        </div>}
        {keys.length > 0 && <div className="studio-pop-section">
          <p className="studio-pop-title">Changed from {name}</p>
          <ul>
            {keys.map((key) => <li key={key}><span>{EDIT_NAME[key] ?? key}</span><em>{shown(key, base)} → {shown(key, draft.values)}</em>
              <button type="button" className="studio-link-btn" aria-label={`Revert ${EDIT_NAME[key] ?? key}`} onClick={() => { studio.edit(revertKeys(draft, key === "accentColor" ? ["accentColor", "hue"] : [key], saved)); refocus(); }}>Revert</button></li>)}
          </ul>
        </div>}
      </div>}
    </div>
    <div className="studio-actions">
      <button type="button" className="studio-btn" disabled={!pending.length} aria-label="Discard draft and go back to what Deck is using" title={pending.length ? `Back to ${deckLabel(settings, systemDark)}` : undefined} onClick={() => { studio.discard(); leaveFocus(); }}>Discard draft</button>
      {presetName && <button type="button" className="studio-btn" disabled={!keys.length} onClick={() => askName({})}>Save as new…</button>}
      <button type="button" className="studio-btn" disabled={!keys.length} title={keys.length ? undefined : "Change something to save"} onClick={() => presetName ? studio.update() : askName({})}>{presetName ? `Update ${presetName}` : "Save as preset…"}</button>
      <button type="button" className="studio-btn studio-primary" disabled={!pending.length} onClick={() => { studio.apply(); leaveFocus(); }}>{pending.length ? "Apply to Deck" : "Applied"}</button>
    </div>
    <p className="studio-vh" role="status">{pending.length ? `${pending.length} not applied. Deck is using ${deckLabel(settings, systemDark)}.` : "Preview matches Deck."}</p>
  </section>;
}

/** Name a new preset, or rename one. Focus comes back to the opener on close. */
export function SaveDialog({ naming, studio, saved, onClose }: { naming: Naming; studio: AppearanceStudioState; saved: SkinFile[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(naming.rename ?? "");
  const [error, setError] = useState<string | null>(null);
  const { rename } = naming;
  const preset = displayName(studio.draft.source);
  const base = builtinFor(studio.draft.values).name;

  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
    return () => opener.current?.focus();
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = presetNameError(name, saved, rename);
    if (problem) { setError(problem); input.current?.focus(); return; }
    if (rename !== undefined) studio.rename(rename, name);
    else studio.save(name);
    onClose();
  };
  // Escape closes this dialog, not Settings behind it.
  return <dialog ref={dialog} className="studio-dialog" aria-labelledby="studio-save-title" onClose={onClose} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={submit}>
      <h3 id="studio-save-title">{rename !== undefined ? `Rename ${rename}` : "Save as a new preset"}</h3>
      <p className="studio-hint">{rename !== undefined ? `Based on ${base}.` : `Saved with ${base}'s theme, based on ${base}. ${preset} stays as it was. Deck only changes when you apply it.`}</p>
      <label htmlFor="studio-save-name">Name</label>
      <input ref={input} id="studio-save-name" type="text" maxLength={40} autoComplete="off" value={name} aria-invalid={error !== null} aria-describedby={error ? "studio-save-err" : undefined} onChange={(event) => { setName(event.currentTarget.value); setError(null); }} />
      {error && <p className="studio-err studio-save-err" id="studio-save-err" role="alert">{error}</p>}
      {rename === undefined && <p className="studio-hint">Mode, chips and the empty-thread field aren't stored in presets.</p>}
      <div className="studio-row-actions studio-end">
        <button type="button" className="studio-btn" onClick={onClose}>Cancel</button>
        <button type="submit" id="studio-save-confirm" className="studio-btn studio-primary">{rename !== undefined ? "Rename" : "Save preset"}</button>
      </div>
    </form>
  </dialog>;
}
