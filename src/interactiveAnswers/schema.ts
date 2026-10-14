// Interactive answers: the card format. A card is a fenced `apex-ui` block of
// JSON at the end of a bot's reply. Every value is checked here, so the card
// component only ever draws a card that makes sense; anything else gets a
// reason to show instead. Comparison cards ignore unknown fields; generated
// cards use the strict contract shared with Electron main.

import { GENERATED_LIMITS, validateGeneratedCard, type GeneratedCard } from "../../shared/generatedCard.mjs";
export type { GeneratedCard } from "../../shared/generatedCard.mjs";

export const SCHEMA_VERSION = 1;
/** The longest comparison source read, in JavaScript UTF-16 code units. */
export const MAX_CARD_CHARS = 16_000;

export interface RangeInput { id: string; type: "range"; label: string; min: number; max: number; step: number; default: number; unit?: string }
export interface ChoiceInput { id: string; type: "choice"; label: string; options: { id: string; label: string }[]; default: string }
export type CardInput = RangeInput | ChoiceInput;
/** A line of the comparison. `better` says which end ranks first. */
export interface CardRow { id: string; label: string; unit?: string; better?: "lower" | "higher" }
/** One of the things compared: a number or text per row id. A missing value shows as a dash. */
export interface CardOption { id: string; label: string; values: Record<string, number | string>; note?: string }
export type CardRule =
  | { type: "atMost"; input: string; row: string }
  | { type: "atLeast"; input: string; row: string }
  | { type: "rankBy"; input: string; rows: Record<string, string> };
export type RankRule = Extract<CardRule, { type: "rankBy" }>;
export interface CardSource { label: string; url: string }

export interface ComparisonCard {
  schemaVersion: 1;
  kind: "comparison";
  cardId: string;
  title: string;
  /** Empty when the card has none. */
  summary: string;
  inputs: CardInput[];
  rows: CardRow[];
  options: CardOption[];
  /** atMost and atLeast put an option out when its row is above or below a range input; rankBy picks, per choice, the row that ranks the rest. */
  rules: CardRule[];
  assumptions: string[];
  sources: CardSource[];
}

/** A block read as a card, or why it can't be one. `unsupported`: a newer app could draw it. */
export type Card = ComparisonCard | GeneratedCard;
export type CardRead = { ok: true; card: Card } | { ok: false; reason: string; unsupported: boolean; kind?: "generated" };

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

class BadCard extends Error {}

function fail(reason: string): never {
  throw new BadCard(reason);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim())) fail(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${field} is longer than ${max} characters.`);
  return trimmed;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(`${field} must be a short id of lowercase letters, digits, - or _.`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a number.`);
  return value;
}

/** A list of `min` to `max` items. An optional one (min 0) may be left out. */
function list(value: unknown, field: string, min: number, max: number): unknown[] {
  const items = value === undefined && min === 0 ? [] : value;
  if (!Array.isArray(items) || items.length < min || items.length > max) fail(`${field} must list ${min} to ${max} items.`);
  return items;
}

function unique(ids: string[], field: string) {
  const seen = new Set<string>();
  for (const one of ids) {
    if (seen.has(one)) fail(`${field} uses the id "${one}" twice.`);
    seen.add(one);
  }
}

const unit = (value: unknown, field: string): { unit?: string } => (value === undefined ? {} : { unit: text(value, field, 8) });

function input(value: unknown, field: string): CardInput {
  const x = object(value, field);
  const base = { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40) };
  if (x.type === "range") {
    const min = number(x.min, `${field}.min`);
    const max = number(x.max, `${field}.max`);
    const step = number(x.step, `${field}.step`);
    if (min >= max) fail(`${field} needs min below max.`);
    if (step <= 0 || (max - min) / step > 1000) fail(`${field}.step must be above 0 and give at most 1000 stops.`);
    const start = number(x.default, `${field}.default`);
    if (start < min || start > max) fail(`${field}.default must be between min and max.`);
    return { ...base, type: "range", min, max, step, default: start, ...unit(x.unit, `${field}.unit`) };
  }
  if (x.type === "choice") {
    const options = list(x.options, `${field}.options`, 2, 6).map((item, j) => {
      const o = object(item, `${field}.options[${j}]`);
      return { id: id(o.id, `${field}.options[${j}].id`), label: text(o.label, `${field}.options[${j}].label`, 40) };
    });
    unique(options.map((o) => o.id), `${field}.options`);
    const start = options.find((o) => o.id === x.default);
    if (!start) fail(`${field}.default must be one of its options.`);
    return { ...base, type: "choice", options, default: start.id };
  }
  return fail(`${field}.type must be "range" or "choice".`);
}

function row(value: unknown, field: string): CardRow {
  const x = object(value, field);
  if (x.better !== undefined && x.better !== "lower" && x.better !== "higher") fail(`${field}.better must be "lower" or "higher".`);
  const better = x.better === "lower" ? "lower" : x.better === "higher" ? "higher" : undefined;
  return { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40), ...unit(x.unit, `${field}.unit`), ...(better ? { better } : {}) };
}

function option(value: unknown, field: string, rows: CardRow[]): CardOption {
  const x = object(value, field);
  const given = x.values === undefined ? {} : object(x.values, `${field}.values`);
  const values: Record<string, number | string> = {};
  for (const r of rows) {
    const v = given[r.id];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") values[r.id] = number(v, `${field}.values.${r.id}`);
    else if (typeof v === "string") values[r.id] = text(v, `${field}.values.${r.id}`, 80, false);
    else fail(`${field}.values.${r.id} must be a number or text.`);
  }
  const note = text(x.note, `${field}.note`, 120, false);
  return { id: id(x.id, `${field}.id`), label: text(x.label, `${field}.label`, 40), values, ...(note ? { note } : {}) };
}

function rules(value: unknown, card: Pick<ComparisonCard, "inputs" | "rows" | "options">): CardRule[] {
  const numeric = (rowId: unknown, field: string): CardRow => {
    const r = card.rows.find((one) => one.id === rowId);
    if (!r) fail(`${field} must name one of the rows.`);
    for (const o of card.options) if (typeof o.values[r.id] !== "number") fail(`${field}: every option needs a number for "${r.label}".`);
    return r;
  };
  let ranks = 0;
  return list(value, "rules", 0, 6).map((item, i): CardRule => {
    const field = `rules[${i}]`;
    const x = object(item, field);
    const linked = card.inputs.find((one) => one.id === x.input);
    if (x.type === "atMost" || x.type === "atLeast") {
      if (!linked || linked.type !== "range") fail(`${field}.input must name a range input.`);
      return { type: x.type === "atMost" ? "atMost" : "atLeast", input: linked.id, row: numeric(x.row, `${field}.row`).id };
    }
    if (x.type === "rankBy") {
      if (++ranks > 1) fail("Only one rankBy rule is allowed.");
      if (!linked || linked.type !== "choice") fail(`${field}.input must name a choice input.`);
      const given = object(x.rows, `${field}.rows`);
      const rows: Record<string, string> = {};
      for (const choice of linked.options) {
        const r = numeric(given[choice.id], `${field}.rows.${choice.id}`);
        if (!r.better) fail(`${field}.rows.${choice.id}: row "${r.id}" needs "better": "lower" or "higher".`);
        rows[choice.id] = r.id;
      }
      return { type: "rankBy", input: linked.id, rows };
    }
    return fail(`${field}.type must be "atMost", "atLeast" or "rankBy".`);
  });
}

/** Read a fenced block's text as a card. */
export function readCard(source: string): CardRead {
  // Bound parsing before reading kind. The larger outer cap admits generated
  // cards; every other kind retains the comparison reader's original cap.
  if (source.length > GENERATED_LIMITS.sourceCodeUnits) return { ok: false, reason: "The card source is larger than 131,072 UTF-16 code units.", unsupported: false };
  if (new TextEncoder().encode(source).byteLength > GENERATED_LIMITS.sourceBytes) return { ok: false, reason: "The card source is larger than 131,072 UTF-8 bytes.", unsupported: false };
  const comparisonTooLarge = (): CardRead => ({ ok: false, reason: `The card is larger than ${MAX_CARD_CHARS.toLocaleString("en-US")} characters.`, unsupported: false });
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    if (source.length > MAX_CARD_CHARS) return comparisonTooLarge();
    return { ok: false, reason: "The card isn't valid JSON.", unsupported: false };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (
    (raw as Record<string, unknown>).kind === "generated" ||
    // Missing/mistyped generated discriminators must not expose code in
    // text-only clients and exports. Valid comparison cards keep their
    // permissive unknown-field contract and never enter this path.
    ((raw as Record<string, unknown>).kind !== "comparison" && ["html", "css", "js"].some((key) => Object.hasOwn(raw, key)))
  )) {
    const read = validateGeneratedCard(raw);
    return read.ok ? read : { ...read, kind: "generated" };
  }
  if (source.length > MAX_CARD_CHARS) return comparisonTooLarge();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "The card must be a JSON object.", unsupported: false };
  const top = raw as Record<string, unknown>;
  if (typeof top.schemaVersion !== "number") return { ok: false, reason: "The card has no schemaVersion.", unsupported: false };
  if (top.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: `Card version ${top.schemaVersion} needs a newer Apex Deck.`, unsupported: true };
  if (typeof top.kind !== "string") return { ok: false, reason: "The card has no kind.", unsupported: false };
  if (top.kind !== "comparison") return { ok: false, reason: `"${top.kind.slice(0, 40)}" cards need a newer Apex Deck.`, unsupported: true };
  try {
    const inputs = list(top.inputs, "inputs", 0, 4).map((item, i) => input(item, `inputs[${i}]`));
    unique(inputs.map((x) => x.id), "inputs");
    const rows = list(top.rows, "rows", 1, 12).map((item, i) => row(item, `rows[${i}]`));
    unique(rows.map((x) => x.id), "rows");
    const options = list(top.options, "options", 2, 6).map((item, i) => option(item, `options[${i}]`, rows));
    unique(options.map((x) => x.id), "options");
    const sources = list(top.sources, "sources", 0, 6).map((item, i) => {
      const x = object(item, `sources[${i}]`);
      const url = text(x.url, `sources[${i}].url`, 300);
      if (!/^https?:\/\/\S+$/i.test(url)) fail(`sources[${i}].url must start with http:// or https://.`);
      return { label: text(x.label, `sources[${i}].label`, 80), url };
    });
    const card: ComparisonCard = {
      schemaVersion: 1,
      kind: "comparison",
      cardId: id(top.cardId, "cardId"),
      title: text(top.title, "title", 80),
      summary: text(top.summary, "summary", 280, false),
      inputs,
      rows,
      options,
      rules: rules(top.rules, { inputs, rows, options }),
      assumptions: list(top.assumptions, "assumptions", 0, 6).map((item, i) => text(item, `assumptions[${i}]`, 200)),
      sources,
    };
    return { ok: true, card };
  } catch (error) {
    if (error instanceof BadCard) return { ok: false, reason: error.message, unsupported: false };
    throw error;
  }
}
