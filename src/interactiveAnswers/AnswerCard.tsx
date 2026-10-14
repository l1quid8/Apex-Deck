import { Fragment, useId } from "react";

import type { InputValues } from "./contract.ts";
import { evaluate, formatValue, inputText, resolveInputs, resultLine } from "./comparison.ts";
import type { ComparisonCard } from "./schema.ts";
import { snapshotText } from "./share.ts";
import "./answer-card.css";

export interface AnswerCardProps {
  card: ComparisonCard;
  /** Its version in the thread, from 1. */
  version: number;
  /** The bot whose reply it is, by display name. */
  author: string;
  /** The settings to show; anything missing or out of range shows its default. */
  values: InputValues | null;
  /** A setting changed. Without it the card is read-only. */
  onChange?: (values: InputValues) => void;
  /** Put a snapshot of these settings in the message box. Without it there's no Discuss button. */
  onDiscuss?: (snapshot: string) => void;
  /** Open a source link the way the chat opens links. */
  onOpen: (target: string) => void;
  /** Saving news for under the buttons. */
  status?: string;
}

/** A comparison card in a finished reply: its settings, the options side by side, the result, and where the numbers came from. */
export function AnswerCard({ card, version, author, values, onChange, onDiscuss, onOpen, status }: AnswerCardProps) {
  const group = useId();
  const ev = evaluate(card, values);
  const [headline, ...details] = card.rows;
  const set = (id: string, value: number | string) => onChange?.({ ...ev.inputs, [id]: value });
  return (
    <section className="answer-card" aria-label={card.title}>
      <header className="answer-card-head">
        <span className="answer-eyebrow">Interactive comparison · v{version} · {author}</span>
        <h3>{card.title}</h3>
        {card.summary && <p className="answer-summary">{card.summary}</p>}
      </header>
      {card.inputs.length > 0 && (
        <div className="answer-inputs">
          {card.inputs.map((input) =>
            input.type === "range" ? (
              <label key={input.id} className="answer-range">
                <span>
                  {input.label} <output>{inputText(input, ev.inputs[input.id])}</output>
                </span>
                <input type="range" min={input.min} max={input.max} step={input.step} value={ev.inputs[input.id]} disabled={!onChange} onChange={(e) => set(input.id, Number(e.target.value))} />
              </label>
            ) : (
              <fieldset key={input.id} className="answer-choice" disabled={!onChange}>
                <legend>{input.label}</legend>
                <div className="answer-segments">
                  {input.options.map((option) => (
                    <label key={option.id} className={ev.inputs[input.id] === option.id ? "on" : undefined}>
                      <input type="radio" name={`${group}-${input.id}`} value={option.id} checked={ev.inputs[input.id] === option.id} onChange={() => set(input.id, option.id)} />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ),
          )}
        </div>
      )}
      <div className="answer-options">
        {card.options.map((option, i) => {
          const result = ev.options[i];
          const best = ev.best === option.id;
          return (
            <article key={option.id} className={`answer-option${best ? " best" : ""}${result.out.length ? " out" : ""}`}>
              <div className="answer-option-top">
                <h4>{option.label}</h4>
                {best && <span className="answer-best">Best fit</span>}
              </div>
              <div className="answer-headline">
                <strong>{formatValue(option.values[headline.id], headline.unit)}</strong>
                <span>{headline.label}</span>
              </div>
              <p className="answer-fit">{result.out.length ? result.out.join(" · ") : result.rank ? `Ranked #${result.rank}` : "Fits these settings"}</p>
              {details.length > 0 && (
                <dl>
                  {details.map((row) => (
                    <Fragment key={row.id}>
                      <dt>{row.label}</dt>
                      <dd>{formatValue(option.values[row.id], row.unit)}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {option.note && <p className="answer-note">{option.note}</p>}
            </article>
          );
        })}
      </div>
      <p className="answer-result" aria-live="polite">{resultLine(card, ev)}</p>
      {(card.assumptions.length > 0 || card.sources.length > 0) && (
        <details className="answer-more">
          <summary>Assumptions and sources</summary>
          {card.assumptions.length > 0 && <ul>{card.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul>}
          {card.sources.length > 0 && (
            <ul className="answer-sources">
              {card.sources.map((source, i) => (
                <li key={i}>
                  <a href={source.url} onClick={(e) => { e.preventDefault(); onOpen(source.url); }}>{source.label}</a>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {onChange && (
        <footer className="answer-foot">
          <button type="button" className="ghost small" onClick={() => onChange(resolveInputs(card, null))}>Reset</button>
          <span className="answer-hint">{status ?? "Saved in this thread. Bots see these settings only when you discuss them."}</span>
          {onDiscuss && <button type="button" className="primary small" onClick={() => onDiscuss(snapshotText(card, ev.inputs, version, author))}>Discuss these settings</button>}
        </footer>
      )}
    </section>
  );
}

/** Where a card will be while its reply is still being written: no controls until the whole card is there. */
export function PreparingCard({ author }: { author: string }) {
  return (
    <section className="answer-card preparing" aria-busy="true">
      <span className="answer-eyebrow">{author} is writing</span>
      <p aria-live="polite">Preparing interactive answer…</p>
      <div className="answer-skeleton" />
      <div className="answer-skeleton short" />
      <p className="answer-hint">Controls appear when the complete card is ready.</p>
    </section>
  );
}

/** A block that can't be drawn as a card: why, with its data tucked away. */
export function CardFallback({ reason, source, hideSource = false }: { reason: string; source: string; hideSource?: boolean }) {
  const bounded = !hideSource && source.length <= 131_072 && new TextEncoder().encode(source).byteLength <= 131_072;
  return (
    <section className="answer-card broken">
      <span className="answer-eyebrow">Interactive answer</span>
      <p>This interactive answer can't be shown. {reason}</p>
      {bounded && <details className="answer-more">
        <summary>Show the card's data</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>}
    </section>
  );
}
