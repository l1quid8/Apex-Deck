//! Live DeepSeek turns through Deck's own adapter, for capturing what the
//! model really sends back. Ignored by default: it needs a real key and spends
//! real tokens. Run it as
//!
//! ```text
//! DS_PROXY=http://127.0.0.1:PORT DEEPSEEK_API_KEY=... \
//!   cargo test -p apex-adapters --test live_deepseek -- --ignored --nocapture
//! ```
//!
//! `DS_PROXY` points at a recording proxy so the raw SSE can be kept as a
//! fixture; without it the request goes straight to the provider. `DS_PROMPT`
//! and `DS_PROMPT2` set the two turns; leave `DS_PROMPT2` out to send one.

use std::sync::Mutex;

use apex_adapters::{build, BuildContext};
use apex_core::{
    Access, Backend, ParticipantConfig, ParticipantId, Progress, Role, TurnRequest, ViewTurn,
};

fn config() -> ParticipantConfig {
    ParticipantConfig {
        id: ParticipantId::new("deepseek"),
        display_name: "DeepSeek".into(),
        backend: Backend::OpenAiCompatible {
            base_url: std::env::var("DS_PROXY")
                .unwrap_or_else(|_| "https://api.deepseek.com/v1".into()),
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
    }
}

fn context() -> BuildContext {
    BuildContext {
        cwd: Some(std::env::temp_dir()),
        path: None,
        codex_hook: None,
        temp: None,
        process_registry: None,
        cargo_target_dir: None,
        media_dir: None,
        attachment_roots: vec![],
        phone: None,
    }
}

fn request(content: String, think: bool) -> TurnRequest {
    TurnRequest {
        effort_override: None,
        access: None,
        system: if think {
            "You are DeepSeek, one bot in a chat with a person and other bots. Think before you \
             answer. Be brief."
                .into()
        } else {
            "You are DeepSeek, one bot in a chat with a person and other bots. Be brief.".into()
        },
        turns: vec![ViewTurn {
            role: Role::User,
            content,
        }],
        unseen: vec![],
        plan: false,
    }
}

#[tokio::test]
#[ignore]
async fn live_deepseek_turn() {
    let bot = build(config(), &context());
    let first = std::env::var("DS_PROMPT").unwrap_or_else(|_| {
        "[Human]: Before anything else, call the todo_write tool with a four-step plan for \
         moving this project from SQLite to Postgres, and mark the first step in_progress. \
         Then answer in one sentence."
            .into()
    });
    let mut prompts = vec![first];
    if let Ok(second) = std::env::var("DS_PROMPT2") {
        prompts.push(second);
    }
    for (n, prompt) in prompts.into_iter().enumerate() {
        let seen: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let result = bot
            .respond_with_progress(request(prompt, true), &|update| {
                let line = match update {
                    Progress::Todo(items) => format!(
                        "todo: {}",
                        items
                            .iter()
                            .map(|t| format!("{:?} {}", t.status, t.text))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    ),
                    Progress::Activity(what) => format!("activity: {what}"),
                    Progress::Work(step) => format!("work: {}", step.label),
                    _ => return,
                };
                let mut seen = seen.lock().unwrap();
                if seen.last() != Some(&line) {
                    seen.push(line);
                }
            })
            .await;
        println!("=== turn {} ===", n + 1);
        for line in seen.into_inner().unwrap() {
            println!("{line}");
        }
        match result {
            Ok(reply) => println!("reply: {:?}", reply.text),
            Err(failure) => println!("ERR: {failure}"),
        }
    }
}
