import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { BUILTIN_SKINS, parseSkin, skinPrompt, themeMode, type AppearanceSettings as AppearanceState, type AppearanceValues, type SkinFile } from "./themes";

const FILE_LIMIT = 32_000;
const SLIDERS: { key: "hue" | "glow" | "blur" | "opacity" | "radius" | "backdrop"; label: string; help: string; min: number; max: number; suffix: string }[] = [
  { key: "hue", label: "Accent hue", help: "Buttons, links and selected threads.", min: 0, max: 360, suffix: "°" },
  { key: "glow", label: "Glow", help: "Strength of the light around active work.", min: 0, max: 100, suffix: "%" },
  { key: "blur", label: "Frost", help: "Blur behind glass surfaces.", min: 0, max: 40, suffix: "px" },
  { key: "opacity", label: "Surface", help: "Lower values let more backdrop through.", min: 30, max: 100, suffix: "%" },
  { key: "radius", label: "Corners", help: "Corner size across panels and controls.", min: 4, max: 30, suffix: "px" },
  { key: "backdrop", label: "Backdrop", help: "Strength of the color field behind glass.", min: 0, max: 100, suffix: "%" },
];

function asSkin(name: string, appearance: AppearanceValues): SkinFile {
  return { format: "apex-glass-playground", version: 2, name, appearance: { ...appearance } };
}

function previewStyle(appearance: AppearanceValues): CSSProperties {
  return {
    "--appearance-hue": appearance.hue,
    "--appearance-glow": appearance.glow / 100,
    "--appearance-blur": `${appearance.blur}px`,
    "--appearance-opacity": appearance.opacity / 100,
    "--appearance-radius": `${appearance.radius}px`,
    "--appearance-backdrop": appearance.backdrop / 100,
    "--appearance-density": appearance.density,
  } as CSSProperties;
}

function SkinPreview({ skin }: { skin: SkinFile }) {
  const appearance = skin.appearance;
  return <span className="appearance-preview" aria-hidden="true" data-mode={themeMode(appearance)} style={previewStyle(appearance)}>
    <span className="appearance-preview-field" />
    <span className="appearance-preview-lines"><i /><i className="short" /><b /><i className="short" /></span>
    <span className="appearance-preview-bubble"><i /></span>
    <span className="appearance-preview-wait"><i /> Waiting</span>
    <span className="appearance-preview-composer"><i /><b /></span>
  </span>;
}

/** Appearance controls for the glass skin system. The parent owns persistence. */
export function AppearanceSettings({ value, onChange }: { value: AppearanceState; onChange: (value: AppearanceState) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [skinName, setSkinName] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>({ text: "" });
  const current = value.current;
  const appearance = current.appearance;
  const saved = value.saved ?? [];

  const apply = (skin: SkinFile) => {
    onChange({ ...value, current: skin });
    setNotice({ text: `${skin.name} selected.` });
  };
  const tune = (patch: Partial<AppearanceValues>) => {
    onChange({ ...value, current: asSkin("Custom", { ...appearance, ...patch }) });
    setNotice({ text: "Custom appearance updated." });
  };
  const keep = (skin: SkinFile) => {
    const nextSaved = [...saved.filter((item) => !(item.name === skin.name && JSON.stringify(item.appearance) === JSON.stringify(skin.appearance))), skin].slice(-50);
    onChange({ ...value, current: skin, saved: nextSaved });
  };
  const saveCurrent = () => {
    const name = skinName.trim().slice(0, 40);
    if (!name) {
      setNotice({ text: "Enter a name for this skin.", error: true });
      return;
    }
    const skin = asSkin(name, appearance);
    keep(skin);
    setSkinName("");
    setNotice({ text: `${name} saved to your skins.` });
  };
  const importText = (text: string) => {
    if (new TextEncoder().encode(text).byteLength > FILE_LIMIT) throw new Error("Skin files must be 32,000 bytes or smaller.");
    const skin = parseSkin(text);
    keep(skin);
    setNotice({ text: `${skin.name} imported and added to your skins.` });
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      if (file.size > FILE_LIMIT) throw new Error("Skin files must be 32,000 bytes or smaller.");
      const text = await file.text();
      importText(text);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };
  const exportSkin = () => {
    try {
      const blob = new Blob([JSON.stringify(current, null, 2) + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${current.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "apex-skin"}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice({ text: `${current.name} exported.` });
    } catch (error) {
      setNotice({ text: `Could not export skin: ${error instanceof Error ? error.message : String(error)}`, error: true });
    }
  };
  const copyText = async (text: string, success: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Check your browser permissions.");
      await navigator.clipboard.writeText(text);
      setNotice({ text: success });
    } catch (error) {
      setNotice({ text: `Could not copy: ${error instanceof Error ? error.message : String(error)}`, error: true });
    }
  };
  const copyPrompt = () => {
    const request = description.trim();
    if (!request) {
      setNotice({ text: "Describe the look you want before copying its prompt.", error: true });
      return;
    }
    void copyText(skinPrompt(request), "AI prompt copied. Paste it into your AI tool to get a skin file.");
  };
  const gallery = [
    ...BUILTIN_SKINS.map((preset) => ({ id: `builtin-${preset.id}`, name: preset.name, note: preset.note, skin: asSkin(preset.name, preset.appearance) })),
    ...saved.map((skin, index) => ({ id: `saved-${index}-${skin.name}`, name: skin.name, note: "Saved skin", skin })),
  ];
  // One tile at most: prefer the tile whose name and values both match, so a saved skin
  // that copies a built-in's values doesn't light up next to it.
  const sameValues = (skin: SkinFile) => JSON.stringify(skin.appearance) === JSON.stringify(appearance);
  const selectedId = (gallery.find(({ skin }) => skin.name === current.name && sameValues(skin)) ?? gallery.find(({ skin }) => sameValues(skin)))?.id;

  return <div className="appearance-settings">
    <header className="appearance-heading">
      <div><p>Skins change how Deck looks, never how it works.</p></div>
      <span className="appearance-current">Using <strong>{current.name}</strong></span>
    </header>

    <section className="appearance-section" aria-labelledby="appearance-skins-title">
      <div className="appearance-section-heading"><div><h3 id="appearance-skins-title">Skins</h3><p>Choose a starting point or return to a skin you saved.</p></div></div>
      <div className="appearance-gallery" role="group" aria-label="Appearance skins">
        {gallery.map(({ id, name, note, skin }) => {
          return <button key={id} type="button" className="appearance-skin" aria-pressed={id === selectedId} onClick={() => apply(skin)}>
            <SkinPreview skin={skin} /><strong>{name}</strong><small>{note}</small>
          </button>;
        })}
      </div>
    </section>

    <section className="appearance-section" aria-labelledby="appearance-tune-title">
      <div className="appearance-section-heading"><div><h3 id="appearance-tune-title">Tune this skin</h3><p>Changes apply as you move each control.</p></div></div>
      <div className="appearance-controls">
        {SLIDERS.map(({ key, label, help, min, max, suffix }) => <div className="appearance-slider" key={key}>
          <div className="appearance-control-copy"><label htmlFor={`appearance-${key}`}>{label}</label><small>{help}</small></div>
          <input id={`appearance-${key}`} type="range" min={min} max={max} step="1" value={appearance[key]} onChange={(event) => tune({ [key]: Number(event.currentTarget.value) })} />
          <output htmlFor={`appearance-${key}`}>{appearance[key]}{suffix}</output>
        </div>)}
        <div className="appearance-option">
          <div className="appearance-control-copy"><strong>Reading density</strong><small>How much room rows and messages get.</small></div>
          <div className="appearance-segment" role="group" aria-label="Reading density">
            <button type="button" aria-pressed={appearance.density === 0.72} onClick={() => tune({ density: 0.72 })}>Compact</button>
            <button type="button" aria-pressed={appearance.density === 1} onClick={() => tune({ density: 1 })}>Roomy</button>
          </div>
        </div>
        <label className="appearance-option">
          <span className="appearance-control-copy"><strong>Light surfaces</strong><small>Pale panels and dark text.</small></span>
          <input type="checkbox" role="switch" checked={appearance.light} onChange={(event) => tune({ light: event.currentTarget.checked })} />
        </label>
        <label className="appearance-option">
          <span className="appearance-control-copy"><strong>Flat surfaces</strong><small>Solid panels without the glass effect.</small></span>
          <input type="checkbox" role="switch" checked={appearance.flat} onChange={(event) => tune({ flat: event.currentTarget.checked })} />
        </label>
      </div>
    </section>

    <section className="appearance-section appearance-save" aria-labelledby="appearance-save-title">
      <div className="appearance-section-heading"><div><h3 id="appearance-save-title">Save this skin</h3><p>Keep a named copy in your appearance gallery.</p></div></div>
      <div className="appearance-inline-form">
        <label className="visually-hidden" htmlFor="appearance-skin-name">Skin name</label>
        <input id="appearance-skin-name" type="text" maxLength={40} value={skinName} placeholder="Name this skin" onChange={(event) => setSkinName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") saveCurrent(); }} />
        <button type="button" className="appearance-primary" onClick={saveCurrent}>Save skin</button>
      </div>
    </section>

    <section className="appearance-section" aria-labelledby="appearance-share-title">
      <div className="appearance-section-heading"><div><h3 id="appearance-share-title">Share a skin</h3><p>Skin files contain the supported appearance values only.</p></div></div>
      <div className="appearance-actions">
        <button type="button" onClick={exportSkin}>Export current skin</button>
        <button type="button" onClick={() => picker.current?.click()}>Import JSON skin</button>
        <input ref={picker} className="visually-hidden" type="file" accept="application/json,.json" aria-label="Choose a skin JSON file" onChange={(event) => void importFile(event)} />
      </div>
      <div className="appearance-prompt">
        <label htmlFor="appearance-prompt-description">Copy an AI prompt</label>
        <p>Describe a look, then copy a prompt that explains Deck’s skin file format. Deck does not generate the skin for you.</p>
        <textarea id="appearance-prompt-description" rows={3} maxLength={500} value={description} placeholder="Deep ocean at night, calm, with a soft teal accent" onChange={(event) => setDescription(event.currentTarget.value)} />
        <button type="button" onClick={copyPrompt}>Copy AI prompt</button>
      </div>
      <p className="appearance-notice" role={notice.error ? "alert" : "status"} aria-live={notice.error ? "assertive" : "polite"}>{notice.text}</p>
      <p className="appearance-safety">Skin files cannot change Deck’s behavior. Approval cards keep their readable, solid treatment.</p>
    </section>
  </div>;
}
