import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Offer } from './questions';
import type { NextStep } from './types';
import './reply-next-steps.css';

/** How long the pointer rests on a suggestion before its prompt shows. */
const PREVIEW_MS = 320;

interface Preview { text: string; left: number; top: number; bottom: number }

/** Follow-ups belong to the offering agent's latest finished response. */
export function ReplyNextSteps({ offer, onStep }: { offer: Offer; onStep(step: NextStep, by: string): void }) {
  const [expanded, setExpanded] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  useEffect(() => () => clearTimeout(timer.current), []);
  // The preview is anchored where the suggestion was when it opened, so a
  // scroll or a layout change would leave it pointing at nothing. Hide it.
  useEffect(() => {
    if (!preview) return;
    const hide = () => setPreview(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', key, true);
    };
  }, [preview]);
  if (offer.pending || !offer.steps.length) return null;

  const hide = () => { clearTimeout(timer.current); setPreview(null); };
  const show = (step: NextStep, el: HTMLElement, delay: number) => {
    hide();
    // A suggestion whose label already is its prompt needs no preview.
    if (!step.prompt.trim() || step.prompt.trim() === step.label.trim()) return;
    const box = el.getBoundingClientRect();
    const open = () => setPreview({ text: step.prompt, left: box.left, top: box.top, bottom: box.bottom });
    if (delay) timer.current = setTimeout(open, delay); else open();
  };

  return <div className="reply-next-steps" onPointerLeave={hide}>
    <hr aria-hidden="true" />
    <div className="reply-next-steps-links" role="group" aria-label="Suggested next steps">
      <span id={`${id}-steps`} className="reply-next-steps-options" hidden={!expanded}>
        {expanded && offer.steps.map((step, i) => <Fragment key={i}>
          {i > 0 && <span className="reply-next-steps-dot" aria-hidden="true">·</span>}
          {/* A span, not a button: Chromium lays an inline button out as one
              atomic box, so its label could never continue across a line. */}
          <span className="reply-next-step" role="button" tabIndex={0} aria-describedby={`${id}-${i}`}
            onPointerEnter={event => show(step, event.currentTarget, PREVIEW_MS)}
            onClick={() => onStep(step, offer.by)}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onStep(step, offer.by);
            }}
            onFocus={event => show(step, event.currentTarget, 0)}
            onBlur={hide}>{step.label}</span>
          <span id={`${id}-${i}`} className="reply-next-steps-sr">{step.prompt}</span>
        </Fragment>)}
      </span>
      {!expanded && <span className="reply-next-steps-label">Next steps</span>}
      <button type="button" className="reply-next-steps-toggle" aria-controls={`${id}-steps`} aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} next steps`} onClick={() => setExpanded(!expanded)}>{expanded ? '‹' : '›'}</button>
    </div>
    {preview && <SuggestionPreview {...preview} />}
  </div>;
}

/** The prompt a suggestion sends: the rail's hover-card look, above the
 *  suggestion and kept inside the window. */
function SuggestionPreview({ text, left, top, bottom }: Preview) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    el.style.left = `${Math.round(Math.min(Math.max(8, left), Math.max(8, window.innerWidth - 8 - box.width)))}px`;
    const above = top - 8 - box.height;
    el.style.top = `${Math.round(above >= 8 ? above : Math.min(bottom + 8, window.innerHeight - 8 - box.height))}px`;
  });
  return createPortal(<div ref={ref} className="hover-card reply-next-steps-tip" role="tooltip" style={{ left, top: top - 8 }}>{text}</div>, document.body);
}
