import { useEffect, useRef, useState } from "react";
import type { GeneratedCard } from "./schema.ts";
import { GeneratedRun, type GeneratedBounds, type GeneratedIdentity, type GeneratedState } from "./generatedRun.ts";
import "./answer-card.css";
import "./generated-card.css";

interface Props {
  card: GeneratedCard;
  source: string;
  version: number;
  author: string;
  identity: GeneratedIdentity;
  historical: boolean;
  readOnly: boolean;
  executionAllowed?: boolean;
  autoStart?: boolean;
  onDiscuss?: (snapshot: string) => void;
}

/** Native views cannot be clipped by CSS: constrain them to the visible intersection. */
export function visibleGeneratedBounds(slot: HTMLElement): GeneratedBounds | null {
  if (document.visibilityState !== "visible" || !slot.isConnected) return null;
  const slotRect = slot.getBoundingClientRect();
  const rect = {
    left: Math.max(0, slotRect.left), top: Math.max(40, slotRect.top),
    right: Math.min(innerWidth, slotRect.right), bottom: Math.min(innerHeight, slotRect.bottom),
  };
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
    const clip = parent.getBoundingClientRect();
    // Use the scroll container's client area, excluding borders and scrollbars.
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const top = clip.top + (parent.clientTop || 0);
      rect.top = Math.max(rect.top, top);
      rect.bottom = Math.min(rect.bottom, parent.clientHeight ? top + parent.clientHeight : clip.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      const left = clip.left + (parent.clientLeft || 0);
      rect.left = Math.max(rect.left, left);
      rect.right = Math.min(rect.right, parent.clientWidth ? left + parent.clientWidth : clip.right);
    }
  }
  const x = Math.ceil(rect.left), y = Math.ceil(rect.top);
  const width = Math.floor(rect.right) - x, height = Math.floor(rect.bottom) - y;
  if (width < 100 || height < 200) return null;
  // App-wide overlays always take precedence over native generated content.
  for (const overlay of document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-apex-agent-overlay], [popover]:popover-open, dialog[open], .modal-backdrop, .mod-modal-backdrop, .thread-details.overlay, .artifacts-panel.overlay, .context-menu, .composer-menu, .menu-list, .bot-popover")) {
    if (!overlay.getClientRects().length || getComputedStyle(overlay).visibility === "hidden") continue;
    if (overlay.hasAttribute?.("data-apex-agent-overlay")) {
      const cover = overlay.getBoundingClientRect();
      if (Math.min(rect.right, cover.right) - Math.max(rect.left, cover.left) >= 1 && Math.min(rect.bottom, cover.bottom) - Math.max(rect.top, cover.top) >= 1) return null;
    } else return null;
  }
  const points = [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.top + 2], [rect.left + 2, rect.bottom - 2], [rect.right - 2, rect.bottom - 2], [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2]];
  if (points.some(([x, y]) => !slot.contains(document.elementFromPoint(x, y)))) return null;
  return { x, y, width, height };
}

/** Code is never put in Deck's DOM. Only main can create the isolated host. */
export function GeneratedAnswerCard({ card, source, version, author, identity, historical, readOnly, executionAllowed = true, autoStart = true, onDiscuss }: Props) {
  const [state, setState] = useState<GeneratedState>({ enabled: false, phase: "idle", reason: "Checking interface availability…", discuss: "", height: 300, attempted: false });
  const controller = useRef<GeneratedRun | null>(null);
  const slot = useRef<HTMLDivElement | null>(null);
  const viewportHeight = useRef<number | null>(null);
  // Focus/availability changes must not retry a stopped or failed revision.
  const automaticAttempted = useRef(false);
  const desktop = typeof window !== "undefined" && Boolean(window.apexDeck?.generatedUI);
  const supported = desktop && executionAllowed && !readOnly && !historical && Boolean(identity.threadId);
  useEffect(() => {
    if (!supported) return;
    const api = window.apexDeck?.generatedUI;
    const run = new GeneratedRun(api, { source, identity }, () => {
      if (run.state.attempted) automaticAttempted.current = true;
      setState({ ...run.state });
    });
    controller.current = run;
    void run.checkCapability();
    return () => { run.dispose(); if (controller.current === run) controller.current = null; };
  }, [supported, source, identity.threadId, identity.hostId, identity.seq, identity.cardId]);
  useEffect(() => {
    const place = () => {
      const run = controller.current;
      if (!run) return;
      const bounds = slot.current ? visibleGeneratedBounds(slot.current) : null;
      if (run.state.phase !== "idle") run.place(bounds);
      else if (autoStart && !automaticAttempted.current) {
        if (bounds && slot.current) viewportHeight.current = Math.ceil(slot.current.getBoundingClientRect().height);
        void run.autoStart(document.hasFocus() ? bounds : null, performance.now());
      }
    };
    const revokeGeometry = () => {
      const run = controller.current;
      if (run?.state.phase === "idle") void run.autoStart(null, performance.now());
      else if (run?.state.phase === "starting") run.place(null);
      else if (run) run.place(slot.current ? visibleGeneratedBounds(slot.current) : null);
    };
    // Update synchronously on scroll so native content stays inside the visible
    // chat area. Pending starts still revoke their previously approved geometry.
    document.addEventListener("scroll", revokeGeometry, true);
    window.addEventListener("resize", revokeGeometry);
    document.addEventListener("visibilitychange", revokeGeometry);
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
    const timer = window.setInterval(place, 125);
    return () => {
      clearInterval(timer); observer.disconnect();
      document.removeEventListener("scroll", revokeGeometry, true);
      window.removeEventListener("resize", revokeGeometry);
      document.removeEventListener("visibilitychange", revokeGeometry);
    };
  }, [autoStart]);
  const run = () => {
    const bounds = slot.current && visibleGeneratedBounds(slot.current);
    if (bounds && slot.current) {
      viewportHeight.current = Math.ceil(slot.current.getBoundingClientRect().height);
      void controller.current?.start(bounds);
    }
    else setState((old) => ({ ...old, reason: "Scroll at least 200px of the interface into view before running it." }));
  };
  const active = state.phase !== "idle";
  // Keep the opening footprint. Changing it can cause Chromium
  // to scroll the transcript automatically, which correctly revokes a native
  // view. Generated content scrolls inside this fixed viewport until Stop.
  return (
    <section className="answer-card generated-answer" data-generated-running={active ? "true" : undefined} aria-label={card.title}>
      <header className="answer-card-head">
        <span className="answer-eyebrow">Generated interface · v{version} · {author}</span>
        <h3>{card.title}</h3>
        <p className="answer-summary">{card.summary}</p>
      </header>
      {(!supported || !state.enabled) && <p className="generated-fallback">{card.fallback}</p>}
      {supported && <>
        {(state.enabled || active) && <div className="generated-slot" ref={slot} style={{ height: (active ? viewportHeight.current : null) ?? state.height }} aria-label={`${card.title} interface`} aria-busy={state.phase === "starting"}>
          {!active && <span>{autoStart && !automaticAttempted.current ? "Opens automatically when in view. Scroll inside to see the full interface." : "Interface paused."}</span>}
        </div>}
        <footer className="answer-foot">
          {!active && state.enabled && (!autoStart || state.attempted || automaticAttempted.current) && <button type="button" className="ghost small" onClick={run}>{state.attempted || automaticAttempted.current ? "Restart" : "Open interface"}</button>}
          {active && <button type="button" className="ghost small" onClick={() => { void controller.current?.stop(); }}>Stop</button>}
          <span className="answer-hint" role="status">{state.reason}</span>
        </footer>
        {state.enabled && <details className="generated-text-version"><summary>Text version</summary><p className="generated-fallback">{card.fallback}</p></details>}
        {state.discuss && <div className="generated-discuss">
          <p>Text offered by this interface:</p>
          <pre>{state.discuss}</pre>
          {onDiscuss && <button type="button" className="primary small" onClick={() => {
            const text = controller.current?.takeDiscuss();
            if (text) onDiscuss(`From ${author}'s interface "${card.title}" (v${version}):\n${text}`);
          }}>Discuss this text</button>}
        </div>}
      </>}
      {!supported && <p className="answer-hint generated-status">{historical ? "An earlier version. The text above is kept for reference." : "This client shows the text version of this interface."}</p>}
    </section>
  );
}
