//! Connected apps, read-only: GitHub, Gmail and Google Drive, plus the
//! assistant's own browser. Each call is one operation through the gateway,
//! like a command. What comes back is external content: it's shown and
//! quoted as evidence, and it can never start a task or approve anything,
//! because only the human's own events do that.
//!
//! Credentials stay in this machine's key store and never reach a prompt:
//! `GITHUB_TOKEN` for GitHub, and `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
//! and `GOOGLE_REFRESH_TOKEN` (read-only scopes) for Gmail and Drive.

use serde::Serialize;
use serde_json::Value;

use super::ToolRun;
use crate::personal::OperationSpec;

pub const TOOLS: &[(&str, &str)] = &[
    ("github.get", "GitHub REST GET, read-only. argv: [\"/repos/OWNER/REPO/pulls?state=open\"]"),
    ("gmail.search", "Search Gmail, read-only. argv: [\"from:alice newer_than:7d\"]"),
    ("gmail.read", "Read one Gmail message as text. argv: [\"MESSAGE_ID\"]"),
    ("drive.search", "Search Google Drive by text, read-only. argv: [\"quarterly report\"]"),
    ("drive.read", "Read one Drive file as text. argv: [\"FILE_ID\"]"),
    ("browser.open", "Open a web page in your own browser and read its text; this asks the human first. argv: [\"https://example.com\"]"),
];
const MAX_TEXT: usize = 48 * 1024;

pub fn known(name: &str) -> bool {
    TOOLS.iter().any(|(tool, _)| *tool == name)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub kind: String,
    pub connected: bool,
    /// Key names to save to connect it. Values never leave this machine.
    pub keys: Vec<String>,
}

fn key(name: &str) -> Option<String> {
    apex_adapters::keys::lookup(name).filter(|value| !value.trim().is_empty())
}

pub fn status() -> Vec<Connector> {
    let google = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
    let google_ok = google.iter().all(|k| key(k).is_some());
    vec![
        Connector { kind: "github".into(), connected: key("GITHUB_TOKEN").is_some(), keys: vec!["GITHUB_TOKEN".into()] },
        Connector { kind: "gmail".into(), connected: google_ok, keys: google.iter().map(|s| s.to_string()).collect() },
        Connector { kind: "drive".into(), connected: google_ok, keys: google.iter().map(|s| s.to_string()).collect() },
        Connector { kind: "browser".into(), connected: super::browser::available(), keys: vec![] },
    ]
}

/// The tools the model may propose right now, with how to call them.
pub fn available() -> Vec<(&'static str, &'static str)> {
    let on: Vec<String> = status().into_iter().filter(|c| c.connected).map(|c| c.kind).collect();
    TOOLS.iter().filter(|(tool, _)| on.iter().any(|kind| tool.starts_with(&format!("{kind}.")))).copied().collect()
}

fn cut(text: String) -> String {
    if text.len() <= MAX_TEXT {
        return text;
    }
    let mut end = MAX_TEXT;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}\n… (cut)", &text[..end])
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("apex-deck-assistant")
        .build()
        .map_err(|e| e.to_string())
}

async fn get_json(request: reqwest::RequestBuilder) -> Result<(u16, Value), String> {
    let response = request.send().await.map_err(|e| format!("The request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok((status, serde_json::from_str(&body).unwrap_or(Value::String(body))))
}

fn arg(spec: &OperationSpec) -> Result<&str, String> {
    spec.argv.first().map(String::as_str).filter(|a| !a.trim().is_empty()).ok_or_else(|| "It needs one argument.".into())
}

pub async fn run(spec: &OperationSpec) -> Result<ToolRun, String> {
    let (code, text) = match spec.tool.as_str() {
        "github.get" => github(arg(spec)?).await?,
        "gmail.search" => gmail_search(arg(spec)?).await?,
        "gmail.read" => gmail_read(arg(spec)?).await?,
        "drive.search" => drive_search(arg(spec)?).await?,
        "drive.read" => drive_read(arg(spec)?).await?,
        "browser.open" => super::browser::open_text(arg(spec)?).await?,
        other => return Err(format!("{other} isn't a connector.")),
    };
    Ok(ToolRun { exit_code: code, output: cut(text) })
}

/// A path on api.github.com. GET only, so nothing on GitHub can change.
async fn github(path: &str) -> Result<(i32, String), String> {
    let token = key("GITHUB_TOKEN").ok_or("GitHub isn't connected: save a GITHUB_TOKEN on this machine.")?;
    let path = path.trim();
    if !path.starts_with('/') || path.contains("://") || path.contains("..") {
        return Err("Give a GitHub API path like /repos/OWNER/REPO/issues.".into());
    }
    let (status, body) = get_json(client()?.get(format!("https://api.github.com{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")).await?;
    Ok((if status < 300 { 0 } else { i32::from(status) }, serde_json::to_string_pretty(&slim(body)).unwrap_or_default()))
}

/// Drop GitHub's bulky URL fields so more of what matters fits.
fn slim(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter()
            .filter(|(k, _)| !(k.ends_with("_url") && k != "html_url") && k != "node_id" && k != "_links" && k != "reactions")
            .map(|(k, v)| (k, slim(v))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(slim).collect()),
        other => other,
    }
}

/// A fresh Google access token from the saved refresh token.
async fn google_token() -> Result<String, String> {
    let (Some(id), Some(secret), Some(refresh)) = (key("GOOGLE_CLIENT_ID"), key("GOOGLE_CLIENT_SECRET"), key("GOOGLE_REFRESH_TOKEN")) else {
        return Err("Google isn't connected: connect it from the assistant's Connections on the Mac.".into());
    };
    let (status, body) = get_json(client()?.post("https://oauth2.googleapis.com/token").form(&[
        ("client_id", id.as_str()), ("client_secret", secret.as_str()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token"),
    ])).await?;
    if status >= 300 {
        return Err(format!("Google refused the saved sign-in ({status}). Connect Google again."));
    }
    body["access_token"].as_str().map(str::to_owned).ok_or_else(|| "Google didn't return an access token.".into())
}

async fn gmail_search(query: &str) -> Result<(i32, String), String> {
    let token = google_token().await?;
    let http = client()?;
    let (status, list) = get_json(http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .bearer_auth(&token).query(&[("q", query), ("maxResults", "10")])).await?;
    if status >= 300 {
        return Ok((i32::from(status), list.to_string()));
    }
    let mut out = Vec::new();
    for id in list["messages"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).take(10) {
        let (_, message) = get_json(http.get(format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}"))
            .bearer_auth(&token).query(&[("format", "metadata"), ("metadataHeaders", "From"), ("metadataHeaders", "Subject"), ("metadataHeaders", "Date")])).await?;
        let header = |name: &str| message["payload"]["headers"].as_array().into_iter().flatten()
            .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
            .and_then(|h| h["value"].as_str()).unwrap_or("").to_owned();
        out.push(format!("id {id}\nFrom: {}\nDate: {}\nSubject: {}\n{}\n", header("From"), header("Date"), header("Subject"), message["snippet"].as_str().unwrap_or("")));
    }
    Ok((0, if out.is_empty() { "No messages matched.".into() } else { out.join("\n") }))
}

fn base64url(data: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(data.trim_end_matches('='))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default()
}

/// The first text/plain part of a message, else its text/html with tags dropped.
fn body_text(part: &Value) -> Option<String> {
    let mime = part["mimeType"].as_str().unwrap_or("");
    if mime == "text/plain" {
        return part["body"]["data"].as_str().map(base64url);
    }
    for child in part["parts"].as_array().into_iter().flatten() {
        if let Some(text) = body_text(child) { return Some(text); }
    }
    (mime == "text/html").then(|| part["body"]["data"].as_str().map(|d| strip_tags(&base64url(d)))).flatten()
}

pub(crate) fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c { '<' => in_tag = true, '>' => { in_tag = false; out.push(' ') } _ if !in_tag => out.push(c), _ => {} }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn gmail_read(id: &str) -> Result<(i32, String), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That isn't a Gmail message id.".into());
    }
    let token = google_token().await?;
    let (status, message) = get_json(client()?.get(format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}"))
        .bearer_auth(token).query(&[("format", "full")])).await?;
    if status >= 300 {
        return Ok((i32::from(status), message.to_string()));
    }
    let header = |name: &str| message["payload"]["headers"].as_array().into_iter().flatten()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str()).unwrap_or("").to_owned();
    let body = body_text(&message["payload"]).unwrap_or_else(|| message["snippet"].as_str().unwrap_or("").to_owned());
    Ok((0, format!("From: {}\nTo: {}\nDate: {}\nSubject: {}\n\n{body}", header("From"), header("To"), header("Date"), header("Subject"))))
}

async fn drive_search(text: &str) -> Result<(i32, String), String> {
    let token = google_token().await?;
    let escaped = text.replace('\\', "\\\\").replace('\'', "\\'");
    let (status, body) = get_json(client()?.get("https://www.googleapis.com/drive/v3/files").bearer_auth(token).query(&[
        ("q", format!("fullText contains '{escaped}' and trashed = false").as_str()),
        ("pageSize", "10"),
        ("fields", "files(id,name,mimeType,modifiedTime,webViewLink)"),
    ])).await?;
    if status >= 300 {
        return Ok((i32::from(status), body.to_string()));
    }
    let lines: Vec<String> = body["files"].as_array().into_iter().flatten().map(|f| format!(
        "id {}  {}  ({}, modified {})", f["id"].as_str().unwrap_or(""), f["name"].as_str().unwrap_or(""), f["mimeType"].as_str().unwrap_or(""), f["modifiedTime"].as_str().unwrap_or(""),
    )).collect();
    Ok((0, if lines.is_empty() { "No files matched.".into() } else { lines.join("\n") }))
}

async fn drive_read(id: &str) -> Result<(i32, String), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That isn't a Drive file id.".into());
    }
    let token = google_token().await?;
    let http = client()?;
    let (status, meta) = get_json(http.get(format!("https://www.googleapis.com/drive/v3/files/{id}")).bearer_auth(&token).query(&[("fields", "name,mimeType,size")])).await?;
    if status >= 300 {
        return Ok((i32::from(status), meta.to_string()));
    }
    let mime = meta["mimeType"].as_str().unwrap_or("");
    let request = if mime.starts_with("application/vnd.google-apps.") {
        let export = if mime.ends_with("spreadsheet") { "text/csv" } else { "text/plain" };
        http.get(format!("https://www.googleapis.com/drive/v3/files/{id}/export")).query(&[("mimeType", export)])
    } else if mime.starts_with("text/") || mime == "application/json" {
        http.get(format!("https://www.googleapis.com/drive/v3/files/{id}")).query(&[("alt", "media")])
    } else {
        return Ok((0, format!("{} is a {mime} file, which I can't read as text.", meta["name"].as_str().unwrap_or(id))));
    };
    let response = request.bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    let code = response.status().as_u16();
    let text = response.text().await.map_err(|e| e.to_string())?;
    Ok((if code < 300 { 0 } else { i32::from(code) }, format!("{}\n\n{text}", meta["name"].as_str().unwrap_or(id))))
}
