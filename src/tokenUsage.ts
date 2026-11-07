import type { TokenTotals } from './types';

type Usage = { input_tokens: number | null; output_tokens: number | null; cached_input_tokens?: number | null; cost_micros?: number | null; cost_estimated?: boolean };
/** Same accumulation as the durable Rust totals. Unknown sides never become reported zero. */
export function addTokenUsage(known: TokenTotals | undefined, event: Usage): TokenTotals {
  const before = known ?? { input: 0, output: 0, turns: 0 };
  const cost = event.cost_micros;
  const estimate = cost != null && event.cost_estimated === true;
  return {
    input: before.input + (event.input_tokens ?? 0),
    output: before.output + (event.output_tokens ?? 0),
    turns: before.turns + 1,
    input_reported_turns: (before.input_reported_turns ?? before.turns) + (event.input_tokens != null ? 1 : 0),
    output_reported_turns: (before.output_reported_turns ?? before.turns) + (event.output_tokens != null ? 1 : 0),
    cached_input: event.cached_input_tokens == null ? before.cached_input : (before.cached_input ?? 0) + event.cached_input_tokens,
    cost_micros: (before.cost_micros ?? 0) + (cost != null && !estimate ? cost : 0),
    unknown_cost_turns: (before.unknown_cost_turns ?? 0) + (cost == null ? 1 : 0),
    estimated_cost_micros: (before.estimated_cost_micros ?? 0) + (cost != null && estimate ? cost : 0),
  };
}
