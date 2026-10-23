import type { ReactNode, Ref } from 'react';

/** The actual Threads box. Callers supply their transport-specific input and
 * attachment/menu state; geometry, modes and voice slots remain shared. */
export function ThreadComposerBox({ children, ref, stacked = false, withTray = false, adding = false }: { children: ReactNode; ref?: Ref<HTMLDivElement>; stacked?: boolean; withTray?: boolean; adding?: boolean }) {
  return <div className={`composer-box${stacked ? ' stacked' : ''}${withTray ? ' with-tray' : ''}${adding ? ' adding' : ''}`} ref={ref}>{children}</div>;
}
export function ComposerModeControls({ planOn, onPlan, tldr, onTldr }: { planOn: boolean; onPlan(): void; tldr: boolean; onTldr(): void }) {
  return <>
    {planOn && <button type="button" className="plan-chip" title="Plan is on: plans only, no changes. Click to turn it off." aria-label="Plan is on. Turn it off" onPointerDown={event => event.preventDefault()} onClick={onPlan}><span aria-hidden="true">◇</span><span className="plan-chip-label">Plan</span><span className="plan-chip-x" aria-hidden="true">✕</span></button>}
    <button type="button" className="tldr-pill" aria-pressed={tldr} aria-label="TL;DR mode" title={`TL;DR mode ${tldr ? 'on' : 'off'}: take a chill pill (⌘⇧T)`} onPointerDown={event => event.preventDefault()} onClick={onTldr}><span aria-hidden>TL;</span><span aria-hidden>DR</span></button>
  </>;
}
