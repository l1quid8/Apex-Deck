// Benchmark pills on agent cards: the words and numbers, kept apart from
// the component so they can be tested. The scores come from the daemon's
// daily Epoch AI download (crates/apex-adapters/src/model_metrics.rs).
import { isLocalHost } from "./previewAddress.ts";
import type { LevelState, ModelMetrics, ParticipantConfig, PillValue } from "./types";

/** The tests the daemon reads, in hover-table order. Ids and owners match `TESTS` in model_metrics.rs. */
export const TESTS = [
  { id: "arc", label: "Puzzles", owner: "ARC Prize" },
  { id: "code", label: "Code", owner: "Cognition" },
  { id: "deepswe", label: "DeepSWE", owner: "Datacurve" },
  { id: "cursor", label: "Cursor", owner: "Cursor" },
] as const;

export type MetricKey = (typeof TESTS)[number]["id"] | "eci" | "price";

/** What each pill means, shown at the top of the hover box. */
export const WHAT: Record<MetricKey, [string, string]> = {
  arc: ["Puzzles · ARC-AGI-2", "Fresh visual logic puzzles the model can't have memorised. % solved."],
  code: ["Code · FrontierCode (Cognition)", "Real software tasks, scored as an average of 5 runs. Each model was tested at one reasoning level only."],
  deepswe: ["DeepSWE (Datacurve)", "Long real-world coding tasks, % solved on the first try. Not yet run on these models."],
  cursor: ["CursorBench", "Real coding tasks done inside the Cursor editor. % solved. Few models tested."],
  eci: ["Overall · Epoch Capabilities Index", "Blends dozens of tests into one number. One score per model, not per level."],
  price: ["Price per 1M tokens", "Input / output, from OpenRouter. Same at every level, but higher levels write more tokens."],
};

/** Listed in apex-daemon's welcome when it can answer `model_metrics`. */
export const METRICS_CAPABILITY = "model_metrics_v1";

/** A model with no reasoning setting has one row under this name. */
const NO_LEVELS = "default";

const pct = (value: number) => `${Math.round(value)}%`;

/**
 * A pill's number and the level to name beside it. The Code test ran at one
 * level per model, so its pill always names that level; the others name a
 * level only when they borrow it because the bot's own was never tested.
 */
export function pillParts(test: string, pill: PillValue | undefined, current: string | null): { value: string; at: string | null; borrowed: boolean } {
  if (!pill) return { value: "none published", at: null, borrowed: false };
  const levels = pill.from_level !== NO_LEVELS;
  const borrowed = levels && pill.from_level !== current;
  return { value: pct(pill.value), at: levels && (borrowed || test === "code") ? pill.from_level : null, borrowed };
}

export function rowText(state: LevelState): string {
  return state === "not_measured" ? "not tested at this level" : "";
}

/** How old the downloaded scores are; `fetchedAt` and `now` in Unix seconds. */
export function ageText(fetchedAt: number, now: number): string {
  if (!fetchedAt) return "never downloaded";
  const seconds = Math.max(0, now - fetchedAt);
  if (seconds < 3600) return "updated just now";
  if (seconds < 86_400) return `updated ${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86_400);
  return days === 1 ? "1 day old" : `${days} days old`;
}

const scored = (metrics: ModelMetrics, test: string) => metrics.rows.some(row => row.scores[test] != null);

/** The groups whose numbers this card shows, for the "via Epoch AI" credit. */
export function credits(metrics: ModelMetrics): string {
  return TESTS.filter(t => scored(metrics, t.id)).map(t => t.owner).join(", ");
}

/** The hover table's columns: a test with no score for this model is left out, except DeepSWE, which waits for its first run. */
export function columns(metrics: ModelMetrics): (typeof TESTS)[number][] {
  return TESTS.filter(t => t.id === "deepswe" || scored(metrics, t.id));
}

/** The pill's dot: how close a score is to the best one today. Null when there is nothing to compare with. */
export function tier(key: string, value: number, top: ModelMetrics["top"]): "t1" | "t2" | "t3" | null {
  const best = top[key]?.value;
  if (best == null || !(best > 0)) return null;
  if (key === "eci") {
    const gap = best - value;
    return gap <= 5 ? "t3" : gap <= 15 ? "t2" : "t1";
  }
  const ratio = value / best;
  return ratio >= 0.88 ? "t3" : ratio >= 0.75 ? "t2" : "t1";
}

const dollars = (n: number) => `$${Number(n.toPrecision(3))}`;

export function money(price: [number, number]): string {
  return `${dollars(price[0])} / ${dollars(price[1])}`;
}

/** Said when the Puzzles pill borrows another level; the Code pill always names its level anyway. */
export function borrowedNote(metrics: ModelMetrics): string | null {
  const arc = metrics.pills.arc;
  if (!arc || !metrics.current || arc.from_level === metrics.current || arc.from_level === NO_LEVELS) return null;
  return `Some tests never ran at “${metrics.current}”, so the pills borrow the nearest tested level and name it.`;
}

export function refreshNote(metrics: ModelMetrics): string | null {
  return metrics.last_error ? `Couldn’t refresh: ${metrics.last_error}` : null;
}

/** Whether an API bot's server is this Mac or a machine on its network, so its model is a local copy. */
export function isLocalServer(baseUrl: string): boolean {
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  return isLocalHost(host) || host === "[::1]" || host.endsWith(".local")
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * What an agent card asks the daemon for: the bot's model, the levels it
 * offers, and the one it runs at, which is `fallbackEffort` while unset.
 * Null for bots with no model to look up, and when the daemon is too old
 * to answer (`supported` false).
 */
export function metricsRequest(config: ParticipantConfig, efforts: string[], fallbackEffort: string | null, supported: boolean): { model: string; efforts: string[]; current: string | null; local: boolean } | null {
  if (!supported) return null;
  const backend = config.backend;
  if (backend.kind !== "agent" && backend.kind !== "open_ai_compatible") return null;
  if (!backend.model) return null;
  const local = backend.kind === "open_ai_compatible" && isLocalServer(backend.base_url);
  return { model: backend.model, efforts, current: config.effort ?? fallbackEffort, local };
}
