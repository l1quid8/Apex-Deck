import React, { useEffect, useState, useRef } from 'react';
import type { RunnerSnapshot } from './types.ts';
import { runnerView } from './viewModel.ts';

export interface RunnerDrawerProps {
  snapshot: RunnerSnapshot | null;
  hostNowOffsetMs: number; // host now - client now
  onAction: (action: 'pause' | 'resume' | 'end' | 'dismiss' | 'update_limits', limits?: any) => void;
  onReviewChanges: () => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  platform: 'desktop' | 'phone';
}

export function RunnerDrawer({ snapshot, hostNowOffsetMs, onAction, onReviewChanges, composerRef, platform }: RunnerDrawerProps) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now() + hostNowOffsetMs);
  const containerRef = useRef<HTMLDivElement>(null);

  // Countdown tick every second when scheduled with nextRunAt
  useEffect(() => {
    if (!snapshot?.nextRunAt) return;
    const id = setInterval(() => setNowMs(Date.now() + hostNowOffsetMs), 1000);
    return () => clearInterval(id);
  }, [snapshot?.nextRunAt, hostNowOffsetMs]);

  // Also update nowMs when snapshot changes
  useEffect(() => {
    setNowMs(Date.now() + hostNowOffsetMs);
  }, [snapshot, hostNowOffsetMs]);

  // Collapse on composer typing
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const onInput = () => {
      if (open) setOpen(false);
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [open, composerRef]);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const view = runnerView(snapshot, nowMs);
  if (!snapshot || !view) return null;

  const isFinished = snapshot.phase === 'completed' || snapshot.phase === 'ended';
  const needsYou = view.needsYou;
  const limitHit = view.limitHit;

  // Slim line content
  const statusDotClass = needsYou ? 'runner-dot needs' : limitHit ? 'runner-dot limit' : view.running ? 'runner-dot running' : 'runner-dot paused';
  const typeLabel = snapshot.kind === 'goal' ? 'Goal' : 'Loop';
  const objectiveShort = snapshot.objective ?? snapshot.prompt ?? '';
  const truncated = objectiveShort.length > 80 ? objectiveShort.slice(0, 80) + '…' : objectiveShort;

  return (
    <div ref={containerRef} className={`runner-drawer-container ${platform} ${open ? 'open' : 'closed'} ${needsYou ? 'needs-you' : ''}`}>
      {/* Slim line inside top border of composer */}
      <div
        className="runner-strip"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls="runner-details"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
        data-testid="runner-strip"
      >
        <span className={statusDotClass} aria-hidden>●</span>
        <span className="runner-type">{typeLabel}</span>
        <span className="runner-metric" data-testid="runner-metric">{view.metric || view.stateLabel}</span>
        <span className="runner-objective-short" title={objectiveShort}>{truncated}</span>
        <span className="runner-spacer" />
        {isFinished ? (
          <>
            <button className="runner-action secondary" onClick={e => { e.stopPropagation(); onReviewChanges(); }} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Review changes</button>
            <button className="runner-action secondary" onClick={e => { e.stopPropagation(); onAction('dismiss'); }} aria-label="Dismiss" style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>×</button>
          </>
        ) : (
          <>
            {view.paused || needsYou ? (
              <button className="runner-action primary" onClick={e => { e.stopPropagation(); onAction('resume'); }} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Resume</button>
            ) : (
              <button className="runner-action primary" onClick={e => { e.stopPropagation(); onAction('pause'); }} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Pause</button>
            )}
            <button className="runner-action danger" onClick={e => { e.stopPropagation(); onAction('end'); }} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>End</button>
          </>
        )}
        <span className="runner-chevron" aria-hidden>{open ? '▾' : '▴'}</span>
      </div>

      {open && (
        <div id="runner-details" className="runner-details" role="region" aria-live="polite">
          <div className="runner-details-section">
            <h4 className="runner-details-title">Objective</h4>
            <p className="runner-full-objective">{snapshot.objective ?? snapshot.prompt}</p>
          </div>

          {snapshot.checkpoint?.criteria && snapshot.checkpoint.criteria.length > 0 && (
            <div className="runner-details-section">
              <h4>Checklist</h4>
              <ul className="runner-criteria">
                {snapshot.checkpoint.criteria.map(c => (
                  <li key={c.id} className={`criteria-${c.status}`}>{c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '○'} {c.id}</li>
                ))}
              </ul>
            </div>
          )}

          {snapshot.kind === 'loop' && (
            <div className="runner-details-section">
              <h4>Loop</h4>
              <p>Every {snapshot.intervalSeconds ? `${Math.floor(snapshot.intervalSeconds/60)}m` : '?'} · Next: {view.countdown ?? '—'} · {snapshot.usage.turns}/{snapshot.limits.maxTurns ?? 30} runs</p>
            </div>
          )}

          <div className="runner-details-section">
            <h4>Progress</h4>
            <p>{snapshot.checkpoint?.done ?? ''}</p>
            {snapshot.checkpoint?.next && <p><em>Next:</em> {snapshot.checkpoint.next}</p>}
            {snapshot.checkpoint?.blocker && <p className="runner-blocker"><em>Blocked:</em> {snapshot.checkpoint.blocker}</p>}
          </div>

          <div className="runner-details-section">
            <h4>Workers</h4>
            <p>Working: {snapshot.workers.join(', ')} {snapshot.checker ? `· Checker: ${snapshot.checker}` : ''}</p>
          </div>

          <div className="runner-details-section">
            <h4>Limits & usage</h4>
            <p>{snapshot.usage.turns}/{snapshot.limits.maxTurns ?? 30} turns · {snapshot.usage.invocations}/{snapshot.limits.maxInvocations ?? 120} invocations · {snapshot.limits.maxCostMicros ? `$${(snapshot.usage.costMicros ?? 0)/1e6}/${snapshot.limits.maxCostMicros ? snapshot.limits.maxCostMicros/1e6 : ''}` : 'Cost unavailable'} · {Math.floor((nowMs - snapshot.startedAt)/60000)}m elapsed</p>
          </div>

          <div className="runner-details-actions">
            {isFinished ? (
              <>
                <button onClick={() => onReviewChanges()} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Review changes</button>
                <button onClick={() => onAction('dismiss')} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Dismiss</button>
              </>
            ) : (
              <>
                {view.paused ? (
                  <button onClick={() => onAction('resume')} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Resume</button>
                ) : (
                  <button onClick={() => onAction('pause')} style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>Pause</button>
                )}
                <button onClick={() => onAction('end')} className="danger" style={{ minHeight: platform === 'phone' ? '44px' : '24px' }}>End {typeLabel}</button>
              </>
            )}
          </div>

          <div className="runner-live-region" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {view.stateLabel} {view.metric}
          </div>
        </div>
      )}
    </div>
  );
}
