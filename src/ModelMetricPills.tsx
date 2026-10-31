// Benchmark pills after "model · level" on an agent card, with a hover box
// comparing every reasoning level the bot offers. Approved design:
// mockups/model-metrics-v4.html.
import { useEffect, useId, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { ModelMetrics as Metrics } from "./types";
import { WHAT, ageText, borrowedNote, columns, credits, money, pillParts, refreshNote, rowText, tier, type MetricKey } from "./modelMetrics.ts";

const EPOCH = "https://epoch.ai/benchmarks";
const OPENROUTER = "https://openrouter.ai/models";
/** Scores refresh daily, so two days means refreshing has been failing. */
const STALE_AFTER = 2 * 86_400;

type Props = {
  backend: Backend;
  model: string;
  efforts: string[];
  current: string | null;
  local: boolean;
  /** Opens a web address outside Deck. */
  open: (url: string) => void;
};

type Loaded = { key: string; metrics: Metrics | null; error: string | null };

export function ModelMetricPills({ backend, model, efforts, current, local, open }: Props) {
  const key = JSON.stringify([model, efforts, current, local]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pinned, setPinned] = useState(false);
  const [focus, setFocus] = useState<MetricKey | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const cardId = useId();

  useEffect(() => {
    let live = true;
    backend.modelMetrics(model, efforts, current, local)
      .then(metrics => { if (live) setLoaded({ key, metrics, error: null }); })
      .catch(error => { if (live) setLoaded({ key, metrics: null, error: error instanceof Error ? error.message : String(error) }); });
    return () => { live = false; };
    // `key` stands for model, efforts, current and local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key]);

  // A pinned box closes on Esc or a click anywhere else.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPinned(false); };
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPinned(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [pinned]);

  if (!loaded || loaded.key !== key) return null;
  if (loaded.error) return <span className="mm-none" title={`Couldn’t fetch benchmarks: ${loaded.error}`}>Benchmarks unavailable</span>;
  const metrics = loaded.metrics;
  if (!metrics) return <span className="mm-none">No public benchmarks</span>;

  const link = (url: string, text: string) => <a href={url} onClick={(e) => { e.preventDefault(); open(url); }}>{text}</a>;
  const now = Date.now() / 1000;
  const shown: MetricKey = focus ?? (metrics.pills.arc ? "arc" : "code");
  const top = metrics.top[shown];
  const topText = top ? ` Top today: ${shown === "eci" ? top.value.toFixed(1) : `${Math.round(top.value)}%`} (${top.model}).` : "";
  const hot = (col: MetricKey) => (shown === col ? "hot" : undefined);
  const levels = !(metrics.rows.length === 1 && metrics.rows[0].effort === "default");
  const cols = columns(metrics);
  const owners = credits(metrics);
  const notes = [borrowedNote(metrics), refreshNote(metrics)].filter((n): n is string => Boolean(n));

  const pill = (key: MetricKey, label: string, value: string, extra: { dot?: string | null; at?: string | null; borrowed?: boolean } = {}) => (
    <button type="button" className={`mm-pill${(focus ?? (pinned ? shown : null)) === key ? " hot" : ""}`} key={key} aria-describedby={cardId} aria-expanded={pinned}
      aria-label={`${WHAT[key][0]}: ${value}${extra.at ? `, tested at ${extra.at}` : ""}`}
      onMouseEnter={() => setFocus(key)} onFocus={() => setFocus(key)} onClick={() => setPinned(p => !p)}>
      {extra.dot && <span className={`mm-dot ${extra.dot}`} aria-hidden="true" />}
      <span className="mm-k">{label}</span><span>{value}</span>
      {extra.at && <span className={`mm-at${extra.borrowed ? "" : " same"}`}>· {extra.at}</span>}
    </button>
  );
  const arc = metrics.pills.arc;
  const code = metrics.pills.code;
  const codeParts = pillParts("code", code, metrics.current);
  const arcParts = pillParts("arc", arc, metrics.current);

  return (
    <div ref={wrap} className={`mm-metrics${pinned ? " pinned" : ""}`} onMouseLeave={() => setFocus(null)}>
      {arc && pill("arc", "Puzzles", arcParts.value, { dot: tier("arc", arc.value, metrics.top), at: arcParts.at, borrowed: arcParts.borrowed })}
      {pill("code", "Code", codeParts.value, { dot: code ? tier("code", code.value, metrics.top) : null, at: codeParts.at, borrowed: codeParts.borrowed })}
      {metrics.eci != null && pill("eci", "Overall", String(Math.round(metrics.eci)), { dot: tier("eci", metrics.eci, metrics.top) })}
      {(metrics.price || metrics.local_note) && pill("price", "$", metrics.price ? money(metrics.price) : "free · local")}
      <div className="mm-card" id={cardId} role="tooltip">
        <div className="mm-card-body">
          <p className="mm-what"><b>{WHAT[shown][0]}</b> <span>{WHAT[shown][1]}{topText}</span></p>
          {levels && <table aria-label={`${metrics.name} scores at each reasoning level`}>
            <thead><tr><th>Reasoning</th>{cols.map(c => <th key={c.id} data-col={c.id} className={hot(c.id)}>{c.label}</th>)}</tr></thead>
            <tbody>{metrics.rows.map(row => (
              <tr key={row.effort} className={row.effort === metrics.current ? "current" : undefined}>
                <td>{row.effort}</td>
                {row.state === "not_measured"
                  ? <td className="gap" colSpan={cols.length}>{rowText(row.state)}</td>
                  : cols.map(c => {
                    const value = row.scores[c.id];
                    if (value == null) return <td key={c.id} data-col={c.id} className={["gap", hot(c.id)].filter(Boolean).join(" ")}>—</td>;
                    const best = metrics.best[c.id] === value;
                    return <td key={c.id} data-col={c.id} className={[best && "best", hot(c.id)].filter(Boolean).join(" ") || undefined}>{value.toFixed(1)}%{best && <span className="mm-sr"> (best level)</span>}</td>;
                  })}
              </tr>
            ))}</tbody>
          </table>}
          <div className="mm-model">
            {metrics.eci != null && <span className={hot("eci")}>Overall <b>{metrics.eci.toFixed(1)}</b>{metrics.top.eci && ` · top today ${metrics.top.eci.value.toFixed(1)}`}</span>}
            <span className={hot("price")}>{metrics.price ? <>Price <b>{money(metrics.price)}</b> per 1M in / out</> : metrics.local_note ? <>Price <b>free</b> · runs on this Mac</> : <>Price <b>—</b> not listed on OpenRouter</>}</span>
          </div>
          {metrics.local_note && <p className="mm-caveat">The Overall score is for the full public model. Your local copy is likely shrunk to fit the Mac and may score lower.{arc ? "" : " No puzzle score was published for it."}</p>}
          {notes.map(note => <p className="mm-caveat" key={note}>{note}</p>)}
          <div className="mm-foot">
            <span>{levels ? `${metrics.name} · ★ best level on each test` : metrics.name}</span>
            <span className={`mm-src${metrics.fetched_at && now - metrics.fetched_at >= STALE_AFTER ? " stale" : ""}`}>
              Data: {link(EPOCH, "Epoch AI")} (CC BY){owners && ` · ${owners} via Epoch AI`} · prices: {link(OPENROUTER, "OpenRouter")} · {ageText(metrics.fetched_at, now)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
