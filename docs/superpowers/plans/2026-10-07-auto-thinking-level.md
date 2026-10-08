# Auto thinking level (Clef picks per reply)

Status: plan only, awaiting Human's OK. Builds on the decision observer
(`docs/superpowers/specs/2026-10-05-decision-provider.md`).

## Goal
Add "Auto" to each bot's thinking menu. For a bot on Auto, Deck asks Clef
which level the next reply needs and passes it for that one reply only.
Bots on a fixed level (e.g. Jigga on xhigh) are never touched.

## Settings
- Per bot: `thinking: "auto" | <fixed level>`.
- Auto also stores a **backup level** (default: the bot's previous fixed
  level). Used on timeout, error, low confidence, observer off, or no key.
- Auto is greyed out unless the decision observer has a working key.

## The Clef question
One extra `choice` question in the existing request (same call, no
extra cost round-trip when the observer already runs):
- `low`: quick facts, yes/no, status, short acknowledgements
- `medium`: normal questions, small edits
- `high`: planning, building, reviewing, debugging
Rules: top choice must be >= 0.5, else backup level. Levels map to each
bot's supported values (Codex `model_reasoning_effort`, Claude `--effort`);
models without effort support (Haiku, Sonnet 4.5) ignore it.

## Per-reply override
- Claude adapter: pass `--effort <level>` for this spawn only; the saved
  setting is unchanged.
- Codex adapter: pass `model_reasoning_effort` for this turn only.
- A reply already running is never changed.
- Steer / Retry / Revert: re-ask Clef or fall back; never reuse a stale pick.

## Timing
- Deck waits at most ~1.5 s for Clef before starting an Auto bot's reply
  (median observed ~0.8 s). Past that: backup level, reply starts.
- Only Auto bots wait; fixed bots start immediately as today.

## Rollout
1. **Week 1, log only:** Clef's level is written to `decisions.jsonl`
   (`thinking: {choice, probabilities}`) for every reply; nobody's level
   changes. Jigga grades picks alongside the routing grades.
2. **Week 2, on:** if picks look right, Auto actually sets the level.
   Human can turn it off per bot at any time.

## Overrides that always win
- Human picks a level manually, or writes "think hard"/"quick answer".
- @mentions, approvals, round limits: unchanged.

## Tests
- Settings round-trip for Auto + backup level; old settings load as fixed.
- Adapter args: Auto pick appears only on that spawn; fixed bots unchanged.
- Timeout, error, low confidence -> backup level.
- Log entry contains only level + probabilities (no chat text).

## Build order (Null)
1. Settings + UI menu entry. 2. Clef question + log field (week 1 ends here).
3. Per-reply override in both adapters behind a flag. 4. Tests. Jigga reviews.
