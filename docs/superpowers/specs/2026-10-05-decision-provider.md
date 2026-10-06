# Decision provider (Clef / Jev), observe-only

## Goal

When a human message has no @mention, ask a decision model (Clef, Jev) who
should reply and whether the room is waiting on the human. Log its pick next
to what Deck actually did. Routing does not change in this phase.

## Trial evidence (2026-10-05, 15 labelled cases)

- Clef 12/15, Jev 12/15, Clef-Flash 7/15. Flash is not offered.
- All models picked a bot when a bot had just asked the human (case 10).
  Rewording the questions fixed that but broke "done"/"sure" replies, so
  the original wording stays. Suppression checks are deferred to a later phase.

## Pieces

1. **`DecisionProvider` trait** (`crates/apex-core/src/decision.rs`)
   - `async fn decide(&self, req: DecisionRequest) -> Result<DecisionResult, String>`
   - Request: `state` (current message first, then recent turns, kept under
     ~2K tokens because Workers AI truncates), named questions of kind
     `choice` / `noul` / `score`.
   - Result: per-question probabilities, model id, latency, usage.
2. **One HTTP adapter** (`crates/apex-adapters/src/decision.rs`). The body
   is the same for all three providers; only these differ:

   | Provider | Endpoint | Auth |
   |---|---|---|
   | Jev | `POST https://api.typesafe.ai/v1/systemone`, `model: jev-latest` | Bearer key |
   | OpenRouter | `POST /api/alpha/decisions`, `model: cloudflare/clef` | Bearer key |
   | Cloudflare | `POST /client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef` | account id + token |

3. **Questions** (fixed, in code):
   - `who_replies`: choice over the roster's bot ids plus `both`/`nobody`.
   - `awaiting_human`: noul.
4. **Observation eligibility**: only human messages routed by Deck without
   mentions are observed. Manually selected Steer and picture recipients are
   skipped. No suppression rules run: bot messages already wake only mentioned
   bots, and the observer runs before a reply can be judged as duplicate.
5. **Settings**: provider + key, off by default, with a note that recent
   room text is sent to the provider. Keys are sent only through `decision_key_save` (older hosts reject it), and live in the OS keychain, not the
   room file.
6. **Log**: one JSONL line per decision under the app data dir: message
   index, Deck's targets (`resolve_targets`), model pick + probabilities,
   awaiting-human probability, latency, numeric usage/cost. Provider responses
   are allowlisted into typed fields; echoed text and unknown fields are dropped. A small CLI or script reports
   agreement rate.

## Concurrency

`post_human` runs with the room borrowed mutably. The decision call is
spawned after `targets_for_human` with a snapshot of the state and never
awaited by the turn; a result whose transcript length no longer matches
(Steer, Retry, Revert) is logged as stale and dropped. A slow or failing
provider can never delay a reply.

## Out of scope for this phase

Changing routing, duplicate-reply suppression, waiting-human suppression, escalation, context ranking, screenshot checks.

## Done when

- Unit tests: request building, manual-recipient skips, stale-drop, provider
  error leaves routing untouched.
- One live run per provider against the key files in `~/.config/{jev,openrouter}`.
- A week of logs, then decide whether the model may route.
