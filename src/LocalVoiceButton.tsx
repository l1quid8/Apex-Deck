import { useEffect, useRef, useState } from 'react';
import './personal-call.css';

/** Separate from native dictation/read-aloud: this is direct local audio dialogue. */
export function LocalVoiceButton() {
  const api = window.apexDeck?.moshi;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('Preparing local voice…');
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => () => { if (pending.current) void api?.stop().catch(() => {}); }, [api]);
  useEffect(() => {
    if (!open || !api) return;
    let live = true;
    const timer = setInterval(() => { void api.status().then(state => {
      if (live && state.message) setMessage(state.message);
    }).catch(() => {}); }, 500);
    return () => { live = false; clearInterval(timer); };
  }, [open, api]);
  if (!api) return null;
  const start = async () => {
    if (pending.current) return;
    setOpen(true); setError(''); setMessage('Preparing local voice…'); pending.current = true;
    try { await api.open(); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; }
  };
  const cancel = () => { setMessage('Stopping local voice…'); void api.stop().then(() => setOpen(false)).catch(cause => setError(String(cause))); };
  return <>
    <button type="button" className="icon" aria-label="Local voice (Moshi)" title="Local voice (Moshi) · Experimental" onClick={() => void start()}>🎙</button>
    {open && <div className="personal-call" role="dialog" aria-modal="true" aria-label="Starting local voice">
      <div className="personal-call-head"><strong>Local voice · Moshi</strong></div>
      <p>Runs on this Mac. No terminal needed.</p>
      <p role="status" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{message}</p>
      {error && <p role="alert" className="personal-call-alert">{error}</p>}
      <div className="personal-call-controls">{error && <button type="button" onClick={() => void start()}>Try again</button>}<button type="button" onClick={cancel}>{error ? 'Close' : 'Cancel'}</button></div>
    </div>}
  </>;
}
