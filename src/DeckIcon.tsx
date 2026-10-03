import type { CSSProperties } from "react";

type IconName = "folder" | "sidebar" | "arrow" | "spark" | "send" | "chat" | "reply";

export function DeckIcon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    {name === "folder" && <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />}
    {name === "sidebar" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>}
    {name === "arrow" && <path d="M5 12h14m-5-5 5 5-5 5" />}
    {name === "spark" && <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" /></>}
    {name === "reply" && <path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" />}
    {name === "send" && <path d="m12 19 0-14m-6 6 6-6 6 6" />}
    {name === "chat" && <><path d="M4 5h16v12H9l-5 4V5Z" /><path d="M8 9h8m-8 4h5" /></>}
  </svg>;
}
