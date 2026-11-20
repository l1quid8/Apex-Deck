import { useEffect, useRef, useState } from "react";
import type { GeneratedCard } from "./schema.ts";
import { GeneratedRun, type GeneratedBounds, type GeneratedIdentity, type GeneratedState } from "./generatedRun.ts";
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
  executionEpoch?: string;
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

// Pass only opaque RGB colors to the isolated surface. The surrounding reply
// can be transparent, particularly in Clay, so find its painted ancestor.
function replyColors(slot: HTMLElement | null) {
  if (!slot) return;
  const hex = (css: string) => {
    const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
    return rgb && "#" + rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("");
  };
  const foreground = hex(getComputedStyle(slot).color);
  if (!foreground) return;
  for (let node: HTMLElement | null = slot; node; node = node.parentElement) {
    const background = hex(getComputedStyle(node).backgroundColor);
    if (background) return { background, foreground, light: document.documentElement.dataset.deckLight === "true" };
  }
}

/** Code is never put in Deck's DOM. Only main can create the isolated host. */
export function GeneratedAnswerCard({ card, source, version, author, identity, historical, readOnly, executionAllowed = true, executionEpoch = "", autoStart = true, onDiscuss }: Props) {
  const [state, setState] = useState<GeneratedState>({ enabled: false, phase: "idle", reason: "Checking interface availability…", discuss: "", height: 300, attempted: false });
  const controller = useRef<GeneratedRun | null>(null);
  const slot = useRef<HTMLDivElement | null>(null);
  const viewportHeight = useRef<number | null>(null);
  const failedRevision = useRef(false);
  const desktop = typeof window !== "undefined" && Boolean(window.apexDeck?.generatedUI);
  const supported = desktop && autoStart && executionAllowed && !readOnly && !historical && Boolean(identity.threadId);
  useEffect(() => {
    // A focus or connection change can remount the controller for this reply.
    // Keep a failed payload inert until ThreadCard mounts a new revision.
    if (!supported || failedRevision.current) return;
    const api = window.apexDeck?.generatedUI;
    const run = new GeneratedRun(api, { source, identity }, () => {
      if (run.state.phase === "idle" && run.state.attempted) failedRevision.current = true;
      setState({ ...run.state });
    }, () => replyColors(slot.current));
    controller.current = run;
    setState({ ...run.state });
    void run.restoreImage();
    void run.checkCapability();
    return () => { run.dispose(); if (controller.current === run) controller.current = null; };
  }, [supported, executionEpoch, source, identity.threadId, identity.hostId, identity.seq, identity.cardId]);
  useEffect(() => {
    // Historical/offline replies may display their own cached pixels, but get
    // no execution authority. Keep the cache result bound to this mount.
    if (!desktop || supported) return;
    let mounted = true;
    void window.apexDeck?.generatedUI?.cached?.({ source, identity, requestId: crypto.randomUUID(), bounds: {x:0,y:40,width:100,height:200} }).then(cached => {
      if (mounted && cached.image && cached.image.length <= 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(cached.image)) {
        setState(previous => ({...previous, image: cached.image!}));
      }
    }).catch(() => {}).finally(() => { if (mounted) setState(previous => ({...previous,cacheChecked:true})); });
    return () => { mounted = false; };
  }, [desktop, supported, source, identity.threadId, identity.hostId, identity.seq, identity.cardId]);
  useEffect(() => {
    if (!supported) return;
    const place = () => {
      const run = controller.current;
      if (!run) return;
      const bounds = slot.current ? visibleGeneratedBounds(slot.current) : null;
      if (run.state.phase !== "idle") run.place(bounds);
      else if (!run.state.attempted) {
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
    const themeObserver = new MutationObserver(() => {
      const run = controller.current;
      if (run && run.state.phase !== "idle") run.place(null);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-deck-light", "data-deck-theme", "data-deck-palette"] });
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
    const timer = window.setInterval(place, 125);
    return () => {
      clearInterval(timer); observer.disconnect(); themeObserver.disconnect();
      document.removeEventListener("scroll", revokeGeometry, true);
      window.removeEventListener("resize", revokeGeometry);
      document.removeEventListener("visibilitychange", revokeGeometry);
    };
  }, [supported]);
  const active = supported && state.phase !== "idle";
  const waitingForCache = desktop && typeof window.apexDeck?.generatedUI?.cached === "function" && !state.cacheChecked;
  const showSlot = waitingForCache || Boolean(state.image) || (supported && (state.enabled || state.reason === "Checking interface availability…") && (active || !state.attempted));
  return (
    <section className="generated-answer" data-generated-running={active ? "true" : undefined} aria-label={card.title}>
      <h3>{card.title}</h3>
      {showSlot ? (
        <div className="generated-slot" ref={slot} style={{ height: (active ? viewportHeight.current : null) ?? state.height }}
          aria-label={card.title} aria-busy={state.phase === "starting"}>
          {state.image && <img className="generated-snapshot" src={state.image} alt={card.title + " — saved view"} draggable={false} />}
        </div>
      ) : (
        <>
          <p className="generated-summary">{card.summary}</p>
          {card.fallback !== card.summary && <p className="generated-fallback">{card.fallback}</p>}
          {supported && state.reason && state.reason !== "Checking interface availability…" &&
            <p className="generated-status" role="status">{state.reason}</p>}
        </>
      )}
      {showSlot && state.image && (state.attempted || (supported && !state.enabled)) && state.phase === "idle" && state.reason && state.reason !== "Checking interface availability…" && <p className="generated-status" role="status">{state.reason}</p>}
      {active && state.discuss && <div className="generated-discuss">
        <pre>{state.discuss}</pre>
        {onDiscuss && <button type="button" className="primary small" onClick={() => {
          const text = controller.current?.takeDiscuss();
          if (text) onDiscuss(`From ${author}'s interface "${card.title}" (v${version}):\n${text}`);
        }}>Discuss this text</button>}
      </div>}
    </section>
  );
}
