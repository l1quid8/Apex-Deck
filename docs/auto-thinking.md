# Auto thinking trial

Enable the decision observer and save its provider key, then turn on **Auto** in an individual bot's settings. Its existing reasoning level becomes the backup. The slider is labelled **Auto backup** while Auto is on. Turn Auto off to use a fixed level again. The add/edit agent form preserves these settings too.

During the trial, **every Auto reply uses the backup**. Clef's low/medium/high recommendation is logged for grading. Fixed bots start immediately and keep their saved level. Auto waits at most 1,500 ms for the shared provider call, including credential lookup. The background observer keeps its existing eight-second window, so a late recommendation can still be graded. Failure, timeout, a busy observer, an absent key, an observer switched off, stale context, or confidence below 50% uses the backup. A blank backup retains the tool's native default. Auto is unavailable for Haiku and Sonnet 4.5; if legacy Auto settings reach them, no Auto effort argument is sent. Fixed configurations retain their existing behavior.

The saved schema uses `auto_effort: true` and leaves `effort` as the backup, preserving old settings and a valid fixed level for older clients. False Auto is omitted by the host. Each reply carries a temporary `effort_override`; the CLI adapter clones the config for that spawn, so neither Claude nor Codex changes its saved setting. `AUTO_THINKING_ACTIVE` in `crates/apex-core/src/decision.rs` is **false**. Activation requires a reviewed code change after the trial; it never turns on by date. The active selection helper supports explicit “think hard”/“quick answer” requests and the 50% threshold.

Decisions share one call for the same transcript within a post/retry. The existing unaddressed-message routing observation adds the thinking question to that call. Addressed replies and bot handoffs also receive thinking observations. Changed transcripts and new retries create fresh decisions; Stop, Steer and Revert invalidate outstanding results. Only Auto bots await a result, and waiting does not hold the edit slot.

`decisions.jsonl` has two entry types:

- Existing routing entries retain their fields, with an additional typed `thinking` value.
- Per-reply entries have `kind: "thinking"`, `agent`, `auto`, `backup`, `thinking`, `model`, `latency_ms`, `stale` and `observe_only`. Errors contain a fixed error string instead of a recommendation. Chat text and keys are never written.

Example per-reply entry (timestamps and identifiers abbreviated):

```json
{"version":1,"kind":"thinking","room":"example","message_index":0,"agent":"null","auto":true,"backup":"ultra","thinking":{"choice":"high","probabilities":{"high":0.8681,"low":0.0218,"medium":0.1101}},"model":"cloudflare/clef","latency_ms":850,"stale":false,"observe_only":true,"at_ms":0}
```

`decision-report.py` filters thinking entries out of routing grades. Other log readers, including the private Clef feed mod, should apply the same `kind != "thinking"` filter to routing totals. Provider usage is logged once per shared call: on the existing routing result, or on the first thinking line for calls outside routing observation. The report totals both without double counting, including stale calls that still incurred a charge.

Live smoke test (synthetic chat only):

```bash
cargo run -p apex-adapters --example decision-smoke -- openrouter "$HOME/.config/openrouter/key"
```

The smoke example now asks the thinking question. Both OpenRouter/Clef and Jev returned validated recommendations in development.
