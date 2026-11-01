// The Appearance page's stored draft.
//
// settings.appearance, botChips and landingTexture stay the record of what Deck
// is using, so every window keeps painting applied values. Pending work lives
// beside them in settings.appearanceDraft until Apply copies it over. Every
// function here is pure and leaves its input alone.

import { CHIP_STYLES, type ChipParts } from "./botChip.ts";
import {
  BUILTIN_SKINS, builtinFor, defaultAppearanceSettings, deriveSource, isColorMode, parseSkin, sameLook, themeFamily,
  type AppearanceSettings, type AppearanceValues, type ColorMode, type PresetRef, type SkinFile, type ThemeId,
} from "./themes.ts";
import { DEFAULT_LANDING_TEXTURE, readBotChips, readLandingTexture, type AppSettings, type LandingTextureSettings } from "./settings.ts";

export interface AppearanceDraft {
  version: 1;
  colorMode: ColorMode;
  source: PresetRef;
  values: AppearanceValues;
  botChips: ChipParts;
  landingTexture: LandingTextureSettings;
  /** Last preset and Material edits per theme, so switching theme and back loses nothing. */
  lastPreset: Partial<Record<ThemeId, PresetRef>>;
  materialEdits: Partial<Record<ThemeId, Partial<AppearanceValues>>>;
}
export type PendingLabel = "Mode" | "Theme and preset" | "Agent chips" | "Empty thread";
export interface PendingChange { label: PendingLabel; from: string; to: string }

type Key = keyof AppearanceValues;
export const SHARED_KEYS: Key[] = ["hue", "accentColor", "radius", "density", "reply"];
export const MATERIAL_KEYS: Record<ThemeId, Key[]> = {
  clay: ["edges"],
  classic: ["edges"],
  liquid: ["edges", "flat", "blur", "opacity", "glow", "backdrop", "backdropPattern", "glowColors", "glowCount", "glowSize"],
};
const THEME_FIRST: Record<ThemeId, string> = { clay: "clay", classic: "classic", liquid: "liquid" };
const MAX_SAVED = 50;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameRef = (a: PresetRef, b: PresetRef) => a.kind === b.kind && (a.kind === "builtin" ? a.id === (b as typeof a).id : a.name === (b as typeof a).name);
const skinFile = (name: string, appearance: AppearanceValues): SkinFile => ({ format: "apex-glass-playground", version: 2, name, appearance });
const appliedAppearance = (settings: AppSettings): AppearanceSettings => settings.appearance ?? defaultAppearanceSettings();
const sameChips = (a: ChipParts, b: ChipParts) => (a.style ?? "classic") === (b.style ?? "classic") && a.tool === b.tool && a.effort === b.effort && a.usage === b.usage;

/** parseSkin's rules for one set of values. Drops a reply that matches the theme's own. */
const canonical = (values: AppearanceValues): AppearanceValues => parseSkin(JSON.stringify(skinFile("draft", values))).appearance;

const refExists = (ref: PresetRef, saved: SkinFile[]) => ref.kind === "builtin" ? BUILTIN_SKINS.some((skin) => skin.id === ref.id) : saved.some((skin) => skin.name === ref.name);
const asRef = (raw: unknown, saved: SkinFile[]): PresetRef | undefined => {
  if (!isRecord(raw)) return undefined;
  const ref = raw.kind === "builtin" && typeof raw.id === "string" ? { kind: "builtin" as const, id: raw.id }
    : raw.kind === "saved" && typeof raw.name === "string" ? { kind: "saved" as const, name: raw.name } : undefined;
  return ref && refExists(ref, saved) ? ref : undefined;
};

function baseValues(ref: PresetRef, saved: SkinFile[]): AppearanceValues {
  const found = ref.kind === "builtin" ? BUILTIN_SKINS.find((skin) => skin.id === ref.id)?.appearance : saved.find((skin) => skin.name === ref.name)?.appearance;
  return { ...(found ?? BUILTIN_SKINS[0].appearance) };
}

export const baseValuesOf = (draft: AppearanceDraft, saved: SkinFile[]) => baseValues(draft.source, saved);

/** The theme a draft is on follows its preset, so Liquid's Solid panels stays Liquid. */
export function draftTheme(draft: AppearanceDraft, saved: SkinFile[]): ThemeId {
  return themeFamily(baseValues(draft.source, saved));
}

export function displayName(ref: PresetRef): string {
  if (ref.kind === "saved") return ref.name;
  return BUILTIN_SKINS.find((skin) => skin.id === ref.id)?.name ?? "Preset";
}

export function modeName(mode: ColorMode | undefined, systemDark: boolean): string {
  if (mode === "light") return "Light";
  if (mode === "dark") return "Dark";
  return `System (${systemDark ? "Dark" : "Light"})`;
}

/** What Deck is using, in words: "Clay Warm", "Mine (earlier version)". */
export function appliedName(settings: AppSettings): string {
  const applied = appliedAppearance(settings);
  const source = deriveSource(applied);
  if (sameLook(applied.current.appearance, baseValues(source, applied.saved))) return displayName(source);
  return `${displayName(source)}${applied.sourceBehind ? " (earlier version)" : " with edits"}`;
}

export function deckLabel(settings: AppSettings, systemDark: boolean): string {
  return `${appliedName(settings)} · ${modeName(appliedAppearance(settings).colorMode, systemDark)}`;
}

const chipName = (chips: ChipParts) => [
  CHIP_STYLES.find((style) => style.id === chips.style)?.label ?? "Classic",
  ...(["tool", "effort", "usage"] as const).filter((part) => chips[part]),
].join(", ");
const fieldName = (field: LandingTextureSettings) => field.enabled
  ? `On, ${field.mode === "single" ? field.color : "rainbow"}, ${field.rainbowSpeed.toFixed(1)}×, ${field.rippleShape}`
  : "Off";

/** Stored draft, or one built from what Deck is using. */
export function workingDraft(settings: AppSettings): AppearanceDraft {
  if (settings.appearanceDraft) return settings.appearanceDraft;
  const applied = appliedAppearance(settings);
  return {
    version: 1,
    colorMode: applied.colorMode ?? "system",
    source: deriveSource(applied),
    values: applied.current.appearance,
    botChips: settings.botChips,
    landingTexture: settings.landingTexture ?? DEFAULT_LANDING_TEXTURE,
    lastPreset: {},
    materialEdits: {},
  };
}

/** Every difference between the draft and Deck: one list, so one commit model. */
export function pendingChanges(settings: AppSettings, draft: AppearanceDraft, systemDark: boolean): PendingChange[] {
  const applied = appliedAppearance(settings);
  const rows: PendingChange[] = [];
  if ((applied.colorMode ?? "system") !== draft.colorMode) rows.push({ label: "Mode", from: modeName(applied.colorMode, systemDark), to: modeName(draft.colorMode, systemDark) });
  if (!sameRef(deriveSource(applied), draft.source) || !sameLook(applied.current.appearance, draft.values)) {
    const edited = editedKeys(draft, applied.saved).length > 0;
    rows.push({ label: "Theme and preset", from: appliedName(settings), to: `${displayName(draft.source)}${edited ? " with edits" : ""}` });
  }
  if (!sameChips(settings.botChips, draft.botChips)) rows.push({ label: "Agent chips", from: chipName(settings.botChips), to: chipName(draft.botChips) });
  const field = settings.landingTexture ?? DEFAULT_LANDING_TEXTURE;
  if (!same(field, draft.landingTexture)) rows.push({ label: "Empty thread", from: fieldName(field), to: fieldName(draft.landingTexture) });
  return rows;
}

export function revertPending(settings: AppSettings, draft: AppearanceDraft, label: PendingLabel): AppearanceDraft {
  const applied = workingDraft({ ...settings, appearanceDraft: undefined });
  if (label === "Mode") return { ...draft, colorMode: applied.colorMode };
  if (label === "Agent chips") return { ...draft, botChips: applied.botChips };
  if (label === "Empty thread") return { ...draft, landingTexture: applied.landingTexture };
  return { ...draft, source: applied.source, values: applied.values, lastPreset: {}, materialEdits: {} };
}

/** Differences from the preset, leaving out keys this theme has no control for. */
export function editedKeys(draft: AppearanceDraft, saved: SkinFile[]): Key[] {
  const base = canonical(baseValues(draft.source, saved));
  const values = canonical(draft.values);
  const keys = [...SHARED_KEYS, ...MATERIAL_KEYS[draftTheme(draft, saved)]].filter((key) => !same(values[key], base[key]));
  // An exact color carries its own hue, so picking one is a single edit.
  return values.accentColor ? keys.filter((key) => key !== "hue") : keys;
}

/** Put some keys back to the preset's values. */
export function revertKeys(draft: AppearanceDraft, keys: Key[], saved: SkinFile[]): AppearanceDraft {
  const base = baseValues(draft.source, saved);
  const values: AppearanceValues = { ...draft.values };
  for (const key of keys) {
    if (base[key] === undefined) delete values[key];
    else Object.assign(values, { [key]: base[key] });
  }
  return { ...draft, values };
}

const editsIn = (keys: Key[], values: AppearanceValues, base: AppearanceValues): Partial<AppearanceValues> =>
  Object.fromEntries(keys.filter((key) => !same(values[key], base[key])).map((key) => [key, values[key]]));

/** Switch theme. Shared edits come along; this theme's Material edits wait for the way back. */
export function pickTheme(draft: AppearanceDraft, theme: ThemeId, saved: SkinFile[]): AppearanceDraft {
  const from = draftTheme(draft, saved);
  if (from === theme) return draft;
  const base = canonical(baseValues(draft.source, saved));
  const values = canonical(draft.values);
  const stored = draft.lastPreset[theme];
  const source = stored && refExists(stored, saved) ? stored : { kind: "builtin" as const, id: THEME_FIRST[theme] };
  const { [theme]: returning, ...materialEdits } = draft.materialEdits;
  const material = editsIn(MATERIAL_KEYS[from], values, base);
  return {
    ...draft,
    source,
    values: canonical({ ...baseValues(source, saved), ...editsIn(SHARED_KEYS, values, base), ...returning }),
    lastPreset: { ...draft.lastPreset, [from]: draft.source },
    materialEdits: Object.keys(material).length ? { ...materialEdits, [from]: material } : materialEdits,
  };
}

export function pickPreset(draft: AppearanceDraft, ref: PresetRef, saved: SkinFile[]): AppearanceDraft {
  const values = canonical(baseValues(ref, saved));
  const theme = themeFamily(values);
  const { [theme]: _dropped, ...materialEdits } = draft.materialEdits;
  return { ...draft, source: ref, values, lastPreset: { ...draft.lastPreset, [theme]: ref }, materialEdits };
}

/** Back to the preset. Mode, chips and the field stay as they are. */
export function clearEdits(draft: AppearanceDraft, saved: SkinFile[]): AppearanceDraft {
  return pickPreset(draft, draft.source, saved);
}

/** Keeps the draft only while it holds something; removes the key otherwise. */
export function storeDraft(settings: AppSettings, draft: AppearanceDraft): AppSettings {
  const { appearanceDraft: _old, ...rest } = settings;
  const keep = pendingChanges(rest, draft, true).length > 0 || Object.keys(draft.materialEdits).length > 0;
  return keep ? { ...rest, appearanceDraft: draft } : rest;
}

export function applyDraft(settings: AppSettings): AppSettings {
  const draft = settings.appearanceDraft;
  if (!draft) return settings;
  const { appearanceDraft: _applied, landingTexture, ...rest } = settings;
  const keepField = landingTexture !== undefined || !same(draft.landingTexture, DEFAULT_LANDING_TEXTURE);
  return {
    ...rest,
    appearance: {
      current: skinFile(displayName(draft.source), draft.values),
      saved: appliedAppearance(settings).saved,
      colorMode: draft.colorMode,
      source: draft.source,
    },
    botChips: draft.botChips,
    ...(keepField ? { landingTexture: draft.landingTexture } : {}),
  };
}

const APPEARANCE_KEYS = ["appearance", "appearanceDraft", "botChips", "landingTexture"] as const;

/** Put the appearance keys of an earlier moment back, leaving everything else as
 *  it is now. Saved presets stay as they are now too, apart from `returning`, the
 *  one preset this Undo brings back. */
export function restoreAppearance(now: AppSettings, earlier: AppSettings, returning?: string): AppSettings {
  const next = { ...now };
  for (const key of APPEARANCE_KEYS) {
    if (earlier[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: earlier[key] });
  }
  const saved = [...(now.appearance?.saved ?? [])];
  const before = earlier.appearance?.saved ?? [];
  const back = before.findIndex((skin) => skin.name === returning);
  if (back >= 0 && !saved.some((skin) => skin.name === returning)) saved.splice(back, 0, before[back]);
  if (saved.length) next.appearance = { ...appliedAppearance(earlier), saved };
  else if (next.appearance) next.appearance = { ...next.appearance, saved };
  const draft = next.appearanceDraft;
  if (!draft) return next;
  const lastPreset = Object.fromEntries(Object.entries(draft.lastPreset).filter(([, last]) => refExists(last, saved)));
  next.appearanceDraft = { ...draft, source: refExists(draft.source, saved) ? draft.source : { kind: "builtin", id: builtinFor(draft.values).id }, lastPreset };
  return next;
}

export function discardDraft(settings: AppSettings): AppSettings {
  const { appearanceDraft: _dropped, ...rest } = settings;
  return rest;
}

/** Store the draft's look under a new name. Deck only learns the name when it already shows that look. */
export function savePreset(settings: AppSettings, name: string): AppSettings {
  const draft = workingDraft(settings);
  const applied = appliedAppearance(settings);
  if (presetLimitError(applied.saved)) return settings;
  const preset = skinFile(name.trim(), canonical(draft.values));
  const source: PresetRef = { kind: "saved", name: preset.name };
  const appearance: AppearanceSettings = {
    ...applied,
    saved: [...applied.saved, preset],
    ...(sameLook(applied.current.appearance, draft.values) ? { current: { ...applied.current, name: preset.name }, source } : {}),
  };
  const theme = draftTheme(draft, applied.saved);
  return storeDraft({ ...settings, appearance }, { ...draft, source, lastPreset: { ...draft.lastPreset, [theme]: source } });
}

/** Overwrite the draft's saved preset. Deck keeps its own copy until Apply. */
export function updatePreset(settings: AppSettings): AppSettings {
  const draft = workingDraft(settings);
  const { source } = draft;
  if (source.kind !== "saved") return settings;
  const applied = appliedAppearance(settings);
  const saved = applied.saved.map((skin) => skin.name === source.name ? { ...skin, appearance: canonical(draft.values) } : skin);
  const { sourceBehind, ...appearance } = applied;
  const inUse = sameRef(deriveSource(applied), source);
  const behind = inUse ? !sameLook(applied.current.appearance, draft.values) : sourceBehind;
  return storeDraft({ ...settings, appearance: { ...appearance, saved, ...(inUse ? { source } : {}), ...(behind ? { sourceBehind: true as const } : {}) } }, draft);
}

/** What Update just did, in words. Reads the settings from before it ran. */
export function presetUpdateNote(settings: AppSettings): string {
  const draft = workingDraft(settings);
  const applied = appliedAppearance(settings);
  const differs = sameRef(deriveSource(applied), draft.source) && !sameLook(applied.current.appearance, draft.values);
  return `${displayName(draft.source)} updated.${differs ? " Deck keeps the earlier version until you apply." : ""}`;
}

function renameRefs(draft: AppearanceDraft, from: string, to: string): AppearanceDraft {
  const moved = (ref: PresetRef): PresetRef => ref.kind === "saved" && ref.name === from ? { kind: "saved", name: to } : ref;
  return { ...draft, source: moved(draft.source), lastPreset: Object.fromEntries(Object.entries(draft.lastPreset).map(([theme, ref]) => [theme, moved(ref)])) };
}

export function renamePreset(settings: AppSettings, from: string, to: string): AppSettings {
  const applied = appliedAppearance(settings);
  const name = to.trim();
  const inUse = sameRef(deriveSource(applied), { kind: "saved", name: from });
  const saved = applied.saved.map((skin) => skin.name === from ? { ...skin, name } : skin);
  const appearance: AppearanceSettings = {
    ...applied,
    saved,
    ...(inUse ? { current: { ...applied.current, name }, source: { kind: "saved" as const, name } } : {}),
  };
  const next = { ...settings, appearance };
  return settings.appearanceDraft ? { ...next, appearanceDraft: renameRefs(settings.appearanceDraft, from, name) } : next;
}

/** Remove a preset. Anything using it keeps its values, now as edits on the built-in. */
export function deletePreset(settings: AppSettings, name: string): AppSettings {
  const applied = appliedAppearance(settings);
  const ref: PresetRef = { kind: "saved", name };
  const saved = applied.saved.filter((skin) => skin.name !== name);
  let appearance: AppearanceSettings = { ...applied, saved };
  if (sameRef(deriveSource(applied), ref)) {
    const { sourceBehind: _behind, ...rest } = appearance;
    const builtin = builtinFor(applied.current.appearance);
    appearance = { ...rest, current: { ...applied.current, name: builtin.name }, source: { kind: "builtin", id: builtin.id } };
  }
  const next = { ...settings, appearance };
  const draft = settings.appearanceDraft;
  if (!draft) return next;
  const lastPreset = Object.fromEntries(Object.entries(draft.lastPreset).filter(([, last]) => !sameRef(last, ref)));
  const source = sameRef(draft.source, ref) ? { kind: "builtin" as const, id: builtinFor(draft.values).id } : draft.source;
  return storeDraft(next, { ...draft, source, lastPreset });
}

export const presetLimitError = (saved: SkinFile[]): string | null => saved.length >= MAX_SAVED ? `You have ${MAX_SAVED} presets. Delete one first.` : null;

export function presetNameError(name: string, saved: SkinFile[], except?: string): string | null {
  const wanted = name.trim();
  if (!wanted) return "Enter a name for this preset.";
  const full = except === undefined ? presetLimitError(saved) : null;
  if (full) return full;
  const lower = wanted.toLowerCase();
  const taken = saved.some((skin) => skin.name.toLowerCase() === lower && skin.name !== except) || BUILTIN_SKINS.some((skin) => skin.name.toLowerCase() === lower);
  return taken ? `${wanted} already exists. Pick another name, or update it instead.` : null;
}

/** Add a preset from a file. A taken name gets a number, so both are kept. Nothing else changes. */
export function importPreset(settings: AppSettings, skin: SkinFile): AppSettings {
  const applied = appliedAppearance(settings);
  if (presetLimitError(applied.saved)) return settings;
  const taken = new Set([...applied.saved, ...BUILTIN_SKINS].map((item) => item.name.toLowerCase()));
  let name = skin.name;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${skin.name.slice(0, 36)} ${n}`;
  return { ...settings, appearance: { ...applied, saved: [...applied.saved, { ...skin, name }] } };
}

function readMaterial(raw: unknown, values: AppearanceValues): AppearanceDraft["materialEdits"] {
  if (!isRecord(raw)) return {};
  const out: AppearanceDraft["materialEdits"] = {};
  for (const theme of Object.keys(MATERIAL_KEYS) as ThemeId[]) {
    const edits = raw[theme];
    if (!isRecord(edits)) continue;
    const known = Object.fromEntries(Object.entries(edits).filter(([key]) => MATERIAL_KEYS[theme].includes(key as Key))) as Partial<AppearanceValues>;
    try { canonical({ ...values, ...known }); out[theme] = known; } catch { /* drop this theme's edits only */ }
  }
  return out;
}

/** Read a stored draft. Anything wrong drops the draft alone: applied settings and presets are untouched. */
export function readAppearanceDraft(raw: unknown, saved: SkinFile[]): AppearanceDraft | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !isColorMode(raw.colorMode) || !isRecord(raw.botChips) || !isRecord(raw.values)) return undefined;
  let values: AppearanceValues;
  try { values = canonical(raw.values as unknown as AppearanceValues); } catch { return undefined; }
  const lastPreset: AppearanceDraft["lastPreset"] = {};
  if (isRecord(raw.lastPreset)) {
    for (const theme of Object.keys(MATERIAL_KEYS) as ThemeId[]) {
      const ref = asRef(raw.lastPreset[theme], saved);
      if (ref) lastPreset[theme] = ref;
    }
  }
  return {
    version: 1,
    colorMode: raw.colorMode,
    source: asRef(raw.source, saved) ?? { kind: "builtin", id: builtinFor(values).id },
    values,
    botChips: readBotChips(raw.botChips),
    landingTexture: readLandingTexture(raw.landingTexture),
    lastPreset,
    materialEdits: readMaterial(raw.materialEdits, values),
  };
}
