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
  /** Background glow layout; omitted means the original three blobs. */
  backdropPattern?: BackdropPattern;
  /** Exact glow colors, one per glow. Omitted means the glows follow the accent. */
  glowColors?: string[];
  /** How many accent-matched glows to draw when glowColors is omitted. */
  glowCount?: number;
  /** Glow size in percent of normal (50–200). */
  glowSize?: number;
}

export const BACKDROP_PATTERNS = [
  { id: "blobs", name: "Blobs" },
  { id: "aurora", name: "Aurora" },
  { id: "halo", name: "Halo" },
  { id: "corners", name: "Corners" },
  { id: "horizon", name: "Horizon" },
  { id: "mesh", name: "Mesh" },
  { id: "stripes", name: "Stripes" },
  { id: "rings", name: "Rings" },
  { id: "dots", name: "Dots" },
  { id: "spotlight", name: "Spotlight" },
  { id: "none", name: "None" },
] as const;
export type BackdropPattern = typeof BACKDROP_PATTERNS[number]["id"];
export const MIN_GLOWS = 1;
export const MAX_GLOWS = 8;

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
  const knownAppearance = new Set<string>([...FIELD_NAMES, "accentColor", "backdropPattern", "glowColors", "glowCount", "glowSize"]);
  for (const key of Object.keys(source)) if (!knownAppearance.has(key)) throw new Error(`Unknown appearance setting: ${key}.`);

  const normalized: Record<string, unknown> = {};
  if (source.accentColor !== undefined) {
    if (typeof source.accentColor !== "string" || !/^#[0-9a-f]{6}$/i.test(source.accentColor)) throw new Error("Accent color must be a six-digit hex color (such as #35aabb).");
    normalized.accentColor = source.accentColor.toLowerCase();
  }
  if (source.backdropPattern !== undefined) {
    if (!BACKDROP_PATTERNS.some(({ id }) => id === source.backdropPattern)) throw new Error(`Background pattern must be one of: ${BACKDROP_PATTERNS.map(({ id }) => id).join(", ")}.`);
    normalized.backdropPattern = source.backdropPattern;
  }
  if (source.glowColors !== undefined) {
    const colors = source.glowColors;
    if (!Array.isArray(colors) || colors.length < MIN_GLOWS || colors.length > MAX_GLOWS) throw new Error(`Glow colors must be a list of ${MIN_GLOWS} to ${MAX_GLOWS} hex colors.`);
    if (!colors.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) throw new Error("Each glow color must be a six-digit hex color (such as #35aabb).");
    normalized.glowColors = colors.map((color: string) => color.toLowerCase());
  }
  if (source.glowCount !== undefined) {
    if (!Number.isInteger(source.glowCount) || (source.glowCount as number) < MIN_GLOWS || (source.glowCount as number) > MAX_GLOWS) throw new Error(`Glow count must be a whole number from ${MIN_GLOWS} to ${MAX_GLOWS}.`);
    normalized.glowCount = source.glowCount;
  }
  if (source.glowSize !== undefined) {
    if (typeof source.glowSize !== "number" || !Number.isFinite(source.glowSize) || source.glowSize < 50 || source.glowSize > 200) throw new Error("Glow size must be between 50 and 200.");
    normalized.glowSize = source.glowSize;
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
    ...(customBackdrop(values) ? backdropVariables(values) : {}),
  };
}

const customBackdrop = (values: AppearanceValues): boolean =>
  values.backdropPattern !== undefined || values.glowColors !== undefined || values.glowCount !== undefined || values.glowSize !== undefined;

function backdropVariables(values: AppearanceValues): Record<string, string> {
  const { image, size } = backdropLayers(values);
  return { "--deck-backdrop-image": image, "--deck-backdrop-size": size };
}

/**
 * The stylesheet's original three blobs (glass-theme.css). Custom blobs reuse these
 * exact spots, stops and oklch lightness/chroma so turning off Match accent never jumps.
 */
export const LEGACY_GLOWS = [
  { at: [12, 4], stop: 46, offset: 0, dark: [.56, .14], light: [.86, .09] },
  { at: [93, 17], stop: 42, offset: 75, dark: [.46, .15], light: [.84, .1] },
  { at: [52, 100], stop: 48, offset: -55, dark: [.5, .12], light: [.87, .08] },
] as const;

/** Accent-matched glow hues: the first three are the original blob offsets. */
const AUTO_OFFSETS = [0, 75, -55, 150, -120, 30, -30, 200];
const AUTO_WEIGHTS = [1, .8, .72, .78, .74, .8, .76, .72];

/**
 * Background edits should be visible: on a flat skin (Classic included) they turn
 * glass on, and a zero Backdrop is lifted to the default strength.
 */
export function backgroundPatch(values: AppearanceValues, patch: Partial<AppearanceValues>): Partial<AppearanceValues> {
  return { ...(values.flat ? { flat: false } : {}), ...(values.backdrop === 0 ? { backdrop: 50 } : {}), ...patch };
}

/** The glow colors as hex, whether picked exactly or derived from the accent hue. */
export function glowColorList(values: AppearanceValues): string[] {
  if (values.glowColors?.length) return [...values.glowColors];
  const count = Math.min(MAX_GLOWS, Math.max(MIN_GLOWS, values.glowCount ?? 3));
  return AUTO_OFFSETS.slice(0, count).map((offset, i) => {
    const [L, C] = LEGACY_GLOWS[i]?.[values.light ? "light" : "dark"] ?? (values.light ? [.86, .09] : [.5, .14]);
    return oklchHex(L, C, values.hue + offset);
  });
}

/** A random set of colors that sit well together, spaced around the color wheel. */
export function shuffledGlowColors(count: number, light: boolean, random: () => number = Math.random): string[] {
  const base = random() * 360;
  const spread = [30, 45, 360 / Math.max(2, count), 150][Math.floor(random() * 4)];
  return Array.from({ length: count }, (_, i) => oklchHex(light ? .82 : .58, light ? .11 : .16, base + i * spread));
}

const BLOB_SPOTS = [[12, 4], [93, 17], [52, 100], [6, 62], [80, 78], [40, 30], [97, 96], [26, 92]];
const CORNER_SPOTS = [[0, 0], [100, 0], [100, 100], [0, 100], [50, 0], [100, 50], [50, 100], [0, 50]];

/**
 * Build the background glow as CSS gradient layers. Every value is a number or
 * a validated hex color, so the result cannot carry anything but gradients.
 * pxScale shrinks pixel-sized patterns (stripes, rings, dots) for small previews.
 */
export function backdropLayers(values: AppearanceValues, pxScale = 1): { image: string; size: string } {
  const pattern = values.backdropPattern ?? "blobs";
  if (pattern === "none") return { image: "none", size: "auto" };
  const colors = glowColorList(values);
  const n = colors.length;
  const strength = values.backdrop / 100;
  const s = (values.glowSize ?? 100) / 100;
  const col = (i: number, k = 1) => rgba(colors[i % n], Math.min(1, strength * AUTO_WEIGHTS[i % AUTO_WEIGHTS.length] * k));
  const r = (v: number) => Math.round(v * 100) / 100;
  const px = (v: number) => `${r(v * s * pxScale)}px`;
  const spot = (i: number, [x, y]: number[], w: number, h: number, k = 1) =>
    `radial-gradient(ellipse ${r(w * s)}% ${r(h * s)}% at ${x}% ${y}%, ${col(i, k)}, transparent)`;
  const layers: string[] = [];
  let size = "auto";
  switch (pattern) {
    case "blobs":
      // Same form as the stylesheet: farthest-corner ellipse with a scaled fade stop.
      colors.forEach((_, i) => {
        const [x, y] = BLOB_SPOTS[i];
        layers.push(`radial-gradient(ellipse at ${x}% ${y}%, ${col(i)}, transparent ${r((LEGACY_GLOWS[i]?.stop ?? 46) * s)}%)`);
      });
      break;
    case "aurora":
      colors.forEach((_, i) => layers.push(spot(i, [r((i + .5) / n * 100), 2 + (i % 2) * 12], 70 / n + 34, 34, 1.15)));
      break;
    case "halo":
      // Overlapping spots around the middle blend into one glow instead of hard rings.
      colors.forEach((_, i) => {
        const angle = i / n * Math.PI * 2;
        layers.push(spot(i, n === 1 ? [50, 45] : [r(50 + Math.cos(angle) * 9), r(45 + Math.sin(angle) * 9)], 44, 50, .9));
      });
      break;
    case "corners":
      colors.forEach((_, i) => layers.push(spot(i, CORNER_SPOTS[i], 46, 50)));
      break;
    case "horizon":
      colors.forEach((_, i) => layers.push(spot(i, [n === 1 ? 50 : r(i / (n - 1) * 100), 102], 100 / n + 55, 58, 1.1)));
      break;
    case "mesh":
      // An even 4 × 3 grid of soft spots. Colors run in reading order so all 12 cells cycle
      // through every glow; counts that divide 4 also step a row so they form diagonals.
      for (let row = 0; row < 3; row++) {
        const shift = 4 % n === 0 ? row : 0;
        for (let c = 0; c < 4; c++) layers.push(spot((row * 4 + c + shift) % n, [r((c + .5) * 25), r((row + .5) / 3 * 100)], 30, 40, .8));
      }
      break;
    case "stripes": {
      const band = 260;
      const stops = colors.flatMap((_, i) => [`transparent ${px(i * band)}`, `${col(i, .42)} ${px(i * band + band / 2)}`]);
      layers.push(`repeating-linear-gradient(135deg, ${stops.join(", ")}, transparent ${px(n * band)})`);
      break;
    }
    case "rings": {
      const band = 170;
      const stops = colors.flatMap((_, i) => [`transparent ${px(i * band)}`, `${col(i, .36)} ${px(i * band + band / 2)}`]);
      layers.push(`repeating-radial-gradient(circle at 18% 108%, ${stops.join(", ")}, transparent ${px(n * band)})`);
      break;
    }
    case "dots": {
      const cell = 24 * s * pxScale;
      colors.forEach((_, i) => layers.push(`radial-gradient(circle at ${r((i + .5) / n * 100)}% 50%, ${col(i, 1.6)} ${r(Math.max(.8, 1.6 * pxScale))}px, transparent ${r(Math.max(1.3, 2.4 * pxScale))}px)`));
      const dotSize = `${r(cell * n)}px ${r(cell)}px`;
      colors.forEach((_, i) => layers.push(spot(i, BLOB_SPOTS[i], 48, 52, .5)));
      size = [...colors.map(() => dotSize), ...colors.map(() => "auto")].join(", ");
      break;
    }
    case "spotlight": {
      const half = Math.min(170, 28 * s + n * 3);
      const stops = colors.map((_, i) => `${col(i, .6)} ${r(180 - half + (i + .5) / n * half * 2)}deg`);
      // A wide fade on each side keeps the fan's edges soft.
      layers.push(`conic-gradient(from 0deg at 50% -12%, transparent ${r(180 - half - 24)}deg, ${stops.join(", ")}, transparent ${r(180 + half + 24)}deg)`);
      break;
    }
  }
  return { image: layers.join(", "), size };
}

function rgba(hex: string, alpha: number): string {
  const [red, green, blue] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${red} ${green} ${blue} / ${Math.round(alpha * 1000) / 1000})`;
}

export function themeMode(values: AppearanceValues): "classic" | "flat" | "glass" {
  if (!values.accentColor && !customBackdrop(values) && FIELD_NAMES.every((field) => values[field] === DEFAULT_APPEARANCE[field])) return "classic";
  return values.flat ? "flat" : "glass";
}

/** Build a truthful prompt for an external AI to return an importable skin JSON file. */
export function skinPrompt(description: string): string {
  const brief = description.trim() || "a distinctive, usable Apex Deck appearance";
  return `Create an Apex Deck appearance skin for this description: ${brief}\n\nReturn only one JSON object using this contract: {"format":"apex-glass-playground","version":2,"name":"Name","appearance":{"hue":0,"glow":0,"blur":0,"opacity":100,"radius":14,"backdrop":0,"density":1,"light":false,"flat":false}}. Optional accentColor is an exact six-digit hex color such as #35aabb; omit it for the legacy hue palette. The background behind the glass is a set of colored glows: optional backdropPattern is one of ${BACKDROP_PATTERNS.map(({ id }) => id).join(", ")}; optional glowColors is a list of ${MIN_GLOWS} to ${MAX_GLOWS} six-digit hex colors, one per glow (omit it to derive the glows from the accent hue); optional glowCount (whole number ${MIN_GLOWS}–${MAX_GLOWS}) sets how many accent-derived glows there are when glowColors is omitted; optional glowSize (number 50–200, percent of normal) makes the glows tighter or wider. Use only these appearance fields: accentColor (optional hex string), backdropPattern (optional), glowColors (optional), glowCount (optional), glowSize (optional), hue (number 0–360), glow (number 0–100), blur (number 0–40), opacity (number 30–100), radius (number 4–30), backdrop (number 0–100), density (exactly 0.72 or 1), light (boolean), flat (boolean). Do not include CSS, scripts, extra keys, or external assets. This prompt requests JSON for the user's import workflow; Apex Deck does not generate the skin itself.`;
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
  return oklchHex(values.light ? .47 : .85, values.light ? .12 : .13, values.hue);
}

function oklchHex(L: number, C: number, hue: number): string {
  const a = C * Math.cos(hue * Math.PI / 180), b = C * Math.sin(hue * Math.PI / 180);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
  return "#" + [4.0767416621*l - 3.3077115913*m + .2309699292*s, -1.2684380046*l + 2.6097574011*m - .3413193965*s, -.0041960863*l - .7034186147*m + 1.707614701*s]
    .map(v => Math.round(Math.max(0, Math.min(1, v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055)) * 255).toString(16).padStart(2, "0")).join("");
}
