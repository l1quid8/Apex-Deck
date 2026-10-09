import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { BACKDROP_PATTERNS, BUILTIN_SKINS, MAX_GLOWS, MIN_GLOWS, accentHex, backdropLayers, backgroundPatch, colorAppearance, glowColorList, parseSkin, shuffledGlowColors, skinPrompt, themeMode, type AppearanceSettings as AppearanceState, type AppearanceValues, type SkinFile } from "./themes";

const FILE_LIMIT = 32_000;
const SLIDERS: { key: "glow" | "blur" | "opacity" | "radius" | "backdrop"; label: string; help: string; min: number; max: number; suffix: string }[] = [
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
    "--appearance-accent": accentHex(appearance),
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

/** Accept #rgb or #rrggbb (same rules as the accent field) and return lowercase #rrggbb, or null. */
function normalizeHex(input: string): string | null {
  let hex = input.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = "#" + [...hex.slice(1)].map(c => c + c).join("");
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
}

/** One exact glow color: a color picker plus a hex box that commits on blur or Enter. */
function GlowColorRow({ index, color, onCommit }: { index: number; color: string; onCommit: (hex: string) => void }) {
  const [text, setText] = useState(color);
  const [error, setError] = useState(false);
  useEffect(() => { setText(color); setError(false); }, [color]);
  const label = `Glow ${index + 1}`;
  const errorId = `appearance-glow-${index}-error`;
  const commitText = () => {
    const hex = normalizeHex(text);
    if (!hex) { setError(true); return; }
    setText(hex);
    setError(false);
    if (hex !== color) onCommit(hex);
  };
  return <>
    <div className="appearance-option appearance-glow">
      <div className="appearance-control-copy"><strong>{label}</strong></div>
      <div className="appearance-color-inputs">
        <input type="color" aria-label={`${label} color`} value={color} onChange={event => { setError(false); onCommit(event.currentTarget.value); }} />
        <input type="text" aria-label={`${label} hex color`} value={text} spellCheck={false} maxLength={7} aria-invalid={error} aria-describedby={error ? errorId : undefined}
          onChange={event => { setText(event.currentTarget.value); setError(false); }}
          onBlur={commitText}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </div>
    </div>
    {error && <p id={errorId} role="alert" className="appearance-glow-error">Enter a hex color such as #35aabb.</p>}
  </>;
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
  const color = accentHex(appearance);
  const [hexInput, setHexInput] = useState(color);
  const [hexError, setHexError] = useState(false);
  useEffect(() => { setHexInput(color); setHexError(false); }, [color]);

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

  const colors = glowColorList(appearance);
  const glowCount = colors.length;
  const pattern = appearance.backdropPattern ?? "blobs";
  const glowSize = appearance.glowSize ?? 100;
  // Every Background control goes through here so Classic and flat skins switch to glass.
  const tuneBackground = (patch: Partial<AppearanceValues>) => tune(backgroundPatch(appearance, patch));
  const setGlowColor = (index: number, hex: string) => {
    const next = [...colors];
    next[index] = hex;
    tuneBackground({ glowColors: next });
  };
  const addGlow = () => {
    if (glowCount >= MAX_GLOWS) return;
    tuneBackground(appearance.glowColors ? { glowColors: [...colors, shuffledGlowColors(1, appearance.light)[0]] } : { glowCount: glowCount + 1 });
  };
  const removeGlow = () => {
    if (glowCount <= MIN_GLOWS) return;
    tuneBackground(appearance.glowColors ? { glowColors: colors.slice(0, -1) } : { glowCount: glowCount - 1 });
  };

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
        <div className="appearance-option appearance-color">
          <div className="appearance-control-copy"><label htmlFor="appearance-color">Accent color</label><small>Pick any color, or enter its hex value.</small></div>
          <div className="appearance-color-inputs">
            <input id="appearance-color" type="color" value={color} onChange={event => { tune(colorAppearance(event.currentTarget.value)); setHexInput(event.currentTarget.value); setHexError(false); }} />
            <input aria-label="Accent hex color" type="text" value={hexInput} spellCheck={false} maxLength={7} aria-invalid={hexError} aria-describedby={hexError ? "appearance-color-error" : undefined}
              onChange={event => {
                const input = event.currentTarget.value;
                setHexInput(input);
                setHexError(false);
                if (/^#[0-9a-f]{6}$/i.test(input)) tune(colorAppearance(input));
              }}
              onBlur={() => { try { const patch = colorAppearance(hexInput); tune(patch); setHexInput(patch.accentColor!); setHexError(false); } catch { setHexError(true); } }}
              onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          </div>
        </div>
        {hexError && <p id="appearance-color-error" role="alert">Enter a hex color such as #35aabb.</p>}
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

    <section className="appearance-section" aria-labelledby="appearance-background-title">
      <div className="appearance-section-heading"><div><h3 id="appearance-background-title">Background</h3><p>The colored glow behind the glass.</p></div></div>
      {appearance.flat && <p>Flat surfaces hide the background. Changing it here turns glass on.</p>}
      <div className="appearance-pattern-grid" role="group" aria-label="Background pattern">
        {BACKDROP_PATTERNS.map(({ id, name }) => {
          // Tiles stay visible even when the Backdrop slider is low.
          const layers = backdropLayers({ ...appearance, backdropPattern: id, backdrop: Math.max(appearance.backdrop, 70) }, 0.25);
          return <button key={id} type="button" className="appearance-pattern" aria-pressed={pattern === id} onClick={() => tuneBackground({ backdropPattern: id })}>
            <span className="appearance-pattern-preview" aria-hidden="true" style={{ backgroundColor: appearance.light ? "#eef1f6" : "#0b1020", backgroundImage: layers.image, backgroundSize: layers.size }} />
            <strong>{name}</strong>
          </button>;
        })}
      </div>
      <div className="appearance-controls">
        <label className="appearance-option">
          <span className="appearance-control-copy"><strong>Match accent</strong><small>Glows follow the accent color. Turn this off to pick each glow.</small></span>
          <input type="checkbox" role="switch" checked={appearance.glowColors === undefined} onChange={(event) => tuneBackground(event.currentTarget.checked ? { glowColors: undefined, glowCount } : { glowColors: colors })} />
        </label>
        <div className="appearance-option">
          <div className="appearance-control-copy"><strong>Glows</strong><small>How many colored glows sit behind the glass.</small></div>
          <div className="appearance-stepper">
            <button type="button" aria-label="Fewer glows" disabled={glowCount <= MIN_GLOWS} onClick={removeGlow}>−</button>
            <output aria-live="polite">{glowCount}</output>
            <button type="button" aria-label="More glows" disabled={glowCount >= MAX_GLOWS} onClick={addGlow}>+</button>
          </div>
        </div>
        {appearance.glowColors
          ? colors.map((hex, index) => <GlowColorRow key={index} index={index} color={hex} onCommit={(next) => setGlowColor(index, next)} />)
          : <div className="appearance-option">
            <div className="appearance-control-copy"><strong>Glow colors</strong><small>Following the accent. Turn off Match accent to edit them.</small></div>
            <div className="appearance-swatches" role="group" aria-label="Glow colors from the accent">
              {colors.map((hex, index) => <span key={index} className="appearance-swatch" title={hex} style={{ backgroundColor: hex }} />)}
            </div>
          </div>}
        <div className="appearance-slider">
          <div className="appearance-control-copy"><label htmlFor="appearance-glow-size">Size</label><small>Makes the glows tighter or wider.</small></div>
          <input id="appearance-glow-size" type="range" min={50} max={200} step="1" value={glowSize} onChange={(event) => tuneBackground({ glowSize: Number(event.currentTarget.value) })} />
          <output htmlFor="appearance-glow-size">{glowSize}%</output>
        </div>
      </div>
      <div className="appearance-actions appearance-background-actions">
        <button type="button" onClick={() => tuneBackground({ glowColors: shuffledGlowColors(glowCount, appearance.light) })}>Shuffle colors</button>
        <button type="button" onClick={() => tuneBackground({ backdropPattern: undefined, glowColors: undefined, glowCount: undefined, glowSize: undefined })}>Reset background</button>
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
