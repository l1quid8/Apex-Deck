// The row under each message, as on the desktop (ChatPane's messageActions): the same buttons,
// icons, labels, order and class names, so the desktop stylesheet draws it the same.
// A bot's row: Quote, Copy, Read aloud, Pin, then › for Retry and Fork, then the time.
// Your row mirrors it: the time, ‹ for Fork and Revert, then Pin, Copy and Reply.
// Touch screens show it all the time; a mouse shows it while the message is hovered.

import type { Message, RevertPlan } from "../types";
import { DeckIcon } from "../DeckIcon";
import { ReadAloudAction } from "../ReadAloudAction";
import { actionChevron, messageTime } from "../messageActions";
import { goBackTitle, type GoBack, type RevertScope } from "../revertConfirm";

const forkIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v5a3 3 0 0 0 3 3 3 3 0 0 1 3 3v1M11 2v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="5" cy="2.5" r="1.2" fill="currentColor"/><circle cx="11" cy="2.5" r="1.2" fill="currentColor"/></svg>;
const retryIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const revertIcon = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4v3.5h3.5M3.4 7.3A5 5 0 1 1 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;

export function MessageActions(props: {
  message: Message;
  /** The bot's name, for Quote's label. */
  who: string;
  /** What the bubble shows, which Read aloud reads. */
  shown: string;
  expanded: boolean; onToggle(): void;
  copied: boolean; onCopy(): void;
  onQuote(): void;
  pinned: boolean; pinning: boolean; onPin(): void;
  /** A bot is working: Retry and Revert wait until it stops. */
  busy: boolean; onGoBack(): void;
  /** Absent where a thread can't be forked. */
  onFork?: () => void;
  /** The Retry or Revert question for this message is open. */
  asking: boolean;
}) {
  const { message } = props;
  const mine = message.speaker.kind === "human";
  const goBackKind: GoBack = mine ? "revert" : "retry";
  const goBackLabel = goBackKind === "retry" ? "Retry" : "Revert to here";
  const goBackHint = props.busy ? "Stop the bots first" : goBackKind === "retry" ? "Retry: delete this reply and after, put files back, ask again" : "Revert: delete everything after, put files back, your text returns to the box";
  const pinLabel = `${props.pinned ? "Unpin" : "Pin"} ${mine ? "your message" : "response"}`;
  const disclosure = <button key="more" type="button" className="msg-action action-disclosure" data-message-more={message.seq}
    title={props.expanded ? "Hide message actions" : "Show message actions"}
    aria-label={props.expanded ? "Hide message actions" : "Show message actions"} aria-expanded={props.expanded}
    onClick={props.onToggle}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={actionChevron(message.speaker.kind, props.expanded) === "‹" ? "M15 6 9 12l6 6" : "m9 6 6 6-6 6"} />
    </svg>
  </button>;
  const stamp = message.at === undefined ? null
    : <time key="time" className="message-time" dateTime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString()}>{messageTime(message.at)}</time>;
  const primary = [
    <button key="quote" type="button" className="msg-action quote" title="Quote" onClick={props.onQuote}
      aria-label={mine ? "Quote your message" : `Quote response from ${props.who}`}>
      <DeckIcon name="reply" size={18} />
    </button>,
    <button key="copy" type="button" className="msg-action copy" title="Copy" aria-label={props.copied ? "Copied" : "Copy message"} onClick={props.onCopy}>
      {props.copied ? <span className="copied">Copied</span> : <DeckIcon name="copy" size={16} />}
    </button>,
    !mine && <ReadAloudAction key="read-aloud" text={props.shown} />,
    <button key="pin" type="button" className="msg-action pin-action" title={pinLabel} aria-label={pinLabel} aria-pressed={props.pinned} disabled={props.pinning} onClick={props.onPin}>
      <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4Z" fill={props.pinned ? "currentColor" : "none"}/><path d="M12 16v6" /></svg>
    </button>,
  ];
  const extra = [
    <button key="goback" type="button" className={`msg-action ${goBackKind}`} disabled={props.busy} aria-label={goBackLabel} title={goBackHint} onClick={props.onGoBack}>{goBackKind === "retry" ? retryIcon : revertIcon}</button>,
    props.onFork && <button key="fork" type="button" className="msg-action fork" aria-label="Fork from here" title="Fork from here" onClick={props.onFork}>{forkIcon}</button>,
  ];
  const ordered = <T,>(items: T[]) => mine ? [...items].reverse() : items;
  const held = props.expanded || props.asking;
  return <span className={`message-actions collapsed-actions${held ? " held" : ""}`}>
    {mine && stamp}
    {mine && disclosure}
    {mine && props.expanded && <span className="message-action-items">{ordered(extra)}</span>}
    <span className="message-primary-actions">{ordered(primary)}</span>
    {!mine && props.expanded && <span className="message-action-items">{extra}</span>}
    {!mine && disclosure}
    {!mine && stamp}
  </span>;
}

/** The Retry/Revert question waiting on a message, as on the desktop. */
export type GoingBack = { paneId: string; kind: GoBack; message: Message; plan: RevertPlan; scope: RevertScope; ticked: string[] };

/** The Retry/Revert question under a message's actions: the desktop's words and choices, in the flow of the chat. */
export function GoBackAsk(props: {
  going: GoingBack;
  /** The bot whose reply it is, for Retry's first line. */
  who: string;
  /** A bot's name, for who ran a command that can't be undone. */
  nameOf(id: string): string;
  onScope(scope: RevertScope): void;
  onTick(path: string): void;
  onAnswer(always: boolean): void;
  onCancel(): void;
}) {
  const { kind, plan, scope, ticked } = props.going;
  const showFiles = plan.available && plan.files.length > 0 && !(kind === "revert" && scope === "chat");
  return <div className="steer-pop goback-pop ph-goback" role="dialog" aria-label={kind === "retry" ? "Retry?" : "Revert?"}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); } }}>
    <strong>{goBackTitle(kind, plan, props.who)}</strong>
    {plan.note && <p>{plan.note}</p>}
    {kind === "revert" && plan.available && plan.files.length > 0 && <div className="goback-scope" role="radiogroup" aria-label="What goes back">
      {([["both", "Files and chat"], ["chat", "Chat only"], ["files", "Files only"]] as const).map(([value, label]) =>
        <label key={value}><input type="radio" name={`goback-${props.going.paneId}`} checked={scope === value} onChange={() => props.onScope(value)} />{label}</label>)}
    </div>}
    {showFiles && <ul className="goback-files">
      {plan.files.map((file) => <li key={file.path}>
        <label title={file.conflict ? "Also changed outside this thread's turns. Untick to keep it as it is now." : undefined}>
          <input type="checkbox" checked={ticked.includes(file.path)} onChange={() => props.onTick(file.path)} />
          <code>{file.path}</code>
          {file.delete && <em>deleted</em>}
          {file.conflict && <em className="warn">also changed elsewhere</em>}
        </label>
      </li>)}
    </ul>}
    {showFiles && plan.skipped.length > 0 && <p>Too big to save, so left as they are: {plan.skipped.join(", ")}</p>}
    {plan.effects.length > 0 && <p className="goback-effects">Can't be undone: {plan.effects.map((effect, i) => <span key={i}><code>{effect.command}</code> ({props.nameOf(effect.by)}){i < plan.effects.length - 1 ? ", " : ""}</span>)}</p>}
    {kind === "revert" && scope !== "files" && <p>Your message goes back in the box, unsent.</p>}
    <div className="row">
      <button type="button" className="primary small" autoFocus onClick={() => props.onAnswer(false)}>Allow once</button>
      <button type="button" className="ghost small" onClick={() => props.onAnswer(true)}>Allow always</button>
      <button type="button" className="link" onClick={props.onCancel}>Cancel</button>
    </div>
  </div>;
}
