use super::Running;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
pub enum FromHelper {
    Ctl(serde_json::Value),
    Bin(Vec<u8>),
}
pub struct Relay {
    tx: mpsc::Sender<Message>,
    rx: mpsc::Receiver<FromHelper>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Relay {
    pub async fn connect(running: &Running) -> Result<Self, String> {
        // The helper acknowledges exclusive ownership. A stale socket may still
        // be closing during same-device takeover, so only that policy close is
        // retried; no audio or control is sent until authentication succeeds.
        let connect = async {
            loop {
                let mut req = format!("ws://127.0.0.1:{}", running.port)
                    .into_client_request()
                    .map_err(|e| e.to_string())?;
                req.headers_mut()
                    .insert("Origin", "apex-daemon".parse().unwrap());
                let (mut ws, _) = tokio_tungstenite::connect_async(req)
                    .await
                    .map_err(|e| e.to_string())?;
                ws.send(Message::text(
                    serde_json::json!({"type":"auth","token":running.token}).to_string(),
                ))
                .await
                .map_err(|e| e.to_string())?;
                match ws.next().await {
                    Some(Ok(Message::Text(t))) if t.len() <= 65536 => {
                        let value: serde_json::Value = serde_json::from_str(&t)
                            .map_err(|_| "Invalid voice helper authentication".to_string())?;
                        if value["type"] == "authenticated" && value["protocolVersion"] == 1 {
                            return Ok::<_, String>(ws);
                        }
                        return Err("Invalid voice helper authentication".into());
                    }
                    Some(Ok(Message::Close(Some(frame))))
                        if u16::from(frame.code) == 1008
                            && frame.reason == "Call already active" =>
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    _ => return Err("Voice helper authentication failed".into()),
                }
            }
        };
        let ws = tokio::time::timeout(std::time::Duration::from_secs(5), connect)
            .await
            .map_err(|_| "Voice helper connection timed out".to_string())??;
        let (tx, mut outgoing) = mpsc::channel(64);
        let (incoming, rx) = mpsc::channel(64);
        let task = tokio::spawn(async move {
            let (mut sink, mut stream) = ws.split();
            loop {
                tokio::select! {
                    message = outgoing.recv() => match message {
                        Some(message) => if sink.send(message).await.is_err() { break; },
                        None => break,
                    },
                    message = stream.next() => {
                        let frame = match message {
                            Some(Ok(Message::Text(text))) if text.len() <= 65536 =>
                                serde_json::from_str(&text).ok().map(FromHelper::Ctl),
                            Some(Ok(Message::Binary(bytes))) if bytes.len() <= 32012 =>
                                Some(FromHelper::Bin(bytes.to_vec())),
                            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                            _ => break,
                        };
                        match frame {
                            Some(frame) => if incoming.try_send(frame).is_err() { break; },
                            None => break,
                        }
                    }
                }
            }
        });
        Ok(Self { tx, rx, task })
    }
    pub fn abort_handle(&self) -> tokio::task::AbortHandle {
        self.task.abort_handle()
    }
    pub fn send_ctl(&self, ctl: serde_json::Value) -> bool {
        self.tx.try_send(Message::text(ctl.to_string())).is_ok()
    }
    pub fn send_bin(&self, frame: Vec<u8>) -> bool {
        self.tx.try_send(Message::Binary(frame.into())).is_ok()
    }
    pub async fn recv(&mut self) -> Option<FromHelper> {
        self.rx.recv().await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn socket_auth_controls_audio_and_close() {
        let (running, task) = crate::voice::test_helper::fake_helper("secret").await;
        let mut relay = Relay::connect(&running).await.unwrap();
        assert!(relay.send_ctl(serde_json::json!({"type":"start","callId":"c","generation":0})));
        match tokio::time::timeout(std::time::Duration::from_secs(2), relay.recv())
            .await
            .unwrap()
            .unwrap()
        {
            FromHelper::Ctl(v) => assert_eq!(v["type"], "ready"),
            _ => panic!("expected control"),
        };
        let frame = vec![0; 1036];
        assert!(relay.send_bin(frame.clone()));
        match relay.recv().await.unwrap() {
            FromHelper::Bin(b) => assert_eq!(b, frame),
            _ => panic!("expected binary"),
        };
        assert!(relay.send_ctl(serde_json::json!({"type":"end"})));
        assert!(relay.recv().await.is_none());
        task.abort();
    }
}
