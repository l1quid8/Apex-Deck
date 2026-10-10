import { useEffect, useRef, useState } from 'react';
import type { BrowserInput, BrowserView, PersonalLane } from './personalAssistant.ts';
import './personal-browser.css';

const KEYS: { key: 'Enter' | 'Tab' | 'Backspace'; label: string }[] = [{ key: 'Enter', label: 'Enter' }, { key: 'Tab', label: 'Tab' }, { key: 'Backspace', label: 'Backspace' }];

/** The assistant's browser: a picture of the page, and take-over to click and type in it. */
export function PersonalBrowser({ lane, onClose }: { lane: PersonalLane; onClose: () => void }) {
  const [view, setView] = useState<BrowserView | null>(null);
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Keeps the address the person is editing from being overwritten by the refresh.
  const editingAddress = useRef(false);
  const laneRef = useRef(lane);
  laneRef.current = lane;

  const apply = (next: BrowserView) => {
    setView(next);
    if (!editingAddress.current) setAddress(next.url);
  };

  const run = async (work: () => Promise<BrowserView | undefined>) => {
    setBusy(true);
    setError('');
    try {
      const next = await work();
      if (next) apply(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => laneRef.current.browserView?.().then((next) => { if (next) apply(next); }).catch(() => undefined);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, []);

  const takenOver = !!view?.takenOver;
  const send = async (input: BrowserInput) => laneRef.current.browserInput?.(input);

  /** A click lands where the person pointed, scaled from the picture on screen to the page's size. */
  const click = (event: { clientX: number; clientY: number; currentTarget: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } }) => {
    if (!view || !takenOver || busy) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - box.left) * view.width) / box.width);
    const y = Math.round(((event.clientY - box.top) * view.height) / box.height);
    void run(() => send({ kind: 'click', x, y }));
  };

  const close = () => {
    void (async () => {
      if (takenOver) await laneRef.current.browserTakeOver?.(false).catch(() => undefined);
      onClose();
    })();
  };

  return (
    <div className="personal-browser" role="dialog" aria-label="Assistant browser">
      <div className="personal-browser-head">
        <strong>{view?.title || 'Browser'}</strong>
        <span className={`personal-browser-state${takenOver ? ' is-taken' : ''}`}>{takenOver ? 'You have it' : 'Assistant is browsing'}</span>
        <button type="button" className="personal-browser-close" onClick={close}>Close</button>
      </div>
      <form className="personal-browser-bar" onSubmit={(event) => {
        event.preventDefault();
        const url = address.trim();
        editingAddress.current = false;
        if (url && takenOver) void run(() => send({ kind: 'navigate', url }));
      }}>
        <button type="button" disabled={busy || !takenOver} onClick={() => void run(() => send({ kind: 'back' }))}>Back</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await refresh(); return undefined; })}>Reload</button>
        <input aria-label="Address" value={address} disabled={!takenOver} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={(event) => setAddress(event.target.value)} />
      </form>
      <div className="personal-browser-toggle">
        <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => laneRef.current.browserTakeOver?.(!takenOver))}>
          {takenOver ? 'Hand back to assistant' : 'Take over'}
        </button>
        {!takenOver && <p className="personal-browser-hint">Take over to click and type, for example to sign in. The assistant waits while you have it.</p>}
      </div>
      {error && <p role="alert" className="personal-browser-alert">{error}</p>}
      {view ? (
        <div className="personal-browser-page">
          <img
            className={takenOver ? 'is-taken' : ''}
            src={`data:image/jpeg;base64,${view.image}`}
            alt={view.title || 'Page in the assistant browser'}
            draggable={false}
            onClick={click}
            onWheel={(event) => { if (takenOver && !busy) void run(() => send({ kind: 'scroll', deltaY: Math.round(event.deltaY) })); }}
          />
        </div>
      ) : <p className="personal-browser-hint">Loading the page…</p>}
      {takenOver && (
        <div className="personal-browser-keys">
          <form onSubmit={(event) => {
            event.preventDefault();
            const text = typed;
            if (!text) return;
            setTyped('');
            void run(() => send({ kind: 'type', text }));
          }}>
            <input aria-label="Type on the page" value={typed} onChange={(event) => setTyped(event.target.value)} />
            <button type="submit" disabled={busy || !typed}>Type</button>
          </form>
          <div>
            {KEYS.map((item) => <button type="button" key={item.key} disabled={busy} onClick={() => void run(() => send({ kind: 'key', key: item.key }))}>{item.label}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}
