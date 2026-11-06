//! What "Apply now" does to a real tool: stop a turn mid-command, run the bot
//! again in Read, then again in Full. Ignored by default: it needs the tool
//! signed in and spends real usage. Run it as
//!
//! ```text
//! LIVE_TOOL=claude cargo test -p apex-adapters --test live_access_restart -- --ignored --nocapture
//! ```
//!
//! `LIVE_TOOL` is claude, codex, gemini, grok or muse.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use apex_adapters::{build, BuildContext};
use apex_core::{Access, AgentTool, Backend, NoApprover, Participant, ParticipantConfig, ParticipantId, Role, TurnRequest, ViewTurn};

const MARK: &str = "293";

fn tool() -> AgentTool {
    match std::env::var("LIVE_TOOL").unwrap_or_default().as_str() {
        "claude" => AgentTool::ClaudeCode,
        "codex" => AgentTool::Codex,
        "gemini" => AgentTool::Gemini,
        "grok" => AgentTool::Grok,
        "muse" => AgentTool::Muse,
        other => panic!("LIVE_TOOL must name a tool, not {other:?}"),
    }
}

fn bot(access: Access, cwd: &Path) -> Arc<dyn Participant> {
    let config = ParticipantConfig {
        can_read_images: false, untethered_computer: false,
        id: ParticipantId::new("live"),
        display_name: "Live".into(),
        backend: Backend::Agent { tool: tool(), model: std::env::var("LIVE_MODEL").ok() },
        persona: String::new(),
        access,
        effort: None,
        speed: None,
        voice: None,
        appearance: None,
        media: None,
    };
    build(config, &BuildContext {
        cwd: Some(cwd.to_path_buf()),
        path: Some(std::env::var("PATH").unwrap()),
        codex_hook: None,
        temp: None,
        process_registry: None,
        cargo_target_dir: None,
        media_dir: None,
        attachment_roots: vec![],
        phone: None,
        data_dir: None,
        observed_addrs: vec![],
        ..BuildContext::default()
    })
}

fn request(turns: Vec<ViewTurn>) -> TurnRequest {
    TurnRequest {
        computer: None,
        effort_override: None,
        access: None,
        system: "You are one bot in a chat. Do what is asked at once, with your tools. Be brief.".into(),
        turns,
        unseen: vec![],
        plan: false,
        cwd: None,
    }
}

fn user(text: &str) -> ViewTurn { ViewTurn { role: Role::User, content: format!("[User]: {text}") } }

fn still_running() -> bool {
    Command::new("pgrep").args([&format!("sleep {MARK}")]).output().is_ok_and(|out| !out.stdout.is_empty())
}

#[tokio::test]
#[ignore]
async fn live_stop_then_change_access() {
    let dir: PathBuf = std::env::temp_dir().join(format!("deck-access-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let first = format!("Run this shell command and wait for it: sleep {MARK} && touch after.txt");

    // Cut the turn off while its command runs, as Apply now does.
    let full = bot(Access::Full, &dir);
    let mut running = {
        let full = full.clone();
        let turns = vec![user(&first)];
        tokio::spawn(async move { full.respond_with_approvals(request(turns), &|_| {}, &NoApprover).await.map(|reply| reply.text) })
    };
    let started = Instant::now();
    while !still_running() && started.elapsed() < Duration::from_secs(90) && !running.is_finished() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let reached = still_running();
    if running.is_finished() { println!("first turn ended by itself: {:?}", (&mut running).await); }
    println!("command reached: {reached} after {:?}", started.elapsed());
    let stopping = Instant::now();
    println!("cancel: {:?}", full.cancel_active_turn().await);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    running.abort();
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!("gone after {:?}, still running: {}", stopping.elapsed(), still_running());
    assert!(!still_running(), "the stopped turn left its command running");
    assert!(!dir.join("after.txt").exists());

    // Lowered: a fresh run knows only the transcript and must not write.
    let blocked = bot(Access::Read, &dir)
        .respond_with_approvals(request(vec![user(&first), ViewTurn { role: Role::Assistant, content: "[Interrupted]".into() }, user("Create a file named blocked.txt containing hi. Try once. If you cannot, say so.")]), &|_| {}, &NoApprover)
        .await;
    println!("read turn: {blocked:?}");
    assert!(!dir.join("blocked.txt").exists(), "Read wrote a file");

    // Raised: the next run may write.
    let allowed = bot(Access::Full, &dir)
        .respond_with_approvals(request(vec![user("Create a file named allowed.txt containing hi.")]), &|_| {}, &NoApprover)
        .await;
    println!("full turn: {allowed:?}");
    assert!(dir.join("allowed.txt").exists(), "Full could not write");
    let _ = std::fs::remove_dir_all(&dir);
}
