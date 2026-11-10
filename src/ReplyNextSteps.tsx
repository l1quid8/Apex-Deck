import { useId, useState } from 'react';
import type { Offer } from './questions';
import type { NextStep } from './types';
import './reply-next-steps.css';

/** Follow-ups belong to the offering agent's latest finished response. */
export function ReplyNextSteps({ offer, onStep }: { offer: Offer; onStep(step: NextStep, by: string): void }) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  if (offer.pending || !offer.steps.length) return null;
  return <div className="reply-next-steps">
    <hr aria-hidden="true" />
    <div className="reply-next-steps-links" role="group" aria-label="Suggested next steps">
      <span id={id} className="reply-next-steps-options" hidden={!expanded}>
        {expanded && offer.steps.slice(0, -1).map((step, i) => <span className="reply-next-steps-item" key={i}>
          {i > 0 && <span className="reply-next-steps-dot" aria-hidden="true">·</span>}
          <span className="reply-next-steps-final">
            <button type="button" className="reply-next-step" title={step.prompt} onClick={() => onStep(step, offer.by)}>{step.label}</button>
          </span>
        </span>)}
      </span>
      <span className="reply-next-steps-item">
        {expanded && offer.steps.length > 1 && <span className="reply-next-steps-dot" aria-hidden="true">·</span>}
        <span className="reply-next-steps-final">
          {expanded ? <button id={`${id}-last`} type="button" className="reply-next-step" title={offer.steps[offer.steps.length - 1].prompt}
            onClick={() => onStep(offer.steps[offer.steps.length - 1], offer.by)}>{offer.steps[offer.steps.length - 1].label}</button>
            : <span id={`${id}-last`} className="reply-next-steps-label">Next steps</span>}
          {toggle()}
        </span>
      </span>
    </div>
  </div>;

  function toggle() {
    return <button key="toggle" type="button" className="reply-next-steps-toggle" aria-controls={`${id} ${id}-last`} aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} next steps`} onClick={() => setExpanded(!expanded)}>{expanded ? '‹' : '›'}</button>;
  }
}
