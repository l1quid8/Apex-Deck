import { useEffect, useRef, useState } from 'react';
import type { BrowserInput, BrowserView, PersonalLane } from './personalAssistant.ts';
import './personal-browser.css';

const KEYS: { key: 'Enter' | 'Tab' | 'Backspace'; label: string }[] = [{ key: 'Enter', label: 'Enter' }, { key: 'Tab', label: 'Tab' }, { key: 'Backspace', label: 'Backspace' }];
export type BrowserPresentation = 'popup' | 'expanded';
export type PersonalBrowserProps = {
  lane: PersonalLane;
  onClose: () => void;
  presentation?: BrowserPresentation;
  onExpand?: () => void;
  onReturnToChat?: () => void;
  /** Hidden views keep their state, but do not poll the host. */
  active?: boolean;
};

/** A view of the existing host browser. Changing presentation never changes its session. */
export function PersonalBrowser({ lane, onClose, presentation = 'expanded', onExpand, onReturnToChat, active = true }: PersonalBrowserProps) {
  const [view, setView] = useState<BrowserView | null>(null);
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editingAddress = useRef(false);
  const laneRef = useRef(lane);
  laneRef.current = lane;
  const epoch = useRef(0);
  const requestVersion = useRef(0);
  const running = useRef(false);
  const ownerKey = JSON.stringify([lane.ref?.hostId ?? lane.assistant?.hostId ?? lane.hostName, lane.ref?.assistantId ?? lane.assistant?.id ?? lane.draftKey]);

  const apply = (next: BrowserView) => {
    setView(next);
    if (!editingAddress.current) setAddress(next.url);
  };

  const refresh = async () => {
    const current = laneRef.current;
    if (!active || current.offline || !current.browserView || running.current) return;
    const started = epoch.current, version = ++requestVersion.current;
    try {
      const next = await current.browserView();
      if (epoch.current === started && requestVersion.current === version) { apply(next); setError(''); }
    } catch (cause) {
      if (epoch.current === started && requestVersion.current === version) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    setView(null); setAddress(''); setTyped(''); setError('');
    editingAddress.current = false;
    running.current = false;
    setBusy(false);
    return () => { epoch.current++; };
  }, [ownerKey]);

  useEffect(() => {
    void refresh();
    if (!active || lane.offline) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => { clearInterval(timer); requestVersion.current++; };
  }, [ownerKey, lane.offline, active]);

  const run = async (work: (current: PersonalLane) => Promise<BrowserView | undefined>) => {
    const current = laneRef.current;
    if (!active || current.offline || running.current) return;
    const started = epoch.current;
    ++requestVersion.current;
    running.current = true;
    setBusy(true); setError('');
    try {
      const next = await work(current);
      if (epoch.current === started && next) apply(next);
    } catch (cause) {
      if (epoch.current === started) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === started) { running.current = false; setBusy(false); }
    }
  };

  const takenOver = !!view?.takenOver;
  const locked = busy || lane.offline || !active;
  const send = (input: BrowserInput) => run(current => current.browserInput?.(input) ?? Promise.resolve(undefined));
  const click = (event: { clientX: number; clientY: number; currentTarget: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } }) => {
    if (!view || !takenOver || locked) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const x = Math.max(0, Math.min(view.width - 1, Math.round(((event.clientX - box.left) * view.width) / box.width)));
    const y = Math.max(0, Math.min(view.height - 1, Math.round(((event.clientY - box.top) * view.height) / box.height)));
    void send({ kind: 'click', x, y });
  };

  return (
    <div className={`personal-browser personal-browser-${presentation}`} role="dialog" aria-label="Assistant browser" aria-modal="false">
      <div className="personal-browser-head">
        <strong>{view?.title || 'Browser'}</strong>
        <span className={`personal-browser-state${takenOver ? ' is-taken' : ''}`}>{lane.offline ? 'Offline' : view ? takenOver ? 'You have it' : 'Assistant has control' : 'Control not yet available'}</span>
        {presentation === 'popup' && onExpand && <button type="button" onClick={onExpand}>Expand browser</button>}
        {presentation === 'expanded' && onReturnToChat && <button type="button" onClick={onReturnToChat}>Return to chat</button>}
        <button type="button" className="personal-browser-close" onClick={onClose}>Close</button>
      </div>
      <p className="personal-browser-hint">Shared assistant profile on {lane.hostName}. Separate from your regular browser. Profile selection is not supported by this host.</p>
      <form className="personal-browser-bar" onSubmit={(event) => {
        event.preventDefault();
        const url = address.trim();
        editingAddress.current = false;
        if (url && takenOver && !locked) void send({ kind: 'navigate', url });
      }}>
        <button type="button" disabled={locked || !takenOver || !lane.browserInput} onClick={() => void send({ kind: 'back' })}>Back</button>
        <button type="button" disabled={locked || !lane.browserView} onClick={() => void refresh()}>{error ? 'Retry' : 'Reload'}</button>
        <input aria-label="Address" value={address} disabled={locked || !takenOver || !lane.browserInput} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={(event) => setAddress(event.target.value)} />
        <button type="submit" disabled={locked || !takenOver || !address.trim() || !lane.browserInput}>Go</button>
      </form>
      <div className="personal-browser-toggle">
        <button type="button" className="primary" disabled={locked || !view || !lane.browserTakeOver} onClick={() => void run(current => current.browserTakeOver?.(!takenOver) ?? Promise.resolve(undefined))}>
          {takenOver ? 'Hand back to assistant' : 'Take over'}
        </button>
        <p className="personal-browser-hint">{takenOver ? 'The assistant waits while you have control. Closing this view keeps you in control.' : 'Take over to click and type, for example to sign in. The assistant waits while you have it.'}</p>
      </div>
      {lane.offline && <p className="personal-browser-hint">Reconnect {lane.hostName} to view the page and use browser controls.</p>}
      {!lane.browserView && <p role="alert" className="personal-browser-alert">This host does not support the assistant browser.</p>}
      {error && <p role="alert" className="personal-browser-alert">{error}</p>}
      {view && !lane.offline ? (
        <div className="personal-browser-page">
          <img className={takenOver ? 'is-taken' : ''} src={`data:image/jpeg;base64,${view.image}`} alt={view.title || 'Page in the assistant browser'} draggable={false} onClick={click}
            onWheel={(event) => { if (takenOver && !locked) void send({ kind: 'scroll', deltaY: Math.round(event.deltaY) }); }} />
        </div>
      ) : !error && !lane.offline && lane.browserView ? <p className="personal-browser-hint">Loading the page…</p> : null}
      {takenOver && (
        <div className="personal-browser-keys">
          <form onSubmit={(event) => {
            event.preventDefault();
            const text = typed;
            if (!text || locked || !lane.browserInput) return;
            const started = epoch.current;
            void run(async current => { const next = await current.browserInput!({ kind: 'type', text }); if (epoch.current === started) setTyped(''); return next; });
          }}>
            <input aria-label="Type on the page" value={typed} disabled={locked || !lane.browserInput} onChange={(event) => setTyped(event.target.value)} />
            <button type="submit" disabled={locked || !typed || !lane.browserInput}>Type</button>
          </form>
          <div>{KEYS.map((item) => <button type="button" key={item.key} disabled={locked || !lane.browserInput} onClick={() => void send({ kind: 'key', key: item.key })}>{item.label}</button>)}</div>
        </div>
      )}
    </div>
  );
}
