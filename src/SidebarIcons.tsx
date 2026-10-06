import type { CSSProperties } from "react";

// The sidebar's small line icons, drawn like DeckIcon (24-unit grid, 1.7 stroke).

const PATHS = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />,
  folderOpen: <><path d="M3 18V7a2 2 0 0 1 2-2h5l2 3h6a2 2 0 0 1 2 2v1" /><path d="M3 19l2.7-7a2 2 0 0 1 1.9-1.3H21l-2.6 7A2 2 0 0 1 16.5 19H3Z" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>,
  pin: <><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4Z" /><path d="M12 16v6" /></>,
  newIn: <><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-4 1 1-4Z" /></>,
  dots: <><circle cx="5" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="19" cy="12" r="1.1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4.3L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4.3L20 16" /><path d="M20 21v-5h-5" /></>,
  chat: <><path d="M4 5h16v12H9l-5 4V5Z" /><path d="M8 9h8m-8 4h5" /></>,
  chevDown: <path d="m6 9 6 6 6-6" />,
  chevRight: <path d="m9 6 6 6-6 6" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  doc: <><path d="M14 3H6v18h12V7Z" /><path d="M14 3v4h4M9 13h6M9 17h4" /></>,
  folderPlus: <><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" /><path d="M12 11v6M9 14h6" /></>,
  plug: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v4" /></>,
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 16, style }: { name: GlyphName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "dots" ? 2.4 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{PATHS[name]}</svg>;
}

/** A project's folder; a server's carries that server's coloured globe. */
export function ProjectFolder({ open, tint, size = 16 }: { open?: boolean; tint?: string; size?: number }) {
  return <span className="fold">
    <Glyph name={open ? "folderOpen" : "folder"} size={size} />
    {tint && <span className="fold-globe" style={{ color: tint }}><Glyph name="globe" size={9} /></span>}
  </span>;
}
