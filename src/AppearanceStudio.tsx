// The Appearance page: Mode beside Theme → Preset → Customize, a neutral editor
// and a live preview. Nothing here changes Deck until Apply.

import { useRef, useState, type KeyboardEvent } from "react";

import { CustomizePanel, MaterialPanel, Segmented } from "./AppearanceControls";
import { AppearanceDetails } from "./AppearanceDetails";
import { AppearancePresetRow } from "./AppearancePresetRow";
import { AppearancePreview, type PreviewScene } from "./AppearancePreview";
import { deckLabel, displayName, draftTheme, editedKeys, pickPreset, pickTheme } from "./appearanceDraft";
import type { AppSettings } from "./settings";
import { builtinFor, effectiveLightFromMode, type AppearanceValues, type ColorMode, type PresetRef, type ThemeId } from "./themes";
import type { AppearanceStudioState } from "./useAppearanceDraft";

export type StudioTab = "customize" | "material" | "details" | "share";
const TABS: { id: StudioTab; name: string }[] = [
  { id: "customize", name: "Customize" }, { id: "material", name: "Material" }, { id: "details", name: "Chips & effects" }, { id: "share", name: "Share" },
];
const THEMES: [ThemeId, string][] = [["clay", "Clay"], ["classic", "Classic"], ["liquid", "Liquid"]];
const MODES: [ColorMode, string][] = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];

export function AppearanceStudio({ studio, settings, systemDark }: { studio: AppearanceStudioState; settings: AppSettings; systemDark: boolean; highlightId: string | null }) {
  const { draft } = studio;
  const saved = settings.appearance?.saved ?? [];
  const [tab, setTab] = useState<StudioTab>("customize");
  const [scene, setScene] = useState<PreviewScene>("thread");
  const tabs = useRef<HTMLDivElement>(null);
  const theme = draftTheme(draft, saved);
  const light = effectiveLightFromMode(draft.colorMode, systemDark, draft.values.light);
  const name = displayName(draft.source);
  const edits = editedKeys(draft, saved).length;
  const isSaved = draft.source.kind === "saved";
  const ctx = {
    draft, saved, onEdit: studio.edit,
    patch: (change: Partial<AppearanceValues>) => {
      const values = { ...draft.values, ...change };
      for (const key of Object.keys(values) as (keyof AppearanceValues)[]) if (values[key] === undefined) delete values[key];
      studio.edit({ ...draft, values });
    },
  };
  const onPick = (ref: PresetRef) => studio.edit(pickPreset(draft, ref, saved));
  const onTheme = (next: ThemeId) => studio.edit(pickTheme(draft, next, saved));
  const onTabKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    setTab(next.id);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  return <div className="studio">
    <section className="studio-status" aria-label="What Deck is using, and what you are previewing">
      <div className="studio-id-text">
        <p className="studio-id-line">{deckLabel(settings, systemDark)}</p>
        <p className="studio-id-line">{name}</p>
      </div>
      <div className="studio-actions">
        <button type="button" className="studio-btn" disabled={!studio.pending.length} onClick={studio.discard}>Discard draft</button>
        {isSaved && <button type="button" className="studio-btn" disabled={!edits}>Save as new…</button>}
        <button type="button" className="studio-btn" disabled={!edits} onClick={isSaved ? studio.update : undefined}>{isSaved ? `Update ${name}` : "Save as preset…"}</button>
        <button type="button" className="studio-btn studio-primary" disabled={!studio.pending.length} onClick={studio.apply}>{studio.pending.length ? "Apply to Deck" : "Applied"}</button>
      </div>
    </section>

    <div className="studio-workspace">
      <section className="studio-editor" aria-label="Appearance controls" tabIndex={-1}>
        <div className="studio-pinned">
          <div className="studio-row">
            <span className="studio-row-label" id="studio-h-mode">Mode</span>
            <Segmented name="studio-mode" labelledBy="studio-h-mode" options={MODES} value={draft.colorMode} onChange={(colorMode) => studio.edit({ ...draft, colorMode })} />
          </div>
          <p className="studio-row-note">Previews here first. Presets never store it.</p>
          <div className="studio-row">
            <span className="studio-row-label" id="studio-h-theme">Theme</span>
            <Segmented name="studio-theme" labelledBy="studio-h-theme" options={THEMES} value={theme} onChange={onTheme} />
          </div>
          <AppearancePresetRow theme={theme} saved={saved} selected={draft.source} light={light} onPick={onPick} />
          <div className="studio-preset-meta">
            <span className="studio-preset-owner">{draft.source.kind === "saved" ? `${name}: yours, based on ${builtinFor(draft.values).name}` : `${name}: built-in, can't be changed`}</span>
            <span className="studio-preset-actions">
              {edits > 0 && <button type="button" className="studio-link-btn" aria-label={`Clear edits, back to ${name}`} onClick={studio.clear}>Clear edits</button>}
            </span>
          </div>
        </div>

        <div ref={tabs} className="studio-tabs" role="tablist" aria-label="Appearance areas">
          {TABS.map(({ id, name: label }, index) => <button key={id} type="button" role="tab" data-tab={id} id={`studio-tab-${id}`} aria-selected={tab === id} aria-controls={`studio-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => onTabKey(event, index)}>
            {label}{id === "material" && <span className="studio-tab-tag"> {theme === "liquid" && !draft.values.flat ? "Glass" : "Solid"}</span>}
          </button>)}
        </div>

        <div className="studio-panel" role="tabpanel" id={`studio-panel-${tab}`} aria-labelledby={`studio-tab-${tab}`}>
          {tab === "customize" && <CustomizePanel ctx={ctx} theme={theme} light={light} />}
          {tab === "material" && <MaterialPanel ctx={ctx} theme={theme} light={light} onUseLiquid={() => onTheme("liquid")} />}
          {(tab === "details" || tab === "share") && <AppearanceDetails tab={tab} studio={studio} settings={settings} />}
        </div>
      </section>

      <aside className="studio-preview" aria-label="Live preview">
        <div className="studio-preview-bar"><p className="studio-prev-state"><b>Preview</b> {studio.pending.length ? "not applied yet" : "matches Deck"}</p>
          <div className="studio-preview-tools"><Segmented name="studio-scene" label="Preview scene" options={[["thread", "Conversation"], ["empty", "Empty thread"]]} value={scene} onChange={setScene} /></div>
        </div>
        <AppearancePreview draft={draft} systemDark={systemDark} scene={scene} />
      </aside>
    </div>
  </div>;
}
