//! Durable, exact-owner image jobs. Persist dispatch intent before network I/O;
//! an uncertain request is never replayed. Asset references contain no URLs/keys.
use crate::{
    personal_workspace::{AssistantAvatarAsset, AssistantRef, AvatarMime},
    Host,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Cursor,
    sync::{Arc, LazyLock, Mutex},
};
static GATE: Mutex<()> = Mutex::new(());
static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Owner {
    Assistant {
        assistant: AssistantRef,
    },
    Creation {
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "draftId")]
        draft_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub owner: Owner,
    pub generation_id: String,
    pub editor_token: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<AssistantAvatarAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: u64,
    pub cost: Option<crate::personal::CostEntry>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Generate {
    pub owner: Owner,
    pub generation_id: String,
    pub editor_token: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub prompt: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Selection {
    Image {
        #[serde(rename = "generationId")]
        generation_id: String,
        #[serde(rename = "assetId")]
        asset_id: String,
    },
    Pixel,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionRow {
    pub provider_profile_id: String,
    pub model_id: String,
    pub label: String,
    pub estimated_cost_micros: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing: Option<&'static str>,
}
#[derive(Serialize)]
pub struct Options {
    pub options: Vec<OptionRow>,
    pub reason: Option<String>,
}
fn valid(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && s.trim() == s && !s.chars().any(char::is_control)
}
fn digest(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn key(host: &Host, owner: &Owner, id: &str) -> String {
    format!(
        "{}:{}:{}",
        host.data_dir().display(),
        serde_json::to_string(owner).unwrap(),
        id
    )
}
fn jobs(host: &Host) -> Result<Vec<Job>, String> {
    let p = host.data_dir().join("assistant-avatars/jobs.json");
    match std::fs::read(p) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
fn save(host: &Host, jobs: &[Job]) -> Result<(), String> {
    let dir = host.data_dir().join("assistant-avatars");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("jobs.tmp");
    crate::storage::write_synced(&p, &serde_json::to_vec(jobs).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(p, dir.join("jobs.json")).map_err(|e| e.to_string())?;
    crate::storage::sync_directory(&dir).map_err(|e| e.to_string())
}
fn normalize(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Avatar payload exceeds 10 MiB.".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Malformed image.")?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        return Err("Use PNG, JPEG or WebP.".into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let im = reader
        .decode()
        .map_err(|e| format!("Invalid avatar image: {e}"))?;
    if im.width() == 0 || im.height() == 0 || im.width() > 4096 || im.height() > 4096 {
        return Err("Avatar dimensions must be 1–4096.".into());
    }
    let mut out = Cursor::new(vec![]);
    im.resize_to_fill(512, 512, image::imageops::FilterType::Lanczos3)
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
#[cfg(feature = "test-support")]
fn fixture_profile() -> apex_core::ParticipantConfig {
    serde_json::from_value(serde_json::json!({"id":"fixture-avatar-provider","display_name":"Deterministic image fixture","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/avatar-fixture","model":"fixture-avatar-image"}})).expect("static fixture profile")
}
const CHATGPT_AVATAR_PROVIDER: &str = "chatgpt-avatar";
const CHATGPT_AVATAR_MODEL: &str = "codex-image-generation";
fn chatgpt_avatar_profile() -> apex_core::ParticipantConfig {
    serde_json::from_value(serde_json::json!({"id":CHATGPT_AVATAR_PROVIDER,"display_name":"ChatGPT Images","access":"read","backend":{"kind":"agent","tool":"codex"}})).expect("static ChatGPT avatar profile")
}
impl Host {
    fn avatar_owner(&self, owner: &Owner) -> Result<(), String> {
        let host = self.local_host_id()?;
        match owner {
            Owner::Assistant { assistant } => {
                if assistant.host_id != host {
                    return Err("Avatar belongs to another host.".into());
                }
                self.personal_get(&assistant.assistant_id)?;
            }
            Owner::Creation { host_id, draft_id } => {
                if host_id != &host || !valid(draft_id) {
                    return Err("Invalid avatar draft owner.".into());
                }
            }
        }
        Ok(())
    }
    pub(crate) fn personal_avatar_collect(&self, now: u64) -> Result<(), String> {
        let _gate = GATE.lock().unwrap();
        let mut list = jobs(self)?;
        let mut referenced: HashSet<String> = self
            .personal_list()?
            .iter()
            .filter_map(|a| {
                a.look
                    .as_ref()?
                    .image
                    .as_ref()
                    .map(|im| im.asset_id.clone())
            })
            .collect();
        for j in &list {
            if j.created_at.saturating_add(86_400_000) > now || j.state == "pending" {
                if let Some(a) = &j.candidate {
                    referenced.insert(a.asset_id.clone());
                }
            }
        }
        let mut removed = HashSet::new();
        for j in &mut list {
            if j.created_at.saturating_add(86_400_000) <= now && j.state != "pending" {
                if let Some(a) = &j.candidate {
                    if !referenced.contains(&a.asset_id) {
                        removed.insert(a.asset_id.clone());
                        j.candidate = None;
                        j.state = "error".into();
                        j.error = Some(
                            "This unused preview expired. Generate a new preview explicitly."
                                .into(),
                        );
                    }
                }
            }
        }
        // Cancellation may already have erased its candidate reference. Collect
        // orphan files by age too, while preserving all saved/active references.
        let directory = self.data_dir().join("assistant-avatars");
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("png") {
                    continue;
                }
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if referenced.contains(id) {
                    continue;
                }
                let age = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                if age.is_some_and(|at| at.saturating_add(86_400_000) <= now) {
                    removed.insert(id.to_owned());
                }
            }
        }
        // Save invalidated references before deleting bytes; attach/save holds GATE too.
        save(self, &list)?;
        for id in removed {
            if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
                match std::fs::remove_file(
                    self.data_dir()
                        .join("assistant-avatars")
                        .join(format!("{id}.png")),
                ) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        Ok(())
    }
    fn avatar_profiles(&self) -> Result<Vec<apex_core::ParticipantConfig>, String> {
        Ok(self
            .session()?
            .and_then(|s| s.profiles)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect())
    }
    pub async fn personal_avatar_options(&self, owner: Owner) -> Result<Options, String> {
        self.avatar_owner(&owner)?;
        self.personal_avatar_collect(crate::personal::now())?;
        #[cfg(feature = "test-support")]
        if crate::test_support::deterministic_avatar_adapter(self).is_some() {
            if let Owner::Assistant { assistant } = &owner {
                let a = self.personal_get(&assistant.assistant_id)?;
                if let Some(reason) =
                    crate::personal_worker::endpoint_refusal(&a, &fixture_profile())
                {
                    return Ok(Options {
                        options: vec![],
                        reason: Some(reason),
                    });
                }
            }
            return Ok(Options {
                options: vec![OptionRow {
                    provider_profile_id: "fixture-avatar-provider".into(),
                    model_id: "fixture-avatar-image".into(),
                    label: "Deterministic fixture image · no provider request or charge".into(),
                    estimated_cost_micros: Some(40000),
                    billing: None,
                }],
                reason: None,
            });
        }
        let mut options = vec![];
        let chatgpt = chatgpt_avatar_profile();
        let chatgpt_allowed = match &owner {
            Owner::Assistant { assistant } => crate::personal_worker::endpoint_refusal(&self.personal_get(&assistant.assistant_id)?, &chatgpt).is_none(),
            Owner::Creation { .. } => true,
        };
        if chatgpt_allowed && apex_adapters::codex_images::available_with_path(crate::agents::login_path().as_deref()).await {
            options.push(OptionRow { provider_profile_id:CHATGPT_AVATAR_PROVIDER.into(), model_id:CHATGPT_AVATAR_MODEL.into(), label:"ChatGPT Images".into(), estimated_cost_micros:None, billing:Some("subscription") });
        }
        for profile in self.avatar_profiles()? {
            let apex_core::Backend::OpenAiCompatible {
                base_url,
                api_key_env,
                ..
            } = &profile.backend
            else {
                continue;
            };
            // The existing media adapter supports Venice image generation only.
            if !reqwest::Url::parse(base_url).ok().is_some_and(|u| {
                u.scheme() == "https"
                    && u.host_str() == Some("api.venice.ai")
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none()
            }) || api_key_env
                .as_deref()
                .and_then(apex_adapters::keys::lookup)
                .is_none()
            {
                continue;
            }
            if let Owner::Assistant { assistant } = &owner {
                let a = self.personal_get(&assistant.assistant_id)?;
                if crate::personal_worker::endpoint_refusal(&a, &profile).is_some() {
                    continue;
                }
            }
            if let Ok(models) = apex_adapters::list_models(base_url, api_key_env.as_deref()).await {
                for m in models
                    .into_iter()
                    .filter(|m| m.kind == apex_adapters::ModelKind::Image)
                {
                    let estimated = m
                        .media
                        .as_ref()
                        .and_then(|s| {
                            apex_adapters::media::image_price(
                                s,
                                &apex_adapters::media::resolve(m.kind, s, None),
                                false,
                            )
                        })
                        .map(|v| (v * 1_000_000.0).ceil() as u64);
                    options.push(OptionRow {
                        provider_profile_id: profile.id.to_string(),
                        model_id: m.id.clone(),
                        label: format!("{} · {}", profile.display_name, m.id),
                        estimated_cost_micros: estimated,
                        billing: None,
                    });
                }
            }
        }
        let reason=options.is_empty().then(||"No image provider is available. Sign in to ChatGPT in Codex, or configure a Venice image provider in Agents/Providers. Assistant privacy settings may restrict providers.".into());
        Ok(Options { options, reason })
    }
    pub fn personal_avatar_status(&self, owner: Owner, id: String) -> Result<Job, String> {
        self.avatar_owner(&owner)?;
        let _gate = GATE.lock().unwrap();
        let mut list = jobs(self)?;
        let j = list
            .iter_mut()
            .find(|j| j.owner == owner && j.generation_id == id)
            .ok_or("Avatar job not found for this owner.")?;
        if j.state == "pending" && !ACTIVE.lock().unwrap().contains(&key(self, &owner, &id)) {
            j.state = "error".into();
            j.error=Some("Provider outcome is uncertain after interruption. This request will never be replayed; generate again explicitly if needed.".into());
            let out = j.clone();
            save(self, &list)?;
            return Ok(out);
        }
        Ok(j.clone())
    }
    pub fn personal_avatar_cancel(&self, owner: Owner, id: String) -> Result<Job, String> {
        self.avatar_owner(&owner)?;
        let _gate = GATE.lock().unwrap();
        let mut list = jobs(self)?;
        let j = list
            .iter_mut()
            .find(|j| j.owner == owner && j.generation_id == id)
            .ok_or("Avatar job not found.")?;
        j.state = "cancelled".into();
        j.candidate = None;
        j.error=Some("Cancelled locally. The provider cannot cancel a dispatched image request and may still charge.".into());
        let out = j.clone();
        save(self, &list)?;
        Ok(out)
    }
    pub async fn personal_avatar_generate(
        self: &Arc<Self>,
        input: Generate,
    ) -> Result<Job, String> {
        self.avatar_owner(&input.owner)?;
        if !valid(&input.generation_id)
            || !valid(&input.editor_token)
            || input.prompt.trim().is_empty()
            || input.prompt.chars().count() > 4000
        {
            return Err("Give a prompt of 1–4000 characters and valid job identifiers.".into());
        }
        // Reconcile before discovery: retries never call any paid adapter again.
        {
            let _gate = GATE.lock().unwrap();
            if let Some(j) = jobs(self)?
                .into_iter()
                .find(|j| j.owner == input.owner && j.generation_id == input.generation_id)
            {
                return Ok(j);
            }
        }
        let options = self.personal_avatar_options(input.owner.clone()).await?;
        let option = options
            .options
            .into_iter()
            .find(|o| {
                o.provider_profile_id == input.provider_profile_id && o.model_id == input.model_id
            })
            .ok_or("Choose a configured supported image model.")?;
        #[cfg(feature = "test-support")]
        if let Some(adapter) = crate::test_support::deterministic_avatar_adapter(self) {
            if input.provider_profile_id != "fixture-avatar-provider"
                || input.model_id != "fixture-avatar-image"
            {
                return Err("Choose the registered fixture image model.".into());
            }
            let job = Job {
                owner: input.owner.clone(),
                generation_id: input.generation_id.clone(),
                editor_token: input.editor_token.clone(),
                state: "pending".into(),
                candidate: None,
                error: None,
                created_at: crate::personal::now(),
                cost: Some(crate::personal::CostEntry {
                    at: crate::personal::now(),
                    purpose: "avatar".into(),
                    kind: "image".into(),
                    source: crate::personal::CostSource::Estimated,
                    micros: Some(option.estimated_cost_micros.unwrap_or(40000)),
                    input_tokens: None,
                    output_tokens: None,
                    bytes_out: input.prompt.len() as u64,
                    endpoint: "127.0.0.1".into(),
                }),
            };
            let (job, dispatch) = self.avatar_reserve(job, &fixture_profile())?;
            if dispatch {
                let host = Arc::clone(self);
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    let result = adapter
                        .generate(&input.owner, &input.generation_id, &input.prompt)
                        .and_then(|bytes| normalize(&bytes));
                    if let Err(error) =
                        host.avatar_finish(&input.owner, &input.generation_id, result)
                    {
                        eprintln!("fixture avatar completion failed: {error}")
                    }
                });
            }
            return Ok(job);
        }
        if option.provider_profile_id == CHATGPT_AVATAR_PROVIDER {
            if input.model_id != CHATGPT_AVATAR_MODEL { return Err("Unsupported ChatGPT image model.".into()); }
            let profile = chatgpt_avatar_profile();
            let job = Job {
                owner:input.owner.clone(), generation_id:input.generation_id.clone(), editor_token:input.editor_token.clone(), state:"pending".into(), candidate:None, error:None, created_at:crate::personal::now(),
                cost:Some(crate::personal::CostEntry { at:crate::personal::now(), purpose:"avatar".into(), kind:"image".into(), source:crate::personal::CostSource::Unknown, micros:None, input_tokens:None, output_tokens:None, bytes_out:input.prompt.len() as u64, endpoint:"api.openai.com".into() }),
            };
            let (job, dispatch) = self.avatar_reserve(job, &profile)?;
            if dispatch {
                let host = Arc::clone(self);
                tokio::spawn(async move {
                    // This generated directory contains no user project or conversation context.
                    let workdir = host.data_dir().join("assistant-avatars/codex").join(digest(&serde_json::to_vec(&(&input.owner, &input.generation_id)).unwrap()));
                    let prepare = (|| -> Result<(), String> {
                        std::fs::create_dir_all(workdir.parent().unwrap()).map_err(|e| e.to_string())?;
                        let mut builder = std::fs::DirBuilder::new();
                        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
                        builder.create(&workdir).map_err(|e| format!("Could not create a private avatar job folder: {e}"))
                    })();
                    let result = match prepare {
                        Ok(()) => apex_adapters::codex_images::generate_with_path(&input.prompt, &workdir, crate::agents::login_path().as_deref()).await.and_then(|bytes| normalize(&bytes)),
                        Err(error) => Err(error),
                    };
                    let _ = std::fs::remove_dir(&workdir);
                    if let Err(error) = host.avatar_finish(&input.owner, &input.generation_id, result) { eprintln!("ChatGPT avatar completion could not persist: {error}"); }
                });
            }
            return Ok(job);
        }
        let profile = self
            .avatar_profiles()?
            .into_iter()
            .find(|p| p.id.as_str() == input.provider_profile_id)
            .ok_or("Provider profile unavailable.")?;
        let apex_core::Backend::OpenAiCompatible {
            base_url,
            api_key_env,
            ..
        } = &profile.backend
        else {
            return Err("Unsupported image provider.".into());
        };
        let cost = crate::personal::CostEntry {
            at: crate::personal::now(),
            purpose: "avatar".into(),
            kind: "image".into(),
            source: if option.estimated_cost_micros.is_some() {
                crate::personal::CostSource::Estimated
            } else {
                crate::personal::CostSource::Unknown
            },
            micros: option.estimated_cost_micros,
            input_tokens: None,
            output_tokens: None,
            bytes_out: input.prompt.len() as u64,
            endpoint: base_url.clone(),
        };
        let job = Job {
            owner: input.owner.clone(),
            generation_id: input.generation_id.clone(),
            editor_token: input.editor_token.clone(),
            state: "pending".into(),
            candidate: None,
            error: None,
            created_at: crate::personal::now(),
            cost: Some(cost.clone()),
        };
        let (job, dispatch) = self.avatar_reserve(job, &profile)?;
        if !dispatch {
            return Ok(job);
        }
        let host = Arc::clone(self);
        let base_url = base_url.clone();
        let key_env = api_key_env.clone();
        tokio::spawn(async move {
            let result = apex_adapters::media::generate_image_bytes(
                &base_url,
                key_env.as_deref(),
                &input.model_id,
                &input.prompt,
            )
            .await
            .and_then(|b| normalize(&b));
            let finish = host.avatar_finish(&input.owner, &input.generation_id, result);
            if let Err(e) = finish {
                eprintln!("avatar completion could not persist: {e}")
            };
            ACTIVE
                .lock()
                .unwrap()
                .remove(&key(&host, &input.owner, &input.generation_id));
        });
        Ok(job)
    }
    fn avatar_finish(
        &self,
        owner: &Owner,
        generation_id: &str,
        result: Result<Vec<u8>, String>,
    ) -> Result<(), String> {
        let _gate = GATE.lock().unwrap();
        let finish = (|| -> Result<(), String> {
            let mut list = jobs(self)?;
            let j = list
                .iter_mut()
                .find(|j| &j.owner == owner && j.generation_id == generation_id)
                .ok_or("Avatar job missing.")?;
            if j.state != "pending" {
                return Ok(());
            }
            match result {
                Ok(bytes) => {
                    let sha = digest(&bytes);
                    let path = self
                        .data_dir()
                        .join("assistant-avatars")
                        .join(format!("{sha}.png"));
                    let tmp = path.with_extension("tmp");
                    crate::storage::write_synced(&tmp, &bytes).map_err(|e| e.to_string())?;
                    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
                    j.candidate = Some(AssistantAvatarAsset {
                        asset_id: sha.clone(),
                        sha256: sha,
                        mime: AvatarMime::Png,
                        width: 512,
                        height: 512,
                    });
                    j.state = "preview".into()
                }
                Err(e) => {
                    j.state = "error".into();
                    j.error = Some(format!(
                        "{e} Outcome may be uncertain; this generation will not be replayed."
                    ))
                }
            }
            save(self, &list)
        })();
        ACTIVE
            .lock()
            .unwrap()
            .remove(&key(self, owner, generation_id));
        finish
    }
    // The shared reservation seam is also exercised by deterministic adapter
    // fixtures. Only a newly persisted dispatch intent may invoke an adapter.
    fn avatar_reserve(
        &self,
        mut job: Job,
        profile: &apex_core::ParticipantConfig,
    ) -> Result<(Job, bool), String> {
        {
            let _gate = GATE.lock().unwrap();
            let mut list = jobs(self)?;
            if let Some(j) = list
                .iter()
                .find(|j| j.owner == job.owner && j.generation_id == job.generation_id)
            {
                return Ok((j.clone(), false));
            }
            if let Owner::Creation { draft_id, .. } = &job.owner {
                if self.personal_list()?.iter().any(|a|a.extra.get("avatarCreationDraftId").and_then(serde_json::Value::as_str)==Some(draft_id.as_str())) {
                    return Err("This avatar creation draft was already consumed. Open a new creation editor.".into());
                }
            }
            if list.len() >= 10000 {
                return Err("Avatar job ledger is full.".into());
            }
            let dispatch_dir = self.data_dir().join("assistant-avatars/dispatch");
            std::fs::create_dir_all(&dispatch_dir).map_err(|e| e.to_string())?;
            let dispatch_key = digest(
                &serde_json::to_vec(&(&job.owner, &job.generation_id))
                    .map_err(|e| e.to_string())?,
            );
            let dispatch_path = dispatch_dir.join(dispatch_key);
            if dispatch_path.try_exists().map_err(|e| e.to_string())? {
                let saved: Job = serde_json::from_slice(
                    &std::fs::read(&dispatch_path).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                if saved.owner != job.owner || saved.generation_id != job.generation_id {
                    return Err("Avatar dispatch tombstone has the wrong owner.".into());
                }
                job = saved;
                job.state = "error".into();
                job.candidate = None;
                job.error=Some("The durable dispatch exists but its job outcome is missing. Outcome is uncertain; this paid request will never be replayed.".into());
                list.push(job.clone());
                save(self, &list)?;
                return Ok((job, false));
            }
            if let Owner::Assistant { assistant } = &job.owner {
                self.change_personal(|assistants| {
                    let a = assistants
                        .iter_mut()
                        .find(|a| a.id == assistant.assistant_id)
                        .ok_or("Assistant disappeared before dispatch.")?;
                    if let Some(why) = crate::personal_worker::endpoint_refusal(a, profile) {
                        return Err(why);
                    }
                    let reservation = serde_json::to_string(&[
                        &job.generation_id,
                        &serde_json::to_string(&job.owner).unwrap(),
                    ])
                    .unwrap();
                    let known = a
                        .extra
                        .get("avatarCostReservations")
                        .and_then(serde_json::Value::as_array);
                    if known
                        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&reservation)))
                    {
                        return Ok(());
                    }
                    if known.is_some_and(|ids| ids.len() >= 10000) {
                        return Err("Avatar cost reservation ledger is full.".into());
                    }
                    let today = crate::personal::now().saturating_sub(86_400_000);
                    let spent: u64 = a
                        .costs
                        .iter()
                        .filter(|c| c.at >= today)
                        .filter_map(|c| c.micros)
                        .sum();
                    if let Some(limit) = a.budget.daily_limit_micros {
                        match job.cost.as_ref().and_then(|c| c.micros) {
                            Some(c) if spent.saturating_add(c) <= limit => {}
                            None if a.budget.unknown_cost_ok => {}
                            _ => {
                                return Err(
                                    "Avatar generation exceeds the assistant's spend policy."
                                        .into(),
                                )
                            }
                        }
                    }
                    a.costs.push(
                        job.cost
                            .clone()
                            .ok_or("Avatar dispatch has no cost reservation.")?,
                    );
                    let ids = a
                        .extra
                        .entry("avatarCostReservations")
                        .or_insert_with(|| serde_json::json!([]))
                        .as_array_mut()
                        .ok_or("Invalid avatar cost reservation ledger.")?;
                    ids.push(serde_json::Value::String(reservation));
                    Ok(())
                })?;
            }
            // An immutable per-owner/generation tombstone survives ledger loss.
            // Flush the reservation before dispatch; Unix also flushes its directory.
            use std::io::Write;
            let mut marker = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dispatch_path)
                .map_err(|e| e.to_string())?;
            marker
                .write_all(&serde_json::to_vec(&job).map_err(|e| e.to_string())?)
                .and_then(|_| marker.sync_all())
                .map_err(|e| e.to_string())?;
            crate::storage::sync_directory(&dispatch_dir).map_err(|e| e.to_string())?;
            list.push(job.clone());
            save(self, &list)?;
            ACTIVE
                .lock()
                .unwrap()
                .insert(key(self, &job.owner, &job.generation_id));
        }
        Ok((job, true))
    }
    pub(crate) fn avatar_creation_costs_locked(
        &self,
        draft_id: &str,
    ) -> Result<Vec<crate::personal::CostEntry>, String> {
        Ok(jobs(self)?
            .into_iter()
            .filter(|j| matches!(&j.owner,Owner::Creation{draft_id:id,..} if id==draft_id))
            .filter_map(|j| j.cost)
            .collect())
    }
    pub(crate) fn with_avatar_selection<T>(
        &self,
        owner: Owner,
        selection: Option<Selection>,
        f: impl FnOnce(Option<AssistantAvatarAsset>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _gate = GATE.lock().unwrap();
        self.avatar_owner(&owner)?;
        let asset = match selection {
            Some(Selection::Image {
                generation_id,
                asset_id,
            }) => {
                let j = jobs(self)?
                    .into_iter()
                    .find(|j| {
                        j.owner == owner && j.generation_id == generation_id && j.state == "preview"
                    })
                    .ok_or("Avatar preview is stale, cancelled or belongs to another owner.")?;
                let asset = j
                    .candidate
                    .filter(|a| a.asset_id == asset_id)
                    .ok_or("Avatar asset does not match this generation.")?;
                self.avatar_bytes(&asset)?;
                Some(asset)
            }
            _ => None,
        };
        f(asset)
    }
    fn avatar_bytes(&self, asset: &AssistantAvatarAsset) -> Result<Vec<u8>, String> {
        if asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || asset.asset_id != asset.sha256
        {
            return Err("Invalid avatar asset hash.".into());
        }
        let bytes = std::fs::read(
            self.data_dir()
                .join("assistant-avatars")
                .join(format!("{}.png", asset.sha256)),
        )
        .map_err(|e| e.to_string())?;
        if digest(&bytes) != asset.sha256 {
            return Err("Avatar hash mismatch.".into());
        }
        Ok(bytes)
    }
    pub fn personal_avatar_asset(
        &self,
        assistant_id: Option<String>,
        owner: Option<Owner>,
        generation_id: Option<String>,
        asset_id: String,
        sha256: String,
    ) -> Result<serde_json::Value, String> {
        let _gate = GATE.lock().unwrap();
        let asset = if let Some(id) = assistant_id {
            self.personal_get(&id)?
                .look
                .and_then(|l| l.image)
                .filter(|a| a.asset_id == asset_id && a.sha256 == sha256)
                .ok_or("This assistant does not own that asset.")?
        } else {
            let owner = owner.ok_or("A preview requires its exact owner.")?;
            self.avatar_owner(&owner)?;
            jobs(self)?
                .into_iter()
                .find(|j| {
                    j.owner == owner
                        && Some(&j.generation_id) == generation_id.as_ref()
                        && j.state == "preview"
                })
                .and_then(|j| j.candidate)
                .filter(|a| a.asset_id == asset_id && a.sha256 == sha256)
                .ok_or("Preview is unavailable for this owner.")?
        };
        Ok(
            serde_json::json!({"base64":base64::engine::general_purpose::STANDARD.encode(self.avatar_bytes(&asset)?)}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    async fn fixture() -> (
        std::path::PathBuf,
        Arc<Host>,
        crate::personal::PersonalAssistant,
    ) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "assistant-avatar-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host = crate::test_support::isolated_host_assuming_verified_ui(
            crate::HostPaths {
                data: root.join("data"),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        std::fs::write(root.join("data/host-id"), "host").unwrap();
        let a=host.personal_create(serde_json::from_value(json!({"name":"Original","folder":root.join("project"),"profile":{"id":"worker","display_name":"Worker","backend":{"kind":"agent","tool":"claude_code"}}})).unwrap()).unwrap();
        (root, host, a)
    }
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(w, h)
            .write_to(&mut b, image::ImageFormat::Png)
            .unwrap();
        b.into_inner()
    }
    fn seed(host: &Host, owner: Owner, id: &str, state: &str) -> Job {
        let bytes = normalize(&png(2, 3)).unwrap();
        let sha = digest(&bytes);
        let asset = AssistantAvatarAsset {
            asset_id: sha.clone(),
            sha256: sha.clone(),
            mime: AvatarMime::Png,
            width: 512,
            height: 512,
        };
        let job = Job {
            owner,
            generation_id: id.into(),
            editor_token: "editor".into(),
            state: state.into(),
            candidate: Some(asset),
            error: None,
            created_at: crate::personal::now(),
            cost: None,
        };
        let _gate = GATE.lock().unwrap();
        let mut list = jobs(host).unwrap();
        list.push(job.clone());
        save(host, &list).unwrap();
        std::fs::write(
            host.data_dir()
                .join("assistant-avatars")
                .join(format!("{sha}.png")),
            bytes,
        )
        .unwrap();
        job
    }
    #[tokio::test]
    async fn chatgpt_avatar_reuses_exact_owner_privacy_and_single_dispatch_reservation() {
        let (root, host, a) = fixture().await;
        let profile = chatgpt_avatar_profile();
        assert_eq!(profile.access, apex_core::Access::Read);
        let owner = Owner::Assistant { assistant:AssistantRef { host_id:"host".into(), assistant_id:a.id.clone() } };
        let make_job = |id:&str| Job { owner:owner.clone(), generation_id:id.into(), editor_token:"editor".into(), state:"pending".into(), candidate:None, error:None, created_at:crate::personal::now(), cost:Some(crate::personal::CostEntry { at:crate::personal::now(), purpose:"avatar".into(), kind:"image".into(), source:crate::personal::CostSource::Unknown, micros:None, input_tokens:None, output_tokens:None, bytes_out:10, endpoint:"api.openai.com".into() }) };
        let (_, dispatch) = host.avatar_reserve(make_job("chatgpt-one"), &profile).unwrap();
        assert!(dispatch);
        assert!(!host.avatar_reserve(make_job("chatgpt-one"), &profile).unwrap().1);
        host.avatar_finish(&owner, "chatgpt-one", normalize(&png(3, 4))).unwrap();
        let (completed, dispatch) = host.avatar_reserve(make_job("chatgpt-one"), &profile).unwrap();
        assert_eq!(completed.state, "preview"); assert!(!dispatch);
        assert_eq!(host.personal_get(&a.id).unwrap().costs.len(), 1);
        host.change_personal(|all| { all.iter_mut().find(|item|item.id==a.id).unwrap().privacy.local_only=true; Ok(()) }).unwrap();
        assert!(host.avatar_reserve(make_job("chatgpt-two"), &profile).unwrap_err().contains("Local-only"));
        assert_eq!(host.personal_get(&a.id).unwrap().costs.len(), 1);
        let _=std::fs::remove_dir_all(root);
    }
    #[test]
    fn assistant_avatar_normalizes_and_rejects_invalid() {
        assert!(normalize(b"garbage").is_err());
        assert!(normalize(&vec![0; 10 * 1024 * 1024 + 1]).is_err());
        assert!(normalize(&png(4097, 1)).is_err());
        assert!(normalize(b"BMunsupported bitmap").is_err());
        let out = normalize(&png(1, 2)).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (512, 512));
    }
    #[tokio::test]
    async fn assistant_avatar_creation_winning_before_reservation_prevents_late_dispatch() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Creation {host_id:"host".into(),draft_id:"consumed-draft".into()};
        let job = Job {owner,generation_id:"late".into(),editor_token:"editor".into(),state:"pending".into(),candidate:None,error:None,created_at:crate::personal::now(),cost:None};
        // A Generate request may already hold its resolved provider when Create
        // wins GATE. The reservation must recheck the consumed draft under GATE.
        let created = host.personal_create(serde_json::from_value(json!({"name":"Pixel","folder":root.join("project"),"profile":a.profile,"avatarDraftId":"consumed-draft","look":{"seed":"pixel","color":"#335599","kind":"pixel"}})).unwrap()).unwrap();
        assert!(created.costs.is_empty()); assert!(created.look.unwrap().image.is_none());
        assert!(host.avatar_reserve(job, a.profile.as_ref().unwrap()).unwrap_err().contains("consumed"));
        assert!(jobs(&host).unwrap().is_empty());
        assert!(host.personal_get(&created.id).unwrap().costs.is_empty());
        let _=std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn assistant_avatar_exact_owner_preview_apply_revision_and_restart() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Assistant {
            assistant: AssistantRef {
                host_id: "host".into(),
                assistant_id: a.id.clone(),
            },
        };
        let job = seed(&host, owner.clone(), "gen", "preview");
        let asset = job.candidate.clone().unwrap();
        assert!(
            host.personal_avatar_asset(
                Some(a.id.clone()),
                None,
                None,
                asset.asset_id.clone(),
                asset.sha256.clone()
            )
            .is_err(),
            "preview does not attach"
        );
        assert!(host
            .personal_avatar_asset(
                None,
                Some(Owner::Creation {
                    host_id: "host".into(),
                    draft_id: "other".into()
                }),
                Some("gen".into()),
                asset.asset_id.clone(),
                asset.sha256.clone()
            )
            .is_err());
        let request = json!({"assistantId":a.id,"expectedRevision":a.revision,"settings":{"name":"Changed","look":{"kind":"image","color":"#123456","seed":"saved"}},"avatar":{"kind":"image","generationId":"gen","assetId":asset.asset_id}});
        let changed = host
            .personal_workspace_configure(serde_json::from_value(request.clone()).unwrap())
            .await
            .unwrap()
            .assistant;
        assert_eq!(changed.look.as_ref().unwrap().image.as_ref(), Some(&asset));
        assert!(host
            .personal_workspace_configure(serde_json::from_value(request).unwrap())
            .await
            .is_err());
        assert_eq!(host.personal_get(&a.id).unwrap(), changed);
        let reply = host
            .personal_avatar_asset(
                Some(a.id.clone()),
                None,
                None,
                asset.asset_id.clone(),
                asset.sha256.clone(),
            )
            .unwrap();
        assert!(reply["base64"].as_str().unwrap().len() > 20);
        drop(host);
        let restarted = Host::new(
            crate::HostPaths {
                data: root.join("data"),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        assert_eq!(
            restarted.personal_get(&a.id).unwrap().look.unwrap().image,
            Some(asset.clone())
        );
        assert!(restarted
            .personal_avatar_asset(Some(a.id), None, None, asset.asset_id, asset.sha256)
            .is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_cancel_uncertainty_and_duplicate_never_dispatch() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Assistant {
            assistant: AssistantRef {
                host_id: "host".into(),
                assistant_id: a.id.clone(),
            },
        };
        let pending = seed(&host, owner.clone(), "pending", "pending");
        let reconciled = host
            .personal_avatar_status(owner.clone(), "pending".into())
            .unwrap();
        assert_eq!(reconciled.state, "error");
        assert!(reconciled.error.unwrap().contains("uncertain"));
        let retried = host
            .personal_avatar_generate(Generate {
                owner: owner.clone(),
                generation_id: "pending".into(),
                editor_token: "new".into(),
                provider_profile_id: "not-configured".into(),
                model_id: "text".into(),
                prompt: "test".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            retried.state, "error",
            "retry returns saved job before discovery/dispatch"
        );
        let cancelled = host
            .personal_avatar_cancel(owner.clone(), "pending".into())
            .unwrap();
        host.avatar_finish(&owner, "pending", normalize(&png(2, 2)))
            .unwrap();
        assert_eq!(
            host.personal_avatar_status(owner.clone(), "pending".into())
                .unwrap()
                .state,
            "cancelled"
        );
        assert_eq!(cancelled.state, "cancelled");
        let before = host.personal_get(&a.id).unwrap();
        let bad = json!({"assistantId":a.id,"expectedRevision":before.revision,"settings":{"name":"must not save"},"avatar":{"kind":"image","generationId":"pending","assetId":pending.candidate.unwrap().asset_id}});
        assert!(host
            .personal_workspace_configure(serde_json::from_value(bad).unwrap())
            .await
            .is_err());
        assert_eq!(host.personal_get(&a.id).unwrap(), before);
        assert!(host
            .personal_avatar_generate(Generate {
                owner,
                generation_id: "fresh".into(),
                editor_token: "e".into(),
                provider_profile_id: "unconfigured".into(),
                model_id: "text-only".into(),
                prompt: "test".into()
            })
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_creation_attaches_only_on_create_and_hash_tamper_fails() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Creation {
            host_id: "host".into(),
            draft_id: "draft".into(),
        };
        let job = seed(&host, owner.clone(), "g", "preview");
        let asset = job.candidate.unwrap();
        assert!(host.personal_get(&a.id).unwrap().look.is_none());
        let input = json!({"name":"Created","folder":root.join("new-project"),"profile":a.profile,"avatarDraftId":"draft","avatarGenerationId":"g","avatarAssetId":asset.asset_id});
        let created = host
            .personal_create(serde_json::from_value(input.clone()).unwrap())
            .unwrap();
        assert_eq!(created.look.unwrap().image, Some(asset.clone()));
        assert!(host
            .personal_create(serde_json::from_value(input).unwrap())
            .is_err());
        std::fs::write(
            host.data_dir()
                .join("assistant-avatars")
                .join(format!("{}.png", asset.sha256)),
            b"tampered",
        )
        .unwrap();
        assert!(host
            .personal_avatar_asset(Some(created.id), None, None, asset.asset_id, asset.sha256)
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_gc_retains_saved_assets_and_active_jobs() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Assistant {
            assistant: AssistantRef {
                host_id: "host".into(),
                assistant_id: a.id.clone(),
            },
        };
        let job = seed(&host, owner.clone(), "saved", "preview");
        let asset = job.candidate.clone().unwrap();
        host.personal_workspace_configure(serde_json::from_value(json!({"assistantId":a.id,"expectedRevision":a.revision,"avatar":{"kind":"image","generationId":"saved","assetId":asset.asset_id}})).unwrap()).await.unwrap();
        {
            let _g = GATE.lock().unwrap();
            let mut list = jobs(&host).unwrap();
            for j in &mut list {
                j.created_at = 0;
            }
            save(&host, &list).unwrap();
        }
        host.personal_avatar_collect(crate::personal::now())
            .unwrap();
        assert!(host
            .personal_avatar_asset(
                Some(a.id.clone()),
                None,
                None,
                asset.asset_id.clone(),
                asset.sha256.clone()
            )
            .is_ok());
        let current = host.personal_get(&a.id).unwrap();
        host.personal_workspace_configure(serde_json::from_value(json!({"assistantId":a.id,"expectedRevision":current.revision,"avatar":{"kind":"pixel"}})).unwrap()).await.unwrap();
        host.personal_avatar_collect(crate::personal::now())
            .unwrap();
        assert!(!host
            .data_dir()
            .join("assistant-avatars")
            .join(format!("{}.png", asset.sha256))
            .exists());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_versioned_create_validates_profile_and_complete_form() {
        let (root, host, _) = fixture().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let body =
                    r#"{"data":[{"id":"text","effort":{"supported_levels":["low","high"]}}]}"#;
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let profile = json!({"id":"configured","display_name":"Configured","backend":{"kind":"open_ai_compatible","base_url":address,"model":"text"},"effort":"high","access":"full"});
        host.session_save(json!({"version":1,"profiles":[profile]}))
            .unwrap();
        let args = json!({"workspaceVersion":4,"name":"Versioned","folder":root.join("versioned"),"profile":profile,"look":{"color":"#AABBCC","seed":"stable"},"projects":[]});
        let created = host
            .call_assuming_verified_ui_for_test(
                crate::Command::from_json(json!({"cmd":"personal_create","args":args})).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created["name"], "Versioned");
        assert_eq!(created["look"]["seed"], "stable");
        assert_eq!(created["profile"]["effort"], "high");
        assert_eq!(created["profile"]["access"], "full");
        let count = host.personal_list().unwrap().len();
        let mut bad = args;
        bad["profile"]["effort"] = json!("invented");
        assert!(host
            .call_assuming_verified_ui_for_test(
                crate::Command::from_json(json!({"cmd":"personal_create","args":bad})).unwrap()
            )
            .await
            .is_err());
        assert_eq!(host.personal_list().unwrap().len(), count);
        server.abort();
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_legacy_configure_cannot_bypass_asset_ownership() {
        let (root, host, a) = fixture().await;
        let before = host.personal_get(&a.id).unwrap();
        let forged=serde_json::from_value(json!({"name":"Must not save","look":{"kind":"image","image":{"assetId":"foreign","sha256":"foreign","mime":"image/png","width":512,"height":512}}})).unwrap();
        assert!(host.personal_configure(&a.id, forged).is_err());
        assert_eq!(host.personal_get(&a.id).unwrap(), before);
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_gc_collects_cancelled_orphan_bytes_after_24_hours() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Assistant {
            assistant: AssistantRef {
                host_id: "host".into(),
                assistant_id: a.id,
            },
        };
        let job = seed(&host, owner.clone(), "orphan", "preview");
        let path = host
            .data_dir()
            .join("assistant-avatars")
            .join(format!("{}.png", job.candidate.unwrap().sha256));
        host.personal_avatar_cancel(owner, "orphan".into()).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
            .unwrap();
        host.personal_avatar_collect(crate::personal::now())
            .unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_stub_dispatch_once_cost_revision_and_spend_privacy() {
        let (root, host, a) = fixture().await;
        let owner = Owner::Assistant {
            assistant: AssistantRef {
                host_id: "host".into(),
                assistant_id: a.id.clone(),
            },
        };
        let profile:apex_core::ParticipantConfig=serde_json::from_value(json!({"id":"images","display_name":"Images","backend":{"kind":"open_ai_compatible","base_url":"https://api.venice.ai/api/v1","model":"image"}})).unwrap();
        let cost = crate::personal::CostEntry {
            at: crate::personal::now(),
            purpose: "avatar".into(),
            kind: "image".into(),
            source: crate::personal::CostSource::Estimated,
            micros: Some(20),
            input_tokens: None,
            output_tokens: None,
            bytes_out: 10,
            endpoint: "api.venice.ai".into(),
        };
        let job = Job {
            owner: owner.clone(),
            generation_id: "stub".into(),
            editor_token: "e".into(),
            state: "pending".into(),
            candidate: None,
            error: None,
            created_at: crate::personal::now(),
            cost: Some(cost),
        };
        let mut provider_calls = 0;
        for _ in 0..2 {
            let (_, dispatch) = host.avatar_reserve(job.clone(), &profile).unwrap();
            if dispatch {
                provider_calls += 1;
            }
        }
        assert_eq!(provider_calls, 1);
        assert_eq!(host.personal_get(&a.id).unwrap().revision, a.revision);
        assert_eq!(host.personal_get(&a.id).unwrap().costs.len(), 1);
        // Deterministic adapter fixture produces valid bytes, then the inspected form saves.
        host.avatar_finish(&owner, "stub", normalize(&png(3, 2)))
            .unwrap();
        let asset = host
            .personal_avatar_status(owner.clone(), "stub".into())
            .unwrap()
            .candidate
            .unwrap();
        let updated=host.personal_workspace_configure(serde_json::from_value(json!({"assistantId":a.id,"expectedRevision":a.revision,"settings":{"name":"Saved"},"avatar":{"kind":"image","generationId":"stub","assetId":asset.asset_id}})).unwrap()).await.unwrap().assistant;
        assert_eq!(updated.costs.len(), 1);
        assert_eq!(updated.look.unwrap().image, Some(asset));
        // Simulate a ledger-write interruption after the cost reservation was persisted.
        {
            let _g = GATE.lock().unwrap();
            save(&host, &[]).unwrap();
        }
        let (recovered, dispatch) = host.avatar_reserve(job.clone(), &profile).unwrap();
        assert!(
            !dispatch,
            "a cost reservation without a surviving job is uncertain, never replayed"
        );
        assert_eq!(recovered.state, "error");
        assert_eq!(
            host.personal_get(&a.id).unwrap().costs.len(),
            1,
            "cost reservation retry cannot double count"
        );
        host.personal_configure(
            &a.id,
            serde_json::from_value(
                json!({"budget":{"dailyLimitMicros":20},"privacy":{"localOnly":true}}),
            )
            .unwrap(),
        )
        .unwrap();
        let mut next = job.clone();
        next.generation_id = "privacy".into();
        assert!(host.avatar_reserve(next, &profile).is_err());
        host.personal_configure(
            &a.id,
            serde_json::from_value(json!({"privacy":{"localOnly":false}})).unwrap(),
        )
        .unwrap();
        let mut next = job;
        next.generation_id = "over-budget".into();
        assert!(host.avatar_reserve(next, &profile).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_creation_rejects_invalid_whole_form() {
        let (root, host, a) = fixture().await;
        let count = host.personal_list().unwrap().len();
        for extra in [
            json!({"look":{"color":"wrong"}}),
            json!({"avatarDraftId":"partial","avatarGenerationId":"missing-asset"}),
            json!({"look":{"kind":"image","image":{"assetId":"arbitrary","sha256":"arbitrary","mime":"image/png","width":512,"height":512}}}),
        ] {
            let mut input = json!({"name":"Bad","folder":root.join("new"),"profile":a.profile});
            for (k, v) in extra.as_object().unwrap() {
                input[k] = v.clone();
            }
            assert!(host
                .personal_create(serde_json::from_value(input).unwrap())
                .is_err());
            assert_eq!(host.personal_list().unwrap().len(), count);
        }
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn assistant_avatar_registered_fixture_runs_exact_rpcs_without_credentials() {
        let (root, host, a) = fixture().await;
        let owner = json!({"kind":"assistant","assistant":{"hostId":"host","assistantId":a.id}});
        let call = |cmd: &str, args: serde_json::Value| {
            crate::Command::from_json(json!({"cmd":cmd,"args":args})).unwrap()
        };
        assert!(
            host.call_assuming_verified_ui_for_test(call(
                "personal_avatar_options",
                json!({"owner":owner})
            ))
            .await
            .unwrap()["options"]
                .as_array()
                .unwrap()
                .iter().all(|option| option["providerProfileId"] != "fixture-avatar-provider"),
            "compiling test support alone never registers a fixture provider"
        );
        let adapter = crate::test_support::register_deterministic_avatar_adapter(&host).unwrap();
        let options = host
            .call_assuming_verified_ui_for_test(call(
                "personal_avatar_options",
                json!({"owner":owner}),
            ))
            .await
            .unwrap();
        assert_eq!(
            options["options"][0]["providerProfileId"],
            "fixture-avatar-provider"
        );
        let args = json!({"owner":owner,"generationId":"rpc-generation","editorToken":"rpc-editor","providerProfileId":"fixture-avatar-provider","modelId":"fixture-avatar-image","prompt":"Blue robot"});
        let first = host
            .call_assuming_verified_ui_for_test(call("personal_avatar_generate", args.clone()))
            .await
            .unwrap();
        assert_eq!(first["state"], "pending");
        host.call_assuming_verified_ui_for_test(call("personal_avatar_generate", args))
            .await
            .unwrap();
        let result = loop {
            let j = host
                .call_assuming_verified_ui_for_test(call(
                    "personal_avatar_status",
                    json!({"owner":owner,"generationId":"rpc-generation"}),
                ))
                .await
                .unwrap();
            if j["state"] != "pending" {
                break j;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(result["state"], "preview");
        assert_eq!(adapter.calls(), 1);
        let updated=host.call_assuming_verified_ui_for_test(call("personal_workspace_configure",json!({"assistantId":a.id,"expectedRevision":a.revision,"settings":{"name":"RPC saved"},"avatar":{"kind":"image","generationId":"rpc-generation","assetId":result["candidate"]["assetId"]}}))).await.unwrap();
        assert_eq!(updated["assistant"]["costs"][0]["micros"], 40000);
        let bytes=host.call_assuming_verified_ui_for_test(call("personal_avatar_asset",json!({"assistantId":a.id,"assetId":result["candidate"]["assetId"],"sha256":result["candidate"]["sha256"]}))).await.unwrap();
        assert!(bytes["base64"].as_str().unwrap().starts_with("iVBOR"));
        let _ = std::fs::remove_dir_all(root);
    }
}
