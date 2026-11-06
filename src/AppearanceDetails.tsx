// The Studio's two quieter tabs. Chips & effects edit the draft like everything
// else. Share moves presets in and out, and never touches Deck or the draft.

import { useRef, useState, type ChangeEvent } from "react";

import { editedKeys, displayName, importPreset, presetLimitError } from "./appearanceDraft";
import { LandingTextureControls } from "./AppearanceSettings";
import { ChipStylePicker } from "./ChipStylePicker";
import type { AppSettings } from "./settings";
import { parseSkin, skinPrompt, type SkinFile } from "./themes";
import type { AppearanceStudioState } from "./useAppearanceDraft";
import { deckClipboard } from "./copyText";

const FILE_LIMIT = 32_000;

function exported(studio: AppearanceStudioState, saved: SkinFile[]): SkinFile {
  const name = displayName(studio.draft.source);
  const modified = editedKeys(studio.draft, saved).length > 0;
  return { format: "apex-glass-playground", version: 2, name: (modified ? `${name} (modified)` : name).slice(0, 40), appearance: studio.draft.values };
}

function ChipsAndEffects({ studio }: { studio: AppearanceStudioState }) {
  const { draft } = studio;
  const chips = draft.botChips;
  const toggles = [["tool", "Tool"], ["effort", "Effort"], ["usage", "Usage"]] as const;
  return <>
    <p className="studio-panel-note">Not part of a preset. Try them in the preview; Apply sets them for all of Deck, in every theme.</p>
    <section className="studio-block" data-ctl="chips" aria-labelledby="studio-h-chips">
      <div className="studio-block-head"><h3 id="studio-h-chips">Agent chips</h3></div>
      <ChipStylePicker value={chips.style ?? "classic"} onChange={(style) => studio.edit({ ...draft, botChips: { ...chips, style } })} />
      <div className="studio-check-row" role="group" aria-label="Show on chips">
        {toggles.map(([part, label]) => <label key={part} data-ctl={part}><input id={`studio-chip-${part}`} type="checkbox" checked={chips[part]} onChange={(event) => studio.edit({ ...draft, botChips: { ...chips, [part]: event.currentTarget.checked } })} /> {label}</label>)}
      </div>
    </section>
    <section className="studio-block" data-ctl="field">
      <LandingTextureControls value={draft.landingTexture} onChange={(landingTexture) => studio.edit({ ...draft, landingTexture })} switchId="studio-field-on" />
    </section>
  </>;
}

function Share({ studio, settings }: { studio: AppearanceStudioState; settings: AppSettings }) {
  const saved = settings.appearance?.saved ?? [];
  const picker = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>({ text: "" });
  const skin = exported(studio, saved);

  const add = (text: string) => {
    try {
      if (new TextEncoder().encode(text).byteLength > FILE_LIMIT) throw new Error("Preset files must be 32,000 bytes or smaller.");
      const preset = parseSkin(text);
      const full = presetLimitError(saved);
      if (full) throw new Error(full);
      studio.change((now) => importPreset(now, preset));
      setImportText("");
      setNotice({ text: `${preset.name} added to your presets. Pick it above to preview it.` });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };
  const addFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > FILE_LIMIT) { setNotice({ text: "Preset files must be 32,000 bytes or smaller.", error: true }); return; }
    add(await file.text());
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(skin, null, 2) + "\n"], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${skin.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "apex-preset"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ text: `${skin.name} exported.` });
  };
  const copyPrompt = async () => {
    try {
      if (!prompt) throw new Error("Clipboard access is unavailable.");
      await deckClipboard.writeText(prompt);
      setNotice({ text: "AI prompt copied." });
    } catch (error) {
      setNotice({ text: `Could not copy: ${error instanceof Error ? error.message : String(error)}`, error: true });
    }
  };

  return <>
    <p className="studio-panel-note">A preset file holds appearance values only. It can't change how Deck behaves.</p>
    <section className="studio-block">
      <div className="studio-block-head"><h3>Export</h3></div>
      <p className="studio-hint">Exports <strong>{skin.name}</strong>, including unsaved changes.</p>
      <div className="studio-row-actions">
        <button type="button" id="studio-export" className="studio-btn studio-small" onClick={() => setJson(JSON.stringify(skin, null, 2))}>Show JSON</button>
        <button type="button" className="studio-btn studio-small" onClick={download}>Download .json</button>
      </div>
      {json !== null && <textarea id="studio-export-text" className="studio-text" rows={9} readOnly spellCheck={false} aria-label="Exported preset JSON" value={json} />}
    </section>
    <section className="studio-block" data-ctl="transfer">
      <div className="studio-block-head"><h3><label htmlFor="studio-import-text">Import</label></h3></div>
      <textarea id="studio-import-text" className="studio-text" rows={5} spellCheck={false} maxLength={FILE_LIMIT} placeholder="Paste preset JSON here" value={importText} onChange={(event) => setImportText(event.currentTarget.value)} />
      <div className="studio-row-actions">
        <button type="button" id="studio-import" className="studio-btn studio-small" disabled={!importText.trim()} onClick={() => add(importText)}>Add to my presets</button>
        <button type="button" className="studio-btn studio-small" onClick={() => picker.current?.click()}>Choose file…</button>
        <input ref={picker} className="studio-vh" type="file" accept="application/json,.json" aria-label="Choose a preset JSON file" tabIndex={-1} onChange={(event) => void addFile(event)} />
      </div>
    </section>
    <section className="studio-block" data-ctl="ai-prompt">
      <div className="studio-block-head"><h3><label htmlFor="studio-ai-look">Ask an AI for a preset</label></h3></div>
      <p className="studio-hint">Describe a look to get a prompt for your AI tool. Deck doesn't generate it.</p>
      <textarea id="studio-ai-look" className="studio-text" rows={2} maxLength={500} placeholder="Deep ocean at night, calm, with a soft teal accent" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
      <div className="studio-row-actions">
        <button type="button" className="studio-btn studio-small" disabled={!description.trim()} onClick={() => setPrompt(skinPrompt(description))}>Show prompt</button>
        {prompt !== null && <button type="button" className="studio-btn studio-small" onClick={() => void copyPrompt()}>Copy prompt</button>}
      </div>
      {prompt !== null && <textarea className="studio-text" rows={6} readOnly aria-label="Generated prompt" value={prompt} />}
    </section>
    {notice.text && <p className="studio-notice" role={notice.error ? "alert" : "status"}>{notice.text}</p>}
  </>;
}

export function AppearanceDetails({ tab, studio, settings }: { tab: "details" | "share"; studio: AppearanceStudioState; settings: AppSettings }) {
  return tab === "details" ? <ChipsAndEffects studio={studio} /> : <Share studio={studio} settings={settings} />;
}
