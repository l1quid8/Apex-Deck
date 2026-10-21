// SPDX-License-Identifier: Apache-2.0
//! Gateway API keys (`gateway-keys.json`).
//!
//! Only the local host user (`Trust::Local` over `daemon.sock` or the local CLI
//! holding `daemon.lock`) can issue, list, or revoke gateway keys. Raw tokens
//! (`apx_sk_<64 hex>`) are returned **once** on issuance; only their SHA-256
//! digest and a redacted display prefix are stored on disk.

use crate::files;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Filename inside `<data>`.
pub const FILE: &str = "gateway-keys.json";

/// Token prefix for all gateway bearer keys.
pub const TOKEN_PREFIX: &str = "apx_sk_";

const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_MONTH: u64 = 30 * SECONDS_PER_DAY;

/// Backend family a gateway key may access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyScope {
    /// Subscription CLIs (`claude`, `codex`, `gemini`, `grok`, `muse`).
    Sub,
    /// OpenAI-compatible HTTP API providers (`openai`, `openrouter`, `xai`, `deepseek`, `venice`, `groq`, saved API profiles).
    Api,
    /// Saved custom CLI command profiles (`Backend::Cli`).
    Cli,
}

impl KeyScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sub => "sub",
            Self::Api => "api",
            Self::Cli => "cli",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "sub" | "subscription" | "subscriptions" => Ok(Self::Sub),
            "api" | "http" | "provider" | "providers" => Ok(Self::Api),
            "cli" | "custom" => Ok(Self::Cli),
            other => Err(format!(
                "unknown scope '{other}' (expected sub, api, or cli)"
            )),
        }
    }

    pub fn default_scopes() -> Vec<Self> {
        vec![Self::Sub, Self::Api]
    }

    pub fn all_scopes() -> Vec<Self> {
        vec![Self::Sub, Self::Api, Self::Cli]
    }
}

/// Persisted record for a single gateway key. Never holds the raw secret token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayKey {
    /// Short identifier used by `keys list` and `keys revoke <id>`.
    pub id: String,
    /// Human-readable label (e.g., `"alex-laptop"` or `"my-test-box"`).
    pub label: String,
    /// Redacted prefix shown in `keys list` (e.g., `"apx_sk_1a2b...9f0e"`).
    pub prefix: String,
    /// Lowercase hex SHA-256 digest of the full `apx_sk_...` bearer token.
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub token_sha256: String,
    /// Allowed backend scopes (`sub`, `api`, `cli`).
    pub scopes: Vec<KeyScope>,
    /// Whether subscription CLI turns may invoke configured MCP servers
    /// (`hl_mcp`, `x_mcp`, etc.) without interactive prompts.
    /// Defaults to `false` so friend keys cannot trigger personal MCP tools.
    #[serde(default)]
    pub allow_mcp: bool,
    /// Optional daily turn cap across subscription CLI turns (or all turns).
    #[serde(default)]
    pub max_turns_per_day: Option<u64>,
    /// Optional monthly API spend cap in microdollars ($1.00 = 1_000_000).
    #[serde(default)]
    pub max_usd_micros_per_month: Option<u64>,
    /// UTC day bucket (`unix_seconds / 86_400`) for `turns_today`.
    #[serde(default)]
    pub day_bucket: u64,
    /// Turns used in `day_bucket`.
    #[serde(default)]
    pub turns_today: u64,
    /// Rolling 30-day bucket (`unix_seconds / (30 * 86_400)`) for `spend_micros_month`.
    #[serde(default)]
    pub month_bucket: u64,
    /// API spend in microdollars accumulated in `month_bucket`.
    #[serde(default)]
    pub spend_micros_month: u64,
    /// Lifetime turns completed with this key.
    #[serde(default)]
    pub total_turns: u64,
    /// Lifetime API spend in microdollars.
    #[serde(default)]
    pub total_spend_micros: u64,
    /// Unix seconds when issued.
    pub created_at: u64,
    /// Unix seconds when last used for a request, if ever.
    #[serde(default)]
    pub last_used_at: Option<u64>,
}

impl GatewayKey {
    /// Return a public view with `token_sha256` stripped for list responses.
    pub fn redacted(&self) -> Self {
        let mut copy = self.clone();
        copy.token_sha256.clear();
        copy
    }

    pub fn has_scope(&self, scope: KeyScope) -> bool {
        self.scopes.contains(&scope)
    }
}

/// Parameters for issuing a new gateway key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueSpec {
    pub label: String,
    pub scopes: Vec<KeyScope>,
    #[serde(default)]
    pub allow_mcp: bool,
    #[serde(default)]
    pub max_turns_per_day: Option<u64>,
    #[serde(default)]
    pub max_usd_micros_per_month: Option<u64>,
}

/// Returned once when a key is newly created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssuedKey {
    /// Full secret bearer token (`apx_sk_<64 hex>`). Shown only at creation.
    pub token: String,
    /// Redacted metadata stored in `gateway-keys.json`.
    pub key: GatewayKey,
}

/// Why a bearer token or turn reservation was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    MissingBearer,
    InvalidToken,
    Revoked,
    ScopeDenied(KeyScope),
    DailyTurnCapExceeded { limit: u64 },
    MonthlySpendCapExceeded { limit_micros: u64 },
}

impl AuthError {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::MissingBearer | Self::InvalidToken | Self::Revoked => 401,
            Self::ScopeDenied(_) => 403,
            Self::DailyTurnCapExceeded { .. } | Self::MonthlySpendCapExceeded { .. } => 429,
        }
    }

    pub fn error_type(&self) -> &'static str {
        match self {
            Self::MissingBearer | Self::InvalidToken | Self::Revoked => "invalid_request_error",
            Self::ScopeDenied(_) => "permission_error",
            Self::DailyTurnCapExceeded { .. } | Self::MonthlySpendCapExceeded { .. } => {
                "rate_limit_error"
            }
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::MissingBearer => {
                "Missing Authorization: Bearer apx_sk_... header.".to_string()
            }
            Self::InvalidToken => "Invalid API key provided.".to_string(),
            Self::Revoked => "This API key has been revoked.".to_string(),
            Self::ScopeDenied(scope) => format!(
                "This API key does not have permission for '{}' models.",
                scope.as_str()
            ),
            Self::DailyTurnCapExceeded { limit } => {
                format!("Daily turn limit ({limit} turns/day) exceeded for this API key.")
            }
            Self::MonthlySpendCapExceeded { limit_micros } => {
                let usd = *limit_micros as f64 / 1_000_000.0;
                format!("Monthly spend limit (${usd:.2}/month) exceeded for this API key.")
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    keys: Vec<GatewayKey>,
    /// Revoked key ids, so `reserve_turn` can reject an in-flight turn.
    #[serde(default)]
    revoked: BTreeSet<String>,
    /// Revoked token digests, so `authenticate` can answer `Revoked` instead of
    /// `InvalidToken` once the key record itself is gone.
    #[serde(default)]
    revoked_digests: BTreeSet<String>,
}

/// Thread-safe registry of gateway keys backed by `<data>/gateway-keys.json`.
pub struct GatewayKeys {
    path: PathBuf,
    store: Mutex<Store>,
    revoked_tx: broadcast::Sender<String>,
}

impl GatewayKeys {
    /// Load `<data>/gateway-keys.json`, or start with an empty registry if absent.
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join(FILE);
        let mut store = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str::<Store>(&raw)
                .map_err(|e| format!("corrupt {}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::default(),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        };

        // Older files (and a crash between "delete the key" and "write the
        // tombstone") can leave a revoked id still present as a live key. Move
        // its digest into the tombstone so `authenticate` says Revoked, not
        // InvalidToken.
        if !store.revoked.is_empty() {
            let revoked = &store.revoked;
            let (dead, live): (Vec<GatewayKey>, Vec<GatewayKey>) = std::mem::take(&mut store.keys)
                .into_iter()
                .partition(|k| revoked.contains(&k.id));
            for k in dead {
                if !k.token_sha256.is_empty() {
                    store.revoked_digests.insert(k.token_sha256);
                }
            }
            store.keys = live;
        }

        let (revoked_tx, _) = broadcast::channel(64);
        Ok(Self {
            path,
            store: Mutex::new(store),
            revoked_tx,
        })
    }

    /// Subscribe to key revocation events (emits key `id` immediately upon `revoke`).
    pub fn subscribe_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked_tx.subscribe()
    }

    /// List active keys (with `token_sha256` stripped).
    pub fn list(&self) -> Vec<GatewayKey> {
        let mut s = self.lock();
        let now = now_unix();
        for k in &mut s.keys {
            refresh_buckets(k, now);
        }
        s.keys.iter().map(GatewayKey::redacted).collect()
    }

    /// Issue a new `apx_sk_...` key and persist its SHA-256 hash to disk.
    pub fn issue(&self, spec: IssueSpec) -> Result<IssuedKey, String> {
        let label = sanitize_label(&spec.label);
        if label.is_empty() {
            return Err("key label cannot be empty".to_string());
        }
        let mut scopes = spec.scopes;
        if scopes.is_empty() {
            scopes = KeyScope::default_scopes();
        }
        scopes.sort();
        scopes.dedup();

        let id = random_hex(6)?; // 12 hex chars
        let secret_hex = random_hex(32)?; // 64 hex chars (256 bits of entropy)
        let token = format!("{TOKEN_PREFIX}{secret_hex}");
        let prefix = format!(
            "{TOKEN_PREFIX}{}...{}",
            &secret_hex[..4],
            &secret_hex[secret_hex.len() - 4..]
        );
        let token_sha256 = sha256_hex(&token);
        let now = now_unix();

        let key = GatewayKey {
            id,
            label,
            prefix,
            token_sha256,
            scopes,
            allow_mcp: spec.allow_mcp,
            max_turns_per_day: spec.max_turns_per_day.filter(|&n| n > 0),
            max_usd_micros_per_month: spec.max_usd_micros_per_month.filter(|&n| n > 0),
            day_bucket: now / SECONDS_PER_DAY,
            turns_today: 0,
            month_bucket: now / SECONDS_PER_MONTH,
            spend_micros_month: 0,
            total_turns: 0,
            total_spend_micros: 0,
            created_at: now,
            last_used_at: None,
        };

        let mut s = self.lock();
        s.keys.push(key.clone());
        self.save(&s)?;

        Ok(IssuedKey {
            token,
            key: key.redacted(),
        })
    }

    /// Revoke a key by `id` (or prefix/label match if unambiguous), persist the
    /// tombstone, and notify any active streaming response to abort immediately.
    pub fn revoke(&self, id_or_label: &str) -> Result<bool, String> {
        let needle = id_or_label.trim();
        if needle.is_empty() {
            return Err("key id cannot be empty".to_string());
        }
        let mut s = self.lock();
        let target_id = if let Some(k) = s.keys.iter().find(|k| k.id == needle) {
            Some(k.id.clone())
        } else {
            let matches: Vec<String> = s
                .keys
                .iter()
                .filter(|k| k.label == needle || k.id.starts_with(needle))
                .map(|k| k.id.clone())
                .collect();
            if matches.len() == 1 {
                Some(matches[0].clone())
            } else {
                None
            }
        };

        let Some(id) = target_id else {
            return Ok(false);
        };

        let digest = s
            .keys
            .iter()
            .find(|k| k.id == id)
            .map(|k| k.token_sha256.clone())
            .unwrap_or_default();
        let before = s.keys.len();
        s.keys.retain(|k| k.id != id);
        let removed = s.keys.len() < before;
        s.revoked.insert(id.clone());
        if !digest.is_empty() {
            s.revoked_digests.insert(digest);
        }
        self.save(&s)?;
        drop(s);

        let _ = self.revoked_tx.send(id);
        Ok(removed)
    }

    /// Verify an `Authorization: Bearer <token>` or raw `<token>` against active keys.
    ///
    /// A token that belonged to a revoked key answers [`AuthError::Revoked`] (401,
    /// "This API key has been revoked.") rather than [`AuthError::InvalidToken`],
    /// so a client that was cut off can tell the difference from a typo.
    pub fn authenticate(&self, raw_token: &str) -> Result<GatewayKey, AuthError> {
        let token = raw_token.trim();
        if !token.starts_with(TOKEN_PREFIX) || token.len() <= TOKEN_PREFIX.len() {
            return Err(AuthError::InvalidToken);
        }
        let digest = sha256_hex(token);
        let mut s = self.lock();
        for key in &mut s.keys {
            if constant_time_eq(key.token_sha256.as_bytes(), digest.as_bytes()) {
                refresh_buckets(key, now_unix());
                return Ok(key.redacted());
            }
        }
        if digest_is_revoked(&s.revoked_digests, &digest) {
            return Err(AuthError::Revoked);
        }
        Err(AuthError::InvalidToken)
    }

    /// Check scope and quota caps, then atomically increment the key's turn counter.
    pub fn reserve_turn(&self, key_id: &str, scope: KeyScope) -> Result<GatewayKey, AuthError> {
        let now = now_unix();
        let mut s = self.lock();
        if s.revoked.contains(key_id) {
            return Err(AuthError::Revoked);
        }
        let Some(key) = s.keys.iter_mut().find(|k| k.id == key_id) else {
            return Err(AuthError::InvalidToken);
        };
        if !key.has_scope(scope) {
            return Err(AuthError::ScopeDenied(scope));
        }
        refresh_buckets(key, now);

        if let Some(limit) = key.max_turns_per_day {
            if key.turns_today >= limit {
                return Err(AuthError::DailyTurnCapExceeded { limit });
            }
        }
        if let Some(limit_micros) = key.max_usd_micros_per_month {
            if key.spend_micros_month >= limit_micros {
                return Err(AuthError::MonthlySpendCapExceeded { limit_micros });
            }
        }

        key.turns_today = key.turns_today.saturating_add(1);
        key.total_turns = key.total_turns.saturating_add(1);
        key.last_used_at = Some(now);
        let snapshot = key.redacted();
        let _ = self.save(&s);
        Ok(snapshot)
    }

    /// Give back a turn reserved by [`Self::reserve_turn`] that never produced a reply.
    ///
    /// The HTTP layer reserves before it spawns a backend, so any failure after
    /// that point (bad request, backend error, client disconnect, revoked-key
    /// race) has to hand the turn back or a client can burn a day's quota on
    /// 400s. Counters saturate at zero, so a double release is harmless.
    ///
    /// If the day bucket rolled over between reserve and release, the refund
    /// lands on the new day; that under-counts by one turn at midnight, which is
    /// the harmless direction.
    pub fn release_turn(&self, key_id: &str) {
        let mut s = self.lock();
        let Some(key) = s.keys.iter_mut().find(|k| k.id == key_id) else {
            return;
        };
        key.turns_today = key.turns_today.saturating_sub(1);
        key.total_turns = key.total_turns.saturating_sub(1);
        let _ = self.save(&s);
    }

    /// Record additional API spend (in microdollars) after a turn finishes.
    pub fn record_spend(&self, key_id: &str, spend_micros: u64) {
        if spend_micros == 0 {
            return;
        }
        let now = now_unix();
        let mut s = self.lock();
        if let Some(key) = s.keys.iter_mut().find(|k| k.id == key_id) {
            refresh_buckets(key, now);
            key.spend_micros_month = key.spend_micros_month.saturating_add(spend_micros);
            key.total_spend_micros = key.total_spend_micros.saturating_add(spend_micros);
            let _ = self.save(&s);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, store: &Store) -> Result<(), String> {
        let mut json = serde_json::to_string_pretty(store)
            .map_err(|e| format!("failed to serialize gateway-keys.json: {e}"))?;
        json.push('\n');
        files::write_private(&self.path, &json)
    }
}

fn refresh_buckets(key: &mut GatewayKey, now: u64) {
    let day = now / SECONDS_PER_DAY;
    if key.day_bucket != day {
        key.day_bucket = day;
        key.turns_today = 0;
    }
    let month = now / SECONDS_PER_MONTH;
    if key.month_bucket != month {
        key.month_bucket = month;
        key.spend_micros_month = 0;
    }
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_string()
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn random_hex(bytes_len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes_len];
    getrandom::fill(&mut buf).map_err(|e| format!("OS random generator failed: {e}"))?;
    let mut out = String::with_capacity(bytes_len * 2);
    for b in buf {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    Ok(out)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Membership test that does not short-circuit on the first match, so the time
/// taken says nothing about which tombstone matched.
fn digest_is_revoked(revoked: &BTreeSet<String>, digest: &str) -> bool {
    let needle = digest.as_bytes();
    let mut found = 0u8;
    for candidate in revoked {
        if constant_time_eq(candidate.as_bytes(), needle) {
            found = 1;
        }
    }
    found == 1
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let id = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "apex-gateway-keys-test-{}-{id}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn issue_persists_hash_not_raw_token_and_authenticates() {
        let dir = temp_dir();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys
            .issue(IssueSpec {
                label: "alex-laptop".into(),
                scopes: vec![KeyScope::Sub, KeyScope::Api],
                allow_mcp: false,
                max_turns_per_day: Some(2),
                max_usd_micros_per_month: Some(5_000_000),
            })
            .unwrap();

        assert!(issued.token.starts_with("apx_sk_"));
        assert!(issued.key.token_sha256.is_empty());

        let on_disk = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(
            !on_disk.contains(&issued.token),
            "raw token must never be written to disk"
        );

        // Reload from disk and authenticate.
        let reloaded = GatewayKeys::load(&dir).unwrap();
        let authed = reloaded.authenticate(&issued.token).unwrap();
        assert_eq!(authed.id, issued.key.id);
        assert_eq!(authed.label, "alex-laptop");
        assert!(!authed.allow_mcp);

        // Scope check: Cli was not granted.
        assert_eq!(
            reloaded.reserve_turn(&authed.id, KeyScope::Cli),
            Err(AuthError::ScopeDenied(KeyScope::Cli))
        );

        // Turn cap check: 2 turns allowed, 3rd rejected with 429.
        reloaded.reserve_turn(&authed.id, KeyScope::Sub).unwrap();
        reloaded.reserve_turn(&authed.id, KeyScope::Sub).unwrap();
        assert_eq!(
            reloaded.reserve_turn(&authed.id, KeyScope::Sub),
            Err(AuthError::DailyTurnCapExceeded { limit: 2 })
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revoke_removes_key_and_broadcasts_id() {
        let dir = temp_dir();
        let keys = GatewayKeys::load(&dir).unwrap();
        let mut rx = keys.subscribe_revocations();
        let issued = keys
            .issue(IssueSpec {
                label: "test-device".into(),
                scopes: KeyScope::all_scopes(),
                allow_mcp: true,
                max_turns_per_day: None,
                max_usd_micros_per_month: None,
            })
            .unwrap();

        assert!(keys.revoke(&issued.key.id).unwrap());
        assert_eq!(rx.try_recv().unwrap(), issued.key.id);
        assert_eq!(keys.authenticate(&issued.token), Err(AuthError::Revoked));
        assert_eq!(
            keys.reserve_turn(&issued.key.id, KeyScope::Sub),
            Err(AuthError::Revoked)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn authenticate_reports_revoked_not_invalid_token() {
        let dir = temp_dir();
        let keys = GatewayKeys::load(&dir).unwrap();
        let victim = keys
            .issue(IssueSpec {
                label: "friend-alienware".into(),
                scopes: KeyScope::default_scopes(),
                allow_mcp: false,
                max_turns_per_day: Some(10),
                max_usd_micros_per_month: None,
            })
            .unwrap();
        let survivor = keys
            .issue(IssueSpec {
                label: "my-test-rig".into(),
                scopes: KeyScope::default_scopes(),
                allow_mcp: false,
                max_turns_per_day: None,
                max_usd_micros_per_month: None,
            })
            .unwrap();

        assert!(keys.authenticate(&victim.token).is_ok());
        assert!(keys.revoke(&victim.key.id).unwrap());

        // The distinguishing assertion: a revoked token is not merely unknown.
        assert_eq!(keys.authenticate(&victim.token), Err(AuthError::Revoked));
        assert_eq!(AuthError::Revoked.status_code(), 401);
        assert_eq!(AuthError::Revoked.message(), "This API key has been revoked.");

        // Never-issued tokens must stay InvalidToken, or the two cases are useless.
        assert_eq!(
            keys.authenticate(&format!("{TOKEN_PREFIX}{}", "0".repeat(64))),
            Err(AuthError::InvalidToken)
        );
        assert_eq!(keys.authenticate("sk-not-ours"), Err(AuthError::InvalidToken));

        // Revoking one key must not disturb the other.
        let still_ok = keys.authenticate(&survivor.token).unwrap();
        assert_eq!(still_ok.id, survivor.key.id);
        assert_eq!(keys.list().len(), 1);

        // The tombstone is on disk, so the verdict survives a daemon restart.
        let reloaded = GatewayKeys::load(&dir).unwrap();
        assert_eq!(
            reloaded.authenticate(&victim.token),
            Err(AuthError::Revoked),
            "revocation tombstone must persist across reload"
        );
        assert!(reloaded.authenticate(&survivor.token).is_ok());
        let on_disk = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(
            !on_disk.contains(&victim.token) && !on_disk.contains(&survivor.token),
            "tombstones and records must hold digests, never raw tokens"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zombie_record_for_a_revoked_id_loads_as_revoked() {
        // Simulate a crash between "drop the key" and "write the tombstone":
        // the id is revoked but the record is still present on disk.
        let dir = temp_dir();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys
            .issue(IssueSpec {
                label: "half-written".into(),
                scopes: KeyScope::default_scopes(),
                allow_mcp: false,
                max_turns_per_day: None,
                max_usd_micros_per_month: None,
            })
            .unwrap();
        let raw = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let mut store: Store = serde_json::from_str(&raw).unwrap();
        store.revoked.insert(issued.key.id.clone());
        store.revoked_digests.clear();
        files::write_private(&dir.join(FILE), &serde_json::to_string_pretty(&store).unwrap())
            .unwrap();

        let reloaded = GatewayKeys::load(&dir).unwrap();
        assert_eq!(reloaded.authenticate(&issued.token), Err(AuthError::Revoked));
        assert!(reloaded.list().is_empty(), "zombie key must not be listed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_turn_refunds_a_reservation_that_produced_no_reply() {
        let dir = temp_dir();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys
            .issue(IssueSpec {
                label: "flaky-client".into(),
                scopes: KeyScope::default_scopes(),
                allow_mcp: false,
                max_turns_per_day: Some(2),
                max_usd_micros_per_month: None,
            })
            .unwrap();
        let id = issued.key.id.clone();
        let scope = KeyScope::default_scopes().into_iter().next().unwrap();

        assert!(keys.reserve_turn(&id, scope).is_ok());
        assert!(keys.reserve_turn(&id, scope).is_ok());
        assert_eq!(
            keys.reserve_turn(&id, scope),
            Err(AuthError::DailyTurnCapExceeded { limit: 2 })
        );

        // A failed backend call gives the turn back...
        keys.release_turn(&id);
        assert_eq!(keys.list()[0].turns_today, 1);
        assert!(keys.reserve_turn(&id, scope).is_ok());
        assert_eq!(keys.list()[0].turns_today, 2);

        // ...and releasing twice, or for a key that never reserved, is harmless.
        keys.release_turn(&id);
        keys.release_turn(&id);
        keys.release_turn(&id);
        assert_eq!(keys.list()[0].turns_today, 0);
        keys.release_turn("k_does_not_exist");

        // Refunds are persisted, so a restart cannot erase the correction.
        let reloaded = GatewayKeys::load(&dir).unwrap();
        assert_eq!(reloaded.list()[0].turns_today, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
