//! Saved API keys as the OpenAI-compatible backend sees them. Keys go to a
//! temp folder through `keys::use_file`, never the real Keychain. `use_file`
//! is global, so every test points it at the same folder and a lock keeps
//! the tests from writing the key file at the same time.

use std::sync::Mutex;
use std::time::Duration;

use apex_adapters::{keys, list_models, OpenAiCompatParticipant};
use apex_core::{
    Access, Backend, Participant, ParticipantConfig, ParticipantError, ParticipantId, Role,
    TurnRequest, ViewTurn,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static LOCK: Mutex<()> = Mutex::new(());

fn data_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("apex-api-keys-test-{}", std::process::id()))
}

/// Point key storage at the shared temp folder and take the lock.
fn setup() -> std::sync::MutexGuard<'static, ()> {
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    keys::use_file(&data_dir());
    guard
}

fn config(id: &str, backend: Backend) -> ParticipantConfig {
    ParticipantConfig {
        id: ParticipantId::new(id),
        display_name: id.to_string(),
        backend,
        persona: String::new(),
        access: Access::Read,
        effort: None,
        auto_effort: false,
        appearance: None,
    }
}

fn request(text: &str) -> TurnRequest {
    TurnRequest {
        effort_override: None,
        access: None,
        system: "You are a test bot.".into(),
        turns: vec![ViewTurn { role: Role::User, content: format!("[Human]: {text}") }],
        unseen: vec![],
        plan: false,
    }
}

fn api(base_url: String, api_key_env: Option<&str>) -> Backend {
    Backend::OpenAiCompatible {
        base_url,
        model: "test-model".into(),
        api_key_env: api_key_env.map(str::to_string),
    }
}

/// A one-shot HTTP server. It answers the first request with `status` and
/// the given body pieces, and returns the request it was sent.
async fn serve_once(
    status: &'static str,
    pieces: Vec<&'static [u8]>,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            received.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&received).into_owned();
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text[..split]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if received.len() >= split + 4 + length {
                    break;
                }
            }
            if read == 0 {
                break;
            }
        }
        let head = format!(
            "HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n"
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        for piece in pieces {
            socket.write_all(piece).await.unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        socket.shutdown().await.unwrap();
        String::from_utf8_lossy(&received).into_owned()
    });
    (address, handle)
}

#[tokio::test]
async fn bot_sends_the_saved_key_as_a_bearer_token() {
    let _guard = setup();
    let name = "APEX_TEST_KEY_SENDS";
    std::env::remove_var(name);
    keys::save(name, "  saved-secret-456 \n").unwrap();

    let (address, server) = serve_once(
        "200 OK",
        vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"],
    )
    .await;
    let bot = OpenAiCompatParticipant::new(config("api", api(address, Some(name))));
    let reply = bot.respond(request("hi"), &|_| {}).await.unwrap();
    assert_eq!(reply.text, "ok");

    let sent = server.await.unwrap().to_ascii_lowercase();
    assert!(sent.contains("authorization: bearer saved-secret-456"), "{sent}");
    keys::remove(name).unwrap();
}

#[tokio::test]
async fn bot_naming_a_key_that_is_nowhere_fails_before_any_request() {
    let _guard = setup();
    let name = "APEX_TEST_KEY_NOWHERE";
    std::env::remove_var(name);
    keys::remove(name).unwrap();

    // Nothing listens on this port, so a request would fail differently.
    let bot = OpenAiCompatParticipant::new(config("api", api("http://127.0.0.1:9".into(), Some(name))));
    let error = bot.respond(request("hi"), &|_| {}).await.unwrap_err();
    assert!(matches!(error, ParticipantError::NotConfigured(_)), "{error:?}");
    let message = error.to_string();
    assert!(message.contains("no API key is saved for"), "{message}");
    assert!(message.contains(name), "{message}");
}

#[tokio::test]
async fn unauthorized_server_without_a_key_setting_asks_for_an_api_key() {
    let _guard = setup();
    let (address, _server) = serve_once("401 Unauthorized", vec![b"{\"error\":\"no key\"}"]).await;
    let bot = OpenAiCompatParticipant::new(config("api", api(address, None)));
    let error = bot.respond(request("hi"), &|_| {}).await.unwrap_err();
    let message = error.to_string();
    assert!(message.contains("401"), "{message}");
    assert!(message.contains("API key"), "{message}");
}

#[tokio::test]
async fn list_models_sends_the_saved_key_and_works_without_one() {
    let _guard = setup();
    let name = "APEX_TEST_KEY_MODELS";
    std::env::remove_var(name);
    keys::save(name, "models-secret-789").unwrap();

    let body: &'static [u8] = b"{\"data\":[{\"id\":\"zeta\"},{\"id\":\"alpha\"}]}";
    let (address, server) = serve_once("200 OK", vec![body]).await;
    let models = list_models(&address, Some(name)).await.unwrap();
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["alpha", "zeta"]);
    let sent = server.await.unwrap().to_ascii_lowercase();
    assert!(sent.starts_with("get /models "), "{sent}");
    assert!(sent.contains("authorization: bearer models-secret-789"), "{sent}");
    keys::remove(name).unwrap();

    // With no key anywhere, the request still goes out and succeeds.
    let missing = "APEX_TEST_KEY_MODELS_MISSING";
    std::env::remove_var(missing);
    keys::remove(missing).unwrap();
    let (address, server) = serve_once("200 OK", vec![body]).await;
    let models = list_models(&address, Some(missing)).await.unwrap();
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["alpha", "zeta"]);
    let sent = server.await.unwrap().to_ascii_lowercase();
    assert!(sent.starts_with("get /models "), "{sent}");
    assert!(!sent.contains("authorization:"), "{sent}");
}
