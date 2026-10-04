import { useEffect, useRef, useState } from "react";

import { Diff } from "./ApprovalCard";
import { deadlineNote, type OpenCard } from "./approvals";
import { listRows, nextLine, nextStripPane, stripView } from "./answerStrip";
import { ago, label, summarize, type Signal } from "./attention";

export interface AttentionItem {
  paneId: string;
  title: string;
  /** The workspace the pane belongs to. */
  workspace: string;
  /** "Code" or "Threads". */
  where: string;
  signal: Signal;
  /** A thread's open approval cards, oldest first. */
  cards?: readonly OpenCard[];
}

interface Props {
  items: AttentionItem[];
  /** Go to the pane. */
  onOpen: (paneId: string) => void;
  /** Answer a card from the list. Only Allow once and Deny are offered here. */
  onDecide: (room: string, request: string, approve: boolean) => Promise<void>;
  /** Clear every Ready flag, leaving Needs you and Failed. */
  onMarkReadySeen: () => void;
}

/** A card's identity across threads: request ids repeat from thread to thread. */
const cardId = (card: OpenCard) => `${card.room}\u001f${card.request}`;

/**
 * Everything that wants attention, in one list, reachable from anywhere in
 * the app. It only appears when there is something in it. The most urgent
 * items come first, and choosing one goes to its pane. A thread stopped on
 * a routine approval can be answered right here; see answerStrip.ts.
 */
export function AttentionMenu({ items, onOpen, onDecide, onMarkReadySeen }: Props) {
  const [open, setOpen] = useState(false);
  /** Threads answered from the list since it opened. They keep their row until it closes. */
  const [answered, setAnswered] = useState<Record<string, AttentionItem>>({});
  /** The card just answered, until it leaves the list. Its strip's buttons wait meanwhile. */
  const [pending, setPending] = useState<{ paneId: string; card: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** A thread whose strip took focus saying "No approvals waiting"; a new card there takes the focus back. */
  const emptyStrip = useRef<string | null>(null);
  const rows = listRows(items, Object.values(answered));
  const cardKeys = rows.flatMap((row) => (row.cards ?? []).map(cardId)).join("\n");
  const hasCards = (paneId: string) => rows.some((row) => row.paneId === paneId && (row.cards?.length ?? 0) > 0);
  /** Move focus into a thread's strip: its first button, else the strip itself. */
  const focusStrip = (paneId: string) => requestAnimationFrame(() => {
    const strip = root.current?.querySelector<HTMLElement>(`[data-strip="${CSS.escape(paneId)}"]`);
    (strip?.querySelector<HTMLElement>("button") ?? strip)?.focus();
  });

  useEffect(() => {
    if (!open) {
      setAnswered((all) => (Object.keys(all).length > 0 ? {} : all));
      setPending(null);
      emptyStrip.current = null;
      return;
    }
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // Once the card just answered has left the list, focus moves on: to the
  // thread's next card, else the next thread below with one.
  useEffect(() => {
    if (!pending || cardKeys.split("\n").includes(pending.card)) return;
    const target = nextStripPane(rows, pending.paneId);
    setPending(null);
    emptyStrip.current = hasCards(target) ? null : target;
    focusStrip(target);
  }, [pending, cardKeys]);

  // The strip that said "No approvals waiting" is replaced when its thread
  // gets a new card, which drops focus on the page; put it on the new strip.
  useEffect(() => {
    const paneId = emptyStrip.current;
    if (!paneId || !hasCards(paneId)) return;
    emptyStrip.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    focusStrip(paneId);
  }, [cardKeys]);

  if (items.length === 0 && !(open && rows.length > 0)) return null;
  const { worst } = summarize(items.map((item) => item.signal));
  const how = (kind: Signal["kind"]) => items.filter((item) => item.signal.kind === kind).length;
  const summary = [
    how("needs_input") > 0 && `${how("needs_input")} need${how("needs_input") === 1 ? "s" : ""} you`,
    how("failed") > 0 && `${how("failed")} failed`,
    how("done") > 0 && `${how("done")} ready`,
  ]
    .filter(Boolean)
    .join(" · ") || "No approvals waiting";
  const now = Date.now();

  const go = (paneId: string) => {
    setOpen(false);
    onOpen(paneId);
  };
  const decide = (item: AttentionItem, card: OpenCard, approve: boolean) => {
    // Remembered without its cards: those come from the live item while it lasts.
    setAnswered((all) => ({ ...all, [item.paneId]: { ...item, cards: undefined } }));
    setPending({ paneId: item.paneId, card: cardId(card) });
    onDecide(card.room, card.request, approve).catch(() => setPending(null));
  };

  return (
    <div className="attention" ref={root}>
      <button ref={toggle} className={`attention-button ${worst ?? ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <span className={`dot ${worst ?? ""}`} />
        {summary}
      </button>
      {open && (
        <div className="attention-list" role="dialog" aria-label="Panes that want attention">
          {rows.map((item) => {
            const live = items.some((other) => other.paneId === item.paneId);
            const cards = item.cards ?? [];
            const card = cards[0];
            const view = card ? stripView(card.action) : null;
            const deadline = card ? deadlineNote(card.action.expires_at, now) : null;
            const next = nextLine(cards);
            const what = (
              <span className="attention-what">
                <strong>{item.title}</strong>
                {live && <span>{item.signal.note || label(item.signal.kind)}</span>}
                {deadline && <span>{deadline}</span>}
              </span>
            );
            const where = (
              <span className="attention-where">
                <span>{item.workspace} · {item.where}</span>
                <span>{ago(item.signal.at, now)}</span>
              </span>
            );
            if (card && view?.kind === "open") {
              return (
                <div key={item.paneId} className="attention-row" data-strip={item.paneId}>
                  <span className={`dot ${item.signal.kind}`} />
                  {what}
                  <button className="ghost small" onClick={() => go(item.paneId)}>Open to answer</button>
                  {where}
                </div>
              );
            }
            const waiting = pending?.paneId === item.paneId;
            return (
              <div key={item.paneId} className={`attention-item ${card || !live ? "expanded" : ""}`}>
                <button className="attention-row" onClick={() => go(item.paneId)}>
                  <span className={`dot ${live ? item.signal.kind : ""}`} />
                  {what}
                  {where}
                </button>
                {card && view && view.kind !== "open" && (
                  <div className="answer-strip" data-strip={item.paneId}>
                    <span className="answer-kind">{view.label}</span>
                    {view.kind === "command"
                      ? <code className="answer-command">{view.command}</code>
                      : <><span className="answer-summary">{view.summary}</span><Diff text={view.diff} /></>}
                    <div className="answer-actions">
                      <button className="primary" disabled={waiting} onClick={() => decide(item, card, true)}>Allow once</button>
                      <button className="danger" disabled={waiting} onClick={() => decide(item, card, false)}>Deny</button>
                      <button className="ghost" onClick={() => go(item.paneId)}>Open thread</button>
                    </div>
                    {next && <span className="answer-next">{next}</span>}
                  </div>
                )}
                {!live && <div className="answer-strip empty" data-strip={item.paneId} tabIndex={-1}>No approvals waiting</div>}
              </div>
            );
          })}
          <div className="attention-foot">
            <span>Most urgent first</span>
            {items.some((item) => item.signal.kind === "done") && <button className="ghost small" onClick={onMarkReadySeen}>Mark ready as seen</button>}
            <span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘J" : "Ctrl+Shift+J"}</kbd> next</span>
          </div>
        </div>
      )}
    </div>
  );
}
