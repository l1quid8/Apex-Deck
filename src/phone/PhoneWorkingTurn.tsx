import type { ReactNode } from 'react';
import { ChevronDown } from './icons';

/** The live-turn surface shared by phone threads and the assistant conversation. */
export function PhoneWorkingTurn({ name, doing, header, open, progressId, onToggle, time, stepCount = 0, asking = false, onStop, stopDisabled = false, children }: {
  name: string; doing: string; header: ReactNode; open: boolean; progressId: string;
  onToggle(): void; time?: string; stepCount?: number; asking?: boolean;
  onStop?: () => void; stopDisabled?: boolean; children?: ReactNode;
}) {
  return <section className={`ph-msg ph-live${open ? ' open' : ''}`} aria-busy="true">
    {header}
    <div className={`ph-working${asking ? ' asking' : ''}`}>
      <button type="button" className="ph-working-toggle" aria-expanded={open} aria-controls={progressId}
        aria-label={`${name}: ${doing.replace(/…$/, '')}. ${open ? 'Hide' : 'Show'} progress${stepCount > 0 ? `, ${stepCount === 1 ? '1 step' : `${stepCount} steps`}` : ''}`} onClick={onToggle}>
        <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="ph-grow ph-ellipsis" role="status">{doing}</span>
        {time !== undefined && <span className="ph-time">{time}</span>}
        <span className="ph-working-chevron" aria-hidden="true"><ChevronDown size={16} /></span>
      </button>
      {onStop && <button type="button" className="ph-stop" aria-label={`Stop ${name}`} disabled={stopDisabled} onClick={onStop}>Stop</button>}
    </div>
    {children}
  </section>;
}
