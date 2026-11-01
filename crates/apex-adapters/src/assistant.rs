//! Tool-free assistant inference, including explicitly attached images, separate from workspace workers and monitors.
use std::sync::Arc;
use apex_core::{Backend, Participant, ParticipantConfig};
use crate::{BuildContext, CliParticipant, OpenAiCompatParticipant};

pub fn assistant_profile_ok(config: &ParticipantConfig) -> Result<(), String> {
    if config.media.is_some() { return Err("Choose a text provider for assistant conversations.".into()); }
    match config.backend {
        Backend::Agent { .. } | Backend::OpenAiCompatible { .. } => Ok(()),
        _ => Err("Choose a connected text provider. Custom commands and scripted profiles cannot run assistant conversations.".into()),
    }
}

/// Never use `build_without_tools` here: its CLI path retains workspace tools.
/// Known CLI adapters remove tools and isolate personal configuration; API
/// participants receive neither workspace tools nor a media generation folder.
pub fn build_assistant(config: ParticipantConfig, context: &BuildContext) -> Result<Arc<dyn Participant>, String> {
    assistant_profile_ok(&config)?;
    Ok(match config.backend {
        Backend::OpenAiCompatible { .. } => Arc::new(OpenAiCompatParticipant::new(config).with_attachment_roots(context.attachment_roots.clone())),
        Backend::Agent { .. } => Arc::new(CliParticipant::new(config).with_context(context).with_tools_disabled()),
        _ => unreachable!("validated above"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn assistant_api_sends_only_authorized_attachment_bytes_without_tools() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let files = crate::attachments::Staged::new().unwrap();
        let own = files.dir.join("assistant-a");
        let sibling = files.dir.join("assistant-b");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        std::fs::write(own.join("screen.png"), png).unwrap();
        std::fs::write(sibling.join("private.png"), png).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let end = loop {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") { break at + 4; }
            };
            let length: usize = String::from_utf8_lossy(&bytes[..end]).lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
            }).unwrap();
            while bytes.len() < end + length {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let body: serde_json::Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
            let reply = "data: {\"choices\":[{\"delta\":{\"content\":\"seen\"}}]}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
            body
        });
        let config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id":"a","display_name":"Assistant","backend":{"kind":"open_ai_compatible","base_url":format!("http://{address}/v1"),"model":"vision"}})).unwrap();
        assert!(!config.can_read_images, "upload support must not invent screenshot-tool capability");
        let bot = build_assistant(config, &BuildContext { attachment_roots: vec![own.canonicalize().unwrap()], ..Default::default() }).unwrap();
        let request = |path: &std::path::Path| apex_core::TurnRequest {
            system: "Describe the supplied image.".into(),
            turns: vec![apex_core::ViewTurn { role: apex_core::Role::User, content: format!("Attached image: {}", path.display()) }],
            access: Some(apex_core::Access::Read), ..Default::default()
        };
        let response = bot.respond(request(&own.join("screen.png")), &|_|{}).await;
        if response.is_err() { server.abort(); }
        assert!(response.is_ok(), "authorized screenshot must reach the API: {response:?}");
        let body = server.await.unwrap();
        assert_eq!(body["messages"][1]["content"][1]["image_url"]["url"], "data:image/png;base64,iVBORw0KGgpmaXh0dXJl");
        assert!(body.get("tools").is_none());
        let outside = bot.respond(request(&sibling.join("private.png")), &|_|{}).await.unwrap_err();
        assert!(outside.to_string().contains("outside the host-authorized attachment folders"));
    }
    #[test]
    fn only_known_text_backends_can_be_assistants() {
        let profile=|backend| serde_json::from_value::<ParticipantConfig>(serde_json::json!({"id":"a","display_name":"Assistant","backend":backend})).unwrap();
        for tool in ["claude_code","codex","gemini","grok","muse"] {
            assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"agent","tool":tool}))).is_ok());
        }
        assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"cli","program":"sh","args":[]}))).is_err());
        assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"scripted","lines":[]}))).is_err());
    }
}
