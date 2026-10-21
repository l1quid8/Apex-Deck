use super::{
    relay::{FromHelper, Relay},
    Lease, Owner, VoiceServer,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc};
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum VoiceRequest {
    VoiceServerStatus {},
    VoiceServerInstall {},
    VoiceServerInstallCancel {},
    VoiceServerWarm {
        room: String,
    },
    VoiceServerOpen {
        room: String,
    },
    VoiceServerClose {
        channel: u32,
        #[serde(default)]
        reason: String,
    },
}
struct Active {
    channel: u32,
    room: String,
    lease: Lease,
    relay: Relay,
    mic: u64,
}
pub struct VoiceSession {
    server: Arc<VoiceServer>,
    pub owner: Owner,
    next: u32,
    active: Option<Active>,
    pending: VecDeque<String>,
    invalid: bool,
}
impl VoiceSession {
    pub fn new(server: Arc<VoiceServer>, owner: Owner) -> Self {
        Self {
            server,
            owner,
            next: 0,
            active: None,
            pending: VecDeque::new(),
            invalid: false,
        }
    }
    pub fn room(&self) -> Option<&str> {
        self.active.as_ref().map(|a| a.room.as_str())
    }
    pub fn attach(&mut self, room: String, lease: Lease, relay: Relay) -> u32 {
        self.close_all("replaced by a new call");
        self.next = self.next.checked_add(1).expect("voice channel exhausted");
        lease.bind_relay(&relay);
        self.active = Some(Active {
            channel: self.next,
            room,
            lease,
            relay,
            mic: 0,
        });
        self.invalid = false;
        self.next
    }
    fn bad(&mut self) {
        if !self.invalid {
            self.invalid = true;
            self.server.log("invalidFrame", json!({}));
        }
    }
    pub fn frame(&mut self, v: &Value) {
        let Some(a) = self.active.as_mut() else {
            return;
        };
        if v["channel"].as_u64() != Some(a.channel as u64) {
            self.bad();
            return;
        }
        let ok = if let Some(ctl) = v.get("ctl") {
            if !ctl.is_object()
                || ctl.to_string().len() > 65536
                || !matches!(
                    ctl["type"].as_str(),
                    Some(
                        "start"
                            | "speak"
                            | "cancel"
                            | "playbackProgress"
                            | "playbackComplete"
                            | "end"
                    )
                )
            {
                self.bad();
                return;
            }
            a.relay.send_ctl(ctl.clone())
        } else if let Some(bin) = v["bin"].as_str() {
            if bin.len() > 42684 {
                self.bad();
                return;
            }
            let Ok(frame) = STANDARD.decode(bin) else {
                self.bad();
                return;
            };
            if frame.len() < 14
                || frame.len() > 32012
                || &frame[..2] != b"DV"
                || frame[2..4] != [1, 0]
                || frame.len() % 2 != 0
            {
                self.bad();
                return;
            }
            let seq = u32::from_le_bytes(frame[8..12].try_into().unwrap());
            if a.relay.send_bin(frame) {
                a.mic += 1;
                if a.mic % 16 == 0 {
                    if self.pending.len() >= 64 {
                        self.close_all("voice connection is too slow");
                        return;
                    }
                    self.pending
                        .push_back(json!({"voice":{"channel":a.channel,"rx":seq}}).to_string());
                }
                true
            } else {
                false
            }
        } else {
            self.bad();
            return;
        };
        if !ok {
            self.close_all("voice connection is too slow");
        }
    }
    pub fn close(&mut self, channel: u32, reason: &str) {
        if self.active.as_ref().is_some_and(|a| a.channel == channel) {
            self.active = None;
            self.pending.clear();
            self.server.log(
                "closed",
                json!({"reason":reason.chars().take(200).collect::<String>()}),
            );
        }
    }
    pub fn close_all(&mut self, reason: &str) {
        if let Some(a) = self.active.take() {
            self.pending.clear();
            self.pending
                .push_back(json!({"voice":{"channel":a.channel,"closed":reason}}).to_string());
            self.server.log(
                "closed",
                json!({"reason":reason.chars().take(200).collect::<String>()}),
            );
        }
    }
    pub async fn next_line(&mut self) -> Option<String> {
        if let Some(s) = self.pending.pop_front() {
            return Some(s);
        }
        let Some(a) = self.active.as_mut() else {
            return std::future::pending().await;
        };
        let frame = tokio::select! {
            biased;
            reason = a.lease.ended() => Err(reason),
            frame = a.relay.recv() => frame.ok_or_else(|| "voice helper stopped".into()),
        };
        match frame {
            Ok(FromHelper::Ctl(v)) => {
                if v["type"] == "timing" {
                    let fields: serde_json::Map<String, Value> = v
                        .as_object()
                        .into_iter()
                        .flat_map(|o| o.iter())
                        .filter(|(_, value)| value.is_number())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    self.server.log("timing", Value::Object(fields));
                }
                Some(json!({"voice":{"channel":a.channel,"ctl":v}}).to_string())
            }
            Ok(FromHelper::Bin(v)) => {
                Some(json!({"voice":{"channel":a.channel,"bin":STANDARD.encode(v)}}).to_string())
            }
            Err(reason) => {
                self.close_all(&reason);
                self.pending.pop_front()
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn channels_bound_frames_acknowledge_and_close_once() {
        let data =
            std::env::temp_dir().join(format!("voice-session-{}", crate::identity::random_hex(8)));
        let (running, task) = super::super::test_helper::fake_helper("secret").await;
        let server = super::super::test_helper::server_with_helper(&data, running);
        let owner = Owner {
            session: 1,
            device: None,
            label: "test".into(),
        };
        let lease = server.acquire(owner.clone()).await.unwrap();
        let relay = Relay::connect(lease.running()).await.unwrap();
        let mut session = VoiceSession::new(server.clone(), owner);
        let channel = session.attach("r".into(), lease, relay);
        session.frame(&json!({"channel":99,"ctl":{"type":"start"}}));
        session.frame(&json!({"channel":channel,"ctl":{"type":"auth","token":"stolen"}}));
        session.frame(&json!({"channel":channel,"bin":"bad"}));
        for seq in 1..=40 {
            session.frame(&json!({"channel":channel,"bin":super::super::test_helper::bin(seq)}));
        }
        let mut bins = 0;
        let mut rx = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while bins < 40 || rx.len() < 2 {
                let line: Value =
                    serde_json::from_str(&session.next_line().await.unwrap()).unwrap();
                if line["voice"]["bin"].is_string() {
                    bins += 1
                }
                if let Some(n) = line["voice"]["rx"].as_u64() {
                    rx.push(n)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(rx, vec![16, 32]);
        session.frame(&json!({"channel":channel,"ctl":{"type":"end"}}));
        let line: Value = serde_json::from_str(&session.next_line().await.unwrap()).unwrap();
        assert_eq!(line["voice"]["closed"], "voice helper stopped");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), session.next_line())
                .await
                .is_err()
        );
        assert!(!server.status().busy);
        task.abort();
        let _ = std::fs::remove_dir_all(data);
    }
}
