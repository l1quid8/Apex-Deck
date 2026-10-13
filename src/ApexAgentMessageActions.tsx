import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { MessageQuote, MessageReaction } from './apexAgentModel.ts';
import { DeckIcon } from './DeckIcon.tsx';
import { messageTime } from './messageActions.ts';
import { ReadAloudAction } from './ReadAloudAction.tsx';
import './apex-agent-message-actions.css';

const REACTIONS: MessageReaction[] = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];
const retryIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const revertIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4v3.5h3.5M3.4 7.3A5 5 0 1 1 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;

/** Shared message controls. They sit under the bubble, the same way a thread's action row does. A reaction is shown as selected only after the host snapshot confirms it. */
export function ApexAgentMessageActions({ reactions = [], onToggleReaction, onReply, disabled = false, text, at, stateKey, onRetry, onRevert, mine = false }: {
  text?: string;
  at?: number;
  stateKey?: string;
  onRetry?: () => Promise<void>;
  onRevert?: () => void;
  reactions?: string[];
  onToggleReaction?: (emoji: MessageReaction, enabled: boolean) => Promise<void>;
  onReply?: () => void;
  disabled?: boolean;
  /** Your messages mirror a model's row: time and collapse sit on the left, reply on the right. */
  mine?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(() => !!stateKey && localStorage.getItem(`apex-agent-pin:${stateKey}`) === 'true');
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { root.current?.closest('article')?.classList.toggle('apex-agent-message-pinned', pinned); }, [pinned]);
  const reply = onReply && <button type="button" className="msg-action quote" onClick={onReply} disabled={disabled} aria-label="Reply to this message" title="Reply"><DeckIcon name="reply" size={18} /></button>;
  const copy = text !== undefined && <button type="button" className="msg-action copy" aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy'} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setFailure(''); setTimeout(() => setCopied(false), 1600); } catch { setFailure('Could not copy message.'); } }}>{copied ? <span className="copied">Copied</span> : <DeckIcon name="copy" size={16} />}</button>;
  const pin = stateKey && <button type="button" className="msg-action pin-action" aria-label={pinned ? 'Unpin message' : 'Pin message'} aria-pressed={pinned} title={pinned ? 'Unpin (this device)' : 'Pin (this device)'} onClick={(event) => { try { localStorage.setItem(`apex-agent-pin:${stateKey}`, String(!pinned)); setPinned(!pinned); event.currentTarget.closest('article')?.classList.toggle('apex-agent-message-pinned', !pinned); } catch { setFailure('Could not save pin.'); } }}><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4Z" fill={pinned ? 'currentColor' : 'none'}/><path d="M12 16v6" /></svg></button>;
  const retry = onRetry && <button type="button" className="msg-action retry" disabled={disabled || pending} aria-label="Retry answer" title="Request another answer; history and files are preserved" onClick={async () => { setPending(true); try { await onRetry(); setFailure(''); } catch (error) { setFailure(String(error)); } finally { setPending(false); } }}>{retryIcon}</button>;
  const revert = onRevert && <button type="button" className="msg-action revert" disabled={disabled} aria-label="Revert to composer" title="Restore message to composer; history and files are preserved" onClick={onRevert}>{revertIcon}</button>;
  // Like a thread's row: the chevron reveals or hides the extra actions, never the message text.
  const pointsLeft = mine === expanded;
  const disclosure = <button type="button" className="msg-action action-disclosure" aria-label={expanded ? 'Hide message actions' : 'Show message actions'} aria-expanded={expanded} title={expanded ? 'Hide message actions' : 'Show message actions'} onClick={() => setExpanded(!expanded)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={pointsLeft ? 'M15 6 9 12l6 6' : 'm9 6 6 6-6 6'} /></svg></button>;
  const readAloud = text !== undefined && text.trim() !== '' && <ReadAloudAction key="read-aloud" text={text} />;
  const stamp = at !== undefined && <time className="message-time" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{messageTime(at)}</time>;
  const primary = [reply, copy, readAloud, pin].filter(Boolean) as ReactNode[];
  const extra = [retry, revert].filter(Boolean) as ReactNode[];
  const ordered = (items: ReactNode[]) => mine ? [...items].reverse() : items;
  return <div ref={root} className={`apex-agent-message-actions message-actions collapsed-actions${open ? ' held' : ''}`} aria-label="Message actions">
    {mine && stamp}
    {mine && disclosure}
    {mine && expanded && <span className="message-action-items">{ordered(extra)}</span>}
    <span className="message-primary-actions">{ordered(primary)}</span>
    {!mine && expanded && <span className="message-action-items">{extra}</span>}
    {!mine && disclosure}
    {!mine && stamp}
    {onToggleReaction && <div className="apex-agent-reactions" aria-label="Reactions">
      <button type="button" className="msg-action apex-agent-reaction-picker" aria-label="Add reaction" title="React" disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)}>☺</button>
      {open && <div className="apex-agent-reaction-options" role="group" aria-label="Choose reaction">{REACTIONS.map((emoji) => <button type="button" key={emoji} className="msg-action apex-agent-reaction" aria-label={`React ${emoji}`} aria-pressed={reactions.includes(emoji)} disabled={disabled} onClick={() => { setOpen(false); void onToggleReaction(emoji, !reactions.includes(emoji)); }}>{emoji}</button>)}</div>}
      {reactions.map((emoji) => <button type="button" key={emoji} className="msg-action apex-agent-reaction-selected" aria-label={`Remove reaction ${emoji}`} aria-pressed="true" disabled={disabled} onClick={() => { void onToggleReaction(emoji as MessageReaction, false); }}>{emoji}</button>)}
    </div>}
    {failure && <span role="alert">{failure}</span>}
  </div>;
}

/** Quotes carry only bounded messages. They are context, not trusted instruction or chat history. */
export function ApexAgentReplyQuote({ quotes, onClear, onRemove }: { quotes: MessageQuote[]; onClear: () => void; onRemove?: (index: number) => void }) {
  if (!quotes.length) return null;
  const clearOne = (index: number) => { if (onRemove) onRemove(index); else onClear(); };
  return <aside className="apex-agent-reply-quote" aria-label={quotes.length === 1 ? 'Quoted message' : 'Quoted messages'}>
    <div><small>{quotes.length === 1 ? `Replying to ${quotes[0].author}` : `Replying to ${quotes.length} messages`}</small><button type="button" aria-label="Remove quoted messages" onClick={onClear}>×</button></div>
    {quotes.map((quote, index) => {
      const bounded = quote.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 360);
      return <div key={`${quote.messageId}:${index}`}>
        {quotes.length > 1 && <small>{quote.author}</small>}
        <blockquote>{bounded || '(empty message)'}</blockquote>
        {quotes.length > 1 && <button type="button" aria-label={`Remove quote ${index + 1}`} onClick={() => clearOne(index)}>×</button>}
      </div>;
    })}
  </aside>;
}
