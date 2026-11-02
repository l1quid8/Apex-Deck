// The preset row: one fixed row in every theme, so nothing below it moves. What
// is off-screen is announced by the cut-off next card, an edge fade, arrows and
// a live count. Arrow keys, Home and End walk the radios and never stop under
// the fade.

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { AppearanceThumb } from "./AppearanceThumb";
import { BUILTIN_SKINS, themeFamily, type AppearanceValues, type PresetRef, type SkinFile, type ThemeId } from "./themes";

const EDGE = 30;
const LIQUID_FIRST = "liquid";
const motion = (): ScrollBehavior => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const refValue = (ref: PresetRef) => ref.kind === "builtin" ? `builtin:${ref.id}` : `saved:${ref.name}`;

interface Card { ref: PresetRef; name: string; values: AppearanceValues; yours: boolean }

function cardsFor(theme: ThemeId, saved: SkinFile[]): Card[] {
  const builtin = BUILTIN_SKINS.filter((skin) => skin.theme === theme).sort((a, b) => Number(b.id === LIQUID_FIRST) - Number(a.id === LIQUID_FIRST));
  return [
    ...builtin.map((skin) => ({ ref: { kind: "builtin" as const, id: skin.id }, name: skin.preset, values: skin.appearance, yours: false })),
    ...saved.filter((skin) => themeFamily(skin.appearance) === theme).map((skin) => ({ ref: { kind: "saved" as const, name: skin.name }, name: skin.name, values: skin.appearance, yours: true })),
  ];
}

export function AppearancePresetRow({ theme, saved, selected, light, onPick }: { theme: ThemeId; saved: SkinFile[]; selected: PresetRef; light: boolean; onPick: (ref: PresetRef) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const cards = cardsFor(theme, saved);
  const yours = cards.filter((card) => card.yours).length;
  const [nav, setNav] = useState({ count: "", atStart: true, atEnd: true });
  const current = refValue(selected);

  const labels = () => [...(strip.current?.querySelectorAll<HTMLElement>("label") ?? [])];
  const shownCards = () => {
    const box = strip.current!.getBoundingClientRect();
    return labels().map((card, index) => [card.getBoundingClientRect(), index] as const).filter(([rect]) => rect.left >= box.left - 1 && rect.right <= box.right + 1).map(([, index]) => index);
  };
  const measure = useCallback(() => {
    const host = strip.current;
    if (!host) return;
    const n = labels().length;
    const shown = shownCards();
    const atStart = host.scrollLeft <= 1;
    const atEnd = host.scrollLeft >= host.scrollWidth - host.clientWidth - 1;
    host.dataset.more = atStart && atEnd ? "" : atStart ? "right" : atEnd ? "left" : "both";
    const count = (atStart && atEnd) || !shown.length ? `${n} preset${n === 1 ? "" : "s"}` : `${shown[0] + 1}–${shown[shown.length - 1] + 1} of ${n}`;
    setNav({ count, atStart, atEnd });
  }, []);

  const reveal = (card: HTMLElement | null | undefined, behavior: ScrollBehavior = "auto") => {
    const host = strip.current;
    if (!card || !host) return;
    const left = card.offsetLeft, right = left + card.offsetWidth, max = host.scrollWidth - host.clientWidth;
    let to = host.scrollLeft;
    if (left - EDGE < to) to = left - EDGE;
    else if (right + EDGE > to + host.clientWidth) to = right + EDGE - host.clientWidth;
    if (left <= EDGE) to = 0;
    if (to > max - EDGE) to = max;
    host.scrollTo({ left: to, behavior });
  };

  // The strip's offsetLeft origin needs it positioned; see .studio-preset-strip.
  useLayoutEffect(() => {
    reveal(strip.current?.querySelector<HTMLElement>("label.studio-on"));
    measure();
  }, [current, theme, cards.length, measure]);

  useLayoutEffect(() => {
    const host = strip.current;
    if (!host) return;
    const observer = new ResizeObserver(() => { reveal(host.querySelector<HTMLElement>("label.studio-on")); measure(); });
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const host = strip.current!;
    const all = labels(), shown = shownCards();
    const first = shown[0] ?? 0, last = shown[shown.length - 1] ?? 0, step = Math.max(1, shown.length - 1);
    const target = all[direction > 0 ? Math.min(all.length - 1, last + 1) : Math.max(0, first - step)];
    host.scrollTo({ left: Math.max(0, target.offsetLeft - (target.offsetLeft ? EDGE : 0)), behavior: motion() });
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const card = cards[event.key === "Home" ? 0 : cards.length - 1];
    onPick(card.ref);
    labels()[event.key === "Home" ? 0 : cards.length - 1].querySelector("input")?.focus();
  };

  const hidden = nav.atStart && nav.atEnd;
  const firstYours = cards.findIndex((card) => card.yours);
  return <div className="studio-preset-block">
    <div className="studio-preset-head">
      <span className="studio-row-label" id="studio-h-preset">Preset</span>
      <span className="studio-preset-count"><span>{nav.count}</span>{yours > 0 && <>
        {" · "}<button type="button" className="studio-link-btn" aria-label={`Jump to your ${yours} saved preset${yours === 1 ? "" : "s"}`} onClick={() => {
          const card = labels()[firstYours];
          strip.current!.scrollTo({ left: card.offsetLeft - EDGE, behavior: motion() });
        }}>{yours} yours</button></>}</span>
      <span className="studio-preset-nav" style={{ visibility: hidden ? "hidden" : undefined }}>
        <button type="button" className="studio-nav-arrow studio-preset-prev" aria-label="Earlier presets" aria-disabled={nav.atStart} onClick={() => { if (!nav.atStart) page(-1); }}><span aria-hidden="true">‹</span></button>
        <button type="button" className="studio-nav-arrow studio-preset-next" aria-label="More presets" aria-disabled={nav.atEnd} onClick={() => { if (!nav.atEnd) page(1); }}><span aria-hidden="true">›</span></button>
      </span>
    </div>
    <div ref={strip} className="studio-preset-strip" role="radiogroup" aria-labelledby="studio-h-preset" onScroll={measure} onKeyDown={onKey}>
      {cards.map((card, index) => {
        const value = refValue(card.ref);
        const on = value === current;
        return <label key={value} data-preset={value} className={`studio-preset-card${on ? " studio-on" : ""}${card.yours ? " studio-yours" : ""}${index === firstYours ? " studio-first-yours" : ""}`}>
          <input className="studio-vh" type="radio" name="studio-preset" value={value} checked={on} onChange={() => onPick(card.ref)} onFocus={(event) => reveal(event.currentTarget.closest("label"))} />
          <AppearanceThumb values={card.values} light={light} />
          <span className="studio-card-name">{card.name}</span>
          {card.yours && <span className="studio-yours-tag">Yours</span>}
        </label>;
      })}
      {!yours && <p className="studio-preset-empty">Presets you save appear here.</p>}
    </div>
  </div>;
}
