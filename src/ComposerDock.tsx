import { useLayoutEffect, useRef, type ReactNode } from 'react';

// Learn from a loaded room's complete composer. Keep it across hiding,
// unmounting and width changes for this window.
let restHeight = Infinity;

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
    let last = -1;
    const measure = () => {
      const composer = el.querySelector('.composer');
      const multi = !!composer?.classList.contains('multi-composer');
      // Both surfaces use the single composer's canonical resting viewport.
      // A short multi editor must not teach a smaller rest and re-tile panes.
      el.style.minHeight = multi && Number.isFinite(restHeight) ? `${restHeight}px` : '';
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      if (!composer) { if (last !== 0) report.current?.(0); last = 0; return; }
      // The new-thread tray disappears on the first Send. Learn the complete
      // resting composer without that temporary row and its parent's gap.
      const extra = [...composer.querySelectorAll<HTMLElement>('[data-dock-extra]')].reduce((height, row) => {
        const rowHeight = row.getBoundingClientRect().height;
        const gap = row.parentElement ? parseFloat(getComputedStyle(row.parentElement).rowGap) || 0 : 0;
        return height + (rowHeight > 0 ? rowHeight + gap : 0);
      }, 0);
      if (!multi && composer.hasAttribute('data-room-ready')) restHeight = Math.min(restHeight, box.height - extra);
      const borrowed = Number.isFinite(restHeight) ? Math.max(0, Math.round(box.height - restHeight)) : 0;
      if (borrowed !== last) { last = borrowed; report.current?.(borrowed); }
      const map = el.parentElement?.querySelector('[data-pane-map-region]');
      if (map) el.style.setProperty('--quick-add-max', Math.min(560, Math.max(260, map.clientHeight * .78), Math.max(0, box.top - 12)) + 'px');
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-room-ready'] });
    measure();
    return () => { observer.disconnect(); mutation.disconnect(); };
  }, [!!target]);
  return <section ref={root} className="composer-dock thread-chat" aria-label="Thread composer" hidden={!target}>
    <button type="button" className="composer-dock-target" onClick={() => target && onReveal?.(target.paneId)}>
      To <i className={`dot ${target?.status ?? 'idle'}`} aria-label={target?.status ?? 'idle'} />
      <strong>{target?.title}</strong><span>{target?.project}{target?.project ? ' · ' : ''}{target?.agents ? `${target.agents} ${target.agents === 1 ? 'agent' : 'agents'}` : 'No agents yet'}</span>
    </button>
    <div ref={slotRef} className="composer-dock-slot" />
    {children}
  </section>;
}
