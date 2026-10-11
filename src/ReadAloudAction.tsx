import { useEffect, useRef, useState } from 'react';
import { getSpeech } from './personalSpeech.ts';

/** Read one assistant message with the device's best available English voice. */
export function ReadAloudAction({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const speech = useRef<ReturnType<typeof getSpeech> | null>(null);
  useEffect(() => () => { if (speaking) speech.current?.cancelSpeak(); }, [speaking]);
  if (!text.trim()) return null;

  return <button type="button" className="msg-action read-aloud" aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'} aria-pressed={speaking} title={speaking ? 'Stop' : 'Read aloud'} onClick={() => {
    speech.current ??= getSpeech();
    if (speaking) { speech.current.cancelSpeak(); setSpeaking(false); return; }
    setSpeaking(true);
    void speech.current.speak(text).finally(() => setSpeaking(false));
  }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{speaking ? <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /> : <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>}</svg></button>;
}
