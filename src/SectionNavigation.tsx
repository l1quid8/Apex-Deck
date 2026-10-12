import { useEffect, useRef, useState } from "react";

import { Diff } from "./ApprovalCard";
import { nextLine, stripView } from "./answerStrip";
import type { OpenCard } from "./approvals";
import { ago, type Attention } from "./attention";
import type { AppSection } from "./types";

const sections = [
  { id: "agents", label: "Agents" },
  { id: "code", label: "Code" },
  { id: "threads", label: "Threads" },
  { id: "library", label: "Library" },
] as const;

export function SectionIcon({ section }: { section: AppSection }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {section === "agents" ? <><path d="M12 3v4M9 3h6M5 7h14v13H5zM2 11v5m20-5v5M9 17h6" /><path d="M9 11v2m6-2v2" /></> : section === "code" ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></> : section === "library" ? <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9.5" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" /></> : <><path d="M4 4h14v11H9l-5 4V4Z" /><path d="M18 9h3v12l-4-3h-5v-3" /></>}
  </svg>;
}

export interface SectionFlagRow {
  key: string;
  title: string;
  note: string;
  meta: string;
  kind: Attention;
  at: number;
  /** Where choosing the row goes; rows without one are only listed. */
  paneId?: string;
  /** A thread's open approval cards, oldest first; the first can be answered from the list. */
  cards?: readonly OpenCard[];
  hostName?: string;
  available?: boolean;
}
export interface SectionFlag { count: number; worst: Attention | null; rows: SectionFlagRow[] }

/**
 * A tab with something needing attention carries a thick underline in the
 * colour of its most urgent item; hovering it lists what is waiting.
 */
export function SectionNavigation({ section, onChange, flags = {}, onOpen, onMarkReadySeen, onDecide }: {
  section: AppSection;
  onChange: (section: AppSection) => void;
  flags?: Partial<Record<AppSection, SectionFlag>>;
  onOpen?: (paneId: string) => void;
  onMarkReadySeen?: () => void;
  /** Answer a card from the list. Only Allow once and Deny are offered here. */
  onDecide?: (room: string, request: string, approve: boolean) => Promise<void>;
}) {
  const [hover, setHover] = useState<{ id: AppSection; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = (id: AppSection, left: number) => { window.clearTimeout(timer.current); setHover({ id, left }); };
  const hide = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setHover(null), 150); };
  /** The card just answered; its buttons wait until it leaves the list. */
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const open = hover ? flags[hover.id] : undefined;
  const rows = open?.rows ?? [];
  const now = Date.now();
  return <nav className="section-navigation" aria-label="Main sections" onKeyDown={(event) => { if (event.key === "Escape") setHover(null); }}>
    {sections.map((item) => {
      const flag = flags[item.id];
      const alert = flag?.count ? flag.worst : null;
      return <button key={item.id} style={{ WebkitAppRegion: "no-drag" }} className={`section-button ${item.id} ${section === item.id ? "selected" : ""}${alert ? ` has-attention ${alert}` : ""}`} aria-current={section === item.id ? "page" : undefined} aria-haspopup={alert ? "dialog" : undefined} onClick={() => onChange(item.id)} onMouseEnter={(event) => alert ? show(item.id, event.currentTarget.offsetLeft) : setHover(null)} onMouseLeave={hide} onFocus={(event) => alert && show(item.id, event.currentTarget.offsetLeft)} onBlur={hide}>
      <span><SectionIcon section={item.id} /></span><span className="section-label">{item.label}</span>
    </button>;
    })}
    {hover && open && rows.length > 0 && <div className="attention-list section-alerts" role="dialog" aria-label="Needs attention" style={{ left: hover.left }} onMouseEnter={() => show(hover.id, hover.left)} onMouseLeave={hide}>
      {rows.map((row) => {
        const body = <>
          <span className={`dot ${row.kind}`} />
          <span className="attention-what"><strong>{row.title}</strong><span>{row.note}</span></span>
          <span className="attention-where"><span>{row.meta}</span><span>{ago(row.at, now)}</span></span>
        </>;
        const go = () => { setHover(null); onOpen?.(row.paneId!); };
        const card = row.cards?.[0];
        const view = card && onDecide ? stripView(card.action) : null;
        if (card && view && view.kind !== "open") {
          const id = `${card.room}\u001f${card.request}`;
          const waiting = pending === id;
          const decide = (approve: boolean) => { setPending(id); onDecide!(card.room, card.request, approve).catch(() => setPending(null)); };
          const next = nextLine(row.cards!);
          return <div key={row.key} className="attention-item expanded">
            <button className="attention-row" onClick={go}>{body}</button>
            <div className="answer-strip" data-strip={row.paneId}>
              <span className="answer-kind">{view.label} · Runs on {row.hostName ?? "This Mac"}</span>
              {view.kind === "command"
                ? <code className="answer-command">{view.command}</code>
                : <><span className="answer-summary">{view.summary}</span><Diff text={view.diff} /></>}
              <div className="answer-actions">
                <button className="primary" disabled={waiting || row.available === false} onClick={() => decide(true)}>Allow once</button>
                <button className="danger" disabled={waiting || row.available === false} onClick={() => decide(false)}>Deny</button>
                <button className="ghost" onClick={go}>Open thread</button>
              </div>
              {next && <span className="answer-next">{next}</span>}
            </div>
          </div>;
        }
        return row.paneId && onOpen
          ? <button key={row.key} className="attention-row" onClick={go}>{body}</button>
          : <div key={row.key} className="attention-row">{body}</div>;
      })}
      <div className="attention-foot">
        <span>Most urgent first</span>
        {rows.some((row) => row.kind === "done") && onMarkReadySeen && <button className="ghost small" onClick={() => { onMarkReadySeen(); setHover(null); }}>Mark ready as seen</button>}
      </div>
    </div>}
  </nav>;
}
