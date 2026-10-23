//! A live DeepSeek turn through Deck's own adapter, for capturing what the
//! model really sends back. Ignored by default: it needs a real key and spends
//! real tokens. Run it as
//!
//! ```text
//! DS_PROXY=http://127.0.0.1:PORT DEEPSEEK_API_KEY=... \
//!   cargo test -p apex-adapters --test live_deepseek -- --ignored --nocapture
//! ```
//!
//! `DS_PROXY` points at a recording proxy so the raw SSE can be kept as a
//! fixture; without it the request goes straight to the provider.

use std::sync::Mutex;

use apex_adapters::{build, BuildContext};
use apex_core::{
    Access, Backend, Participant, ParticipantConfig, ParticipantId, Role, TurnRequest, ViewTurn,
};

#[tokio::test]
#[ignore]
async fn live_deepseek_turn() {
    let base = std::env::var("DS_PROXY").unwrap_or_else(|_| "https://api.deepseek.com/v1".into());
    let cfg = ParticipantConfig {
        id: ParticipantId::new("deepseek"),
        display_name: "DeepSeek".into(),
        backend: Backend::OpenAiCompatible {
            base_url: base,
            model: std::env::var("DS_MODEL").unwrap_or_else(|_| "deepseek-chat".into()),
            api_key_env: Some("DEEPSEEK_API_KEY".into()),
        },
        persona: String::new(),
        access: Access::Read,
        effort: None,
        speed: None,
        voice: None,
        appearance: None,
        media: None,
    };
    let context = BuildContext {
        cwd: Some(std::env::temp_dir()),
        path: None,
        codex_hook: None,
        temp: None,
        process_registry: None,
        cargo_target_dir: None,
        media_dir: None,
        attachment_roots: vec![],
        phone: None,
    };
    let bot = build(cfg, &context);
    let request = TurnRequest {
        effort_override: None,
        access: None,
        system: "You are DeepSeek, one bot in a chat with a person and other bots. Be brief."
            .into(),
        turns: vec![ViewTurn {
            role: Role::User,
            content: std::env::var("DS_PROMPT").unwrap_or_else(|_| {
                "[Human]: Plan only, and don't read or change any files while you plan: I want to \
                 move this project from SQLite to Postgres. Work out the steps, keep your to-do \
                 list up to date as you go, and reply once the plan is written."
                    .into()
            }),
        }],
        unseen: vec![],
        plan: false,
    };
    let streamed = Mutex::new(String::new());
    let result = bot
        .respond(request, &|piece| streamed.lock().unwrap().push_str(piece))
        .await;
    match result {
        Ok(reply) => println!("OK text: {:?}", reply.text),
        Err(failure) => println!("ERR: {failure}"),
    }
    println!("--- streamed ---\n{}", streamed.lock().unwrap());
}
