import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HostConnectionStore } from "./hostConnections";
import { buildNotice, helperNotice, reachNotice } from "./hostFacts.ts";
import { Glyph } from "./SidebarIcons";

// The cards that open beside the sidebar when the pointer rests on a
// project or a thread, as in Codex. They hold actions (Pin, Retry), so the
// pointer can move onto a card without it closing.

const OPEN_MS = 450;
const CLOSE_MS = 150;

export interface HoverTarget { kind: "project" | "thread"; id: string; top: number }

/** Hover timing for the rail's rows and the card they open. */
export function useHoverCard() {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);
  const enter = useCallback((kind: HoverTarget["kind"], id: string, row: HTMLElement) => {
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setTarget({ kind, id, top: row.getBoundingClientRect().top }), OPEN_MS);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setTarget(null), CLOSE_MS);
  }, []);
  const keep = useCallback(() => clearTimeout(closeTimer.current), []);
  const hide = useCallback(() => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); setTarget(null); }, []);
  return { target, enter, leave, keep, hide };
}

/** A card beside the rail, at the row's height and inside the window. */
export function HoverCard({ left, top, onEnter, onLeave, children }: { left: number; top: number; onEnter(): void; onLeave(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - 8 - box.height)}px`;
  });
  return <div ref={ref} className="hover-card" role="tooltip" style={{ left, top: Math.max(8, top - 6) }} onMouseEnter={onEnter} onMouseLeave={onLeave}>{children}</div>;
}

const noStore = { subscribe: () => () => {}, get: () => null };
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function ProjectCard({ name, path, remote, hostName, tint, threads, pinned, store, onPin, onRetry, onConnect, folder }: {
  name: string; path: string; remote: boolean; hostName: string; tint: string; threads: number; pinned: boolean;
  store?: HostConnectionStore; folder: ReactNode; onPin(): void; onRetry(): void; onConnect(): void;
}) {
  const source = store ?? noStore;
  const state = useSyncExternalStore(source.subscribe, source.get);
  const count = `${threads} thread${threads === 1 ? "" : "s"}`;
  const reach = remote && state ? reachNotice(hostName, state.status, state.seenAt, time) : null;
  const helper = remote && state?.status.kind === "connected" ? buildNotice(hostName, __APP_BUILD__, state.build) ?? helperNotice(hostName, __APP_VERSION__, state.helper) : null;
  return <>
    <div className="card-row title">{folder}<span className="grow">{name}</span>
      <span className="side"><button className="act" onClick={onPin} aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} title={pinned ? "Unpin project" : "Pin project"}><Glyph name="pin" size={13} /></button></span>
    </div>
    <div className="card-row">{remote ? <span style={{ color: tint }}><Glyph name="globe" size={14} /></span> : <Glyph name="laptop" size={14} />}
      <span className="grow">{remote ? hostName : "This Mac"} · {count}</span></div>
    <hr />
    {reach && <div className={`card-row ${reach.tone}`}><Glyph name="info" size={14} /><span className="grow">{reach.text}</span>
      {reach.action && <span className="side"><button className="act" onClick={reach.action === "retry" ? onRetry : onConnect} title={reach.action === "retry" ? "Try again now" : "Connect now"} aria-label={reach.action === "retry" ? `Retry ${hostName}` : `Connect to ${hostName}`}><Glyph name="refresh" size={14} /></button></span>}
    </div>}
    {helper && <div className="card-row warn"><Glyph name="info" size={14} /><span className="grow">{helper}</span></div>}
    <div className="card-row"><Glyph name="folder" size={14} /><span className="grow mono">{path || "No folder"}</span></div>
  </>;
}

export function ThreadCard({ title, project, hostName, remote, tint, twin, age, who, folder }: {
  title: string; project: string; hostName: string; remote: boolean; tint: string; twin: string; age: string; who: string[]; folder: ReactNode;
}) {
  return <>
    <div className="card-row title"><span className="grow">{title}</span>
      <span className="side">{remote && <span style={{ color: tint }} title={hostName}><Glyph name="globe" size={14} /></span>}{age}</span></div>
    <div className="card-row">{folder}<span className="grow">{project} · {remote ? hostName : "This Mac"}{twin && <> · <span className="mono">{twin}</span></>}</span></div>
    <div className="card-row"><Glyph name="chat" size={14} /><span className="grow">Threads · {who.length ? who.join(", ") : "No bots yet"}</span></div>
  </>;
}
