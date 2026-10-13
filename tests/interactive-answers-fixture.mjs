// The example card from the bots' instructions (ANSWERS_SYSTEM in
// crates/apex-core/src/view.rs), for the interactive answers tests. This file
// is not a test itself: its name doesn't end in .test.mjs.

export const EXAMPLE = {
  schemaVersion: 1,
  kind: "comparison",
  cardId: "hosting",
  title: "Where should this run?",
  summary: "Managed hosting fits most budgets with the least upkeep.",
  inputs: [
    { id: "budget", type: "range", label: "Monthly budget", min: 50, max: 500, step: 25, default: 250, unit: "$" },
    { id: "priority", type: "choice", label: "Priority", options: [{ id: "cost", label: "Cost" }, { id: "ease", label: "Simplicity" }], default: "ease" },
  ],
  rows: [
    { id: "price", label: "Monthly cost", unit: "$", better: "lower" },
    { id: "ease", label: "Ease, 1 to 5", better: "higher" },
    { id: "work", label: "Upkeep" },
  ],
  options: [
    { id: "vps", label: "VPS", values: { price: 60, ease: 2, work: "High" }, note: "You own updates and backups." },
    { id: "managed", label: "Managed", values: { price: 180, ease: 5, work: "Low" } },
    { id: "serverless", label: "Serverless", values: { price: 90, ease: 4, work: "Medium" }, note: "Cost grows with traffic." },
  ],
  rules: [
    { type: "atMost", input: "budget", row: "price" },
    { type: "rankBy", input: "priority", rows: { cost: "price", ease: "ease" } },
  ],
  assumptions: ["Prices are estimates for one small web app."],
  sources: [{ label: "Provider pricing", url: "https://example.com/pricing" }],
};

/** The example as a fenced block's text. */
export const source = JSON.stringify(EXAMPLE);

/** The example's text after `change` edits a copy of it. */
export function variant(change) {
  const card = structuredClone(EXAMPLE);
  change(card);
  return JSON.stringify(card);
}
