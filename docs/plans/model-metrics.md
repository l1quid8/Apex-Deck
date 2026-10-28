# Model Metrics Pills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real benchmark pills (Puzzles, Code, Overall, Price) after "model · effort" on each agent card. A hover box compares every reasoning level the model offers. No API key or sign-up is needed.

**Architecture:** Once a day, each daemon downloads Epoch AI's public benchmark zip and OpenRouter's public model list. It keeps only the few tests in an allow-list and caches the result on disk. It then matches each bot's model and effort levels to Epoch's `<model>_<level>` rows. The UI asks the daemon for one model's level rows and draws the pills and hover box from `mockups/model-metrics-v4.html`. Every daemon fetches its own copy, so Deck never ships or re-hosts a dataset.

**Tech Stack:** Rust (`apex-adapters`, `apex-host`, `apex-daemon`), React/TS (`src/`), `reqwest` (already used), new crates `zip` (deflate only) and `csv`, node `--test` for UI logic.

**Spec:** `mockups/model-metrics-v4.html` (real-data version of the approved v2 layout, with Cognition's FrontierCode as the Code pill; v3's SciCode pill belonged to Artificial Analysis). v4 has no sentence explaining the missing Code levels; the Human removed it, so don't add it back.

**Decisions (Human, 2026-10-28):** keep ARC Prize and Cognition scores with credit; add DeepSWE as a second Code column in the hover box, empty until DeepSWE tests these models; build Native (executing-plans, one review at the end).

## Research findings (2026-10-26)

**Epoch download.** `GET https://epoch.ai/data/benchmark_data.zip` is about 2.3 MB and returns `200` with an `ETag`, so a refresh can send `If-None-Match` and usually get `304`. The zip holds one CSV per test, plus `model_metadata.csv` and `epoch_capabilities_index/eci_scores.csv`.

**Row names carry the level.** Examples are `gpt-6.1-sol_medium`, `claude-opus-5-5_xhigh`, `deepseek-v4.1-flash_max`, `deepseek-v4.1-flash-1017_max` (a dated re-run), and `qwen3.5-9B_none`. `model_metadata.csv` maps each `model_version` to a `model_group` such as "Claude Opus 5.5", which is the key in `eci_scores.csv`.

**Licence check.** From the README inside the zip and https://epoch.ai/benchmarks/use-this-data:
- "Epoch AI's data is free to use, distribute, and reproduce provided the source and authors are credited" (CC BY 4.0).
- "This hub also includes data sourced from external projects, which retains its original licensing." "Users are responsible for complying with the license terms of the specific data they use."
- So the CC BY licence covers only Epoch's own runs (files without `_external`) and its Capabilities Index (ECI). External files keep their owners' terms.

**Which file comes from where:**

| File | Owner | Split by level? | Our bots covered | Decision |
|---|---|---|---|---|
| `scicode_external.csv` | Artificial Analysis (all 226 rows) | yes | all 4 | **Excluded.** AA's own terms require their API and forbid redistribution without a contract. |
| `arc_agi_2_external.csv` | ARC Prize | yes, low to max | Sol, Opus, DeepSeek Flash | Use, credited "ARC Prize via Epoch AI". ARC Prize says its scores are "open source and reproducible". |
| `frontiercode_external.csv` | Cognition | one level per model | Sol medium, Opus medium, Flash high | Use as the new Code pill, credited "Cognition via Epoch AI". |
| `cursorbench_external.csv` | Cursor | yes | Opus only | Use as an extra hover column, credited "Cursor via Epoch AI". |
| `deepswe_external.csv` | Datacurve (DeepSWE) | yes, low to max | none yet (stops at GPT-5.6 Sol, Opus 5, V4 Flash) | Use as a second Code column in the hover box, credited "Datacurve via Epoch AI". Score column `Pass@1`, 0 to 1. Empty (`—`) until DeepSWE tests our models; the daily download fills it with no code change. |
| `eci_scores.csv` | Epoch | no (one per model) | all 4 | Use for Overall. |
| Epoch's own runs (GPQA, FrontierMath, …) | Epoch | **no, `_max` only** | all 4 | Not used. With max-only rows the per-level table would show one row. |

**The trade-off the Human must know about:** every score that changes with the reasoning level comes from an outside group. ARC Prize, Cognition, Cursor and Datacurve publish their results openly but name no reuse licence. Showing a few credited numbers, fetched separately by each person's own machine, is low risk but isn't an explicit grant. The source list is a const table (Task 1), so any test can be removed in one line.

**OpenRouter prices.** `GET https://openrouter.ai/api/v1/models` returns `200` JSON with no key. `api_info::models("https://openrouter.ai/api/v1", None)` already parses it into `ApiModel.price_in` / `price_out` per million. OpenRouter's terms (§7.5) forbid scripts that "scrape or copy any information on the Site". Calling their documented public API once a day isn't scraping, but if they object, the Price pill is dropped and nothing else changes.

## Global Constraints

- The only network calls are `https://epoch.ai/data/benchmark_data.zip` and `https://openrouter.ai/api/v1/models`. Neither sends a key, and each runs at most once per 24 hours per daemon.
- The cache file is `<data folder>/model-metrics.json`, holding parsed rows only. The zip is never kept.
- Every hover box ends with `Data: Epoch AI (CC BY) · <test owner> via Epoch AI · prices: OpenRouter`, with each name linked through Deck's existing `open_target` (`https://epoch.ai/benchmarks`, `https://openrouter.ai/models`).
- Any row whose `Source` column contains `artificialanalysis.ai` is dropped, even inside an allowed file.
- Never show one level's number as another's. A borrowed number is tagged with its level (`61% · low`). A level no test ran says `not measured`. A level the model doesn't offer says `not offered`.
- Local and custom-URL models are never matched against Epoch and show `No public benchmarks`. The one exception is a model id in `OVERRIDES` that names a public release, such as Gwen's Qwen3.5 9B, which shows a note: `Scores are for the full public model; your local copy may score lower.`
- Desktop only. The phone and a "speed on your Mac" pill are out of scope (see Later).

## Review Focus

1. **The current level was never tested** (deepgeek on medium). The pill shows the nearest tested level with a visible tag, and the current row says `not measured`. Pinned in Task 2 (`nearest_measured_is_tagged`) and Task 4 (`pill tag names the borrowed level`).
2. **Epoch changes the zip**: a renamed file, a renamed score column, or a new dated row like `deepseek-v4.1-flash-1017_max`. A missing file or column skips that one test and records it in `last_error`, and the other pills still render. A dated row never beats the plain row. Pinned in Task 1 (`missing_test_file_skips_only_that_test`) and Task 2 (`dated_rerun_does_not_replace_base`).
3. **Download fails, or returns 304.** A failure keeps the last cache and its age, and the hover box says `Couldn't refresh: <reason>`. A 304 only bumps `fetched_at`. Pinned in Task 1 (`failed_refresh_keeps_cache`, `not_modified_keeps_rows`).
4. **Deck ids differ from Epoch ids**: `deepseek-flash` vs `deepseek-v4.1-flash`, `qwen3.5-9b` vs `qwen3.5-9B`, a dated `-YYYYMMDD` suffix. Case-folding plus `OVERRIDES` must match these, and an unknown id gives `None`, not empty pills. Pinned in Task 2 (`override_table_wins`, `case_insensitive_match`, `unknown_model_is_none`).
5. **AA data sneaks back in** through another file's `Source` column. Pinned in Task 1 (`aa_rows_are_dropped`).

---

### Task 1: Download, filter and cache Epoch + OpenRouter data

**Files:**
- Create: `crates/apex-adapters/src/model_metrics.rs`
- Create: `crates/apex-adapters/tests/fixtures/model_metrics/epoch_min.zip`, built by a test helper from small CSVs: two ARC-AGI-2 rows per model, one FrontierCode row with an `artificialanalysis.ai` source, `model_metadata.csv`, and `eci_scores.csv`
- Modify: `crates/apex-adapters/Cargo.toml` (`zip = { version = "2", default-features = false, features = ["deflate"] }`, `csv = "1"`), and `src/lib.rs` (`pub mod model_metrics;`)

**Interfaces:**
- Produces:
  - `pub struct TestSpec { pub id: &'static str, pub file: &'static str, pub score_column: &'static str, pub label: &'static str, pub owner: &'static str }`
  - `pub const TESTS: &[TestSpec]` with exactly these entries, in this order:
    - `{ id: "arc", file: "arc_agi_2_external.csv", score_column: "Score", label: "Puzzles", owner: "ARC Prize" }`
    - `{ id: "code", file: "frontiercode_external.csv", score_column: "Main score", label: "Code", owner: "Cognition" }`
    - `{ id: "cursor", file: "cursorbench_external.csv", score_column: "Score", label: "Cursor", owner: "Cursor" }`
    - `{ id: "deepswe", file: "deepswe_external.csv", score_column: "Pass@1", label: "DeepSWE", owner: "Datacurve" }`
  - `pub struct Score { pub test: String, pub model_version: String, pub value: f64 }`, where value is 0 to 100 (the CSV's 0 to 1 times 100)
  - `pub struct MetricsCache { pub fetched_at: u64, pub etag: Option<String>, pub scores: Vec<Score>, pub groups: HashMap<String, String>, pub eci: HashMap<String, f64>, pub prices: HashMap<String, (f64, f64)>, pub last_error: Option<String> }`. `groups` maps model_version to model_group, and `prices` is keyed by OpenRouter id.
  - `pub fn parse_zip(bytes: &[u8]) -> (Vec<Score>, HashMap<String,String>, HashMap<String,f64>, Vec<String>)`, where the last value lists skipped-test warnings
  - `pub async fn current(data: &Path) -> MetricsCache`, which refreshes first when the cache is older than 86,400 s

- [ ] **Step 1: Write the failing tests** in `model_metrics.rs`:
  - `parses_fixture`: `parse_zip` yields a `Score { test: "arc", model_version: "gpt-6.1-sol_medium", value: 86.7 }` (±0.05), `groups["gpt-6.1-sol_medium"] == "GPT-6.1 Sol"`, and `eci["GPT-6.1 Sol"] == 168.37`.
  - `aa_rows_are_dropped`: the FrontierCode row whose `Source` contains `artificialanalysis.ai` is absent.
  - `missing_test_file_skips_only_that_test`: a zip without `cursorbench_external.csv` still yields the arc scores, and the warnings contain `cursorbench_external.csv`.
  - `failed_refresh_keeps_cache`: given a saved cache and a fetch error `"timed out"`, the result keeps the old `scores` and `fetched_at`, with `last_error == Some("timed out")`.
  - `not_modified_keeps_rows`: a fetcher returning `NotModified` keeps the `scores` and sets `fetched_at` to now.
  - Inject the network as `current_with(data, now, fetch_zip: impl Fn(Option<&str>) -> Fut<Result<Fetched,String>>, fetch_prices: …)`, where `enum Fetched { Body(Vec<u8>, Option<String>), NotModified }`.
- [ ] **Step 2: Run** `cargo test -p apex-adapters model_metrics` and confirm the tests fail because they don't compile.
- [ ] **Step 3: Implement.** Read only the zip entries named in `TESTS`, plus the two lookup files. Prices come from `api_info::models("https://openrouter.ai/api/v1", None)`. A price failure keeps the old prices and doesn't fail the whole refresh. Write the cache atomically (temp file plus rename), and guard refreshes with a `tokio::sync::Mutex` so several cards opening at once make one request. Use a 30 s timeout and reject bodies over 20 MB.
- [ ] **Step 4: Run** `cargo test -p apex-adapters model_metrics`. Expected: all pass.
- [ ] **Step 5: Real check.** Run `cargo test -p apex-adapters model_metrics -- --ignored live_epoch_download`. This ignored test downloads the real zip and asserts at least one `arc` score for `claude-opus-5-5_high`.
- [ ] **Step 6: Commit** `feat(metrics): fetch and cache Epoch benchmark and OpenRouter price data`.

### Task 2: Match a bot's model and levels to rows

**Files:**
- Modify: `crates/apex-adapters/src/model_metrics.rs`

**Interfaces:**
- Consumes: `MetricsCache`, `TESTS`
- Produces:
  - `pub enum LevelState { Measured, NotMeasured, NotOffered }`, serialised in snake_case
  - `pub struct LevelRow { pub effort: String, pub state: LevelState, pub scores: HashMap<String, f64> }`, keyed by test id
  - `pub struct PillValue { pub value: f64, pub from_level: String }`
  - `pub struct ModelMetrics { pub name: String, pub rows: Vec<LevelRow>, pub current: Option<String>, pub pills: HashMap<String, PillValue>, pub best: HashMap<String, String>, pub eci: Option<f64>, pub price: Option<(f64, f64)>, pub local_note: bool, pub fetched_at: u64, pub last_error: Option<String> }`. `best` maps each test id to the level with the top score, for the ★.
  - `pub fn match_model(model: &str, efforts: &[String], current: Option<&str>, cache: &MetricsCache) -> Option<ModelMetrics>`, which returns `None` when no Epoch row matches the model

- [ ] **Step 1: Write the failing tests:**
  - `per_level_rows`: Sol with efforts `["low","medium","high","xhigh","max"]` gives five `Measured` rows, and `rows[1].scores["arc"]` is ≈86.7.
  - `nearest_measured_is_tagged`: DeepSeek Flash with efforts `["low","medium","high","max"]` and current `medium` gives `pills["arc"].from_level == "high"` and a medium row of `NotMeasured`. Ties go to the higher level.
  - `per_test_borrowing`: for Opus on `high`, `pills["code"].from_level == "medium"` (FrontierCode has only medium) while `pills["arc"].from_level == "high"`.
  - `dated_rerun_does_not_replace_base`: with both `deepseek-v4.1-flash_max` and `deepseek-v4.1-flash-1017_max` present, the max row uses the plain one.
  - `case_insensitive_match`: `qwen3.5-9b` finds `qwen3.5-9B_none`. A single `_none` or bare row maps to `current`, or to `"default"` when the model has no levels.
  - `override_table_wins`: `deepseek-flash` resolves through `OVERRIDES` to `deepseek-v4.1-flash`.
  - `unknown_model_is_none`: `match_model("made-up-1", …)` is `None`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Normalise: lowercase, then drop a trailing `-YYYYMMDD`. Look up `OVERRIDES: &[(&str, &str, bool)]` (deck id, Epoch base, local note), which starts with `("qwen3.5-9b","qwen3.5-9b",true)` and one DeepSeek entry. DeepSeek ids come live from DeepSeek's `/models`, and none is hard-coded in Deck, so before writing `override_table_wins`, read deepgeek's real model id from its participant record and use it in place of `deepseek-flash`. Rows match `<base>_<level>` exactly, so `<base>-NNNN_<level>` never matches. ECI comes from `groups[<base>_*] → eci`. The price comes from the OpenRouter id whose part after `/` equals the base with `.` kept (so `openai/gpt-6.1-sol`); no match gives `None`. "Nearest" means the closest measured effort by position in `efforts`.
- [ ] **Step 4: Run** `cargo test -p apex-adapters model_metrics`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(metrics): match bot model and effort levels to benchmark rows`.

### Task 3: Daemon command and backend call

**Files:**
- Modify: `crates/apex-host/src/host.rs`, next to `api_balance` (~line 1336). This file has someone else's uncommitted change, so stage only this hunk.
- Modify: `crates/apex-host/src/command.rs` (enum variant, dispatch near the `ApiBalance` arm at ~532, parse test near ~631)
- Modify: `crates/apex-daemon/src/authority.rs` (add it to the read-only list beside `api_balance`, ~429)
- Modify: `src/backend.ts` (interface plus stub) and `src/commandBackend.ts` (beside `api_balance`, ~77)

**Interfaces:**
- Consumes: `model_metrics::current`, `model_metrics::match_model`
- Produces:
  - Command `model_metrics` with args `{ model: string, efforts: string[], current: string | null, custom: boolean }`. It returns `ModelMetrics | null`. `custom: true` returns `null` unless the model is in `OVERRIDES` with the local note set.
  - TS `modelMetrics(model: string, efforts: string[], current: string | null, custom: boolean): Promise<ModelMetrics | null>`
  - TS types `ModelMetrics`, `LevelRow`, `PillValue`, mirroring Task 2 field for field (camelCase over the wire, as the other commands do)

- [ ] **Step 1: Write the failing tests.** Add `model_metrics` to the `command.rs` parse test. Add a host test `custom_backend_never_matches`: `custom: true` with `"venice-glm"` gives `None` without reading the cache. Add `model_metrics` to the authority read-only test list.
- [ ] **Step 2: Run** `cargo test -p apex-host model_metrics` and `cargo test -p apex-daemon authority`, and confirm they fail.
- [ ] **Step 3: Implement** the host method, dispatch, authority row and TS wiring.
- [ ] **Step 4: Run** both cargo commands plus `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(metrics): model_metrics daemon command`.

### Task 4: Pills and hover box

**Files:**
- Create: `src/ModelMetrics.tsx` (pills plus hover box, ported from `mockups/model-metrics-v4.html`, using Deck variables `--bg/--panel/--line/--text`). The hover table always has a DeepSWE column after Code for matched models, showing `—` in every row until data arrives; the Cursor column still shows only when that model has Cursor scores.
- Create: `src/modelMetrics.ts` (pure helpers)
- Modify: `src/ChatPane.tsx` agent card (~3531): render `<ModelMetrics …/>` after the `chipDescription(p, ALL_PARTS)` line, passing the bot's model, `effortsFor(...)`, its current effort, and `custom` for `open_ai_compatible`
- Modify: the stylesheet the agent cards use
- Test: `tests/model-metrics.test.mjs`

**Interfaces:**
- Consumes: `backend.modelMetrics`, `TESTS` labels and owners (sent with the result, or mirrored as a TS const that matches Task 1 exactly)

- [ ] **Step 1: Write the failing tests** against `src/modelMetrics.ts`:
  - `pill tag names the borrowed level`: `pillLabel("Puzzles", {value: 60.6, fromLevel: "low"}, "medium")` returns `"Puzzles 61% · low"`. When the level matches the current one, it returns `"Puzzles 61%"`.
  - `missing value is a dash`: `pillLabel("Code", undefined, "medium")` returns `"Code —"`.
  - `row text by state`: `rowText("not_offered")` returns `"not offered"` and `rowText("not_measured")` returns `"not measured"`.
  - `age text`: `ageText(fetchedAt, now)` returns `"today"`, `"yesterday"` or `"3 days old"`.
  - `credit line`: `creditLine(["arc","code"])` returns `"Data: Epoch AI (CC BY) · ARC Prize, Cognition via Epoch AI · prices: OpenRouter"`. An empty DeepSWE column isn't credited: only tests with at least one score for that model are passed in.
  - `deepswe column is always present`: `columns(metrics)` includes `deepswe` even when no row has a DeepSWE score, and includes `cursor` only when some row has one.
- [ ] **Step 2: Run** `npm test -- tests/model-metrics.test.mjs` and confirm the tests fail.
- [ ] **Step 3: Implement** the helpers and the component: hover opens, click pins it open, Esc closes, keyboard focus opens, ★ marks each test's best level, and the current row is highlighted. The hover box mentions that more reasoning isn't always better only when `best` differs from the max level.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit`. Expected: both pass.
- [ ] **Step 5: Look before installing.** Render the Agents page offscreen in the vite preview with a seeded cache. View PNGs of Jigga (borrowed Code `· medium`), deepgeek (borrowed Puzzles `· high`), Gwen (local note) and a Venice bot (`No public benchmarks`), and compare them with v4.
- [ ] **Step 6: Commit** `feat(metrics): benchmark pills and level table on agent cards`.

## Later (not in this plan)

- **Speed on your Mac.** A bot's turn includes tool calls, so tokens divided by turn time understates real speed. It needs its own design that times only the text-streaming spans.
- **Phone pills.**
- **Asking ARC Prize, Cognition and Cursor** for an explicit reuse line, if Deck is ever sold.
