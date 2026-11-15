// The quick menu's icon controls: one small cell per setting, whose icon shows
// the current choice and moves to the next one on click.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Access, Speed } from './types';

/** How long after the last click a cycled choice saves. */
export const CYCLE_SETTLE_MS = 450;

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** A cell that steps through `options`: click for the next, Shift-click or the left arrow for the previous. */
export function CycleButton<T extends string>({ label, options, value, onChange, icon, className, disabled, hint }: {
  label: string;
  options: { value: T; text: string; title?: string }[];
  value: string;
  onChange: (value: T) => void;
  icon: (value: string) => ReactNode;
  className?: string;
  disabled?: boolean;
  /** Longer help, added to the tooltip. */
  hint?: string;
}) {
  // Clicks step the icon at once; the choice saves once clicking stops, so passing
  // through Ask and Edit on the way to Full never saves them.
  const [pending, setPending] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ pending, onChange });
  latest.current = { pending, onChange };
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { pending: next, onChange: save } = latest.current;
    if (next !== null) { setPending(null); save(next); }
  };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); const { pending: next, onChange: save } = latest.current; if (next !== null) save(next); } }, []);
  const shown = pending ?? value;
  const index = Math.max(0, options.findIndex(o => o.value === shown));
  const current = options[index];
  const step = (by: number) => {
    if (options.length < 2) return;
    // From the latest choice, not the last render, so quick repeated clicks each move one step.
    const from = Math.max(0, options.findIndex(o => o.value === (latest.current.pending ?? value)));
    const next = options[(from + by + options.length) % options.length].value;
    setPending(next);
    latest.current = { pending: next, onChange };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, CYCLE_SETTLE_MS);
  };
  const tip = [`${label}: ${current?.text ?? ''}`, current?.title, hint, options.length > 1 ? 'Click for next · Shift-click for previous' : ''].filter(Boolean).join('\n');
  return <button type="button" className={className ? `quick-cell ${className}` : 'quick-cell'} disabled={disabled || options.length < 2}
    aria-label={`${label}: ${current?.text ?? ''}`} title={tip} data-value={current?.value ?? ''} onBlur={flush}
    onClick={event => step(event.shiftKey ? -1 : 1)}
    onKeyDown={event => {
      const by = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
      if (by) { event.preventDefault(); step(by); }
    }}>
    <span className="quick-cell-icon" aria-hidden="true">{icon(current?.value ?? '')}</span>
    <span className="quick-cell-label">{current?.text}</span>
  </button>;
}

/** Bars that fill up to the chosen reasoning level. Step 0 is the tool's default. */
export function ReasoningBars({ steps, index }: { steps: number; index: number }) {
  return <span className="quick-bars">
    {Array.from({ length: steps }, (_, i) => <span key={i} className={i <= index ? 'on' : undefined} style={{ height: `${6 + i * (10 / Math.max(1, steps - 1))}px` }} />)}
  </span>;
}

/** A gauge whose needle points left for Default, up for Standard and right for Fast. */
export function SpeedGauge({ value }: { value: Speed | '' | string }) {
  const angle = value === 'fast' ? 62 : value === 'standard' ? 0 : -62;
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    <path d="M3.5 17a8.5 8.5 0 1 1 17 0" />
    <path d="M12 4.5v1.5M5 10l1.2.8M19 10l-1.2.8" />
    <path className="quick-needle" d="M12 17V9.5" style={{ transform: `rotate(${angle}deg)` } as CSSProperties} />
    <circle cx="12" cy="17" r="1.4" fill="currentColor" />
  </svg>;
}

/** Eye for Read-only, a question for Ask, a pencil for Edit and an open lock for Full. */
export function AccessIcon({ value }: { value: Access | string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}>
    {value === 'read' && <><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>}
    {value === 'ask' && <><path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4a8 8 0 1 1 15.3-3.9z" /><path d="M10.2 9.6a2 2 0 1 1 2.8 1.8c-.6.3-1 .8-1 1.4" /><path d="M12 15.6h.01" /></>}
    {value === 'edits' && <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13 7l4 4" /></>}
    {value === 'full' && <><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7" /></>}
    {value === 'talk' && <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4a8 8 0 1 1 15.3-3.9z" />}
  </svg>;
}

export function ResetIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></svg>;
}

export function CompactIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l6.5-6.5" /><path d="M3.5 20.5L10 14" /></svg>;
}

const RING = 2 * Math.PI * 9.5;

/** A ring filled to `level` (0 to 1) of what is left, with a small glyph inside. Unknown draws an empty ring. */
export function UsageRing({ level, glyph, low }: { level: number | null; glyph: 'context' | 'clock' | 'calendar' | 'money'; low?: boolean }) {
  const shown = level === null ? 0 : Math.max(0, Math.min(1, level));
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className={low ? 'quick-ring low' : 'quick-ring'}>
    <circle cx="12" cy="12" r="9.5" className="quick-ring-track" strokeWidth="2" />
    {level !== null && <circle cx="12" cy="12" r="9.5" className="quick-ring-fill" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${shown * RING} ${RING}`} transform="rotate(-90 12 12)" />}
    <g className="quick-ring-glyph" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {glyph === 'context' && <path d="M9 9.5h6M9 12h6M9 14.5h4" />}
      {glyph === 'clock' && <path d="M12 8v4l2.5 1.5" />}
      {glyph === 'calendar' && <><rect x="8.5" y="9" width="7" height="6.5" rx="1" /><path d="M8.5 11.3h7" /></>}
      {glyph === 'money' && <path d="M14 9.5h-2.8a1.4 1.4 0 0 0 0 2.8h1.6a1.4 1.4 0 0 1 0 2.8H10M12 8v1.5M12 15.1v1.5" />}
    </g>
  </svg>;
}

/** Small arrow and stack icons for the token line. */
export function TokenIcon({ kind }: { kind: 'in' | 'out' | 'cached' | 'turns' }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'in' && <><path d="M12 4v14" /><path d="M6 12l6 6 6-6" /></>}
    {kind === 'out' && <><path d="M12 20V6" /><path d="M6 12l6-6 6 6" /></>}
    {kind === 'cached' && <><ellipse cx="12" cy="6" rx="7" ry="2.5" /><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" /><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></>}
    {kind === 'turns' && <path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.3A8 8 0 1 1 20 12z" />}
  </svg>;
}
