// The editor's two tabs. Customize holds what every theme shares, in the same
// places. Material holds the theme's own surface settings, and never shows a
// control the theme can't use.

import { useEffect, useState, type ReactNode } from "react";

import { GlowColorRow } from "./AppearanceSettings";
import { editedKeys, revertKeys, type AppearanceDraft } from "./appearanceDraft";
import { paletteOf } from "./AppearanceThumb";
import {
  BACKDROP_PATTERNS, MAX_GLOWS, MIN_GLOWS, accentHex, backdropLayers, backgroundPatch, colorAppearance, glowColorList, shuffledGlowColors,
  type AppearanceValues, type SkinFile, type ThemeId,
} from "./themes";

type Key = keyof AppearanceValues;
export const HUES: [string, number][] = [["Terracotta", 38], ["Sage", 152], ["Slate", 252], ["Teal", 172], ["Violet", 290], ["Rose", 15]];
const CORNERS: Record<ThemeId, string> = { clay: "Cards and composer only. Columns stay flush.", classic: "Every panel and control.", liquid: "Every glass panel and control." };
const THEME_NOTE: Record<"clay" | "classic", string> = {
  clay: "Clay is solid. Flush columns, straight dividers, opaque surfaces.",
  classic: "Classic is solid. Rounded, separated panels on opaque surfaces.",
};
const swatch = (hue: number) => `oklch(.72 .1 ${hue})`;

interface Ctx { draft: AppearanceDraft; saved: SkinFile[]; onEdit: (next: AppearanceDraft) => void; patch: (change: Partial<AppearanceValues>) => void }

export function Segmented<T extends string>({ name, label, labelledBy, options, value, onChange }: { name: string; label?: string; labelledBy?: string; options: [T, string][]; value: T; onChange: (value: T) => void }) {
  return <div className="studio-seg" role="radiogroup" aria-label={label} aria-labelledby={labelledBy}>
    {options.map(([id, text]) => <label key={id} className={`studio-seg-item${id === value ? " studio-on" : ""}`}>
      <input className="studio-vh" type="radio" name={name} value={id} checked={id === value} onChange={() => onChange(id)} />
      <span>{text}</span>
    </label>)}
  </div>;
}

/** One control's frame: its name, the changed dot and its own revert. */
function Ctl({ ctx, id, name, keys, className = "", label, children }: { ctx: Ctx; id?: string; name: string; keys?: Key[]; className?: string; label?: string; children: ReactNode }) {
  const changed = keys ? editedKeys(ctx.draft, ctx.saved).some((key) => keys.includes(key)) : false;
  return <div className={`studio-ctl ${className}${changed ? " studio-changed" : ""}`} data-ctl={id}>
    <div className="studio-ctl-head">
      {label ? <label className="studio-ctl-name" htmlFor={label}>{name}</label> : <span className="studio-ctl-name">{name}</span>}
      {changed && <button type="button" className="studio-ctl-revert" aria-label={`Revert ${name}`} title={`Revert ${name}`} onClick={() => ctx.onEdit(revertKeys(ctx.draft, keys!, ctx.saved))}>↺</button>}
    </div>
    {children}
  </div>;
}

function RangeRow({ ctx, id, name, field, min, max, suffix, keys, note }: { ctx: Ctx; id?: string; name: string; field: "radius" | "blur" | "opacity" | "glow" | "backdrop"; min: number; max: number; suffix: string; keys?: Key[]; note?: string }) {
  const inputId = `studio-${field}`;
  const value = ctx.draft.values[field];
  return <Ctl ctx={ctx} id={id} name={name} keys={keys ?? [field]} className="studio-line" label={inputId}>
    <input id={inputId} type="range" min={min} max={max} step={1} value={value} aria-describedby={note ? `${inputId}-note` : undefined} onChange={(event) => ctx.patch({ [field]: event.currentTarget.valueAsNumber })} />
    <output htmlFor={inputId}>{value}{suffix}</output>
    {note && <p className="studio-hint studio-full" id={`${inputId}-note`}>{note}</p>}
  </Ctl>;
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

function AccentControl({ ctx, light }: { ctx: Ctx; light: boolean }) {
  const { values } = ctx.draft;
  const exact = values.accentColor !== undefined;
  const hueName = HUES.find(([, hue]) => hue === values.hue)?.[0] ?? `Hue ${values.hue}`;
  const [text, setText] = useState(values.accentColor ?? "");
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(values.accentColor ?? ""); setBad(false); }, [values.accentColor]);
  const typed = (value: string) => {
    setText(value);
    try { ctx.patch(colorAppearance(value)); setBad(false); } catch { /* wait until it's a color */ }
  };
  const palette = paletteOf(values);
  return <Ctl ctx={ctx} id="accent" name="Accent" keys={["hue", "accentColor"]} className="studio-accent">
    <div className="studio-accent-mode">
      <Segmented name="studio-accent" label="Accent type" options={[["adaptive", "Adaptive"], ["exact", "Exact color"]]} value={exact ? "exact" : "adaptive"}
        onChange={(mode) => ctx.patch(mode === "exact" ? colorAppearance(accentHex({ ...values, light })) : { accentColor: undefined })} />
    </div>
    <div className="studio-accent-slot">
      {exact ? <>
        <div className="studio-exact-row">
          <input type="color" aria-label="Exact accent color" value={values.accentColor} onChange={(event) => ctx.patch(colorAppearance(event.currentTarget.value))} />
          <input type="text" className="studio-hex" aria-label="Exact accent hex value" maxLength={7} spellCheck={false} value={text} aria-invalid={bad} onChange={(event) => typed(event.currentTarget.value)} onBlur={() => { try { colorAppearance(text); } catch { setBad(true); } }} />
        </div>
        {bad && <p className="studio-err" role="alert">Enter a hex color such as #35aabb.</p>}
      </> : <>
        <div className="studio-swatches" role="radiogroup" aria-label="Accent color">
          {HUES.map(([name, hue]) => <label key={hue} className={`studio-hue-item${hue === values.hue ? " studio-on" : ""}`} title={name}>
            <input className="studio-vh" type="radio" name="studio-hue" checked={hue === values.hue} aria-label={name} onChange={() => ctx.patch({ hue })} />
            <span className="studio-hue-dot" style={{ background: swatch(hue) }} />
          </label>)}
        </div>
        <label className="studio-range-row"><span className="studio-vh">Hue</span><input type="range" min={0} max={360} value={values.hue} onChange={(event) => ctx.patch({ hue: event.currentTarget.valueAsNumber })} /><output>{hueName}</output></label>
      </>}
    </div>
    <p className="studio-hint">{exact ? "Used as-is in both modes. Check how it reads:" : "Tuned for Light and Dark so it stays readable."}</p>
    <div className="studio-result">
      {(["Dark", "Light"] as const).map((mode) => {
        const bg = palette[mode === "Dark" ? "dark" : "light"].bg;
        const accent = accentHex({ ...values, light: mode === "Light" });
        const ratio = contrast(accent, bg);
        return <div key={mode} className={`studio-res-item${(mode === "Light") === light ? " studio-now" : ""}`} style={{ background: bg, color: contrast("#ffffff", bg) > contrast("#000000", bg) ? "#fff" : "#111" }}>
          <span className="studio-res-chip" style={{ background: accent }} />
          <span className="studio-res-ratio">{mode} {ratio.toFixed(1)}:1 {ratio >= 4.5 ? "✓" : "⚠ low"}</span>
        </div>;
      })}
    </div>
  </Ctl>;
}

export function CustomizePanel({ ctx, theme, light }: { ctx: Ctx; theme: ThemeId; light: boolean }) {
  const { values } = ctx.draft;
  const ownReply = theme === "clay" ? "serif" : "sans";
  return <>
    <AccentControl ctx={ctx} light={light} />
    <Ctl ctx={ctx} id="reply" name="Reply text" keys={["reply"]} className="studio-line-seg">
      <Segmented name="studio-reply" label="Reply text" options={[["serif", "Serif"], ["sans", "Sans"]]} value={values.reply ?? ownReply} onChange={(reply) => ctx.patch({ reply: reply === ownReply ? undefined : reply })} />
    </Ctl>
    <Ctl ctx={ctx} id="density" name="Density" keys={["density"]} className="studio-line-seg">
      <Segmented name="studio-density" label="Density" options={[["0.72", "Compact"], ["1", "Roomy"]]} value={String(values.density) as "0.72" | "1"} onChange={(density) => ctx.patch({ density: Number(density) as 0.72 | 1 })} />
    </Ctl>
    <RangeRow ctx={ctx} id="corners" name="Corners" field="radius" min={4} max={30} suffix="px" note={CORNERS[theme]} />
  </>;
}

function PanelEdges({ ctx }: { ctx: Ctx }) {
  return <Ctl ctx={ctx} id="edges" name="Panel edges" keys={["edges"]} className="studio-line-seg">
    <Segmented name="studio-edges" label="Panel edges" options={[["soft", "Soft"], ["strong", "Strong"]]} value={ctx.draft.values.edges ?? "soft"} onChange={(edges) => ctx.patch({ edges: edges === "strong" ? "strong" : undefined })} />
  </Ctl>;
}

function GlowDetails({ ctx, light }: { ctx: Ctx; light: boolean }) {
  const { values } = ctx.draft;
  const shown = { ...values, light };
  const matching = !values.glowColors;
  const colors = glowColorList(shown);
  const glow = (change: Partial<AppearanceValues>) => ctx.patch(backgroundPatch(values, change));
  const count = (step: number) => {
    const next = colors.length + step;
    if (matching) glow({ glowCount: next });
    else glow({ glowColors: step > 0 ? [...colors, shuffledGlowColors(1, light)[0]] : colors.slice(0, -1) });
  };
  return <details className="studio-more-glow">
    <summary>Glow colors and size</summary>
    <Ctl ctx={ctx} id="glow-colors" name="Match accent" keys={["glowColors"]} className="studio-line-seg studio-switch-row" label="studio-match-accent">
      <input id="studio-match-accent" type="checkbox" role="switch" checked={matching} onChange={(event) => glow({ glowColors: event.currentTarget.checked ? undefined : colors })} />
    </Ctl>
    {matching
      ? <div className="studio-glow-colors">{colors.map((color) => <span key={color} className="studio-sw" style={{ background: color }} title={color} />)}</div>
      : colors.map((color, index) => <GlowColorRow key={index} index={index} color={color} onCommit={(hex) => glow({ glowColors: colors.map((old, i) => i === index ? hex : old) })} />)}
    <Ctl ctx={ctx} id="glow-count" name="Glows" keys={["glowCount"]} className="studio-line-seg">
      <div className="studio-stepper">
        <button type="button" className="studio-btn studio-small" aria-label="Fewer glows" disabled={colors.length <= MIN_GLOWS} onClick={() => count(-1)}>−</button>
        <output aria-live="polite">{colors.length}</output>
        <button type="button" className="studio-btn studio-small" aria-label="More glows" disabled={colors.length >= MAX_GLOWS} onClick={() => count(1)}>+</button>
      </div>
    </Ctl>
    <Ctl ctx={ctx} id="glow-size" name="Size" keys={["glowSize"]} className="studio-line" label="studio-glow-size">
      <input id="studio-glow-size" type="range" min={50} max={200} step={1} value={values.glowSize ?? 100} onChange={(event) => glow({ glowSize: event.currentTarget.valueAsNumber })} />
      <output htmlFor="studio-glow-size">{values.glowSize ?? 100}%</output>
    </Ctl>
    <div className="studio-row-actions"><button type="button" className="studio-btn studio-small" onClick={() => glow({ glowColors: shuffledGlowColors(colors.length, light) })}>Shuffle colors</button></div>
  </details>;
}

export function MaterialPanel({ ctx, theme, light, onUseLiquid }: { ctx: Ctx; theme: ThemeId; light: boolean; onUseLiquid: () => void }) {
  const { values } = ctx.draft;
  if (theme !== "liquid") return <>
    <p className="studio-cap-line">{THEME_NOTE[theme]}</p>
    <PanelEdges ctx={ctx} />
    <div className="studio-cap-note">
      <p>Frost, glow and backgrounds need glass, so they aren't here.</p>
      <button type="button" className="studio-btn studio-small" onClick={onUseLiquid}>Switch to Liquid</button>
    </div>
  </>;
  return <>
    <Ctl ctx={ctx} id="flat" name="Solid panels" keys={["flat"]} className="studio-line-seg studio-switch-row" label="studio-flat">
      <input id="studio-flat" type="checkbox" role="switch" checked={values.flat} onChange={(event) => ctx.patch({ flat: event.currentTarget.checked })} />
    </Ctl>
    {values.flat
      ? <div className="studio-cap-note">
          <p><strong>Glass is off.</strong> Frost, glow and the background are hidden. Your settings are kept.</p>
          <button type="button" className="studio-btn studio-small" onClick={() => ctx.patch({ flat: false })}>Turn glass on</button>
        </div>
      : <>
          <RangeRow ctx={ctx} id="frost" name="Frost" field="blur" min={0} max={40} suffix="px" />
          <RangeRow ctx={ctx} id="surface" name="Opacity" field="opacity" min={30} max={100} suffix="%" />
          <RangeRow ctx={ctx} id="glow" name="Glow" field="glow" min={0} max={100} suffix="%" />
          <RangeRow ctx={ctx} id="backdrop" name="Backdrop" field="backdrop" min={0} max={100} suffix="%" />
          <Ctl ctx={ctx} id="pattern" name="Pattern" keys={["backdropPattern"]}>
            <div className="studio-pattern-strip" role="radiogroup" aria-label="Pattern">
              {BACKDROP_PATTERNS.map((pattern) => {
                const on = (values.backdropPattern ?? "blobs") === pattern.id;
                const layers = backdropLayers({ ...values, light, backdropPattern: pattern.id, backdrop: Math.max(values.backdrop, 70) }, .25);
                return <label key={pattern.id} className={`studio-pattern-card${on ? " studio-on" : ""}`}>
                  <input className="studio-vh" type="radio" name="studio-pattern" value={pattern.id} checked={on} onChange={() => ctx.patch(backgroundPatch(values, { backdropPattern: pattern.id }))} />
                  <span className="studio-pat" aria-hidden="true" style={{ backgroundColor: light ? "#eef1f6" : "#0b1020", backgroundImage: layers.image, backgroundSize: layers.size }} />
                  <span>{pattern.name}</span>
                </label>;
              })}
            </div>
          </Ctl>
          <PanelEdges ctx={ctx} />
          <GlowDetails ctx={ctx} light={light} />
        </>}
  </>;
}
