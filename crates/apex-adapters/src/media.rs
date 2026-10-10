//! Bots whose model makes pictures or videos. Each message becomes one
//! request to the provider, and the reply is the file it made, saved with
//! the thread's attachments so the chat shows it and the Library keeps it.
//!
//! Venice is the only provider wired up so far. Pictures come back in one
//! answer (`/image/generate`, or `/image/edit` for an attached picture).
//! Videos are queued (`/video/queue`), polled (`/video/retrieve`) until
//! they are done, and downloaded straight away because their links expire.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use apex_core::{ActionKind, Approver, MediaSettings, Message, ParticipantError, ParticipantId, Progress, ProgressSink, ProposedAction, Reply, Role, Speaker, TurnRequest, PASS_TOKEN};
use base64::Engine;
use serde_json::{json, Value};

use crate::api_info::{ApiModel, MediaSpec, ModelKind};

/// The choices actually sent. Must match `resolveMedia` in src/media.ts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resolved {
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub quality: Option<String>,
    pub duration: Option<String>,
    /// Sent only when the model lets sound be switched.
    pub audio: Option<bool>,
    pub build_on_last: bool,
}

fn seconds(duration: &str) -> f64 {
    duration.trim_end_matches('s').parse().unwrap_or(0.0)
}

/// The saved choice when the model lists it, otherwise the default:
/// video at 16:9 and 720p, the shortest length of at least 5 seconds, and
/// sound on; pictures at the model's own defaults. Settings the model
/// doesn't list are left out.
pub fn resolve(kind: ModelKind, spec: &MediaSpec, saved: Option<&MediaSettings>) -> Resolved {
    let saved = saved.cloned().unwrap_or_default();
    let video = kind == ModelKind::Video;
    let pick = |list: &[String], chosen: Option<String>, fallbacks: &[Option<&str>]| -> Option<String> {
        let first = list.first()?;
        if let Some(chosen) = chosen.filter(|c| list.contains(c)) {
            return Some(chosen);
        }
        Some(fallbacks.iter().flatten().find(|f| list.iter().any(|l| l == *f)).map(|f| f.to_string()).unwrap_or_else(|| first.clone()))
    };
    let mut by_length: Vec<&String> = spec.durations.iter().collect();
    by_length.sort_by(|a, b| seconds(a).total_cmp(&seconds(b)));
    let at_least_five = by_length.into_iter().find(|d| seconds(d) >= 5.0).map(String::as_str);
    Resolved {
        aspect_ratio: pick(&spec.aspect_ratios, saved.aspect_ratio, &[video.then_some("16:9"), spec.default_aspect_ratio.as_deref()]),
        resolution: pick(&spec.resolutions, saved.resolution, &[video.then_some("720p"), spec.default_resolution.as_deref()]),
        quality: pick(&spec.qualities, saved.quality, &[spec.default_quality.as_deref()]),
        duration: pick(&spec.durations, saved.duration, &[at_least_five]),
        audio: (video && spec.audio && spec.audio_configurable).then_some(saved.audio.unwrap_or(true)),
        build_on_last: saved.build_on_last.unwrap_or(true),
    }
}

/// Dollars per picture for these choices, when the model lists a price.
pub fn image_price(spec: &MediaSpec, resolved: &Resolved, editing: bool) -> Option<f64> {
    if editing && spec.edit_price.is_some() {
        return spec.edit_price;
    }
    if let (Some(resolution), Some(quality)) = (&resolved.resolution, &resolved.quality) {
        if let Some(price) = spec.prices.get(&format!("{resolution}/{quality}")) {
            return Some(*price);
        }
    }
    resolved.resolution.as_ref().and_then(|r| spec.prices.get(r)).copied().or(spec.price)
}

/// What the person asked for this turn: their latest message without its
/// attachment lines and Deck's own notes, and the pictures it attached.
pub(crate) fn latest_ask(request: &TurnRequest) -> (String, Vec<PathBuf>) {
    let text = request
        .unseen
        .iter()
        .rev()
        .find(|m: &&Message| m.speaker == Speaker::Human)
        .map(|m| m.text.clone())
        .or_else(|| {
            let turn = request.turns.iter().rev().find(|t| t.role == Role::User)?;
            // The view joins messages; the last one is the newest.
            let last = turn.content.rsplit("\n\n[").next().unwrap_or(&turn.content);
            Some(last.split_once("]: ").map_or(last, |(_, said)| said).to_string())
        })
        .unwrap_or_default();
    let mut images = Vec::new();
    let mut kept = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("Attached image: ") {
            images.push(PathBuf::from(path.trim()));
        } else if line.starts_with("Attached file: ") || line.starts_with("Attached folder: ") || line.starts_with("[TL;DR mode:") {
        } else {
            kept.push(line);
        }
    }
    // Leading @handles only say who the message is for.
    let said = kept.join("\n");
    let mut said = said.trim();
    while let Some(rest) = said.strip_prefix('@') {
        said = rest.split_once(char::is_whitespace).map_or("", |(_, after)| after).trim_start();
    }
    (said.trim().to_string(), images)
}

/// Whether this turn comes from a person's message that names `bot` by its
/// `@handle`. A message that names nobody, `@all`, another bot's mention, a
/// retry and a suggestions request don't, so none of them can spend money.
pub(crate) fn named_by_person(request: &TurnRequest, bot: &ParticipantId) -> bool {
    request.unseen.iter().rev().find(|m| m.speaker == Speaker::Human).is_some_and(|m| apex_core::names(&m.text, bot))
}

/// Where a media reply records the description it was made from.
const PROMPT_LABEL: &str = "Prompt: ";

/// The description this bot's last picture or video was made from.
/// Replies saying something wasn't made are skipped.
pub(crate) fn last_prompt(request: &TurnRequest) -> Option<String> {
    request.turns.iter().rev().filter(|t| t.role == Role::Assistant).find_map(|reply| {
        let start = reply.content.rfind(&format!("\n{PROMPT_LABEL}")).map(|i| i + 1).or_else(|| reply.content.starts_with(PROMPT_LABEL).then_some(0))?;
        let rest = &reply.content[start + PROMPT_LABEL.len()..];
        let end = rest.find("\n\nAttached ").unwrap_or(rest.len());
        Some(rest[..end].trim().to_string()).filter(|p| !p.is_empty())
    })
}

/// The description sent: with Build on last, the last one plus the change
/// asked for. Over the model's limit, the oldest part of the last
/// description goes first; the new words are kept.
pub(crate) fn build_prompt(previous: Option<&str>, said: &str, build_on_last: bool, limit: Option<usize>) -> String {
    let limit = limit.unwrap_or(usize::MAX);
    let tail = |text: &str, room: usize| -> String {
        let count = text.chars().count();
        text.chars().skip(count.saturating_sub(room)).collect()
    };
    match previous.filter(|_| build_on_last) {
        Some(previous) if !said.is_empty() => {
            let change = format!("\n\nChange: {said}");
            let room = limit.saturating_sub(change.chars().count());
            if room == 0 { tail(said, limit) } else { format!("{}{change}", tail(previous, room).trim_start()) }
        }
        Some(previous) => tail(previous, limit),
        None => tail(said, limit),
    }
}

fn failed(message: impl Into<String>) -> ParticipantError {
    ParticipantError::Failed(message.into())
}

/// Venice's content filter in plain words, when the words given say the
/// filter stopped the job. None for any other reason.
fn content_filter(words: &str) -> Option<&'static str> {
    let words = words.to_lowercase();
    let filtered = ["content policy", "content filter", "moderation"].iter().any(|w| words.contains(w)) || (words.contains("free account") && words.contains("upgrade"));
    filtered.then_some("Venice's content filter blocked this. Your account is fine. Try rewording it, for example without real names.")
}

/// A provider's refusal, with what to do about it.
pub(crate) fn explain(status: u16, body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let said = value["error"].as_str().or_else(|| value["error"]["message"].as_str()).or_else(|| value["message"].as_str()).map(str::to_string).unwrap_or_else(|| body.chars().take(200).collect());
    // A real shortage of balance or a refused key says so, whatever the words.
    if let Some(plain) = content_filter(body).filter(|_| !matches!(status, 401..=403)) {
        let suggestion = value["suggested_prompt"].as_str().filter(|_| status == 422).map(|s| format!(" Venice suggests: \"{s}\"")).unwrap_or_default();
        return format!("{plain}{suggestion}");
    }
    match status {
        401 | 403 => format!("Venice refused the saved API key ({said}). Open this bot's settings and paste a new one into API key."),
        402 => "Your Venice balance is too low for this. Top up at venice.ai, then send it again.".into(),
        409 => {
            let docs = value["docs_url"].as_str().map(|u| format!(" See {u}.")).unwrap_or_default();
            format!("This model needs a one-time consent on Venice before it can be used.{docs}")
        }
        413 => "The attached picture is too large for Venice. Try a smaller one.".into(),
        422 => {
            let suggestion = value["suggested_prompt"].as_str().map(|s| format!(" Venice suggests: \"{s}\"")).unwrap_or_default();
            format!("Venice refused this under its content rules ({said}).{suggestion}")
        }
        429 | 503 => format!("Venice is busy right now ({said}). Try again in a minute."),
        _ => format!("Venice answered {status}: {said}"),
    }
}

/// "0:53".
fn clock(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// The work line while a video is made, from Venice's own timings.
pub(crate) fn video_activity(elapsed_ms: u64, expected_ms: Option<u64>) -> String {
    match expected_ms.filter(|e| *e > 0) {
        Some(expected) => format!("Making video · {} of ~{}", clock(elapsed_ms), clock(expected)),
        None => format!("Making video · {}", clock(elapsed_ms)),
    }
}

/// "$1.44", "$0.03".
fn dollars(usd: f64) -> String {
    format!("${usd:.2}")
}

/// One line in the daemon log for a paid job. Never the key or the prompt.
fn log_job(event: &str, model: &str, queue_id: Option<&str>, cost: Option<f64>, detail: &str) {
    let queue = queue_id.map(|q| format!(" queue_id={q}")).unwrap_or_default();
    let cost = cost.map(dollars).unwrap_or_else(|| "unknown".into());
    let detail = if detail.is_empty() { String::new() } else { format!(" {detail}") };
    eprintln!("[apex-deck] media job {event}: model={model}{queue} cost={cost}{detail}");
}

/// Why Venice has stopped a queued video, when its status says so: a
/// failure status or any error. An unfamiliar status keeps waiting, since
/// giving up on a paid job that is still going would waste it.
fn stopped(status: &Value) -> Option<String> {
    let state = status["status"].as_str().unwrap_or_default().to_ascii_uppercase();
    let text = |v: &Value| v.as_str().or_else(|| v["message"].as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let reason = text(&status["error"]).or_else(|| text(&status["message"])).or_else(|| text(&status["reason"]));
    let failed = ["FAIL", "ERROR", "CANCEL", "REJECT", "BLOCK", "EXPIRE"].iter().any(|word| state.contains(word));
    if !failed && status["error"].is_null() {
        return None;
    }
    Some(reason.unwrap_or_else(|| if state.is_empty() { "no reason given".into() } else { state }))
}

/// What the person sees when Venice stopped a video for this reason.
fn stopped_message(reason: &str) -> String {
    match content_filter(reason) {
        Some(plain) => plain.into(),
        None => format!("Venice stopped making the video: {}.", reason.trim_end_matches('.')),
    }
}

/// Every failure after a video is queued names the job and warns of the charge.
fn after_queue(error: ParticipantError, queue_id: &str) -> ParticipantError {
    match error {
        ParticipantError::Failed(message) => failed(format!("{message} Job {queue_id}. Venice may still charge for it; quote this job number to Venice support for a refund.")),
        other => other,
    }
}

fn data_url(path: &Path) -> Result<(String, String), ParticipantError> {
    let bytes = std::fs::read(path).map_err(|e| failed(format!("couldn't read the attached picture {}: {e}", path.display())))?;
    let mime = match bytes.as_slice() {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((format!("data:{mime};base64,{b64}"), b64))
}

fn extension(bytes: &[u8], video: bool) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "png",
        [0xFF, 0xD8, ..] => "jpg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        [0x1A, 0x45, 0xDF, 0xA3, ..] => "webm",
        [_, _, _, _, b'f', b't', b'y', b'p', b'q', b't', b' ', b' ', ..] => "mov",
        _ if video => "mp4",
        _ => "png",
    }
}

/// Save what the model made under a new name in `dir`.
fn save(dir: &Path, model: &str, bytes: &[u8], video: bool) -> Result<PathBuf, ParticipantError> {
    std::fs::create_dir_all(dir).map_err(|e| failed(format!("couldn't make the attachments folder: {e}")))?;
    let stem: String = model.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let ext = extension(bytes, video);
    let mut n = 1;
    let path = loop {
        let name = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem}-{n}.{ext}") };
        let path = dir.join(name);
        if !path.exists() {
            break path;
        }
        n += 1;
    };
    std::fs::write(&path, bytes).map_err(|e| failed(format!("couldn't save the file: {e}")))?;
    Ok(path)
}

/// The reply: what was made and from what, then the file.
fn reply_text(model: &ApiModel, details: &[String], cost: Option<f64>, prompt: &str, note: Option<&str>, file: &Path, video: bool) -> String {
    let name = model.label.as_deref().unwrap_or(&model.id);
    let mut line = vec![format!("Made with {name}")];
    line.extend(details.iter().cloned());
    if let Some(cost) = cost {
        line.push(dollars(cost));
    }
    let note = note.map(|n| format!("{n}\n\n")).unwrap_or_default();
    let kind = if video { "video" } else { "image" };
    format!("{}\n\n{note}{PROMPT_LABEL}{prompt}\n\nAttached {kind}: {}", line.join(" · "), file.display())
}

/// Everything one media turn needs.
pub(crate) struct Job<'a> {
    pub client: &'a reqwest::Client,
    pub base_url: &'a str,
    pub key: Option<String>,
    pub model: &'a ApiModel,
    pub settings: Option<&'a MediaSettings>,
    pub dir: &'a Path,
    /// How often a queued video is checked on. Tests make it short.
    pub poll: Duration,
    /// Asked before anything is paid for.
    pub approver: &'a dyn Approver,
    /// This bot, which a person's message must name.
    pub bot: &'a ParticipantId,
}

impl Job<'_> {
    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        let url = format!("{}/{path}", self.base_url.trim_end_matches('/'));
        let call = self.client.post(url).json(body);
        match &self.key {
            Some(key) => call.bearer_auth(key),
            None => call,
        }
    }

    async fn send(&self, path: &str, body: &Value) -> Result<reqwest::Response, ParticipantError> {
        let response = self.post(path, body).send().await.map_err(|e| failed(format!("couldn't reach Venice: {e}")))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let text = response.text().await.unwrap_or_default();
        Err(failed(explain(status.as_u16(), &text)))
    }

    /// One turn. Answers only a person's message that names this bot, asks
    /// before paying, and puts a failure in the chat so it isn't lost.
    pub(crate) async fn run(&self, request: &TurnRequest, on_progress: ProgressSink<'_>) -> Result<Reply, ParticipantError> {
        if !named_by_person(request, self.bot) {
            eprintln!("[apex-deck] media bot {} not named by a person's message, so it passed", self.bot.as_str());
            return Ok(Reply::text(PASS_TOKEN));
        }
        let kind = if self.model.kind == ModelKind::Image { "picture" } else { "video" };
        match self.make(request, on_progress).await {
            Err(ParticipantError::Failed(why) | ParticipantError::NotConfigured(why)) => Ok(Reply::text(format!("The {kind} wasn't made. {why}"))),
            other => other,
        }
    }

    /// Ask the person to pay for this. `detail` names the model and settings.
    async fn confirm(&self, what: &str, cost: Option<f64>, details: &[String], prompt: &str, on_progress: ProgressSink<'_>) -> bool {
        let price = cost.map_or("price unknown".to_string(), dollars);
        let name = self.model.label.as_deref().unwrap_or(&self.model.id);
        let settings = std::iter::once(name.to_string()).chain(details.iter().cloned()).collect::<Vec<_>>().join(" · ");
        on_progress(Progress::Activity("Waiting for your OK"));
        let action = ProposedAction { kind: ActionKind::Spend, title: format!("{what} · {price}"), detail: format!("{settings}\n\n{prompt}"), expires_at: None, risky: true };
        let approved = self.approver.decide(action).await.approved();
        if !approved {
            eprintln!("[apex-deck] media job declined: model={} cost={price}", self.model.id);
        }
        approved
    }

    async fn make(&self, request: &TurnRequest, on_progress: ProgressSink<'_>) -> Result<Reply, ParticipantError> {
        let spec = self.model.media.clone().unwrap_or_default();
        let resolved = resolve(self.model.kind, &spec, self.settings);
        let (said, images) = latest_ask(request);
        let previous = last_prompt(request);
        if said.is_empty() && images.is_empty() && previous.is_none() {
            return Err(failed("Say what to make."));
        }
        let mut prompt = build_prompt(previous.as_deref(), &said, resolved.build_on_last, spec.prompt_limit);
        match self.model.kind {
            ModelKind::Image => self.image(&spec, &resolved, &prompt, &images, on_progress).await,
            _ => {
                if prompt.is_empty() {
                    prompt = "Bring this picture to life.".into();
                }
                self.video(&spec, &resolved, &prompt, &images, on_progress).await
            }
        }
    }

    async fn image(&self, spec: &MediaSpec, resolved: &Resolved, prompt: &str, images: &[PathBuf], on_progress: ProgressSink<'_>) -> Result<Reply, ParticipantError> {
        if prompt.is_empty() {
            return Err(failed("Say what to change in the picture."));
        }
        let picture = images.first();
        let editing = picture.is_some() && spec.edit_model.is_some();
        let mut details: Vec<String> = Vec::new();
        let mut note = None;
        let cost = image_price(spec, resolved, editing);
        let shown: Vec<String> = if editing { vec!["edit".into()] } else { [&resolved.aspect_ratio, &resolved.resolution, &resolved.quality].into_iter().flatten().cloned().collect() };
        if !self.confirm(if editing { "Edit the picture" } else { "Make a picture" }, cost, &shown, prompt, on_progress).await {
            return Ok(Reply::text(PASS_TOKEN));
        }
        let bytes = if let (true, Some(picture), Some(edit_model)) = (editing, picture, spec.edit_model.as_deref()) {
            on_progress(Progress::Activity("Editing picture"));
            let (_, b64) = data_url(picture)?;
            let body = json!({ "model": edit_model, "prompt": prompt, "image": b64 });
            details.push("edit".into());
            self.send("image/edit", &body).await?.bytes().await.map_err(|e| failed(format!("the picture didn't arrive: {e}")))?.to_vec()
        } else {
            if picture.is_some() {
                note = Some("This model can't edit pictures, so it made a new one from your words.");
            }
            on_progress(Progress::Activity("Making picture"));
            let mut body = json!({ "model": self.model.id, "prompt": prompt, "format": "png" });
            for (field, value) in [("aspect_ratio", &resolved.aspect_ratio), ("resolution", &resolved.resolution), ("quality", &resolved.quality)] {
                if let Some(value) = value {
                    body[field] = json!(value);
                    details.push(value.clone());
                }
            }
            let answer: Value = self.send("image/generate", &body).await?.json().await.map_err(|e| failed(format!("Venice's answer couldn't be read: {e}")))?;
            let b64 = answer["images"][0].as_str().ok_or_else(|| failed("Venice sent no picture back."))?;
            base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| failed(format!("the picture couldn't be read: {e}")))?
        };
        let path = save(self.dir, &self.model.id, &bytes, false)?;
        let sent = if editing { spec.edit_model.as_deref().unwrap_or(self.model.id.as_str()) } else { self.model.id.as_str() };
        log_job("made", sent, None, cost, &format!("file={}", path.display()));
        Ok(Reply {
            text: reply_text(self.model, &details, cost, prompt, note, &path, false),
            cost_micros: cost.map(|c| (c * 1_000_000.0).round() as u64),
            // The price comes from our table, not from Venice's answer, so it is an estimate.
            cost_estimated: cost.is_some(),
            ..Reply::default()
        })
    }

    /// The video settings Venice is sent, for the quote and the job alike.
    fn video_body(&self, model: &str, resolved: &Resolved, animating: bool) -> Value {
        let mut body = json!({ "model": model });
        if let Some(duration) = &resolved.duration {
            body["duration"] = json!(duration);
        }
        if let Some(resolution) = &resolved.resolution {
            body["resolution"] = json!(resolution);
        }
        // An animated picture keeps its own shape.
        if let (Some(aspect), false) = (&resolved.aspect_ratio, animating) {
            body["aspect_ratio"] = json!(aspect);
        }
        if let Some(audio) = resolved.audio {
            body["audio"] = json!(audio);
        }
        body
    }

    async fn video(&self, spec: &MediaSpec, resolved: &Resolved, prompt: &str, images: &[PathBuf], on_progress: ProgressSink<'_>) -> Result<Reply, ParticipantError> {
        let picture = images.first();
        let model = match (picture, spec.image_model.as_deref()) {
            (Some(_), Some(sibling)) => sibling.to_string(),
            (None, _) if spec.needs_image => return Err(failed("This model animates a picture. Attach one with your message.")),
            _ => self.model.id.clone(),
        };
        let animating = picture.is_some() && (spec.image_model.is_some() || spec.needs_image);
        let base = self.video_body(&model, resolved, animating);
        on_progress(Progress::Activity("Checking the price"));
        let quote = self.send("video/quote", &base).await?.json::<Value>().await.ok().and_then(|q| q["quote"].as_f64());
        let mut shown: Vec<String> = [&resolved.duration, &resolved.resolution].into_iter().flatten().cloned().collect();
        if let (Some(aspect), false) = (&resolved.aspect_ratio, animating) {
            shown.push(aspect.clone());
        }
        if animating {
            shown.push("from your picture".into());
        }
        match resolved.audio {
            Some(true) => shown.push("sound".into()),
            Some(false) => shown.push("no sound".into()),
            None => {}
        }
        if !self.confirm(if animating { "Animate the picture" } else { "Make a video" }, quote, &shown, prompt, on_progress).await {
            return Ok(Reply::text(PASS_TOKEN));
        }

        let mut body = base.clone();
        body["prompt"] = json!(prompt);
        if let (true, Some(picture)) = (animating, picture) {
            body["image_url"] = json!(data_url(picture)?.0);
        }
        on_progress(Progress::Activity("Making video"));
        let queued: Value = self.send("video/queue", &body).await?.json().await.map_err(|e| failed(format!("Venice's answer couldn't be read: {e}")))?;
        let queue_id = queued["queue_id"].as_str().ok_or_else(|| failed("Venice didn't start the video."))?.to_string();
        let mut download_url = queued["download_url"].as_str().map(str::to_string);
        log_job("queued", &model, Some(&queue_id), quote, "");

        let started = Instant::now();
        let limit = Duration::from_secs(30 * 60);
        // Everything from here on is after the queue call, so any failure names the job.
        let waited: Result<PathBuf, ParticipantError> = async {
            let bytes = loop {
                tokio::time::sleep(self.poll).await;
                let mut check = json!({ "model": model, "queue_id": queue_id });
                // Files Venice hands back itself can go once they are here;
                // ones behind a download link are fetched from it first.
                if download_url.is_none() {
                    check["delete_media_on_completion"] = json!(true);
                }
                let response = self.send("video/retrieve", &check).await?;
                let is_video = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("video/") || t.starts_with("application/octet-stream"));
                if is_video {
                    break response.bytes().await.map_err(|e| failed(format!("the video didn't arrive: {e}")))?.to_vec();
                }
                let status: Value = response.json().await.map_err(|e| failed(format!("Venice's answer couldn't be read: {e}")))?;
                if let Some(url) = status["download_url"].as_str() {
                    download_url = Some(url.to_string());
                }
                // Stop as soon as Venice says the video failed, not at the time limit.
                if let Some(reason) = stopped(&status) {
                    return Err(failed(stopped_message(&reason)));
                }
                if status["status"] == "COMPLETED" {
                    let url = download_url.clone().ok_or_else(|| failed("Venice finished the video but sent no way to fetch it."))?;
                    let fetched = self.client.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| failed(format!("couldn't download the video: {e}")))?;
                    let bytes = fetched.bytes().await.map_err(|e| failed(format!("the video didn't arrive: {e}")))?.to_vec();
                    // Done with it; tidying up is best effort.
                    let _ = self.post("video/complete", &json!({ "model": model, "queue_id": queue_id })).send().await;
                    break bytes;
                }
                // Deck's own clock: Venice's count restarts when a queued job starts.
                let elapsed = started.elapsed().as_millis() as u64;
                on_progress(Progress::Activity(&video_activity(elapsed, status["average_execution_time"].as_u64())));
                if started.elapsed() > limit {
                    return Err(failed("Venice was still making the video after 30 minutes, so Deck stopped waiting."));
                }
            };
            save(self.dir, &model, &bytes, true)
        }
        .await;
        let path = match waited {
            Ok(path) => path,
            Err(error) => {
                log_job("failed", &model, Some(&queue_id), quote, &format!("reason={error}"));
                return Err(after_queue(error, &queue_id));
            }
        };
        log_job("completed", &model, Some(&queue_id), quote, &format!("file={}", path.display()));
        Ok(Reply {
            text: reply_text(self.model, &shown, quote, prompt, None, &path, true),
            cost_micros: quote.map(|c| (c * 1_000_000.0).round() as u64),
            // Venice's pre-job quote, not a charge Venice reported after the job.
            cost_estimated: quote.is_some(),
            ..Reply::default()
        })
    }
}

/// What one video costs with these choices, from Venice's own quote.
pub async fn quote(base_url: &str, api_key_env: Option<&str>, model: &str, settings: Option<&MediaSettings>) -> Result<Option<f64>, String> {
    let Some(info) = crate::api_info::model(base_url, api_key_env, model).await else { return Ok(None) };
    if info.kind != ModelKind::Video {
        return Ok(None);
    }
    let resolved = resolve(info.kind, info.media.as_ref().unwrap_or(&MediaSpec::default()), settings);
    let client = reqwest::Client::new();
    let job = Job { client: &client, base_url, key: api_key_env.filter(|n| !n.is_empty()).and_then(crate::keys::lookup), model: &info, settings, dir: Path::new(""), poll: Duration::ZERO, approver: &apex_core::NoApprover, bot: &ParticipantId::new("") };
    let response = job.send("video/quote", &job.video_body(model, &resolved, false)).await.map_err(|e| e.to_string())?;
    let answer: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(answer["quote"].as_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::ViewTurn;

    fn seedance() -> MediaSpec {
        MediaSpec {
            aspect_ratios: vec!["auto".into(), "21:9".into(), "16:9".into(), "9:16".into()],
            resolutions: vec!["480p".into(), "720p".into(), "1080p".into()],
            durations: vec!["4s".into(), "5s".into(), "6s".into(), "10s".into()],
            audio: true,
            audio_configurable: true,
            ..MediaSpec::default()
        }
    }

    #[test]
    fn video_defaults_are_five_seconds_720p_wide_with_sound() {
        let resolved = resolve(ModelKind::Video, &seedance(), None);
        assert_eq!(resolved.duration.as_deref(), Some("5s"));
        assert_eq!(resolved.resolution.as_deref(), Some("720p"));
        assert_eq!(resolved.aspect_ratio.as_deref(), Some("16:9"));
        assert_eq!(resolved.audio, Some(true));
        assert!(resolved.build_on_last);
    }

    #[test]
    fn saved_choices_win_only_when_the_model_lists_them() {
        let saved = MediaSettings { duration: Some("10s".into()), resolution: Some("4k".into()), audio: Some(false), build_on_last: Some(false), ..Default::default() };
        let resolved = resolve(ModelKind::Video, &seedance(), Some(&saved));
        assert_eq!(resolved.duration.as_deref(), Some("10s"));
        assert_eq!(resolved.resolution.as_deref(), Some("720p"), "4k isn't listed, so the default stays");
        assert_eq!(resolved.audio, Some(false));
        assert!(!resolved.build_on_last);
        let silent = MediaSpec { audio: true, audio_configurable: false, ..seedance() };
        assert_eq!(resolve(ModelKind::Video, &silent, None).audio, None, "sound that can't be switched isn't sent");
    }

    #[test]
    fn pictures_use_the_models_own_defaults_and_prices() {
        let spec = MediaSpec {
            aspect_ratios: vec!["1:1".into(), "16:9".into()],
            default_aspect_ratio: Some("1:1".into()),
            resolutions: vec!["1K".into(), "2K".into()],
            default_resolution: Some("1K".into()),
            qualities: vec!["low".into(), "medium".into()],
            default_quality: Some("medium".into()),
            prices: [("1K".to_string(), 0.07), ("2K".to_string(), 0.1), ("1K/low".to_string(), 0.05)].into_iter().collect(),
            edit_price: Some(0.08),
            ..MediaSpec::default()
        };
        let resolved = resolve(ModelKind::Image, &spec, None);
        assert_eq!(resolved.aspect_ratio.as_deref(), Some("1:1"));
        assert_eq!(image_price(&spec, &resolved, false), Some(0.07));
        let low = resolve(ModelKind::Image, &spec, Some(&MediaSettings { quality: Some("low".into()), ..Default::default() }));
        assert_eq!(image_price(&spec, &low, false), Some(0.05));
        assert_eq!(image_price(&spec, &low, true), Some(0.08));
        assert_eq!(image_price(&MediaSpec { price: Some(0.03), ..Default::default() }, &Resolved::default(), false), Some(0.03));
    }

    fn human(text: &str) -> Message {
        Message { servers: vec![], seq: 0, speaker: Speaker::Human, text: text.into(), at: None }
    }

    fn turn(unseen: Vec<Message>, turns: Vec<ViewTurn>) -> TurnRequest {
        TurnRequest { access: None, effort_override: None, system: String::new(), turns, unseen, plan: false }
    }

    #[test]
    fn the_ask_drops_handles_notes_and_attachment_lines() {
        let request = turn(vec![human("@allison a fox in snow\n\nAttached image: /a/fox.png\nAttached file: /a/notes.txt\n\n[TL;DR mode: answer in 2–4 sentences.]")], vec![]);
        let (said, images) = latest_ask(&request);
        assert_eq!(said, "a fox in snow");
        assert_eq!(images, [PathBuf::from("/a/fox.png")]);
        let from_view = turn(vec![], vec![ViewTurn { role: Role::User, content: "[Human]: first\n\n[Human]: a red bike".into() }]);
        assert_eq!(latest_ask(&from_view).0, "a red bike");
    }

    #[test]
    fn build_on_last_adds_the_change_to_the_last_description() {
        let reply = "Made with Flux · $0.03\n\nPrompt: a fox in snow\n\nAttached image: /a/flux.png";
        let request = turn(vec![], vec![ViewTurn { role: Role::Assistant, content: reply.into() }]);
        let previous = last_prompt(&request);
        assert_eq!(previous.as_deref(), Some("a fox in snow"));
        assert_eq!(build_prompt(previous.as_deref(), "at sunset", true, None), "a fox in snow\n\nChange: at sunset");
        assert_eq!(build_prompt(previous.as_deref(), "a whale", false, None), "a whale");
        assert_eq!(build_prompt(None, "a whale", true, None), "a whale");
        assert_eq!(build_prompt(Some("abcdef"), "xy", true, Some(16)), "cdef\n\nChange: xy", "the oldest words go first");
        assert_eq!(build_prompt(Some("abcdef"), "xyz", true, Some(2)), "yz");
    }

    #[test]
    fn refusals_say_what_to_do() {
        assert!(explain(402, r#"{"error":"INSUFFICIENT_BALANCE"}"#).contains("Top up"));
        assert!(explain(402, r#"{"error":"Free accounts can't do this. Upgrade or buy credits."}"#).contains("Top up"), "a real shortage isn't called a filter");
        assert!(explain(401, r#"{"error":"Authentication failed"}"#).contains("paste a new one"));
        assert!(explain(422, r#"{"error":"blocked","suggested_prompt":"a calm fox"}"#).contains("a calm fox"));
        assert!(explain(409, r#"{"error":"needs_consent","docs_url":"https://docs.venice.ai/x"}"#).contains("https://docs.venice.ai/x"));
        assert!(explain(422, r#"{"error":"Free accounts can't make this. Upgrade or buy credits."}"#).starts_with("Venice's content filter blocked this. Your account is fine."));
    }

    #[test]
    fn only_a_failure_status_or_an_error_ends_the_wait() {
        assert_eq!(stopped(&json!({ "status": "FAILED", "error": "content policy" })).as_deref(), Some("content policy"));
        assert_eq!(stopped(&json!({ "status": "CANCELLED" })).as_deref(), Some("CANCELLED"));
        assert!(stopped(&json!({ "status": "PROCESSING" })).is_none());
        assert!(stopped(&json!({ "status": "IN_PROGRESS" })).is_none(), "an unfamiliar status keeps waiting");
    }

    #[test]
    fn the_video_line_uses_venices_timings() {
        assert_eq!(video_activity(53_200, Some(145_000)), "Making video · 0:53 of ~2:25");
        assert_eq!(video_activity(5_000, None), "Making video · 0:05");
    }

    // ---------------------------------------------------------- fake Venice

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One scripted answer: status, content type, body.
    type Answer = (u16, &'static str, Vec<u8>);

    /// A server that answers each path from its own queue of answers (the
    /// last one repeats) and records every request as "PATH BODY".
    async fn fake_venice(script: Vec<(&'static str, Vec<Answer>)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let queues: Arc<Mutex<HashMap<&'static str, Vec<Answer>>>> = Arc::new(Mutex::new(script.into_iter().collect()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let (log, queues) = (log.clone(), queues.clone());
                tokio::spawn(async move {
                    let mut received = Vec::new();
                    let mut buffer = [0u8; 65536];
                    let (head, body) = loop {
                        let read = socket.read(&mut buffer).await.unwrap_or(0);
                        received.extend_from_slice(&buffer[..read]);
                        let text = String::from_utf8_lossy(&received).into_owned();
                        if let Some(split) = text.find("\r\n\r\n") {
                            let length = text[..split].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if received.len() >= split + 4 + length || read == 0 {
                                break (text[..split].to_string(), text[split + 4..].to_string());
                            }
                        }
                        if read == 0 { return; }
                    };
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    log.lock().unwrap().push(format!("{path} {body}"));
                    let (status, kind, bytes) = {
                        let mut queues = queues.lock().unwrap();
                        let key = queues.keys().find(|k| path.ends_with(*k)).copied();
                        match key.and_then(|k| queues.get_mut(k)) {
                            Some(queue) if queue.len() > 1 => queue.remove(0),
                            Some(queue) => queue[0].clone(),
                            None => (404, "application/json", b"{\"error\":\"no such path\"}".to_vec()),
                        }
                    };
                    let head = format!("HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", bytes.len());
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&bytes).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (address, seen)
    }

    fn json_answer(value: Value) -> Answer {
        (200, "application/json", value.to_string().into_bytes())
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 1, 2, 3];
    const MP4: &[u8] = &[0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 9, 9];

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-media-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn image_model() -> ApiModel {
        ApiModel { id: "flux-2-pro".into(), label: Some("Flux 2 Pro".into()), kind: ModelKind::Image, media: Some(MediaSpec {
            aspect_ratios: vec!["1:1".into(), "16:9".into()], default_aspect_ratio: Some("1:1".into()), price: Some(0.03),
            edit_model: Some("flux-2-pro-edit".into()), edit_price: Some(0.04), ..MediaSpec::default() }), ..ApiModel::default() }
    }

    fn video_model() -> ApiModel {
        ApiModel { id: "seedance-2-5-text-to-video-basic".into(), label: Some("Seedance 2.5".into()), kind: ModelKind::Video, media: Some(MediaSpec {
            image_model: Some("seedance-2-5-image-to-video-basic".into()), ..seedance() }), ..ApiModel::default() }
    }

    /// Answers every price card one way and keeps what it was shown.
    struct Cards {
        approve: bool,
        shown: Mutex<Vec<ProposedAction>>,
    }

    #[async_trait::async_trait]
    impl Approver for Cards {
        async fn decide(&self, action: ProposedAction) -> apex_core::Decision {
            self.shown.lock().unwrap().push(action);
            if self.approve { apex_core::Decision::Approve } else { apex_core::Decision::Reject }
        }
    }

    async fn run_job(address: &str, model: &ApiModel, dir: &Path, request: TurnRequest) -> (Result<Reply, ParticipantError>, Vec<String>) {
        let (result, activity, _) = run_job_answering(true, address, model, dir, request).await;
        (result, activity)
    }

    /// A turn by the bot "allison", whose price cards get `approve`.
    async fn run_job_answering(approve: bool, address: &str, model: &ApiModel, dir: &Path, request: TurnRequest) -> (Result<Reply, ParticipantError>, Vec<String>, Vec<ProposedAction>) {
        let client = reqwest::Client::new();
        let activity = Mutex::new(Vec::new());
        let sink = |p: Progress<'_>| if let Progress::Activity(a) = p { activity.lock().unwrap().push(a.to_string()) };
        let cards = Cards { approve, shown: Mutex::new(Vec::new()) };
        let bot = ParticipantId::new("allison");
        let job = Job { client: &client, base_url: address, key: Some("k".into()), model, settings: None, dir, poll: Duration::from_millis(10), approver: &cards, bot: &bot };
        let result = job.run(&request, &sink).await;
        (result, activity.into_inner().unwrap(), cards.shown.into_inner().unwrap())
    }

    #[tokio::test]
    async fn an_image_bot_saves_the_picture_and_records_its_prompt_and_price() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(PNG);
        let (address, seen) = fake_venice(vec![("/image/generate", vec![json_answer(json!({ "images": [b64] }))])]).await;
        let dir = scratch("image");
        let (result, activity) = run_job(&address, &image_model(), &dir, turn(vec![human("@allison a fox in snow")], vec![])).await;
        let reply = result.unwrap();
        let saved = dir.join("flux-2-pro.png");
        assert_eq!(std::fs::read(&saved).unwrap(), PNG);
        assert_eq!(reply.text, format!("Made with Flux 2 Pro · 1:1 · $0.03\n\nPrompt: a fox in snow\n\nAttached image: {}", saved.display()));
        assert_eq!(reply.cost_micros, Some(30_000));
        assert_eq!(activity, ["Waiting for your OK", "Making picture"]);
        let sent = seen.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_str(sent.split_once(' ').unwrap().1).unwrap();
        assert_eq!(body, json!({ "model": "flux-2-pro", "prompt": "a fox in snow", "format": "png", "aspect_ratio": "1:1" }));
    }

    #[tokio::test]
    async fn an_attached_picture_is_edited_with_the_sibling_model_building_on_the_last_prompt() {
        let (address, seen) = fake_venice(vec![("/image/edit", vec![(200, "image/png", PNG.to_vec())])]).await;
        let dir = scratch("edit");
        let picture = dir.join("fox.png");
        std::fs::write(&picture, PNG).unwrap();
        let earlier = ViewTurn { role: Role::Assistant, content: "Made with Flux 2 Pro\n\nPrompt: a fox in snow\n\nAttached image: /x.png".into() };
        let request = turn(vec![human(&format!("@allison at sunset\n\nAttached image: {}", picture.display()))], vec![earlier]);
        let reply = run_job(&address, &image_model(), &dir, request).await.0.unwrap();
        assert!(reply.text.starts_with("Made with Flux 2 Pro · edit · $0.04\n\nPrompt: a fox in snow\n\nChange: at sunset"), "{}", reply.text);
        let sent = seen.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_str(sent.split_once(' ').unwrap().1).unwrap();
        assert_eq!(body["model"], "flux-2-pro-edit");
        assert_eq!(body["image"], "iVBORw0KGgoBAgM=");
    }

    #[tokio::test]
    async fn a_video_is_quoted_queued_polled_and_saved() {
        let processing = json_answer(json!({ "status": "PROCESSING", "average_execution_time": 145000, "execution_duration": 53200 }));
        let (address, seen) = fake_venice(vec![
            ("/video/quote", vec![json_answer(json!({ "quote": 1.44 }))]),
            ("/video/queue", vec![json_answer(json!({ "model": "m", "queue_id": "q1" }))]),
            ("/video/retrieve", vec![processing.clone(), processing, (200, "video/mp4", MP4.to_vec())]),
        ]).await;
        let dir = scratch("video");
        let (result, activity) = run_job(&address, &video_model(), &dir, turn(vec![human("@allison a drone over a city at night")], vec![])).await;
        let reply = result.unwrap();
        let saved = dir.join("seedance-2-5-text-to-video-basic.mp4");
        assert_eq!(std::fs::read(&saved).unwrap(), MP4);
        assert_eq!(reply.text, format!("Made with Seedance 2.5 · 5s · 720p · 16:9 · sound · $1.44\n\nPrompt: a drone over a city at night\n\nAttached video: {}", saved.display()));
        assert_eq!(reply.cost_micros, Some(1_440_000));
        assert!(activity.iter().any(|a| a.starts_with("Making video · 0:00 of ~2:25")), "{activity:?}");
        let seen = seen.lock().unwrap().clone();
        let body = |i: usize| -> Value { serde_json::from_str(seen[i].split_once(' ').unwrap().1).unwrap() };
        assert_eq!(body(0), json!({ "model": "seedance-2-5-text-to-video-basic", "duration": "5s", "resolution": "720p", "aspect_ratio": "16:9", "audio": true }));
        assert_eq!(body(1)["prompt"], "a drone over a city at night");
        assert_eq!(body(2), json!({ "model": "seedance-2-5-text-to-video-basic", "queue_id": "q1", "delete_media_on_completion": true }));
    }

    #[tokio::test]
    async fn a_private_video_is_fetched_from_its_link_and_an_attached_picture_is_animated() {
        // The finished file sits behind a link on another server.
        let (address, seen) = fake_venice(vec![("/files/clip.mp4", vec![(200, "video/mp4", MP4.to_vec())])]).await;
        let queued = json_answer(json!({ "model": "m", "queue_id": "q2", "download_url": format!("{address}/files/clip.mp4") }));
        let (address2, seen2) = fake_venice(vec![
            ("/video/quote", vec![json_answer(json!({ "quote": 0.5 }))]),
            ("/video/queue", vec![queued]),
            ("/video/retrieve", vec![json_answer(json!({ "status": "COMPLETED" }))]),
            ("/video/complete", vec![json_answer(json!({ "success": true }))]),
        ]).await;
        let dir = scratch("private");
        let picture = dir.join("cat.png");
        std::fs::write(&picture, PNG).unwrap();
        let request = turn(vec![human(&format!("@allison\nAttached image: {}", picture.display()))], vec![]);
        let reply = run_job(&address2, &video_model(), &dir, request).await.0.unwrap();
        assert!(reply.text.contains("· from your picture ·"), "{}", reply.text);
        assert!(reply.text.contains("Prompt: Bring this picture to life."), "{}", reply.text);
        assert_eq!(std::fs::read(dir.join("seedance-2-5-image-to-video-basic.mp4")).unwrap(), MP4);
        let sent = seen2.lock().unwrap().clone();
        let queue: Value = serde_json::from_str(sent[1].split_once(' ').unwrap().1).unwrap();
        assert_eq!(queue["model"], "seedance-2-5-image-to-video-basic");
        assert!(queue["image_url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(queue.get("aspect_ratio").is_none(), "an animated picture keeps its own shape");
        assert!(!sent[2].contains("delete_media_on_completion"), "a linked file isn't deleted before it is fetched");
        assert!(sent.iter().any(|r| r.starts_with("/video/complete")), "{sent:?}");
        assert!(seen.lock().unwrap().iter().any(|r| r.starts_with("/files/clip.mp4")));
    }

    #[tokio::test]
    async fn refusals_from_venice_reach_the_chat_with_what_to_do() {
        let (address, _) = fake_venice(vec![("/video/quote", vec![(402, "application/json", br#"{"error":"INSUFFICIENT_BALANCE"}"#.to_vec())])]).await;
        let dir = scratch("broke");
        // Failures are replies, so the chat keeps them.
        let said = run_job(&address, &video_model(), &dir, turn(vec![human("@allison a whale")], vec![])).await.0.unwrap().text;
        assert!(said.starts_with("The video wasn't made. ") && said.contains("balance is too low"), "{said}");
        let (address, _) = fake_venice(vec![("/image/generate", vec![(422, "application/json", br#"{"error":"Content policy","suggested_prompt":"a calm fox"}"#.to_vec())])]).await;
        let said = run_job(&address, &image_model(), &dir, turn(vec![human("@allison x")], vec![])).await.0.unwrap().text;
        assert!(said.starts_with("The picture wasn't made. ") && said.contains("a calm fox"), "{said}");
        let picture_only = ApiModel { media: Some(MediaSpec { needs_image: true, ..seedance() }), ..video_model() };
        let said = run_job(&address, &picture_only, &dir, turn(vec![human("@allison a whale")], vec![])).await.0.unwrap().text;
        assert!(said.contains("Attach one"), "{said}");
    }

    #[tokio::test]
    async fn only_a_persons_message_naming_the_bot_can_spend() {
        let (address, seen) = fake_venice(vec![("/video/quote", vec![json_answer(json!({ "quote": 2.91 }))])]).await;
        let dir = scratch("unnamed");
        let earlier = ViewTurn { role: Role::Assistant, content: "Made with Seedance 2.5\n\nPrompt: a city at night\n\nAttached video: /x.mp4".into() };
        let bot_said = Message { servers: vec![], seq: 1, speaker: Speaker::Bot(ParticipantId::new("jigga")), text: "a stray @allison would spend money".into(), at: None };
        for (why, unseen) in [
            ("names nobody", vec![human("here's the usage table")]),
            ("names the room", vec![human("@all thoughts?")]),
            ("another bot named it", vec![human("what happened?"), bot_said.clone()]),
            ("no new message at all", vec![]),
        ] {
            let (result, _, cards) = run_job_answering(true, &address, &video_model(), &dir, turn(unseen, vec![earlier.clone()])).await;
            assert_eq!(result.unwrap().text, PASS_TOKEN, "{why}");
            assert!(cards.is_empty(), "{why}");
        }
        assert!(seen.lock().unwrap().is_empty(), "nothing reached Venice");
    }

    #[tokio::test]
    async fn every_job_asks_with_its_price_and_a_no_spends_nothing() {
        let (address, seen) = fake_venice(vec![("/video/quote", vec![json_answer(json!({ "quote": 2.91 }))])]).await;
        let dir = scratch("declined");
        let (result, activity, cards) = run_job_answering(false, &address, &video_model(), &dir, turn(vec![human("@allison a whale")], vec![])).await;
        assert_eq!(result.unwrap().text, PASS_TOKEN);
        assert_eq!(activity.last().map(String::as_str), Some("Waiting for your OK"));
        assert_eq!(cards.len(), 1);
        assert_eq!((cards[0].kind, cards[0].title.as_str(), cards[0].risky), (ActionKind::Spend, "Make a video · $2.91", true));
        assert_eq!(cards[0].detail, "Seedance 2.5 · 5s · 720p · 16:9 · sound\n\na whale");
        assert!(seen.lock().unwrap().iter().all(|r| r.starts_with("/video/quote")), "only the free quote was asked for");

        let (address, seen) = fake_venice(vec![]).await;
        let (_, _, cards) = run_job_answering(false, &address, &image_model(), &dir, turn(vec![human("@allison a fox")], vec![])).await;
        assert_eq!(cards[0].title, "Make a picture · $0.03");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn build_on_last_skips_replies_that_made_nothing() {
        let made = ViewTurn { role: Role::Assistant, content: "Made with Flux\n\nPrompt: a fox in snow\n\nAttached image: /x.png".into() };
        let failed = ViewTurn { role: Role::Assistant, content: "The picture wasn't made. Venice is busy right now.".into() };
        assert_eq!(last_prompt(&turn(vec![], vec![made, failed])).as_deref(), Some("a fox in snow"));
    }

    #[tokio::test]
    async fn a_video_venice_stops_with_a_failed_status_ends_at_once_with_the_job_number() {
        let (address, seen) = fake_venice(vec![
            ("/video/quote", vec![json_answer(json!({ "quote": 2.91 }))]),
            ("/video/queue", vec![json_answer(json!({ "model": "m", "queue_id": "q9" }))]),
            ("/video/retrieve", vec![json_answer(json!({ "status": "FAILED", "error": "Blocked by the content policy" }))]),
        ]).await;
        let dir = scratch("blocked");
        let reply = run_job(&address, &video_model(), &dir, turn(vec![human("@allison a whale")], vec![])).await.0.unwrap();
        assert_eq!(reply.text, "The video wasn't made. Venice's content filter blocked this. Your account is fine. Try rewording it, for example without real names. Job q9. Venice may still charge for it; quote this job number to Venice support for a refund.");
        let polls = seen.lock().unwrap().iter().filter(|r| r.starts_with("/video/retrieve")).count();
        assert_eq!(polls, 1, "the first poll that says it failed is the last");
    }

    #[tokio::test]
    async fn a_video_venice_cancels_says_why_with_the_job_number() {
        let (address, _) = fake_venice(vec![
            ("/video/quote", vec![json_answer(json!({ "quote": 2.91 }))]),
            ("/video/queue", vec![json_answer(json!({ "model": "m", "queue_id": "q10" }))]),
            ("/video/retrieve", vec![json_answer(json!({ "status": "CANCELLED" }))]),
        ]).await;
        let dir = scratch("cancelled");
        let reply = run_job(&address, &video_model(), &dir, turn(vec![human("@allison a whale")], vec![])).await.0.unwrap();
        assert_eq!(reply.text, "The video wasn't made. Venice stopped making the video: CANCELLED. Job q10. Venice may still charge for it; quote this job number to Venice support for a refund.");
    }
}
