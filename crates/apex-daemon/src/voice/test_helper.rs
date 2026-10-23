use super::*;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
pub async fn fake_helper(token: &str) -> (Running, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = token.to_owned();
    let running = Running {
        port,
        token: token.clone(),
    };
    let owner = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let token = token.clone();
            let owner = owner.clone();
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, origin_check)
                .await
                else {
                    return;
                };
                let auth = ws.next().await.unwrap().unwrap().into_text().unwrap();
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&auth).unwrap(),
                    json!({"type":"auth","token":token})
                );
                if owner.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let _=ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame{code:tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,reason:"Call already active".into()})).await;
                    return;
                }
                struct Release(Arc<std::sync::atomic::AtomicBool>);
                impl Drop for Release {
                    fn drop(&mut self) {
                        self.0.store(false, std::sync::atomic::Ordering::SeqCst)
                    }
                }
                let _release = Release(owner);
                ws.send(Message::text(
                    json!({"type":"authenticated","protocolVersion":1}).to_string(),
                ))
                .await
                .unwrap();
                while let Some(Ok(message)) = ws.next().await {
                    match message {
                        Message::Binary(b) => {
                            if ws.send(Message::Binary(b)).await.is_err() {
                                break;
                            }
                        }
                        Message::Text(t) => {
                            let ctl: serde_json::Value = serde_json::from_str(&t).unwrap();
                            if ctl["type"] == "end" {
                                let _ = ws.close(None).await;
                                break;
                            }
                            if ctl["type"] == "start" {
                                let reply = json!({"type":"ready","callId":ctl["callId"],"generation":ctl["generation"],"voices":["am_michael"],"semantic":true});
                                if ws.send(Message::text(reply.to_string())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        _ => break,
                    }
                }
            });
        }
    });
    (running, task)
}
struct FakeLaunch(Running);
struct FakeProcess;
impl Helper for FakeProcess {
    fn exited(&mut self) -> futures::future::BoxFuture<'_, String> {
        Box::pin(std::future::pending())
    }
}
#[async_trait::async_trait]
impl Launch for FakeLaunch {
    async fn launch(&self, _: &Path) -> Result<(Running, Box<dyn Helper>), String> {
        Ok((self.0.clone(), Box::new(FakeProcess)))
    }
}
pub fn server_with_helper(data: &Path, running: Running) -> Arc<VoiceServer> {
    let server = VoiceServer::with(
        data,
        Ok(()),
        manifest::LINUX_X86_64,
        Deps {
            fetch: Arc::new(install::Http),
            run: Arc::new(install::Process),
            free_bytes: Arc::new(|_| Ok(u64::MAX)),
            launch: Arc::new(FakeLaunch(running)),
            idle: IDLE,
        },
    );
    let dest = server.root.join(&server.manifest.version);
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(
        dest.join("complete.json"),
        json!({"manifestSha256":server.manifest_hash}).to_string(),
    )
    .unwrap();
    server
}
pub fn bin(seq: u32) -> String {
    use base64::Engine;
    let mut b = vec![0; 1036];
    b[..2].copy_from_slice(b"DV");
    b[2] = 1;
    b[8..12].copy_from_slice(&seq.to_le_bytes());
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// The fake helper accepts a handshake only from the daemon's own origin.
/// tungstenite fixes the callback's error type, and its `ErrorResponse` is
/// much larger than the response it hands back.
#[allow(clippy::result_large_err)]
fn origin_check(
    req: &tokio_tungstenite::tungstenite::handshake::server::Request,
    response: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    assert_eq!(req.headers()["origin"], "apex-daemon");
    Ok(response)
}
