import { memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { GAP, centreId, chooseAnchor, insertIndex, place, refitScroll, reorder, scrollFor, stepZoom, zoomScroll, type Arrangement, type Placement, type PxRect, type Size } from "./paneArrangement";

export interface PaneMapHandle { reveal(id: string): void }
interface PaneMapProps {
  arrangement: Arrangement;
  borrowed?: number;
  mounted: string[];
  onArrangement(next: Arrangement): void;
  active: string[];
  maximized: string | null;
  onRestore(): void;
  onVisiblePanes?(ids: string[]): void;
  onTargetOnly?(id: string | null): void;
  renderPane(id: string, rect: PxRect | null, onScreen: boolean): ReactNode;
  onPopOut(id: string, x: number, y: number): void;
  handle: Ref<PaneMapHandle>;
}
type Point = { x: number; y: number };
interface Drag {
  id: string; pid: number; start: Point; point: Point; screen: Point;
  rect: PxRect; original: Arrangement; order: string[]; active: boolean;
}
const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=true], [role=textbox]");
const inside = (r: PxRect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const axisScroll = (el: HTMLElement, p: Placement) => p.axis === "x" ? el.scrollLeft : el.scrollTop;

// Keep geometry and viewport bookkeeping out of expensive thread render paths.
// Numeric props let React compare rects without depending on fresh rect objects.
const PaneContent = memo(function PaneContent({ id, x, y, w, h, placed, onScreen, renderPane }: {
  id: string; x: number; y: number; w: number; h: number; placed: boolean; onScreen: boolean;
  renderPane: PaneMapProps["renderPane"];
}) {
  return renderPane(id, placed ? { x, y, w, h } : null, onScreen);
});

/** One native scroller and one keyed parent for every pane, across every layout. */
export function PaneMap(props: PaneMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });
  const offset = useRef(0);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const visibleRef = useRef<string[]>([]);
  const savedScroll = useRef(0);
  const motion = useRef({ until: 0, timer: 0 });
  const focusMotion = useRef({ until: 0, timer: 0 });
  const drawnLayout = useRef<{ placement: Placement; maximized: string | null } | null>(null);
  const focusGlides = useRef(new Map<string, Animation>());
  const [resizing, setResizing] = useState(false);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const press = useRef<Drag | null>(null);
  const retireDrag = useRef<() => void>(() => {});
  const placement = useMemo(() => place(props.arrangement, area, props.borrowed), [props.arrangement, area, props.borrowed]);
  const fitted = useRef({ arrangement: props.arrangement, area, borrowed: props.borrowed });
  const beforeFit = fitted.current;
  const refitting = beforeFit.arrangement === props.arrangement && beforeFit.area.w === area.w &&
    (beforeFit.area.h !== area.h || beforeFit.borrowed !== props.borrowed);
  // The borrowed-height render can precede the map's ResizeObserver. Don't
  // commit scroll or Focus bookkeeping for that temporary size pairing.
  const stale = () => { const el = root.current; return !!el && (el.clientWidth !== area.w || el.clientHeight !== area.h); };
  useLayoutEffect(() => { if (!stale()) fitted.current = { arrangement: props.arrangement, area, borrowed: props.borrowed }; });
  const live = useRef({ props, area, placement });
  live.current = { props, area, placement };
  const pointer = useRef<Point | null>(null);
  const held = useRef<{ id: string; point: Point } | null>(null);
  const wheelAcc = useRef({ value: 0, time: 0 });
  const pendingScroll = useRef<number | null>(null);
  const pendingReveal = useRef<string | null>(null);
  // The refit's own scroll correction updates visibility without freezing views.
  const quietScroll = useRef<number | null>(null);
  const previous = useRef<{ mode: Arrangement["mode"]; order: string[]; maximized: string | null } | null>(null);

  // Read the old DOM before React changes positioning mode. Reading the drawn
  // rect (rather than just the destination) also lets a second switch interrupt
  // a glide without jumping. Only the two panes changing sticky ownership need it.
  const oldFocus = drawnLayout.current?.placement.focus;
  const newFocus = placement.focus;
  const changingFocus = oldFocus?.id !== newFocus?.id;
  const rebaseGlide = changingFocus || (drawnLayout.current?.placement !== placement && focusGlides.current.size > 0);
  const starts = new Map<string, Point>();
  if (rebaseGlide && root.current && !props.maximized && !drawnLayout.current?.maximized) {
    const box = root.current.getBoundingClientRect();
    for (const slot of root.current.querySelectorAll<HTMLElement>(".pane-map-slot")) {
      const id = slot.dataset.paneId;
      if (id && (id === oldFocus?.id || id === newFocus?.id || focusGlides.current.has(id)) && slot.style.display !== "none") {
        const rect = slot.getBoundingClientRect();
        starts.set(id, { x: rect.x - box.x, y: rect.y - box.y });
      }
    }
  }

  const updateVisibility = () => {
    const el = root.current;
    if (!el) return;
    const { placement: p, area, props: now } = live.current;
    const full = now.maximized && now.mounted.includes(now.maximized);
    const scroll = axisScroll(el, p);
    // A one-pane zoom targets the nearest snapped pane, even mid-scroll.
    // Focus layouts retain their side list and therefore allow multi targeting.
    const one = !p.focus && p.levels[p.levelIdx]?.shown === 1;
    // Borrowed height and ResizeObserver arrive in separate renders. A stale
    // size pair can momentarily look like one-pane zoom while clearing text.
    if (!stale()) now.onTargetOnly?.(full ? now.maximized : one ? centreId(p, scroll) : null);
    const ids = now.mounted.filter(id => {
      if (full) return now.maximized === id;
      if (p.focus?.id === id) return true;
      const r = p.rects.get(id);
      if (!r) return false;
      const x = r.x + p.region.x - (p.axis === "x" ? scroll : 0);
      const y = r.y + p.region.y - (p.axis === "y" ? scroll : 0);
      return r.w > 0 && r.h > 0 && x + r.w > 0 && y + r.h > 0 && x < area.w && y < area.h;
    });
    if (ids.length === visibleRef.current.length && ids.every((id, i) => id === visibleRef.current[i])) return;
    visibleRef.current = ids;
    setVisibleIds(ids);
  };
  const markMotion = (state: typeof motion, attribute: "moving" | "focusMoving", glide: boolean) => {
    const el = root.current;
    if (!el) return;
    el.dataset[attribute] = "";
    const duration = glide && !matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : 150;
    state.current.until = Math.max(state.current.until, performance.now() + duration);
    window.clearTimeout(state.current.timer);
    const gliding = () => [...el.querySelectorAll<HTMLElement>(".pane-map-slot")].some(slot =>
      slot.hasAttribute("data-pinned") === (attribute === "focusMoving") && slot.getAnimations().some(animation => animation.playState === "running"));
    const settle = () => {
      const remaining = state.current.until - performance.now();
      if (remaining > 0 || press.current?.active || el.classList.contains("adjusting") || gliding()) {
        state.current.timer = window.setTimeout(settle, Math.max(16, remaining, 100));
      } else delete el.dataset[attribute];
    };
    state.current.timer = window.setTimeout(settle, duration);
  };
  const markMoving = (glide = false) => markMotion(motion, "moving", glide);
  const markFocusMoving = (glide = false) => markMotion(focusMotion, "focusMoving", glide);
  useLayoutEffect(() => () => {
    window.clearTimeout(motion.current.timer);
    window.clearTimeout(focusMotion.current.timer);
    for (const animation of focusGlides.current.values()) animation.cancel();
  }, []);

  const scrollTo = (value: number) => {
    const el = root.current;
    if (!el) return;
    const p = live.current.placement;
    el.scrollLeft = p.axis === "x" ? value : 0;
    el.scrollTop = p.axis === "y" ? value : 0;
    offset.current = axisScroll(el, p);
    updateVisibility();
  };
  const reveal = (id: string) => {
    const { props: now, placement: p } = live.current;
    if (!now.arrangement.order.includes(id)) return;
    if (now.maximized && now.maximized !== id) {
      pendingReveal.current = id;
      now.onRestore();
      return;
    }
    if (p.focus?.id === id || now.maximized === id) return;
    if (root.current) scrollTo(scrollFor(p, { kind: "active", ids: [id] }, axisScroll(root.current, p)));
  };
  useImperativeHandle(props.handle, () => ({ reveal }), []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setArea(before => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      return next.w === before.w && next.h === before.h ? before : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.borrowed]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      const drag = press.current;
      if (!drag?.active) return;
      const { props: now, placement: p } = live.current;
      const box = el.getBoundingClientRect();
      const at = insertIndex(p, { x: drag.point.x - box.left, y: drag.point.y - box.top }, drag.id, axisScroll(el, p));
      const order = reorder(drag.original.order, drag.id, at);
      if (order.some((id, i) => now.arrangement.order[i] !== id)) {
        const arrangement = { ...now.arrangement, order };
        drag.order = order;
        // Native events may arrive before React has painted the prior move.
        live.current = { ...live.current, props: { ...now, arrangement }, placement: place(arrangement, live.current.area, now.borrowed) };
        now.onArrangement(arrangement);
      }
      markMoving(true);
      markFocusMoving(true);
      setDragging({ ...drag });
    };
    const edgePan = () => {
      const drag = press.current;
      if (!drag?.active) { frame = 0; return; }
      const p = live.current.placement;
      const box = el.getBoundingClientRect();
      const position = p.axis === "x" ? drag.point.x - box.left - p.region.x : drag.point.y - box.top - p.region.y;
      const span = p.axis === "x" ? p.region.w : p.region.h;
      const edge = Math.min(48, span / 4);
      const speed = position < edge ? -Math.min(18, (edge - position) / 3) : position > span - edge ? Math.min(18, (position - span + edge) / 3) : 0;
      if (speed) {
        const next = Math.max(0, Math.min(p.snaps.at(-1) ?? 0, axisScroll(el, p) + speed));
        if (p.axis === "x") el.scrollLeft = next; else el.scrollTop = next;
        update();
      }
      frame = requestAnimationFrame(edgePan);
    };
    const finish = (cancel: boolean) => {
      const drag = press.current;
      if (!drag) return;
      press.current = null;
      cancelAnimationFrame(frame); frame = 0;
      if (el.hasPointerCapture(drag.pid)) el.releasePointerCapture(drag.pid);
      if (cancel && drag.active) live.current.props.onArrangement(drag.original);
      setDragging(null);
    };
    retireDrag.current = () => finish(false);
    const move = (event: PointerEvent) => {
      const drag = press.current;
      if (!drag || event.pointerId !== drag.pid) return;
      drag.point = { x: event.clientX, y: event.clientY };
      drag.screen = { x: event.screenX, y: event.screenY };
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 6) return;
        drag.active = true;
        focusGlides.current.get(drag.id)?.cancel();
        focusGlides.current.delete(drag.id);
        el.setPointerCapture(drag.pid);
      }
      event.preventDefault();
      update();
      if (!frame) frame = requestAnimationFrame(edgePan);
    };
    const up = (event: PointerEvent) => {
      const drag = press.current;
      if (!drag || event.pointerId !== drag.pid) return;
      if (drag?.active && (event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight)) {
        // App snapshots its current order when it opens the external window.
        // Commit the original order before asking it to take that snapshot.
        flushSync(() => finish(true));
        live.current.props.onPopOut(drag.id, event.screenX, event.screenY);
      }
      finish(false);
    };
    const cancel = (event?: PointerEvent) => { if (!event || event.pointerId === press.current?.pid) finish(true); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && press.current?.active) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !area.w || !area.h || stale()) return;
    const old = previous.current;
    const arr = props.arrangement;
    const drag = press.current;
    if (drag && (props.maximized || arr.mode !== drag.original.mode || arr.order.length !== drag.order.length || arr.order.some((id, i) => id !== drag.order[i]))) retireDrag.current();
    if (!refitting) markMoving(true);
    previous.current = { mode: arr.mode, order: arr.order, maximized: props.maximized };
    if (props.maximized) {
      if (!old?.maximized) savedScroll.current = offset.current;
      scrollTo(0); return;
    }
    if (old?.maximized) scrollTo(savedScroll.current);
    if (press.current?.active) return;
    if (pendingReveal.current) {
      const id = pendingReveal.current;
      pendingReveal.current = null;
      reveal(id);
      return;
    }
    if (pendingScroll.current !== null) {
      const value = pendingScroll.current;
      pendingScroll.current = null;
      scrollTo(value);
      return;
    }
    const reset = old && old.mode !== arr.mode && !["left", "right"].includes(arr.mode);
    if (reset) held.current = null;
    const selected = props.active.filter(id => placement.rects.has(id));
    const single = !placement.focus && placement.levels[placement.levelIdx]?.shown === 1;
    // Preserve the reading line even when the active pane is already visible,
    // or is pinned outside the scrolling region. At one-pane zoom, keep the
    // targeted pane: switching composers can change height while a sliver of
    // the previous row still intersects the viewport.
    scrollTo(reset ? 0 : refitting && !single ? refitScroll(drawnLayout.current?.placement, placement, offset.current, selected)
      : scrollFor(placement, selected.length ? { kind: "active", ids: selected } : null, axisScroll(el, placement)));
    quietScroll.current = refitting ? offset.current : null;
  }, [placement, props.maximized]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || stale()) return;
    const old = drawnLayout.current;
    const focus = placement.focus;
    const beforeFocus = old?.placement.focus;
    const a = beforeFocus?.rect, b = focus?.rect;
    if (!refitting && (beforeFocus?.id !== focus?.id || a?.x !== b?.x || a?.y !== b?.y || a?.w !== b?.w || a?.h !== b?.h || old?.maximized !== props.maximized)) markFocusMoving(!resizing);
    drawnLayout.current = { placement, maximized: props.maximized };
    if (!rebaseGlide && old?.maximized === props.maximized) return;
    for (const animation of focusGlides.current.values()) animation.cancel();
    focusGlides.current.clear();
    if (!rebaseGlide || props.maximized || old?.maximized || resizing || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scrollX = el.scrollLeft, scrollY = el.scrollTop;
    for (const [id, start] of starts) {
      if (press.current?.active && press.current.id === id) continue;
      const slot = [...el.querySelectorAll<HTMLElement>(".pane-map-slot")].find(slot => slot.dataset.paneId === id);
      if (!slot || slot.style.display === "none") continue;
      const pinned = focus?.id === id;
      // Sticky insets are viewport coordinates; absolute slots use the new
      // scroller's content coordinates. Neither creates a fixed containing block.
      const from = pinned ? { marginLeft: `${start.x}px`, top: `${start.y}px` }
        : { left: `${start.x + scrollX}px`, top: `${start.y + scrollY}px` };
      const to = pinned ? { marginLeft: slot.style.marginLeft, top: slot.style.top }
        : { left: slot.style.left, top: slot.style.top };
      const animation = slot.animate([from, to], { duration: 220, easing: "ease" });
      focusGlides.current.set(id, animation);
      if (pinned) markFocusMoving(true);
      void animation.finished.then(() => {
        if (focusGlides.current.get(id) === animation) focusGlides.current.delete(id);
      }, () => {});
    }
  }, [placement, props.maximized]);

  useLayoutEffect(() => {
    if (resizing) {
      for (const animation of focusGlides.current.values()) animation.cancel();
      focusGlides.current.clear();
    }
  }, [resizing]);

  useLayoutEffect(() => {
    if (!placement.focus || props.maximized) setResizing(false);
  }, [!!placement.focus, props.maximized]);

  const zoom = (dir: 1 | -1 | 0, point: Point | null) => {
    const el = root.current;
    const { props: now, placement: before, area: size } = live.current;
    if (!el || now.maximized) return;
    const arr = now.arrangement;
    const nextArr = { ...arr, zoom: dir === 0 ? 1 : stepZoom(arr, size, dir, now.borrowed) };
    if (nextArr.zoom === arr.zoom) { if (dir === 0) scrollTo(0); return; }
    const next = place(nextArr, size, now.borrowed);
    const scroll = axisScroll(el, before);
    const regionPoint = point && { x: point.x - before.region.x, y: point.y - before.region.y };
    let pointerId: string | null = null;
    if (regionPoint) {
      const worldPoint = { x: regionPoint.x + (before.axis === "x" ? scroll : 0), y: regionPoint.y + (before.axis === "y" ? scroll : 0) };
      pointerId = [...before.rects].find(([, rect]) => inside(rect, worldPoint))?.[0] ?? null;
      if (!pointerId && before.levelIdx >= 0) {
        const level = before.levels[before.levelIdx];
        const line = Math.max(0, Math.floor((before.axis === "x" ? worldPoint.x : worldPoint.y) / ((before.axis === "x" ? level.w : level.h) + GAP)));
        pointerId = [...before.rects.keys()][before.axis === "x" ? line : line * level.cols] ?? null;
      }
    }
    const locked = point && held.current && Math.hypot(point.x - held.current.point.x, point.y - held.current.point.y) <= 4 ? held.current.id : null;
    const anchor = chooseAnchor(next, now.active, pointerId, locked, centreId(before, scroll));
    let at: number | null = null;
    if (anchor?.kind === "active") {
      const ids = [...before.rects.keys()].filter(id => anchor.ids.includes(id));
      const rect = before.rects.get(ids[Math.floor((ids.length - 1) / 2)]);
      const start = rect ? (before.axis === "x" ? rect.x : rect.y) - scroll : 0;
      const span = before.axis === "x" ? before.region.w : before.region.h;
      const anyVisible = ids.some(id => {
        const r = before.rects.get(id)!;
        const first = (before.axis === "x" ? r.x : r.y) - scroll;
        return first < span && first + (before.axis === "x" ? r.w : r.h) > 0;
      });
      at = rect && anyVisible ? start + (before.axis === "x" ? rect.w : rect.h) / 2 : span / 2;
      held.current = null;
    } else if (anchor?.kind === "pane") {
      at = regionPoint ? (before.axis === "x" ? regionPoint.x : regionPoint.y)
        : now.active.includes(anchor.id) ? null : (before.axis === "x" ? before.region.w : before.region.h) / 2;
      if (point && (anchor.id === locked || anchor.id === pointerId)) held.current = { id: anchor.id, point };
    }
    markMoving(true);
    pendingScroll.current = dir === 0 ? 0 : zoomScroll(next, anchor, at);
    live.current = { ...live.current, props: { ...now, arrangement: nextArr }, placement: next };
    now.onArrangement(nextArr);
  };

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      const { placement: p, props: now } = live.current;
      const box = el.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (now.maximized || (p.focus && inside(p.focus.rect, point))) return;
        pointer.current = point;
        const time = performance.now();
        if (time - wheelAcc.current.time > 400) wheelAcc.current.value = 0;
        wheelAcc.current.time = time;
        wheelAcc.current.value += Math.max(-0.7, Math.min(0.7, -event.deltaY * (event.deltaMode === 1 ? 16 : 1) * 0.0075));
        if (Math.abs(wheelAcc.current.value) >= 0.18) {
          const dir = wheelAcc.current.value > 0 ? 1 : -1;
          wheelAcc.current.value = 0;
          zoom(dir, point);
        }
      } else if (p.axis === "x" && event.deltaY && !event.defaultPrevented) {
        // A transcript keeps its vertical wheel; only empty space moves the map sideways.
        let target = event.target instanceof HTMLElement ? event.target : null;
        while (target && target !== el) {
          const style = getComputedStyle(target);
          if (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 1) return;
          target = target.parentElement;
        }
        event.preventDefault();
        el.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : 1);
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const p = placement;
  const full = props.maximized && props.mounted.includes(props.maximized);
  const rectFor = (id: string): PxRect | null => full ? (props.maximized === id ? { x: 0, y: 0, w: area.w, h: area.h } : null)
    : p.focus?.id === id ? p.focus.rect : p.rects.has(id) ? { ...p.rects.get(id)!, x: p.rects.get(id)!.x + p.region.x, y: p.rects.get(id)!.y + p.region.y } : null;
  const visible = new Set(visibleIds);
  const visibleKey = JSON.stringify(visibleIds);
  useLayoutEffect(() => { updateVisibility(); }, [placement, props.maximized, props.mounted]);
  useLayoutEffect(() => { props.onVisiblePanes?.(visibleIds); }, [visibleKey, props.onVisiblePanes]);
  const readScroll = () => {
    const el = root.current;
    if (!el) return;
    offset.current = axisScroll(el, live.current.placement);
    const quiet = quietScroll.current !== null && Math.abs(offset.current - quietScroll.current) < 1;
    quietScroll.current = null;
    if (!quiet) markMoving();
    updateVisibility();
  };
  return <div className={`pane-map-frame${resizing || dragging ? " adjusting" : ""}`}>
    <div ref={root} className={`pane-map${resizing || dragging ? " adjusting" : ""}${resizing ? " resizing" : ""}${refitting ? " refitting" : ""}`} data-pane-map-region data-axis={p.axis} data-level={p.levelIdx} data-many={!full && props.arrangement.order.length > 1 ? "" : undefined}
    style={{ overflowX: !full && p.axis === "x" ? "auto" : "hidden", overflowY: !full && p.axis === "y" ? "auto" : "hidden", scrollSnapType: dragging ? "none" : `${p.axis} mandatory` }}
    tabIndex={0} aria-label="Thread panes" onScroll={readScroll}
    onTransitionEnd={event => {
      // A delayed transitionend may extend motion, but cannot restart a map
      // whose final animated frame has already settled.
      if (event.target instanceof HTMLElement && event.target.classList.contains("pane-map-slot") && event.currentTarget.hasAttribute("data-moving")) markMoving();
    }}
    onPointerDownCapture={event => {
      const target = event.target instanceof Element ? event.target : null;
      const slot = target?.closest<HTMLElement>(".pane-map-slot");
      if (press.current || event.button !== 0 || event.metaKey || event.ctrlKey || full || !slot || !target?.closest(".pane-head") || target.closest("button, input, select, a, [contenteditable=true]") || target.closest(".pane-head")?.querySelector(".thread-name-input")) return;
      const id = slot.dataset.paneId;
      if (!id || !props.arrangement.order.includes(id)) return;
      const box = root.current!.getBoundingClientRect();
      const r = slot.getBoundingClientRect();
      press.current = { id, pid: event.pointerId, start: { x: event.clientX, y: event.clientY }, point: { x: event.clientX, y: event.clientY }, screen: { x: event.screenX, y: event.screenY }, rect: { x: r.x - box.x, y: r.y - box.y, w: r.width, h: r.height }, original: props.arrangement, order: props.arrangement.order, active: false };
    }}
    onPointerMove={event => { const r = event.currentTarget.getBoundingClientRect(); const point = { x: event.clientX - r.left, y: event.clientY - r.top }; pointer.current = p.focus && inside(p.focus.rect, point) ? null : point; }}
    onPointerLeave={() => { pointer.current = null; held.current = null; }}
    onKeyDown={event => {
      if (event.target !== root.current || editable(event.target) || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      if (["-", "=", "+", "0"].includes(event.key)) { event.preventDefault(); zoom(event.key === "0" ? 0 : event.key === "-" ? -1 : 1, pointer.current); return; }
      const el = root.current;
      if (!el || full || p.levelIdx < 0 || event.target !== el) return;
      const key = event.key;
      const back = key === "ArrowUp" || key === "ArrowLeft" || key === "PageUp";
      const forward = key === "ArrowDown" || key === "ArrowRight" || key === "PageDown";
      if (!back && !forward && key !== "Home" && key !== "End") return;
      event.preventDefault();
      const index = p.snaps.reduce((best, snap, i) => Math.abs(snap - axisScroll(el, p)) < Math.abs(p.snaps[best] - axisScroll(el, p)) ? i : best, 0);
      const page = key.startsWith("Page") ? (p.axis === "x" ? p.levels[p.levelIdx].cols : p.levels[p.levelIdx].rows) : 1;
      const at = key === "Home" ? 0 : key === "End" ? p.snaps.length - 1 : Math.max(0, Math.min(p.snaps.length - 1, index + (back ? -page : page)));
      scrollTo(p.snaps[at]);
    }}>
    <div className="pane-map-space" aria-hidden="true" style={{ width: full ? area.w : Math.max(area.w, p.world.w + p.region.x), height: full ? area.h : Math.max(area.h, p.world.h) }} />
    {!full && p.snaps.map(snap => <div key={`${p.axis}:${snap}`} className="pane-map-snap" aria-hidden="true" style={p.axis === "x" ? { left: snap, top: 0, width: 1, height: area.h } : { left: 0, top: snap, width: area.w, height: 1 }} />)}
    {props.mounted.map(id => {
      const pinned = !full && p.focus?.id === id;
      const r = rectFor(id);
      const onScreen = visible.has(id);
      const lifted = dragging?.id === id ? dragging : null;
      const style: CSSProperties = lifted ? { width: lifted.rect.w, height: lifted.rect.h, left: lifted.rect.x + lifted.point.x - lifted.start.x + (p.axis === "x" ? offset.current : 0), top: lifted.rect.y + lifted.point.y - lifted.start.y + (p.axis === "y" ? offset.current : 0) }
        : r ? { width: r.w, height: r.h, left: pinned ? 0 : r.x, top: pinned ? 0 : r.y, ...(pinned ? { marginLeft: r.x } : {}) } : { display: "none" };
      return <div key={id} className={`pane-map-slot${pinned ? " pinned" : ""}${lifted ? " dragging" : ""}`} data-pane-id={id} data-pinned={pinned && !lifted ? "" : undefined} style={style}><PaneContent id={id} x={r?.x ?? 0} y={r?.y ?? 0} w={r?.w ?? 0} h={r?.h ?? 0} placed={!!r} onScreen={onScreen} renderPane={props.renderPane} /></div>;
    })}
    </div>
    {!full && p.focus && <div className={`divider row pane-map-divider${resizing ? " held" : ""}`} role="separator" aria-label="Focus pane width" aria-orientation="vertical" tabIndex={0}
      style={{ left: p.region.x ? p.region.x - GAP : p.region.w, top: 0, width: GAP, height: area.h }}
      onDoubleClick={() => props.onArrangement({ ...props.arrangement, focusShare: 0.58 })}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation();
        const span = area.w - GAP;
        const sign = props.arrangement.mode === "right" ? -1 : 1;
        const share = props.arrangement.focusShare + sign * (event.key === "ArrowRight" ? 0.02 : -0.02);
        props.onArrangement({ ...props.arrangement, focusShare: Math.max(320 / span, Math.min((span - 260) / span, share)) });
      }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
      onPointerMove={event => { if (!resizing || !root.current) return; const x = event.clientX - root.current.getBoundingClientRect().left; const width = props.arrangement.mode === "right" ? area.w - x - GAP / 2 : x - GAP / 2; props.onArrangement({ ...props.arrangement, focusShare: Math.max(320, Math.min(area.w - GAP - 260, width)) / (area.w - GAP) }); }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); }}
      onPointerCancel={() => setResizing(false)} onLostPointerCapture={() => setResizing(false)} />}
  </div>;
}
