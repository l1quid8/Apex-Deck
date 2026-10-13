// Interactive answers: what a comparison card's settings give. Only the rule
// types in schema.ts decide anything, so a person can always check the
// result: limits put options out, then the chosen priority ranks the options
// that are left. Ties keep the card's order. Nothing here calls a model.

import type { InputValues } from "./contract.ts";
import type { CardInput, CardRow, ComparisonCard, RangeInput, RankRule } from "./schema.ts";

/** Decimal places a number is written with: 0.25 has 2, 1e-7 has 7. */
function places(n: number): number {
  const [digits, exponent] = String(n).split("e-");
  return (digits.split(".")[1]?.length ?? 0) + (exponent ? Number(exponent) : 0);
}

/** `value` moved inside the input's range and onto its nearest step. */
export function snap(input: Pick<RangeInput, "min" | "max" | "step">, value: number): number {
  const inside = Math.min(input.max, Math.max(input.min, value));
  const stepped = input.min + Math.round((inside - input.min) / input.step) * input.step;
  return Math.min(input.max, Number(stepped.toFixed(Math.min(20, Math.max(places(input.min), places(input.step))))));
}

/** The settings to use: saved ones that still fit the card, else each input's default. */
export function resolveInputs(card: Pick<ComparisonCard, "inputs">, saved: InputValues | null | undefined): InputValues {
  const out: InputValues = {};
  for (const input of card.inputs) {
    const value = saved?.[input.id];
    if (input.type === "range") out[input.id] = typeof value === "number" && Number.isFinite(value) ? snap(input, value) : input.default;
    else out[input.id] = typeof value === "string" && input.options.some((o) => o.id === value) ? value : input.default;
  }
  return out;
}

export interface OptionResult {
  id: string;
  label: string;
  /** Why it's out, one line per limit it breaks; empty when it fits. */
  out: string[];
  /** Its place among the options that fit, from 1, when the card ranks them; else null. */
  rank: number | null;
}

export interface Evaluation {
  /** The settings used. */
  inputs: InputValues;
  /** One per option, in the card's order. */
  options: OptionResult[];
  /** The top-ranked option that fits; null when the card doesn't rank or nothing fits. */
  best: string | null;
  /** The row that ranks the options for the chosen priority. */
  rankedBy: CardRow | null;
  /** How many options fit every limit. */
  fitting: number;
}

export const isRank = (rule: ComparisonCard["rules"][number]): rule is RankRule => rule.type === "rankBy";

export function evaluate(card: ComparisonCard, values: InputValues | null | undefined): Evaluation {
  const inputs = resolveInputs(card, values);
  const options: OptionResult[] = card.options.map((option) => ({
    id: option.id,
    label: option.label,
    out: card.rules.flatMap((rule) => {
      if (rule.type === "rankBy") return [];
      const limit = inputs[rule.input] as number;
      const value = option.values[rule.row] as number;
      const name = (card.inputs.find((input) => input.id === rule.input)?.label ?? rule.input).toLowerCase();
      if (rule.type === "atMost" && value > limit) return [`Above ${name}`];
      if (rule.type === "atLeast" && value < limit) return [`Below ${name}`];
      return [];
    }),
    rank: null,
  }));
  const ranking = card.rules.find(isRank);
  const rankedBy = ranking ? card.rows.find((row) => row.id === ranking.rows[inputs[ranking.input] as string]) ?? null : null;
  if (rankedBy) {
    const sign = rankedBy.better === "lower" ? 1 : -1;
    card.options
      .map((option, i) => ({ value: option.values[rankedBy.id] as number, result: options[i] }))
      .filter(({ result }) => result.out.length === 0)
      .sort((a, b) => sign * (a.value - b.value))
      .forEach(({ result }, place) => { result.rank = place + 1; });
  }
  return {
    inputs,
    options,
    best: options.find((o) => o.rank === 1)?.id ?? null,
    rankedBy,
    fitting: options.filter((o) => o.out.length === 0).length,
  };
}

const PREFIX = new Set(["$", "€", "£", "¥"]);

/** A value as the card shows it: "$1,250", "35%", "12.5 ms"; text as written; nothing as a dash. */
export function formatValue(value: number | string | undefined, unit?: string): string {
  if (value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  const digits = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const sign = value < 0 ? "-" : "";
  if (!unit) return `${sign}${digits}`;
  if (PREFIX.has(unit)) return `${sign}${unit}${digits}`;
  return unit === "%" ? `${sign}${digits}%` : `${sign}${digits} ${unit}`;
}

/** A setting in words: "$250" for a range, the option's label for a choice. */
export function inputText(input: CardInput, value: number | string | undefined): string {
  if (input.type === "range") return formatValue(typeof value === "number" ? value : input.default, input.unit);
  return input.options.find((o) => o.id === value)?.label ?? String(value ?? "");
}

/** One line saying what the settings give. */
export function resultLine(card: ComparisonCard, ev: Evaluation): string {
  if (ev.fitting === 0) return "No option fits these settings.";
  const ranking = card.rules.find(isRank);
  const best = card.options.find((o) => o.id === ev.best);
  const input = ranking && card.inputs.find((one) => one.id === ranking.input);
  if (best && input) return `Best fit: ${best.label} (${input.label.toLowerCase()}: ${inputText(input, ev.inputs[input.id])}).`;
  return `${ev.fitting} of ${card.options.length} options fit these settings.`;
}
