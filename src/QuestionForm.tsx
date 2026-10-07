// The form attached to the top of the composer: a bot's question while its
// turn is paused, or the next steps it suggests after a reply. Shared by
// the desktop chat and the phone.

import { useState } from "react";
import { answerText, askPick, askSend, askStart, askType, type AskMove, type FormView } from "./questions";
import type { NextStep } from "./types";

export interface QuestionFormProps {
  view: FormView;
  nameOf: (id: string) => string;
  colorOf?: (id: string) => string;
  /** The option the arrow keys have reached. */
  highlighted: number;
  /** A question folded to one line by Esc. The bot is still waiting. */
  collapsed: boolean;
  /** A short line shown in place of the form, such as "Answered on another device". */
  notice: string | null;
  onHighlight(index: number): void;
  onExpand(): void;
  onAnswer(request: string, answers: string[][] | null): void;
  onStep(step: NextStep, by: string): void;
  onDismiss(): void;
  phone?: boolean;
}

export function QuestionForm(props: QuestionFormProps) {
  const { view } = props;
  if (props.notice) return <div className="qform qform-notice" role="status">{props.notice}</div>;
  if (view.kind === "none") return null;
  if (view.kind === "pending") return <div className="qform qform-pending" aria-live="polite">next steps…</div>;
  if (view.kind === "steps") {
    return (
      <div className={`qform qform-steps${props.phone ? " phone" : ""}`} role="group" aria-label="Suggested next steps">
        <span className="qform-label">Next</span>
        <div className="qform-chips">
          {view.offer.steps.map((step, i) => (
            <button key={i} type="button" className={i === props.highlighted ? "on" : ""} title={step.prompt}
              onMouseEnter={() => props.onHighlight(i)} onClick={() => props.onStep(step, view.offer.by)}>
              {!props.phone && <kbd>{i + 1}</kbd>}{step.label}
            </button>
          ))}
        </div>
        <button type="button" className="qform-x" aria-label="Dismiss next steps" onClick={props.onDismiss}>✕</button>
      </div>
    );
  }
  const who = props.nameOf(view.ask.id);
  if (props.collapsed) {
    return <button type="button" className="qform qform-collapsed" onClick={props.onExpand}>{who} is waiting on you</button>;
  }
  return <Asking key={view.ask.request} {...props} view={view} who={who} />;
}

function Asking(props: QuestionFormProps & { view: Extract<FormView, { kind: "question" }>; who: string }) {
  const { ask, position, of } = props.view;
  const [ask_, setAsk] = useState(() => askStart(ask.questions));
  const [other, setOther] = useState("");
  const { step, answers } = ask_;
  const q = ask.questions[step];
  if (!q) return null;
  const last = step === ask.questions.length - 1;
  const chosen = answers[step] ?? [];
  // Keep the move; a finished ask goes to the bot.
  const take = (move: AskMove) => {
    if (move.state.step !== step) setOther("");
    setAsk(move.state);
    if (move.send) props.onAnswer(ask.request, move.send);
  };
  const pick = (label: string) => take(askPick(ask_, ask.questions, label));
  const typed = () => { take(askType(ask_, ask.questions, other)); if (q.multi_select) setOther(""); };
  const next = () => {
    if (!chosen.length) return;
    const send = askSend(ask_, ask.questions);
    if (send) props.onAnswer(ask.request, send);
    else { setOther(""); setAsk({ ...ask_, step: step + 1 }); }
  };
  return (
    <div className={`qform qform-ask${props.phone ? " phone" : ""}`} role="group" aria-label={`${props.who} asks`}>
      <div className="qform-head">
        <span className="qform-who" style={props.colorOf ? { color: props.colorOf(ask.id) } : undefined}>{props.who} asks</span>
        {of > 1 && <span className="qform-count">{position} of {of}</span>}
        {ask.questions.length > 1 && <span className="qform-count">Question {step + 1} of {ask.questions.length}</span>}
        <button type="button" className="qform-x" aria-label="Skip this question" title="Skip: the bot hears you skipped it" onClick={() => props.onAnswer(ask.request, null)}>✕</button>
      </div>
      {q.header && <div className="qform-tag">{q.header}</div>}
      <p className="qform-q">{q.question}</p>
      <ol className="qform-options">
        {q.options.map((option, i) => (
          <li key={option.label}>
            <button type="button" className={`${i === props.highlighted ? "on" : ""}${chosen.includes(option.label) ? " picked" : ""}`}
              aria-pressed={q.multi_select ? chosen.includes(option.label) : undefined}
              onMouseEnter={() => props.onHighlight(i)} onClick={() => pick(option.label)}>
              {q.multi_select ? <span className="qform-box" aria-hidden="true">{chosen.includes(option.label) ? "☑" : "☐"}</span> : <kbd>{props.phone ? "" : i + 1}</kbd>}
              <span className="qform-text">{option.label}</span>
              {option.description && <span className="qform-desc">{option.description}</span>}
            </button>
          </li>
        ))}
        <li className="qform-other">
          <input aria-label="Other answer" placeholder={q.options.length ? "Other…" : "Your answer…"} value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); typed(); } }} />
        </li>
      </ol>
      {(step > 0 || q.multi_select || chosen.length > 0) && (
        <div className="qform-foot">
          {step > 0 && <button type="button" className="ghost small" onClick={() => setAsk({ ...ask_, step: step - 1 })}>Back</button>}
          {q.multi_select && <button type="button" className="primary small" disabled={!chosen.length} onClick={next}>{last ? "Send" : "Next"}</button>}
          {chosen.length > 0 && <span className="qform-so-far">{answerText([chosen])}</span>}
        </div>
      )}
    </div>
  );
}
