// A preset's thumbnail: a miniature of Deck's surfaces, showing what applying
// the preset gives in the draft's Mode. Colors mirror clay-theme.css and
// glass-theme.css, which only paint a whole document.

import type { CSSProperties } from "react";
import { accentHex, backdropLayers, themeFamily, type AppearanceValues } from "./themes";

interface Palette { bg: string; panel: string; raised: string; text: string; line: string; edge: string }
export const THUMB_PALETTES: Record<"warm" | "black" | "deck", { dark: Palette; light: Palette }> = {
  warm: { dark: { bg: "#262421", panel: "30 28 26", raised: "48 45 41", text: "#efe9e0", line: "#3b3732", edge: "#544e46" }, light: { bg: "#f8f5ee", panel: "240 236 227", raised: "255 253 249", text: "#29251f", line: "#e1dacd", edge: "#c9c0b1" } },
  black: { dark: { bg: "#000000", panel: "16 16 16", raised: "24 24 24", text: "#f2f2f2", line: "#2a2a2a", edge: "#3f3f3f" }, light: { bg: "#f7f7f6", panel: "238 238 236", raised: "255 255 255", text: "#1c1c1c", line: "#dddddc", edge: "#bdbdbb" } },
  deck: { dark: { bg: "#000000", panel: "16 16 16", raised: "24 24 24", text: "#f5f5f5", line: "#2c2c2c", edge: "#3a3a3a" }, light: { bg: "#d9e4ec", panel: "247 250 252", raised: "236 243 247", text: "#142636", line: "#c7d3dc", edge: "#aebdc9" } },
};

export const paletteOf = (values: AppearanceValues) =>
  THUMB_PALETTES[themeFamily(values) !== "clay" ? "deck" : values.palette === "black" ? "black" : "warm"];

export function AppearanceThumb({ values, light }: { values: AppearanceValues; light: boolean }) {
  const family = themeFamily(values);
  const glass = family === "liquid" && !values.flat;
  const tokens = paletteOf(values)[light ? "light" : "dark"];
  const material = family === "clay" ? "flush" : glass ? "glass" : "solid";
  const backdrop = glass ? backdropLayers({ ...values, light }, .25) : { image: "none", size: "auto" };
  const style = {
    "--bg": tokens.bg, "--panel": `rgb(${tokens.panel})`, "--panel-rgb": tokens.panel, "--panel-2": `rgb(${tokens.raised})`, "--text": tokens.text, "--line": tokens.line, "--studio-edge": tokens.edge,
    "--accent": accentHex({ ...values, light }), "--thumb-opacity": glass ? values.opacity / 100 : 1, "--radius": `${values.radius}px`,
    "--gap": family === "clay" ? "0px" : "8px", backgroundImage: backdrop.image, backgroundSize: backdrop.size,
  } as CSSProperties;
  return <span className="studio-thumb" aria-hidden="true" data-material={material} data-light={String(light)} data-palette={family === "clay" ? (values.palette ?? "warm") : undefined} style={style}>
    <i className="studio-t-rail" />
    <i className="studio-t-pane"><i className="studio-t-l" /><i className="studio-t-l studio-s" /><i className="studio-t-a" /><i className="studio-t-box" /></i>
  </span>;
}
