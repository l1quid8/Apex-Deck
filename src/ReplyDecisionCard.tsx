import { useEffect, useRef, useState } from "react";
import type { Backend } from "./backend";
import { actOnDecision, suggestionsMode, type ReplyOffer } from "./replyDecision";
import "./replyDecision.css";

export function useReplyOffer(backend: Backend | null, id: string, enabled: boolean, seq: number | null, busy: boolean) {
  const [snapshot, setSnapshot] = useState<{ backend: Backend; room: string; offer: ReplyOffer } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(n => n + 1);
  useEffect(() => {
    setSnapshot(null);
    if (!enabled || !backend || backend.demo) return;
    let live = true;
    let version = 0;
    let timer: number;
    const read = async () => {
      const ticket = ++version;
      window.clearTimeout(timer);
      try {
        const next = await backend.call<ReplyOffer>("room_reply_decision", { id });
        if (live && version === ticket) setSnapshot({ backend, room: id, offer: next });
      } catch {
        if (live && version === ticket) setSnapshot(null);
      } finally {
        if (live && version === ticket) timer = window.setTimeout(read, 5000);
      }
    };
    const subscription = backend.onSettingsChanged?.(raw => {
      if (!live) return;
      setSnapshot({ backend, room: id, offer: { mode: suggestionsMode(raw), decision: null, replySeq: null, checkout: null } });
      void read();
    });
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
      void subscription?.then(off => off()).catch(() => {});
    };
  }, [backend, id, enabled, seq, busy, revision]);
  return { offer: enabled && snapshot && snapshot.backend === backend && snapshot.room === id ? snapshot.offer : null, refresh };
}

export function ReplyDecisionCard({ offer, backend, room, refresh, focused, report }: {
  offer: ReplyOffer; backend: Backend; room: string; refresh(): void; focused: boolean; report(message: string, error: boolean): void;
}) {
  const card = offer.decision!;
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focused) return;
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof Element && !section.current?.contains(target) && target !== document.body) return;
      if (target instanceof Element && target.closest('textarea,input,select,[contenteditable=true],[role=dialog],dialog')) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && primary.current && !primary.current.disabled) {
        event.preventDefault(); primary.current.click();
      } else if (event.key === "Escape" && section.current?.contains(document.activeElement) && later.current) {
        event.preventDefault(); later.current.click();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [focused]);
  async function choose(dismiss: boolean) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const message = await actOnDecision(backend, room, offer, dismiss);
      if (message) report(message, false);
    } catch (error) { report(String(error), true); }
    finally { refresh(); working.current = false; setBusy(false); }
  }
  const label = card.cancellable ? "Cancel" : card.primary;
  return <section className="reply-decision" ref={section} aria-label="Reply decision" aria-busy={busy}>
    {card.dismissible && <button className="dismiss" disabled={busy} aria-label="Dismiss decision" onClick={() => void choose(true)}>×</button>}
    {card.context && <p className="context">{card.context}</p>}
    <strong>{card.question}</strong>
    {card.detail && <details><summary>Show check output</summary><pre>{card.detail}</pre></details>}
    {label && <div className="actions">
      <button className="primary" ref={primary} disabled={busy} onClick={() => void choose(false)}>{label}</button>
      {card.dismissible && <button ref={later} disabled={busy} onClick={() => void choose(true)}>Not yet</button>}
      <small>{card.turns === 0 ? "0 turns · Deck runs it" : "1 model turn"}</small>
    </div>}
  </section>;
}
