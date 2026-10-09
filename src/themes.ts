export interface AppearanceValues {
  hue: number;
  /** Exact user-picked accent; omitted by legacy hue-only skins. */
  accentColor?: string;
  glow: number;
  blur: number;
  opacity: number;
  radius: number;
  backdrop: number;
  density: 0.72 | 1;
  light: boolean;
  flat: boolean;
}

export interface SkinFile {
  format: "apex-glass-playground";
  version: 2;
  name: string;
  author?: string;
  appearance: AppearanceValues;
}

export interface BuiltinSkin {
  id: string;
  name: string;
  note: string;
  appearance: AppearanceValues;
}

export interface AppearanceSettings {
  current: SkinFile;
  saved: SkinFile[];
}

const appearance = (values: AppearanceValues): AppearanceValues => Object.freeze(values);

export const DEFAULT_APPEARANCE: AppearanceValues = appearance({
  hue: 163, glow: 0, blur: 0, opacity: 100, radius: 14, backdrop: 0, density: 1, light: false, flat: true,
});

export const BUILTIN_SKINS: BuiltinSkin[] = [
  { id: "classic", name: "Classic", note: "Today's Deck, no glass", appearance: DEFAULT_APPEARANCE },
  { id: "smoked", name: "Smoked", note: "Quiet glass", appearance: appearance({ hue: 168, glow: 40, blur: 24, opacity: 76, radius: 18, backdrop: 35, density: 1, light: false, flat: false }) },
  { id: "tide", name: "Tide", note: "Cool and deep", appearance: appearance({ hue: 223, glow: 62, blur: 28, opacity: 60, radius: 20, backdrop: 70, density: 1, light: false, flat: false }) },
  { id: "dusk", name: "Dusk", note: "Violet evening", appearance: appearance({ hue: 290, glow: 55, blur: 26, opacity: 64, radius: 18, backdrop: 65, density: 1, light: false, flat: false }) },
  { id: "rose", name: "Rose", note: "Warm and soft", appearance: appearance({ hue: 15, glow: 45, blur: 22, opacity: 70, radius: 22, backdrop: 55, density: 1, light: false, flat: false }) },
  { id: "frost", name: "Frost", note: "Light glass", appearance: appearance({ hue: 218, glow: 40, blur: 26, opacity: 66, radius: 18, backdrop: 70, density: 1, light: true, flat: false }) },
  { id: "liquid", name: "Liquid", note: "Full glass", appearance: appearance({ hue: 172, glow: 85, blur: 30, opacity: 44, radius: 24, backdrop: 95, density: 1, light: false, flat: false }) },
];

const FORMAT = "apex-glass-playground" as const;
const MAX_SKIN_BYTES = 32_000;
const FIELD_NAMES = ["hue", "glow", "blur", "opacity", "radius", "backdrop", "density", "light", "flat"] as const;
const RANGES: Record<string, readonly [number, number]> = {
  hue: [0, 360], glow: [0, 100], blur: [0, 40], opacity: [30, 100], radius: [4, 30], backdrop: [0, 100],
};
const LABELS: Record<string, string> = { hue: "Hue", glow: "Glow", blur: "Frost", opacity: "Surface opacity", radius: "Corner radius", backdrop: "Backdrop" };
const DEFAULT_SKIN: SkinFile = { format: FORMAT, version: 2, name: "Classic", appearance: DEFAULT_APPEARANCE };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Parse and validate an imported skin, migrating v1 files into the v2 shape. */
export function parseSkin(text: string): SkinFile {
  if (typeof text !== "string") throw new TypeError("Skin content must be text.");
  if (utf8Length(text) > MAX_SKIN_BYTES) throw new Error("Skin files must be 32,000 UTF-8 bytes or smaller.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Skin content must be valid JSON."); }
  if (!isRecord(value)) throw new Error("A skin must be a JSON object.");
  if (value.format !== FORMAT) throw new Error(`Skin format must be \"${FORMAT}\".`);
  if (value.version !== 1 && value.version !== 2) throw new Error("Skin version must be 1 or 2.");

  const allowedTop = new Set(["format", "version", "name", "author", "appearance"]);
  for (const key of Object.keys(value)) if (!allowedTop.has(key)) throw new Error(`Unknown skin field: ${key}.`);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Skin name must be a non-empty string.");
  if (value.author !== undefined && typeof value.author !== "string") throw new Error("Skin author must be text.");
  if (!isRecord(value.appearance)) throw new Error("Skin appearance must be an object.");
  const source = value.appearance;
  const knownAppearance = new Set<string>([...FIELD_NAMES, "accentColor"]);
  for (const key of Object.keys(source)) if (!knownAppearance.has(key)) throw new Error(`Unknown appearance setting: ${key}.`);

  const normalized: Record<string, unknown> = {};
  if (source.accentColor !== undefined) {
    if (typeof source.accentColor !== "string" || !/^#[0-9a-f]{6}$/i.test(source.accentColor)) throw new Error("Accent color must be a six-digit hex color (such as #35aabb).");
    normalized.accentColor = source.accentColor.toLowerCase();
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const raw = source[key];
    if (key === "backdrop" && value.version === 1 && raw === undefined) {
      normalized.backdrop = 50;
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${LABELS[key]} must be a finite number.`);
    if (raw < min || raw > max) throw new Error(`${LABELS[key]} must be between ${min} and ${max}.`);
    normalized[key] = raw;
  }
  if (source.density !== 0.72 && source.density !== 1) throw new Error("Density must be 0.72 or 1.");
  if (typeof source.light !== "boolean" || typeof source.flat !== "boolean") throw new Error("Light and flat must be true or false.");
  normalized.density = source.density;
  normalized.light = source.light;
  normalized.flat = source.flat;

  const name = value.name.trim().slice(0, 40);
  const result: SkinFile = {
    format: FORMAT,
    version: 2,
    name,
    ...(typeof value.author === "string" && value.author.trim() ? { author: value.author.trim().slice(0, 80) } : {}),
    appearance: normalized as unknown as AppearanceValues,
  };
  return result;
}

/** Convert validated settings into CSS custom properties. Classic intentionally has no overrides. */
export function themeVariables(values: AppearanceValues): Record<string, string> {
  if (themeMode(values) === "classic") return {};
  return {
    ...(values.accentColor ? {
      "--deck-custom-accent": values.accentColor,
      "--deck-custom-accent-ink": accentInk(values.accentColor),
    } : {}),
    "--deck-hue": String(values.hue),
    "--deck-glow": String(values.glow / 100),
    "--deck-blur": `${values.blur}px`,
    "--deck-opacity": String(values.opacity / 100),
    "--deck-radius": `${values.radius}px`,
    "--deck-backdrop": String(values.backdrop / 100),
    "--deck-density": String(values.density),
  };
}

export function themeMode(values: AppearanceValues): "classic" | "flat" | "glass" {
  if (!values.accentColor && FIELD_NAMES.every((field) => values[field] === DEFAULT_APPEARANCE[field])) return "classic";
  return values.flat ? "flat" : "glass";
}

/** Build a truthful prompt for an external AI to return an importable skin JSON file. */
export function skinPrompt(description: string): string {
  const brief = description.trim() || "a distinctive, usable Apex Deck appearance";
  return `Create an Apex Deck appearance skin for this description: ${brief}\n\nReturn only one JSON object using this contract: {"format":"apex-glass-playground","version":2,"name":"Name","appearance":{"hue":0,"glow":0,"blur":0,"opacity":100,"radius":14,"backdrop":0,"density":1,"light":false,"flat":false}}. Optional accentColor is an exact six-digit hex color such as #35aabb; omit it for the legacy hue palette. Use only these appearance fields: accentColor (optional hex string), hue (number 0–360), glow (number 0–100), blur (number 0–40), opacity (number 30–100), radius (number 4–30), backdrop (number 0–100), density (exactly 0.72 or 1), light (boolean), flat (boolean). Do not include CSS, scripts, extra keys, or external assets. This prompt requests JSON for the user's import workflow; Apex Deck does not generate the skin itself.`;
}

export function defaultAppearanceSettings(): AppearanceSettings {
  return { current: { ...DEFAULT_SKIN, appearance: { ...DEFAULT_APPEARANCE } }, saved: [] };
}

/** Read stored appearance settings defensively: current falls back, while each saved skin is salvaged independently. */
export function readAppearance(raw: unknown): AppearanceSettings {
  const fallback = defaultAppearanceSettings();
  if (!isRecord(raw)) return fallback;
  let current = fallback.current;
  try { current = parseSkin(JSON.stringify(raw.current)); } catch { /* use Classic */ }
  const saved: SkinFile[] = [];
  if (Array.isArray(raw.saved)) {
    for (const candidate of raw.saved) {
      if (saved.length >= 50) break;
      try { saved.push(parseSkin(JSON.stringify(candidate))); } catch { /* skip this saved skin only */ }
    }
  }
  return { current, saved };
}

/** Normalize picker/hex input and derive a hue for the background color field. */
export function colorAppearance(input: string): Pick<AppearanceValues, "accentColor" | "hue"> {
  let hex = input.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = "#" + [...hex.slice(1)].map(c => c + c).join("");
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Enter a hex color such as #35aabb.");
  hex = hex.toLowerCase();
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) hue = ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return { accentColor: hex, hue: Math.round(hue) };
}

function accentInk(hex: string): string {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  return luminance > .179 ? "#000000" : "#ffffff";
}

/** Show the existing OKLCH accent in the picker without altering legacy skins. */
export function accentHex(values: AppearanceValues): string {
  if (values.accentColor) return values.accentColor;
  if (themeMode(values) === "classic") return "#71e6b5";
  const L = values.light ? .47 : .85, C = values.light ? .12 : .13;
  const a = C * Math.cos(values.hue * Math.PI / 180), b = C * Math.sin(values.hue * Math.PI / 180);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
  return "#" + [4.0767416621*l - 3.3077115913*m + .2309699292*s, -1.2684380046*l + 2.6097574011*m - .3413193965*s, -.0041960863*l - .7034186147*m + 1.707614701*s]
    .map(v => Math.round(Math.max(0, Math.min(1, v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055)) * 255).toString(16).padStart(2, "0")).join("");
}
