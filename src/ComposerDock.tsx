import type { ReactNode } from 'react';

export function ComposerDock({ target, slotRef, children }: {
  target: { paneId: string; title: string; project: string } | null;
  slotRef: (el: HTMLDivElement | null) => void;
  children?: ReactNode;
}) {
  return <section className="composer-dock thread-chat" aria-label="Thread composer" hidden={!target}>
    <div className="composer-dock-target">To: <strong>{target?.title}</strong><span>{target?.project}</span></div>
    <div ref={slotRef} className="composer-dock-slot" />
    {children}
  </section>;
}
