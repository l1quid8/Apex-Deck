import { useEffect, useRef, useState } from 'react';
import type { PersonalLane } from './personalAssistant.ts';
import { getSpeech, type Speech } from './personalSpeech.ts';
import './personal-call.css';

type Phase = 'ready' | 'listening' | 'thinking' | 'speaking';
const PHASE_LABEL: Record<Phase, string> = { ready: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };
/** Replies read aloud. Approvals are only pointed to, since the buttons live in the chat. */
const SPEAK_KINDS = ['chat', 'result', 'notice', 'helper'];
const APPROVAL_LINE = 'I need your approval in the chat.';

/** A voice call with the personal assistant. The conversation lives on the server, so ending the call changes nothing there. */
export function PersonalCall({ lane, onEnd, speech: injected }: { lane: PersonalLane; onEnd: () => void; speech?: Speech }) {
  const [speech] = useState<Speech>(() => injected ?? getSpeech());
  const [phase, setPhase] = useState<Phase>('ready');
  const [partial, setPartial] = useState('');
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  // Message ids already seen, so a reply is spoken once no matter how often the screen re-renders.
  const seen = useRef<Set<string>>(new Set());
  // Only replies after the call has sent something are spoken; older history stays silent.
  const awaiting = useRef(false);
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Bumped to drop queued speech on barge-in, mute or end.
  const generation = useRef(0);

  const idle = () => setPhase(pending.current > 0 ? 'speaking' : 'ready');

  const say = (text: string) => {
    if (muted) return;
    const mine = generation.current;
    pending.current += 1;
    setPhase('speaking');
    queue.current = queue.current
      .then(() => (mine === generation.current ? speech.speak(text) : undefined))
      .catch(() => undefined)
      .then(() => {
        pending.current -= 1;
        if (pending.current === 0) setPhase((current) => (current === 'speaking' ? 'ready' : current));
      });
  };

  // Runs on every render: anything new since the last render is checked once.
  useEffect(() => {
    const messages = lane.assistant?.messages ?? [];
    const fresh = messages.filter((item) => !seen.current.has(item.id));
    for (const item of messages) seen.current.add(item.id);
    if (!awaiting.current) return;
    for (const item of fresh) {
      if (item.role === 'assistant' && SPEAK_KINDS.includes(item.kind)) say(item.text);
      else if (item.role === 'system' && item.kind === 'approval') say(APPROVAL_LINE);
    }
  });

  // Ending the screen (however it happens) stops any speech still playing.
  useEffect(() => () => { generation.current += 1; speech.cancelSpeak(); }, []);

  const send = async (text: string) => {
    awaiting.current = true;
    setError('');
    setPhase('thinking');
    try {
      await lane.send(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      idle();
    }
  };

  const talk = async () => {
    generation.current += 1;
    speech.cancelSpeak();
    setError('');
    setPartial('');
    setPhase('listening');
    let text = '';
    try {
      text = (await speech.listen(setPartial)).trim();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      idle();
      return;
    }
    if (!text) { idle(); return; }
    await send(text);
  };

  const toggleMute = () => {
    if (!muted) { generation.current += 1; speech.cancelSpeak(); }
    setMuted(!muted);
  };

  const end = () => {
    generation.current += 1;
    speech.stop();
    speech.cancelSpeak();
    onEnd();
  };

  const offline = lane.offline;
  const replies = (lane.assistant?.messages ?? []).filter((item) => item.role === 'assistant');
  const lastReply = replies[replies.length - 1]?.text ?? '';
  const label = lane.assistant?.paused && phase === 'ready' ? 'Paused' : PHASE_LABEL[phase];

  return (
    <div className="personal-call" role="dialog" aria-label="Voice call">
      <div className="personal-call-head"><strong>{lane.name}</strong><span className="personal-call-muted">{lane.hostName}</span></div>
      <div className="personal-call-stage">
        <div className={`personal-call-orb is-${label.toLowerCase()}`} data-phase={phase} aria-live="polite"><span>{label}</span></div>
        {partial && <p className="personal-call-partial">{partial}</p>}
        {lastReply && <p className="personal-call-reply">{lastReply}</p>}
        {error && <p role="alert" className="personal-call-alert">{error}</p>}
      </div>
      {speech.canListen ? (
        <div className="personal-call-controls">
          {phase === 'listening'
            ? <button type="button" className="personal-call-talk" onClick={() => speech.stop()}>Done</button>
            : <button type="button" className="personal-call-talk" disabled={offline || phase === 'thinking'} onClick={() => void talk()}>Tap to talk</button>}
        </div>
      ) : (
        <form className="personal-call-fallback" onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text || offline) return;
          setDraft('');
          void send(text);
        }}>
          <input aria-label="Type instead" value={draft} placeholder="Voice isn't available here. Type instead." onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" disabled={offline || !draft.trim()}>Send</button>
        </form>
      )}
      <div className="personal-call-controls">
        <button type="button" aria-pressed={muted} onClick={toggleMute}>{muted ? 'Replies muted' : 'Mute replies'}</button>
        <button type="button" onClick={end}>End call</button>
      </div>
      <p className="personal-call-muted personal-call-note">Voice is turned into text on this device; only the text goes to your assistant.</p>
    </div>
  );
}
