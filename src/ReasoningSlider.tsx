import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { effortLabel } from './models';

const label = (value: string) => value === 'xhigh' ? 'xHigh' : value ? effortLabel(value) : 'Default';

export function ReasoningSlider({ efforts, value, onCommit, title = "Reasoning" }: {
  title?: string;
  efforts: string[];
  value: string;
  onCommit: (value: string) => void;
}) {
  const steps = ['', ...efforts];
  const selected = Math.max(0, steps.indexOf(value));
  const [position, setPosition] = useState(selected);
  const raw = useRef(selected);
  const input = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ pointer: number; start: number } | null>(null);
  const update = (next: number) => { raw.current = next; setPosition(next); };
  useEffect(() => { if (!gesture.current) update(selected); }, [selected]);
  const stop = Math.max(0, Math.min(steps.length - 1, Math.round(position)));
  const pointerPosition = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    return Math.max(0, Math.min(efforts.length, (clientX - rect.left - 7) / Math.max(1, rect.width - 14) * efforts.length));
  };
  const commit = (next = Math.round(raw.current)) => {
    update(next);
    onCommit(steps[next] ?? '');
  };
  const cancel = () => {
    if (!gesture.current) return;
    update(gesture.current.start);
    gesture.current = null;
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (gesture.current?.pointer === event.pointerId && input.current) update(pointerPosition(input.current, event.clientX));
    };
    const release = (event: PointerEvent) => {
      if (gesture.current?.pointer !== event.pointerId || !input.current) return;
      gesture.current = null;
      commit(Math.round(pointerPosition(input.current, event.clientX)));
      if (input.current.hasPointerCapture(event.pointerId)) input.current.releasePointerCapture(event.pointerId);
    };
    const abort = (event: PointerEvent) => { if (gesture.current?.pointer === event.pointerId) cancel(); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', abort);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', abort);
    };
  });
  return <div className="effort-slider">
    <div className="effort-heading">{title} <span className="effort-value">{efforts.length ? label(steps[stop]) : 'Not supported'}</span></div>
    <div className={`effort-control${gesture.current ? ' dragging' : ''}`} style={{ '--effort-position': `${efforts.length ? position / efforts.length * 100 : 0}%` } as CSSProperties}>
      <div className="effort-rail" aria-hidden="true"><div className="effort-fill" /><div className="effort-thumb" /></div>
      <input ref={input} type="range" aria-label="Reasoning" aria-valuetext={label(steps[stop])} min={0} max={efforts.length} step="any" value={position} disabled={!efforts.length}
        onChange={event => { if (gesture.current) update(Number(event.currentTarget.value)); }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          gesture.current = { pointer: event.pointerId, start: selected };
          event.currentTarget.setPointerCapture(event.pointerId);
          update(pointerPosition(event.currentTarget, event.clientX));
        }}
        onPointerCancel={cancel} onLostPointerCapture={cancel} onBlur={cancel}
        onKeyDown={event => {
          if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
          const current = Math.round(raw.current);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? efforts.length
            : ['ArrowRight', 'ArrowUp'].includes(event.key) ? Math.min(efforts.length, current + 1)
            : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? Math.max(0, current - 1) : null;
          if (next !== null) { event.preventDefault(); commit(next); }
        }} />
    </div>
    {!!efforts.length && <div className={`effort-ticks${steps.length > 5 ? ' compact' : ''}`}>
      {steps.map((s, i) => <button type="button" key={s || 'default'} className={i === stop ? 'on' : ''}
        style={{ left: `${i / efforts.length * 100}%` }} aria-label={`Reasoning: ${label(s)}`} aria-pressed={i === stop}
        onClick={() => commit(i)}><span>{label(s)}</span></button>)}
    </div>}
  </div>;
}
