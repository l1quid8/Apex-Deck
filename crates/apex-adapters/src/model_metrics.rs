//! Public benchmark scores and prices for the pills beside each bot's model.
//!
//! Once a day each daemon downloads Epoch AI's benchmark zip and
//! OpenRouter's model list, keeps only the tests in [`TESTS`], and saves
//! the parsed rows in `<data folder>/model-metrics.json`. Neither source
//! needs a key, and Deck never ships or re-hosts the data itself.

use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One test whose scores Deck shows, read from one CSV in Epoch's zip.
pub struct TestSpec {
    pub id: &'static str,
    pub file: &'static str,
    pub score_column: &'static str,
    pub label: &'static str,
    /// Who ran the test. Epoch only collects these results, so the hover
    /// box credits "<owner> via Epoch AI".
    pub owner: &'static str,
}

/// The only tests Deck reads. Every one comes from an outside group whose
/// results Epoch collects; Epoch's own runs are scored at "max" only, so
/// they can't compare reasoning levels. SciCode is deliberately absent:
/// Epoch copies it from Artificial Analysis, whose terms forbid passing it on.
pub const TESTS: &[TestSpec] = &[
    TestSpec { id: "arc", file: "arc_agi_2_external.csv", score_column: "Score", label: "Puzzles", owner: "ARC Prize" },
    TestSpec { id: "code", file: "frontiercode_external.csv", score_column: "Main score", label: "Code", owner: "Cognition" },
    TestSpec { id: "cursor", file: "cursorbench_external.csv", score_column: "Score", label: "Cursor", owner: "Cursor" },
    TestSpec { id: "deepswe", file: "deepswe_external.csv", score_column: "Pass@1", label: "DeepSWE", owner: "Datacurve" },
];

const EPOCH_ZIP: &str = "https://epoch.ai/data/benchmark_data.zip";
const OPENROUTER: &str = "https://openrouter.ai/api/v1";
const METADATA: &str = "model_metadata.csv";
const ECI: &str = "epoch_capabilities_index/eci_scores.csv";
const CACHE_FILE: &str = "model-metrics.json";
/// Rows whose `Source` names this site are Artificial Analysis's data.
const EXCLUDED_SOURCE: &str = "artificialanalysis.ai";
/// Neither the download nor any one file inside it may be bigger.
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const DAY: u64 = 86_400;
/// After a failed refresh, wait this long before trying again, so an
/// offline Mac doesn't retry on every card it draws.
const RETRY_AFTER: u64 = 3_600;

/// A test score for one `<model>_<level>` row, from 0 to 100, to 0.01.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub test: String,
    pub model_version: String,
    pub value: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MetricsCache {
    /// When the scores were last confirmed current (Unix seconds); 0 = never.
    pub fetched_at: u64,
    /// When a refresh was last attempted, successful or not.
    #[serde(default)]
    pub tried_at: u64,
    pub etag: Option<String>,
    pub scores: Vec<Score>,
    /// `model_version` → Epoch's `model_group`, the key into `eci`.
    pub groups: HashMap<String, String>,
    /// Epoch Capabilities Index by `model_group`.
    pub eci: HashMap<String, f64>,
    /// OpenRouter id → (input, output) US dollars per million tokens.
    pub prices: HashMap<String, (f64, f64)>,
    pub last_error: Option<String>,
}

pub enum Fetched {
    Body(Vec<u8>, Option<String>),
    NotModified,
}

/// Read the allowed tests, the model groups and the capabilities index
/// out of Epoch's zip. A missing file or column skips only that part and
/// is listed in the returned warnings.
pub fn parse_zip(bytes: &[u8]) -> (Vec<Score>, HashMap<String, String>, HashMap<String, f64>, Vec<String>) {
    let (mut scores, mut groups, mut eci, mut warnings) = (Vec::new(), HashMap::new(), HashMap::new(), Vec::new());
    let mut zip = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(zip) => zip,
        Err(e) => {
            warnings.push(format!("Epoch's download isn't a readable zip: {e}"));
            return (scores, groups, eci, warnings);
        }
    };
    for test in TESTS {
        let rows = match table(&mut zip, test.file, &["Model version", test.score_column]) {
            Ok(rows) => rows,
            Err(e) => {
                warnings.push(e);
                continue;
            }
        };
        for row in rows {
            if row.get("Source").is_some_and(|s| s.to_ascii_lowercase().contains(EXCLUDED_SOURCE)) {
                continue;
            }
            let (Some(model), Some(value)) = (row.get("Model version"), row.get(test.score_column).and_then(|v| v.trim().parse::<f64>().ok())) else { continue };
            if model.is_empty() || !value.is_finite() {
                continue;
            }
            // Kept to 0.01: plenty for a whole-percent pill, and short
            // decimals survive the JSON cache unchanged.
            scores.push(Score { test: test.id.into(), model_version: model.clone(), value: (value * 10_000.0).round() / 100.0 });
        }
    }
    match table(&mut zip, METADATA, &["model_version", "model_group"]) {
        Ok(rows) => groups.extend(rows.into_iter().filter_map(|mut row| Some((row.remove("model_version")?, row.remove("model_group")?)))),
        Err(e) => warnings.push(e),
    }
    match table(&mut zip, ECI, &["Model", "eci"]) {
        Ok(rows) => eci.extend(rows.into_iter().filter_map(|row| Some((row.get("Model")?.clone(), row.get("eci")?.trim().parse::<f64>().ok()?)))),
        Err(e) => warnings.push(e),
    }
    (scores, groups, eci, warnings)
}

/// One CSV from the zip as header → value maps, after checking that the
/// named columns exist.
fn table<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, file: &str, needs: &[&str]) -> Result<Vec<HashMap<String, String>>, String> {
    let entry = zip.by_name(file).map_err(|_| format!("{file} is missing from Epoch's download"))?;
    if entry.size() > MAX_BYTES {
        return Err(format!("{file} is too big"));
    }
    let mut text = String::new();
    entry.take(MAX_BYTES).read_to_string(&mut text).map_err(|e| format!("{file}: {e}"))?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let headers: Vec<String> = reader.headers().map_err(|e| format!("{file}: {e}"))?.iter().map(str::to_string).collect();
    if let Some(missing) = needs.iter().find(|n| !headers.iter().any(|h| h == *n)) {
        return Err(format!("{file} has no \"{missing}\" column"));
    }
    Ok(reader
        .records()
        .filter_map(Result::ok)
        .map(|record| headers.iter().cloned().zip(record.iter().map(str::to_string)).collect())
        .collect())
}

/// The cached metrics, refreshed first when they are a day old.
pub async fn current(data: &Path) -> MetricsCache {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    current_with(data, now, fetch_zip, fetch_prices).await
}

/// [`current`] with the clock and network passed in.
pub async fn current_with<Z, ZF, P, PF>(data: &Path, now: u64, fetch_zip: Z, fetch_prices: P) -> MetricsCache
where
    Z: FnOnce(Option<String>) -> ZF,
    ZF: Future<Output = Result<Fetched, String>>,
    P: FnOnce() -> PF,
    PF: Future<Output = Result<HashMap<String, (f64, f64)>, String>>,
{
    // Several cards opening at once make one request; the rest wait and
    // then read what it saved.
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = REFRESH.lock().await;
    let mut cache = load(data).unwrap_or_default();
    let stale = cache.fetched_at == 0 || now.saturating_sub(cache.fetched_at) >= DAY;
    let may_retry = cache.last_error.is_none() || now.saturating_sub(cache.tried_at) >= RETRY_AFTER;
    if !stale || !may_retry {
        return cache;
    }
    cache.tried_at = now;
    let zip_error = match fetch_zip(cache.etag.clone()).await {
        Ok(Fetched::NotModified) => {
            cache.fetched_at = now;
            None
        }
        Ok(Fetched::Body(bytes, etag)) => {
            let (scores, groups, eci, warnings) = parse_zip(&bytes);
            if scores.is_empty() {
                Some(if warnings.is_empty() { "Epoch's download had no scores".to_string() } else { warnings.join("; ") })
            } else {
                (cache.scores, cache.groups, cache.eci, cache.etag, cache.fetched_at) = (scores, groups, eci, etag, now);
                (!warnings.is_empty()).then(|| warnings.join("; "))
            }
        }
        Err(e) => Some(e),
    };
    let price_error = match fetch_prices().await {
        Ok(prices) if !prices.is_empty() => {
            cache.prices = prices;
            None
        }
        Ok(_) => None,
        Err(e) => Some(format!("Couldn't refresh prices: {e}")),
    };
    cache.last_error = zip_error.or(price_error);
    let _ = save(data, &cache);
    cache
}

fn cache_path(data: &Path) -> PathBuf {
    data.join(CACHE_FILE)
}

pub fn load(data: &Path) -> Option<MetricsCache> {
    serde_json::from_slice(&std::fs::read(cache_path(data)).ok()?).ok()
}

/// Write through a temp file, so a crash never leaves half a cache.
pub fn save(data: &Path, cache: &MetricsCache) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("Couldn't save benchmark data: {e}");
    std::fs::create_dir_all(data).map_err(fail)?;
    let path = cache_path(data);
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(cache).map_err(|e| e.to_string())?).map_err(fail)?;
    std::fs::rename(&temp, &path).map_err(fail)
}

/// Download Epoch's zip, or learn that the saved copy is still current.
async fn fetch_zip(etag: Option<String>) -> Result<Fetched, String> {
    let mut call = reqwest::Client::new().get(EPOCH_ZIP).timeout(Duration::from_secs(30));
    if let Some(etag) = etag {
        call = call.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let mut response = call.send().await.map_err(|e| format!("Couldn't reach epoch.ai: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::NotModified);
    }
    if !status.is_success() {
        return Err(format!("epoch.ai returned {status}"));
    }
    let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    if response.content_length().is_some_and(|n| n > MAX_BYTES) {
        return Err("Epoch's download is too big".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Couldn't download from epoch.ai: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > MAX_BYTES {
            return Err("Epoch's download is too big".into());
        }
    }
    Ok(Fetched::Body(body, etag))
}

/// Deck model ids that Epoch spells differently: (Deck id, Epoch base id,
/// also matches a local copy). DeepSeek's own API calls V4.1 Flash
/// `deepseek-flash`. A local model only ever matches through this table,
/// because a name on someone's own server proves nothing, and a local
/// entry also matches quantised copies such as `qwen3.5-9b-mlx-4bit`.
const OVERRIDES: &[(&str, &str, bool)] = &[("qwen3.5-9b", "qwen3.5-9b", true), ("deepseek-flash", "deepseek-v4.1-flash", false)];

/// The row for a model with no reasoning setting.
const NO_LEVELS: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LevelState {
    Measured,
    NotMeasured,
}

/// One reasoning level the bot offers, with each test's score there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LevelRow {
    pub effort: String,
    pub state: LevelState,
    /// Test id → score, only for tests that ran at this level.
    pub scores: HashMap<String, f64>,
}

/// A pill's number and the level it was measured at, which can differ
/// from the bot's own level when that one was never tested.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PillValue {
    pub value: f64,
    pub from_level: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelMetrics {
    /// Epoch's name for the model, such as "Claude Opus 5.5".
    pub name: String,
    pub rows: Vec<LevelRow>,
    pub current: Option<String>,
    /// Test id → the score shown on the pill.
    pub pills: HashMap<String, PillValue>,
    /// Test id → top score across levels, for the ★; only when the test
    /// ran at two or more of the bot's levels.
    pub best: HashMap<String, f64>,
    pub eci: Option<f64>,
    /// US dollars per million tokens, input and output.
    pub price: Option<(f64, f64)>,
    /// Scores are for the public model, run here from a local copy.
    pub local_note: bool,
    pub fetched_at: u64,
    pub last_error: Option<String>,
}

/// Lowercase, keep only the file name of a local model path, and drop a
/// dated `-YYYYMMDD` suffix.
fn normalize(model: &str) -> String {
    let name = model.trim_end_matches('/').rsplit('/').next().unwrap_or(model).to_lowercase();
    match name.rsplit_once('-') {
        Some((base, date)) if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) => base.to_string(),
        _ => name,
    }
}

/// OpenRouter writes `claude-opus-5.5` where Deck and Epoch write `claude-opus-5-5`.
fn same_id(a: &str, b: &str) -> bool {
    a.replace('.', "-").eq_ignore_ascii_case(&b.replace('.', "-"))
}

/// Match a bot's model and reasoning levels to the cached scores. `None`
/// means Epoch has nothing for this model.
pub fn match_model(model: &str, efforts: &[String], current: Option<&str>, local: bool, cache: &MetricsCache) -> Option<ModelMetrics> {
    let id = normalize(model);
    let entry = OVERRIDES.iter().find(|(deck, _, local_ok)| id == *deck || (*local_ok && id.starts_with(&format!("{deck}-"))));
    let base = match entry {
        Some((_, base, local_ok)) if *local_ok || !local => base.to_string(),
        _ if local => return None,
        _ => id,
    };
    // `<base>_<level>` exactly, so a dated re-run `<base>-1017_<level>`
    // never stands in for the model itself.
    let level_of = |version: &str| -> Option<String> {
        let version = version.to_lowercase();
        match version.rsplit_once('_') {
            Some((b, level)) if b == base => Some(level.to_string()),
            None if version == base => Some(String::new()),
            _ => None,
        }
    };
    let group = cache.groups.iter().find(|(version, _)| level_of(version).is_some()).map(|(_, group)| group.clone());
    let mut by_level: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for score in &cache.scores {
        if let Some(level) = level_of(&score.model_version) {
            by_level.entry(level).or_default().insert(score.test.clone(), score.value);
        }
    }
    if group.is_none() && by_level.is_empty() {
        return None;
    }

    // A model with no levels gets one row from its `_none` or bare entry.
    let (offered, current): (Vec<String>, Option<String>) = if efforts.is_empty() {
        let scores = by_level.remove("none").or_else(|| by_level.remove("")).unwrap_or_default();
        by_level = HashMap::from([(NO_LEVELS.to_string(), scores)]);
        (vec![NO_LEVELS.to_string()], Some(NO_LEVELS.to_string()))
    } else {
        (efforts.to_vec(), current.map(str::to_string))
    };
    let rows: Vec<LevelRow> = offered
        .iter()
        .map(|effort| {
            let scores = by_level.get(effort).cloned().unwrap_or_default();
            let state = if scores.is_empty() { LevelState::NotMeasured } else { LevelState::Measured };
            LevelRow { effort: effort.clone(), state, scores }
        })
        .collect();

    let (mut pills, mut best) = (HashMap::new(), HashMap::new());
    let at = current.as_deref().and_then(|c| offered.iter().position(|e| e == c));
    for test in TESTS {
        let measured: Vec<(usize, f64)> = rows.iter().enumerate().filter_map(|(i, row)| Some((i, *row.scores.get(test.id)?))).collect();
        if measured.len() >= 2 {
            best.insert(test.id.to_string(), measured.iter().map(|(_, v)| *v).fold(f64::MIN, f64::max));
        }
        // The nearest tested level; on a tie the lower one, so a pill
        // never overstates the bot's own level.
        if let Some(at) = at {
            if let Some((i, value)) = measured.iter().min_by_key(|(i, _)| (i.abs_diff(at), *i)) {
                pills.insert(test.id.to_string(), PillValue { value: *value, from_level: rows[*i].effort.clone() });
            }
        }
    }

    let price = (!local)
        .then(|| cache.prices.iter().find(|(id, _)| !id.contains(':') && id.rsplit_once('/').is_some_and(|(_, name)| same_id(name, &base))))
        .flatten()
        .map(|(_, price)| *price);
    Some(ModelMetrics {
        name: group.clone().unwrap_or_else(|| base.clone()),
        rows,
        current,
        pills,
        best,
        eci: group.and_then(|g| cache.eci.get(&g).copied()),
        price,
        local_note: local,
        fetched_at: cache.fetched_at,
        last_error: cache.last_error.clone(),
    })
}

/// OpenRouter's public price list, keyed by its model id.
async fn fetch_prices() -> Result<HashMap<String, (f64, f64)>, String> {
    let models = crate::api_info::models(OPENROUTER, None).await?;
    Ok(models.into_iter().filter_map(|m| Some((m.id, (m.price_in?, m.price_out?)))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const ARC: &str = "Model version,Score,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Name,Cost per task,Notes,id\n\
gpt-6.1-sol_medium,0.8666666666666667,2026-09-29,OpenAI,United States of America,,,GPT-6.1 Sol (Medium),,,rec1\n\
gpt-6.1-sol_high,0.9166666666666666,2026-09-29,OpenAI,United States of America,,,GPT-6.1 Sol (High),,,rec2\n\
claude-opus-5-5_high,0.9333333333333333,2026-09-22,Anthropic,United States of America,,,Claude Opus 5.5 (High),,,rec3\n\
claude-opus-5-5_medium,0.875,2026-09-22,Anthropic,United States of America,,,Claude Opus 5.5 (Medium),,,rec4\n";
    const CODE: &str = "Model version,Main score,Harness,Reasoning effort,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Name,Aggregation,Source,Notes\n\
gpt-6.1-sol_medium,0.5023,codex,medium,2026-09-29,OpenAI,United States of America,,,GPT-6.1 Sol,Mean@5,https://cognition.com/frontiercode,\n\
copied-model_medium,0.41,x,medium,2026-09-01,Lab,\"Somewhere, Else\",,\"notes, with a comma\",Copied,Mean@5,https://artificialanalysis.ai/evaluations/scicode,\n";
    const CURSOR: &str = "Model version,Score,Reasoning level,Cost per task,Tokens per task,Steps per task,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Name,Rank,Source,Notes\n\
claude-opus-5-5_high,0.56,High,3.97,53078,68,2026-09-22,Anthropic,United States of America,,,Opus 5.5 High,3,https://cursor.com/cursorbench,\n";
    const DEEPSWE: &str = "Model version,Pass@1,Pass@4,Harness,Reasoning effort,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Name,95% CI half-width,Runs,Mean cost (USD),Mean output tokens,Mean agent steps,Source,Notes\n\
gpt-5.6-sol_max,0.7266666666666667,,x,max,2026-06-01,OpenAI,United States of America,,,GPT-5.6 Sol,,,,,,https://deepswe.datacurve.ai/,\n";
    const META: &str = "model_version,model_group,date,display_name,organization,country,accessibility,training_compute_flop\n\
gpt-6.1-sol_medium,GPT-6.1 Sol,2026-09-29,GPT-6.1 Sol (medium),OpenAI,United States of America,API access,\n\
claude-opus-5-5_high,Claude Opus 5.5,2026-09-22,Claude Opus 5.5 (high),Anthropic,United States of America,API access,\n";
    const ECI: &str = "Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization,Country (of organization),Model accessibility,Accessibility group,model_versions\n\
GPT-6.1 Sol,GPT-6.1 Sol,168.37,165.0,174.43,2026-09-29,OpenAI,United States of America,API access,Closed weights,\n\
Claude Opus 5.5,Claude Opus 5.5,168.83,165.25,173.95,2026-09-22,Anthropic,United States of America,API access,Closed weights,\n";

    /// A small Epoch zip built in memory: real rows for our models, plus one
    /// row copied from Artificial Analysis that must never come through.
    fn epoch_zip(skip: &[&str]) -> Vec<u8> {
        let files = [
            ("arc_agi_2_external.csv", ARC),
            ("frontiercode_external.csv", CODE),
            ("cursorbench_external.csv", CURSOR),
            ("deepswe_external.csv", DEEPSWE),
            ("model_metadata.csv", META),
            ("epoch_capabilities_index/eci_scores.csv", ECI),
            ("README.md", "Epoch AI benchmark data\n"),
        ];
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in files.into_iter().filter(|(name, _)| !skip.contains(name)) {
            out.start_file(name, options).unwrap();
            out.write_all(body.as_bytes()).unwrap();
        }
        out.finish().unwrap().into_inner()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-model-metrics-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn saved(dir: &Path, fetched_at: u64) -> MetricsCache {
        let cache = MetricsCache {
            fetched_at,
            tried_at: fetched_at,
            etag: Some("\"abc\"".into()),
            scores: vec![Score { test: "arc".into(), model_version: "gpt-6.1-sol_medium".into(), value: 86.7 }],
            groups: HashMap::from([("gpt-6.1-sol_medium".into(), "GPT-6.1 Sol".into())]),
            eci: HashMap::from([("GPT-6.1 Sol".into(), 168.37)]),
            prices: HashMap::from([("openai/gpt-6.1-sol".into(), (2.0, 10.0))]),
            last_error: None,
        };
        save(dir, &cache).unwrap();
        cache
    }

    fn no_prices() -> std::future::Ready<Result<HashMap<String, (f64, f64)>, String>> {
        std::future::ready(Ok(HashMap::new()))
    }

    #[test]
    fn parses_fixture() {
        let (scores, groups, eci, warnings) = parse_zip(&epoch_zip(&[]));
        let sol = scores.iter().find(|s| s.test == "arc" && s.model_version == "gpt-6.1-sol_medium").expect("arc score for Sol medium");
        assert!((sol.value - 86.7).abs() < 0.05, "{}", sol.value);
        let code = scores.iter().find(|s| s.test == "code" && s.model_version == "gpt-6.1-sol_medium").expect("code score for Sol medium");
        assert!((code.value - 50.23).abs() < 0.005, "{}", code.value);
        assert!(scores.iter().any(|s| s.test == "cursor" && s.model_version == "claude-opus-5-5_high"));
        assert!(scores.iter().any(|s| s.test == "deepswe" && s.model_version == "gpt-5.6-sol_max"));
        assert_eq!(groups["gpt-6.1-sol_medium"], "GPT-6.1 Sol");
        assert_eq!(eci["GPT-6.1 Sol"], 168.37);
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn aa_rows_are_dropped() {
        let (scores, ..) = parse_zip(&epoch_zip(&[]));
        assert!(!scores.iter().any(|s| s.model_version == "copied-model_medium"), "{scores:?}");
    }

    #[test]
    fn missing_test_file_skips_only_that_test() {
        let (scores, _, _, warnings) = parse_zip(&epoch_zip(&["cursorbench_external.csv"]));
        assert!(scores.iter().any(|s| s.test == "arc"));
        assert!(!scores.iter().any(|s| s.test == "cursor"));
        assert!(warnings.iter().any(|w| w.contains("cursorbench_external.csv")), "{warnings:?}");
    }

    #[test]
    fn renamed_score_column_skips_only_that_test() {
        let renamed = ARC.replacen("Score", "Accuracy", 1);
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in [("arc_agi_2_external.csv", renamed.as_str()), ("frontiercode_external.csv", CODE)] {
            out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            out.write_all(body.as_bytes()).unwrap();
        }
        let (scores, _, _, warnings) = parse_zip(&out.finish().unwrap().into_inner());
        assert!(!scores.iter().any(|s| s.test == "arc"));
        assert!(scores.iter().any(|s| s.test == "code"));
        assert!(warnings.iter().any(|w| w.contains("arc_agi_2_external.csv") && w.contains("Score")), "{warnings:?}");
    }

    #[tokio::test]
    async fn fresh_cache_skips_network() {
        let dir = scratch("fresh");
        let old = saved(&dir, 1_000);
        let got = current_with(&dir, 1_000 + 3_600, |_| async { panic!("fetched a fresh cache") }, || async { panic!("fetched a fresh cache") }).await;
        assert_eq!(got, old);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_cache_refreshes_scores_and_prices() {
        let dir = scratch("stale");
        saved(&dir, 1_000);
        let now = 1_000 + DAY + 5;
        let body = epoch_zip(&[]);
        let got = current_with(
            &dir,
            now,
            |_| async move { Ok(Fetched::Body(body, Some("\"new\"".into()))) },
            || std::future::ready(Ok(HashMap::from([("openai/gpt-6.1-sol".to_string(), (2.5, 12.0))]))),
        )
        .await;
        assert_eq!(got.fetched_at, now);
        assert_eq!(got.etag.as_deref(), Some("\"new\""));
        assert!(got.scores.iter().any(|s| s.test == "cursor"));
        assert_eq!(got.prices["openai/gpt-6.1-sol"], (2.5, 12.0));
        assert_eq!(got.last_error, None);
        assert_eq!(load(&dir), Some(got), "the refresh is saved");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_refresh_keeps_cache() {
        let dir = scratch("failed");
        let old = saved(&dir, 1_000);
        let got = current_with(&dir, 1_000 + DAY + 5, |_| async { Err("timed out".to_string()) }, no_prices).await;
        assert_eq!(got.scores, old.scores);
        assert_eq!(got.fetched_at, 1_000);
        assert_eq!(got.prices, old.prices, "an empty price list keeps the old prices");
        assert_eq!(got.last_error.as_deref(), Some("timed out"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_refresh_waits_an_hour_before_retrying() {
        let dir = scratch("retry");
        saved(&dir, 1_000);
        let failed_at = 1_000 + DAY + 5;
        current_with(&dir, failed_at, |_| async { Err("timed out".to_string()) }, no_prices).await;
        let soon = current_with(&dir, failed_at + 60, |_| async { panic!("retried within the hour") }, || async { panic!("retried within the hour") }).await;
        assert_eq!(soon.last_error.as_deref(), Some("timed out"));
        let later = current_with(&dir, failed_at + RETRY_AFTER, |_| async { Ok(Fetched::NotModified) }, no_prices).await;
        assert_eq!(later.last_error, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unreadable_download_keeps_cache() {
        let dir = scratch("unreadable");
        let old = saved(&dir, 1_000);
        let got = current_with(&dir, 1_000 + DAY + 5, |_| async { Ok(Fetched::Body(b"<html>maintenance</html>".to_vec(), Some("\"bad\"".into()))) }, no_prices).await;
        assert_eq!(got.scores, old.scores);
        assert_eq!(got.fetched_at, 1_000);
        assert_eq!(got.etag, old.etag, "a bad body's etag would turn the next refresh into a 304");
        assert!(got.last_error.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn not_modified_keeps_rows() {
        let dir = scratch("not-modified");
        let old = saved(&dir, 1_000);
        let now = 1_000 + DAY + 5;
        let got = current_with(
            &dir,
            now,
            |etag| {
                assert_eq!(etag.as_deref(), Some("\"abc\""), "the saved etag is sent");
                async { Ok(Fetched::NotModified) }
            },
            || async { Err("prices down".to_string()) },
        )
        .await;
        assert_eq!(got.scores, old.scores);
        assert_eq!(got.fetched_at, now);
        assert_eq!(got.prices, old.prices);
        assert_eq!(got.last_error.as_deref(), Some("Couldn't refresh prices: prices down"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn first_run_without_network_is_empty_with_reason() {
        let dir = scratch("first");
        let got = current_with(&dir, 50_000, |etag| {
            assert_eq!(etag, None);
            async { Err("offline".to_string()) }
        }, no_prices)
        .await;
        assert!(got.scores.is_empty());
        assert_eq!(got.fetched_at, 0);
        assert_eq!(got.last_error.as_deref(), Some("offline"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Downloads the real zip. Run by hand:
    /// `cargo test -p apex-adapters model_metrics -- --ignored live_epoch_download`
    #[tokio::test]
    #[ignore]
    async fn live_epoch_download() {
        let Fetched::Body(bytes, etag) = fetch_zip(None).await.expect("download") else { panic!("304 without an etag") };
        assert!(etag.is_some(), "Epoch sends an ETag");
        let (scores, groups, eci, warnings) = parse_zip(&bytes);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(scores.iter().any(|s| s.test == "arc" && s.model_version == "claude-opus-5-5_high"), "{} scores", scores.len());
        assert_eq!(groups.get("claude-opus-5-5_high").map(String::as_str), Some("Claude Opus 5.5"));
        assert!(eci.contains_key("Claude Opus 5.5"));
        let prices = fetch_prices().await.expect("OpenRouter prices");
        assert!(!prices.is_empty());
        let cache = MetricsCache { scores, groups, eci, prices, ..Default::default() };
        let all: Vec<String> = ["low", "medium", "high", "xhigh", "max"].map(String::from).to_vec();
        let no_xhigh: Vec<String> = ["low", "medium", "high", "max"].map(String::from).to_vec();
        let deepgeek = match_model("deepseek-flash", &no_xhigh, Some("medium"), false, &cache).expect("deepgeek");
        assert_eq!(deepgeek.name, "DeepSeek V4.1 Flash");
        assert_eq!(deepgeek.pills["arc"].from_level, "low");
        assert!(deepgeek.price.is_some());
        let opus = match_model("claude-opus-5-5", &all, Some("high"), false, &cache).expect("Opus");
        assert_eq!(opus.pills["code"].from_level, "medium");
        assert!(opus.price.is_some() && opus.eci.is_some());
        let gwen = match_model("/models/Qwen3.5-9B-MLX-4bit", &[], None, true, &cache).expect("Gwen");
        assert!(gwen.local_note && gwen.eci.is_some());
    }

    /// Real scores from Epoch's 2026-10-28 download, trimmed.
    fn matched_cache() -> MetricsCache {
        let rows: &[(&str, &str, f64)] = &[
            ("arc", "gpt-6.1-sol_low", 76.67),
            ("arc", "gpt-6.1-sol_medium", 86.67),
            ("arc", "gpt-6.1-sol_high", 91.67),
            ("arc", "gpt-6.1-sol_xhigh", 91.67),
            ("arc", "gpt-6.1-sol_max", 94.17),
            ("code", "gpt-6.1-sol_medium", 50.23),
            ("arc", "claude-opus-5-5_medium", 87.5),
            ("arc", "claude-opus-5-5_high", 93.33),
            ("code", "claude-opus-5-5_medium", 54.64),
            ("cursor", "claude-opus-5-5_high", 56.0),
            ("arc", "deepseek-v4.1-flash_none", 1.25),
            ("arc", "deepseek-v4.1-flash_low", 60.56),
            ("arc", "deepseek-v4.1-flash_high", 67.5),
            ("arc", "deepseek-v4.1-flash_max", 72.92),
            ("arc", "deepseek-v4.1-flash-1017_max", 80.0),
            ("code", "deepseek-v4.1-flash_high", 43.87),
            ("arc", "qwen3.5-9B_none", 2.5),
        ];
        let groups = [
            ("gpt-6.1-sol_medium", "GPT-6.1 Sol"),
            ("claude-opus-5-5_high", "Claude Opus 5.5"),
            ("deepseek-v4.1-flash_max", "DeepSeek V4.1 Flash"),
            ("deepseek-v4.1-flash-1017_max", "DeepSeek V4.1 Flash 1017"),
            ("qwen3.5-9B_none", "Qwen3.5-9B"),
        ];
        MetricsCache {
            fetched_at: 1_000,
            scores: rows.iter().map(|(test, model, value)| Score { test: (*test).into(), model_version: (*model).into(), value: *value }).collect(),
            groups: groups.iter().map(|(v, g)| ((*v).into(), (*g).into())).collect(),
            eci: HashMap::from([("GPT-6.1 Sol".into(), 168.37), ("Claude Opus 5.5".into(), 168.83), ("DeepSeek V4.1 Flash".into(), 155.93), ("Qwen3.5-9B".into(), 139.32)]),
            prices: HashMap::from([
                ("openai/gpt-6.1-sol".into(), (2.0, 10.0)),
                ("openai/gpt-6.1-sol:batch".into(), (1.0, 5.0)),
                ("anthropic/claude-opus-5.5".into(), (4.0, 20.0)),
                ("deepseek/deepseek-v4.1-flash".into(), (0.14, 0.42)),
                ("deepseek/deepseek-v4.1-flash-1017".into(), (0.15, 0.6)),
                ("qwen/qwen3.5-9b".into(), (0.17, 0.25)),
            ]),
            ..Default::default()
        }
    }

    fn levels(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    const ALL: &[&str] = &["low", "medium", "high", "xhigh", "max"];

    #[test]
    fn per_level_rows() {
        let m = match_model("gpt-6.1-sol", &levels(ALL), Some("medium"), false, &matched_cache()).expect("Sol matches");
        assert_eq!(m.name, "GPT-6.1 Sol");
        assert_eq!(m.rows.iter().map(|r| r.effort.as_str()).collect::<Vec<_>>(), ALL);
        assert!(m.rows.iter().all(|r| r.state == LevelState::Measured), "{:?}", m.rows);
        assert!((m.rows[1].scores["arc"] - 86.7).abs() < 0.05);
        assert_eq!(m.pills["arc"], PillValue { value: 86.67, from_level: "medium".into() });
        assert_eq!(m.eci, Some(168.37));
        assert_eq!(m.price, Some((2.0, 10.0)), "the :batch price is never used");
        assert!(!m.local_note);
    }

    #[test]
    fn nearest_measured_is_tagged() {
        let m = match_model("deepseek-flash", &levels(&["low", "medium", "high", "max"]), Some("medium"), false, &matched_cache()).expect("deepgeek matches");
        // Low and high are equally near; the lower one never overstates.
        assert_eq!(m.pills["arc"].from_level, "low");
        assert_eq!(m.rows[1].effort, "medium");
        assert_eq!(m.rows[1].state, LevelState::NotMeasured);
        assert!(m.rows[1].scores.is_empty());
        assert!(!m.rows.iter().any(|r| r.effort == "none"), "levels the bot doesn't offer get no row");
    }

    #[test]
    fn per_test_borrowing() {
        let m = match_model("claude-opus-5-5", &levels(ALL), Some("high"), false, &matched_cache()).expect("Opus matches");
        assert_eq!(m.pills["code"], PillValue { value: 54.64, from_level: "medium".into() });
        assert_eq!(m.pills["arc"].from_level, "high");
        assert_eq!(m.price, Some((4.0, 20.0)), "OpenRouter writes 5.5 where Deck writes 5-5");
    }

    #[test]
    fn best_needs_two_measured_levels() {
        let m = match_model("gpt-6.1-sol", &levels(ALL), Some("medium"), false, &matched_cache()).unwrap();
        assert_eq!(m.best.get("arc"), Some(&94.17));
        assert_eq!(m.best.get("code"), None, "one tested level has nothing to compare");
    }

    #[test]
    fn dated_rerun_does_not_replace_base() {
        let m = match_model("deepseek-flash", &levels(&["low", "medium", "high", "max"]), Some("max"), false, &matched_cache()).unwrap();
        assert_eq!(m.rows[3].scores["arc"], 72.92);
        assert_eq!(m.name, "DeepSeek V4.1 Flash");
        assert_eq!(m.price, Some((0.14, 0.42)));
    }

    #[test]
    fn case_insensitive_match() {
        let m = match_model("Qwen3.5-9b", &[], None, false, &matched_cache()).expect("qwen3.5-9B_none matches");
        assert_eq!(m.rows.len(), 1);
        assert_eq!(m.rows[0].effort, "default");
        assert_eq!(m.rows[0].scores["arc"], 2.5);
        assert_eq!(m.pills["arc"].from_level, "default");
        assert_eq!(m.eci, Some(139.32));
        let dated = match_model("claude-opus-5-5-20260922", &levels(ALL), Some("high"), false, &matched_cache());
        assert_eq!(dated.map(|m| m.name), Some("Claude Opus 5.5".into()), "a -YYYYMMDD suffix is dropped");
    }

    #[test]
    fn local_model_matches_only_through_override() {
        let gwen = "/Users/someone/models/Qwen3.5-9B-MLX-4bit";
        let m = match_model(gwen, &[], None, true, &matched_cache()).expect("Gwen's local Qwen matches");
        assert!(m.local_note);
        assert_eq!(m.eci, Some(139.32));
        assert_eq!(m.price, None, "a local model costs nothing to run");
        assert!(match_model("gpt-6.1-sol", &levels(ALL), Some("medium"), true, &matched_cache()).is_none(), "a local server's model name proves nothing");
    }

    #[test]
    fn override_table_wins() {
        assert_eq!(match_model("deepseek-flash", &[], None, false, &matched_cache()).map(|m| m.name), Some("DeepSeek V4.1 Flash".into()));
    }

    #[test]
    fn unknown_model_is_none() {
        assert!(match_model("made-up-1", &levels(ALL), Some("high"), false, &matched_cache()).is_none());
    }
}
