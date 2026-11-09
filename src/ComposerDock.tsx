import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function ComposerDock({ target, slotRef, onBorrowed, onReveal, children }: {
  target: { paneId: string; title: string; project: string; status?: string; agents?: number } | null;
  slotRef: (el: HTMLDivElement | null) => void;
  onBorrowed?: (px: number) => void;
  onReveal?: (id: string) => void;
  children?: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const report = useRef(onBorrowed);
  report.current = onBorrowed;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !target) { report.current?.(0); return; }
    let width = -1, rest = Infinity, last = -1;
    const measure = () => {
      const box = el.getBoundingClientRect();
      if (!el.querySelector('.composer')) { rest = Infinity; width = -1; if (last !== 0) report.current?.(0); last = 0; return; }
      if (width !== box.width) { width = box.width; rest = Infinity; }
      rest = Math.min(rest, box.height);
      const borrowed = Math.round(box.height - rest);
      if (borrowed !== last) { last = borrowed; report.current?.(borrowed); }
      const map = el.parentElement?.querySelector('[data-pane-map-region]');
      if (map) el.style.setProperty('--quick-add-max', Math.min(560, Math.max(260, map.clientHeight * .78), Math.max(0, box.top - 12)) + 'px');
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true, subtree: true });
    measure();
    return () => { observer.disconnect(); mutation.disconnect(); };
  }, [!!target]);
  return <section ref={root} className="composer-dock thread-chat" aria-label="Thread composer" hidden={!target}>
    <button type="button" className="composer-dock-target" onClick={() => target && onReveal?.(target.paneId)}>
      To <i className={`dot ${target?.status ?? 'idle'}`} aria-label={target?.status ?? 'idle'} />
      <strong>{target?.title}</strong><span>{target?.project}{target?.project ? ' · ' : ''}{target?.agents ?? 0} agents</span>
    </button>
    <div ref={slotRef} className="composer-dock-slot" />
    {children}
  </section>;
}
