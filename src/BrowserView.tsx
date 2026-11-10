import { useEffect, useRef, useState } from "react";

import type { BrowserApi, BrowserState } from "./backend";
import { covered, MODAL, OVERLAYS, viewBounds } from "./browserGeometry";

// The Electron app's docked browser: a placeholder in the layout, with the
// real page (a native view drawn above the whole window) kept over it. The
// view steps aside while the pane is off screen, and shows a picture of
// itself while a menu or dialog is drawn over the pane, or its pane map is
// moving or clips any part of it. Native views aren't clipped by the DOM.

interface Props {
  pane: string;
  url: string;
  browser: BrowserApi;
  /** False while the pane is off screen, or the page has nothing to show. */
  visible: boolean;
  onState: (state: BrowserState) => void;
}

export function BrowserView({ pane, url, browser, visible, onState }: Props) {
  const place = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const report = useRef(onState);
  report.current = onState;
  const wanted = useRef({ url, visible });
  wanted.current = { url, visible };
  const schedule = useRef<() => void>(() => {});

  useEffect(() => browser.onState((from, state) => { if (from === pane) report.current(state); }), [browser, pane]);

  useEffect(() => {
    const el = place.current;
    if (!el) return;
    let shown = false;
    let last = "";
    let queued = false;
    let frame = 0;
    let done = false;
    /** One update at a time: showing and hiding talk to main. */
    let chain: Promise<void> = Promise.resolve();

    const update = async () => {
      if (done) return;
      const { url, visible } = wanted.current;
      const rect = el.getBoundingClientRect();
      const offScreen = !visible || !url || rect.width < 1 || rect.height < 1 || document.visibilityState === "hidden";
      // Full-window Preview stays in its pane's DOM, but its fixed layer and
      // native page use the window. Only the docked page is clipped by the map.
      const region = el.closest(".preview.full-window") ? null : el.closest("[data-pane-map-region]");
      const regionRect = region?.getBoundingClientRect();
      const moving = el.closest("[data-pinned]") ? "data-focus-moving" : "data-moving";
      const mapCovered = region !== null && (region.hasAttribute(moving) || (regionRect !== undefined && (
        rect.left < regionRect.left || rect.top < regionRect.top || rect.right > regionRect.right || rect.bottom > regionRect.bottom
      )));
      const overlays = [...document.querySelectorAll(OVERLAYS)].filter((o) => !el.contains(o)).map((o) => o.getBoundingClientRect());
      const under = !offScreen && (mapCovered || document.querySelector(MODAL) !== null || covered(rect, overlays));
      if (offScreen || under) {
        if (!shown) return;
        shown = false;
        last = "";
        const picture = await browser.hide(pane, under);
        if (!done) setSnapshot(under ? picture : null);
        return;
      }
      const bounds = viewBounds(rect, browser.zoom());
      const key = `${JSON.stringify(bounds)} ${url}`;
      if (shown && key === last) return;
      if (!shown || !last.endsWith(` ${url}`)) {
        await browser.show(pane, bounds, url);
      } else {
        browser.bounds(pane, bounds);
      }
      shown = true;
      last = key;
      if (!done) setSnapshot(null);
    };
    // Coalesce everything that can move the pane into one check per frame,
    // and look again on the next frame, after layout settles.
    const run = () => {
      queued = false;
      chain = chain.then(update, update);
    };
    schedule.current = () => {
      if (queued) return;
      queued = true;
      frame = requestAnimationFrame(() => {
        run();
        frame = requestAnimationFrame(() => { if (!queued) run(); });
      });
    };
    const resize = new ResizeObserver(() => schedule.current());
    resize.observe(el);
    const changes = new MutationObserver(() => schedule.current());
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal", "class", "style", "hidden", "data-moving", "data-focus-moving", "data-pinned"] });
    const moved = () => schedule.current();
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("scrollend", moved, true);
    window.addEventListener("transitionend", moved, true);
    document.addEventListener("visibilitychange", moved);
    // Anything the observers can't see, such as a pane sliding over.
    const fallback = setInterval(moved, 1000);
    schedule.current();
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      clearInterval(fallback);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("scrollend", moved, true);
      window.removeEventListener("transitionend", moved, true);
      document.removeEventListener("visibilitychange", moved);
      void chain.then(() => browser.close(pane));
    };
  }, [browser, pane]);

  useEffect(() => { schedule.current(); }, [url, visible]);

  return (
    <div ref={place} className="browser-place" hidden={!visible}>
      {snapshot && <img className="browser-snapshot" src={snapshot} alt="" draggable={false} />}
    </div>
  );
}
