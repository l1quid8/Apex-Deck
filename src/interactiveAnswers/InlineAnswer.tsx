import { useState } from "react";
import type { InlineCard } from "./schema.ts";
import "./inline-answer.css";

type OfKind<K> = Extract<InlineCard, { kind: K }>;
const format = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 });

function Stages({ stages }: OfKind<"flowchart">) {
  const [selected, select] = useState(0);
  return <>
    <ol className="inline-stages">{stages.map((stage, i) =>
      <li key={i}><button type="button" aria-pressed={i === selected} onClick={() => select(i)}>
        <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span> {stage.label}
      </button></li>
    )}</ol>
    <p role="status">{stages[selected].detail}</p>
  </>;
}

function Calculator({ input, factor, outputUnit }: OfKind<"scale">) {
  const [amount, setAmount] = useState(input.default);
  return <>
    <label>{input.label} · {format.format(amount)} {input.unit}
      <input type="range" min={input.min} max={input.max} step={input.step} value={amount}
        onChange={e => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n) && n >= input.min && n <= input.max) setAmount(n); }} />
    </label>
    <output>{format.format(amount * factor)} {outputUnit}</output>
  </>;
}

function Bars({ points, unit }: OfKind<"bars">) {
  const [delta, setDelta] = useState(false);
  const values = points.map(p => p.value - (delta ? points[0].value : 0));
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = high - low || 1;
  return <>
    <div className="inline-modes">
      <button type="button" aria-pressed={!delta} onClick={() => setDelta(false)}>Values</button>
      <button type="button" aria-pressed={delta} onClick={() => setDelta(true)}>Change from {points[0].label}</button>
    </div>
    <ul className="inline-bars" aria-live="polite">{points.map((point, i) => <li key={i}>
      <span>{point.label}</span><strong>{delta && values[i] > 0 ? "+" : ""}{format.format(values[i])} {unit}</strong>
      <div className="inline-track" aria-hidden="true">
        <i style={{ left: ((Math.min(0, values[i]) - low) / span * 100) + "%", width: (Math.abs(values[i]) / span * 100) + "%" }} />
        <b style={{ left: (-low / span * 100) + "%" }} />
      </div>
    </li>)}</ul>
  </>;
}

export function InlineAnswer({ card }: { card: InlineCard }) {
  return <section className="generated-answer inline-answer" data-no-swipe aria-label={card.title}>
    <h3>{card.title}</h3><p>{card.summary}</p>
    {card.kind === "flowchart" ? <Stages {...card} /> : card.kind === "scale" ? <Calculator {...card} /> : <Bars {...card} />}
  </section>;
}
