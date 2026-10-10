use std::sync::Mutex;
use std::time::Duration;

use apex_adapters::{build, list_models, BuildContext, CliParticipant, OpenAiCompatParticipant};
use apex_core::{ActionKind, Approver, Decision, FileChange, ProposedAction};
use apex_core::{
    Access, Backend, Participant, ParticipantConfig, ParticipantError, ParticipantId, Role, Room,
    RoomOptions, Speaker, TurnPolicy, TurnRequest, ViewTurn,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn config(id: &str, backend: Backend) -> ParticipantConfig {
    ParticipantConfig {
        id: ParticipantId::new(id),
        display_name: id.to_string(),
        backend,
        persona: String::new(),
        access: Access::Read,
        effort: None,
        auto_effort: false,
        appearance: None, media: None
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

/// The same request with the thread's Plan switch on, as the room sends it.
fn planning(text: &str) -> TurnRequest {
    TurnRequest { effort_override: None, access: Some(Access::Read), plan: true, ..request(text) }
}

/// Run `respond` and return the result plus everything streamed.
async fn ask(
    participant: &dyn Participant,
    text: &str,
) -> (Result<apex_core::Reply, ParticipantError>, String) {
    let streamed = Mutex::new(String::new());
    let result =
        participant.respond(request(text), &|piece| streamed.lock().unwrap().push_str(piece)).await;
    (result, streamed.into_inner().unwrap())
}

// ---------------------------------------------------------------- CLI

#[cfg(unix)]
fn sh(script: &str) -> Backend {
    Backend::Cli { program: "sh".into(), args: vec!["-c".into(), script.into()] }
}

#[cfg(unix)]
#[tokio::test]
async fn cli_reply_is_the_programs_output_and_is_streamed() {
    let bot = CliParticipant::new(config("cli", sh("printf 'hello '; printf 'from the tool\\n'")));
    let (result, streamed) = ask(&bot, "hi").await;
    assert_eq!(result.unwrap().text, "hello from the tool");
    assert_eq!(streamed, "hello from the tool\n");
}

#[cfg(unix)]
#[tokio::test]
async fn cli_receives_the_system_prompt_and_conversation_on_stdin() {
    let bot = CliParticipant::new(config("cli", sh("cat")));
    let (result, _) = ask(&bot, "what is 2+2?").await;
    let echoed = result.unwrap().text;
    assert!(echoed.starts_with("You are a test bot."));
    assert!(echoed.contains("[Human]: what is 2+2?"));
    assert!(echoed.ends_with("--- Your reply ---"));
}

#[cfg(unix)]
#[tokio::test]
async fn cli_failure_reports_the_exit_status_and_error_output() {
    let bot = CliParticipant::new(config("cli", sh("echo 'usage limit reached' >&2; exit 3")));
    let (result, _) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("usage limit reached"), "{message}");
            assert!(message.contains('3'), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cli_failure_with_pages_of_output_is_reduced_to_the_error() {
    // Shaped like a real agent failure: banner, echoed prompt, a huge log
    // line, then the line that matters.
    let script = r#"cat >/dev/null
echo "Some Agent v1.0" >&2
echo "user" >&2
echo "You are a test bot." >&2
head -c 40000 /dev/zero | tr '\0' 'x' >&2; echo >&2
echo 'ERROR: {"type":"error","status":400,"error":{"message":"The model is not supported."}}' >&2
exit 1"#;
    let bot = CliParticipant::new(config("cli", sh(script)));
    let (result, _) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.ends_with(": The model is not supported."), "{message}");
            assert!(message.len() < 200, "{}", message.len());
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cli_failure_explained_on_standard_output_is_reported() {
    // Claude Code prints a failure inside the run as its normal output and
    // leaves the error output empty.
    let bot = CliParticipant::new(config("cli", sh("cat >/dev/null; echo 'Not logged in · Please run /login'; exit 1")));
    let (result, _) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("Not logged in · Please run /login"), "{message}");
            assert!(!message.contains("no error output"), "{message}");
            assert!(message.contains("To fix:"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
async fn cli_missing_program_is_reported_as_not_configured() {
    let backend = Backend::Cli { program: "apex-deck-no-such-program".into(), args: vec![] };
    let bot = CliParticipant::new(config("cli", backend));
    let (result, _) = ask(&bot, "hi").await;
    assert!(matches!(result, Err(ParticipantError::NotConfigured(_))), "{result:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn cli_that_hangs_is_stopped_at_the_timeout() {
    let bot = CliParticipant::new(config("cli", sh("sleep 30")))
        .with_timeout(Duration::from_millis(200));
    let started = std::time::Instant::now();
    let (result, _) = ask(&bot, "hi").await;
    assert!(matches!(result, Err(ParticipantError::Failed(_))), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[cfg(unix)]
#[tokio::test]
async fn cli_timeout_terminates_the_process_tree_before_returning() {
    let dir = fake_tool("cli-tree-timeout", "unused", "");
    let pid_file = dir.join("descendant.pid");
    let script = format!("sleep 30 & echo $! > '{}' ; wait", pid_file.display());
    let bot = CliParticipant::new(config("cli", sh(&script)))
        .with_timeout(Duration::from_millis(300));
    let (result, _) = ask(&bot, "hi").await;
    assert!(matches!(result, Err(ParticipantError::Failed(_))), "{result:?}");
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let status = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        if state.trim().is_empty() || state.trim_start().starts_with('Z') { break; }
        assert!(std::time::Instant::now() < deadline, "descendant {pid} survived timeout (state {})", state.trim());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_reports_incomplete_cleanup_when_ownership_record_cannot_be_removed() {
    let dir = fake_tool("cli-cleanup-incomplete", "unused", "");
    let registry = dir.join("registry");
    std::fs::create_dir_all(&registry).unwrap();
    let pid_file = dir.join("descendant.pid");
    let script = format!("sleep 30 & echo $! > '{}' ; wait", pid_file.display());
    let bot = CliParticipant::new(config("cli", sh(&script)))
        .with_context(&BuildContext { process_registry: Some(registry.clone()), ..context_in(&dir) })
        .with_timeout(Duration::from_millis(500));

    let response = tokio::spawn(async move { ask(&bot, "hi").await.0 });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let manifest = loop {
        if let Some(path) = std::fs::read_dir(&registry).unwrap().flatten().map(|entry| entry.path()).find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json")) {
            break path;
        }
        assert!(std::time::Instant::now() < deadline, "worker ownership record was not created");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    std::fs::remove_file(&manifest).unwrap();
    std::fs::create_dir(&manifest).unwrap();

    let result = tokio::time::timeout(Duration::from_secs(4), response).await.unwrap().unwrap();
    assert!(matches!(result, Err(ParticipantError::CleanupIncomplete(_))), "{result:?}");
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    wait_for_process_to_stop(pid).await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn startup_recovery_kills_only_the_still_verified_owned_group() {
    struct GroupGuard(i32);
    impl Drop for GroupGuard {
        fn drop(&mut self) { unsafe { libc::kill(-self.0, libc::SIGKILL); } }
    }

    let dir = fake_tool("cli-registry-recovery", "unused", "");
    let registry = dir.join("registry");
    std::fs::create_dir_all(&registry).unwrap();
    let pid_file = dir.join("descendant.pid");
    let script = format!("sleep 30 & echo $! > '{}' ; wait", pid_file.display());
    let bot = std::sync::Arc::new(CliParticipant::new(config("cli", sh(&script)))
        .with_context(&BuildContext { process_registry: Some(registry.clone()), ..context_in(&dir) }));
    let worker = bot.clone();
    let response = tokio::spawn(async move { worker.respond(request("hi"), &|_| {}).await });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let manifest = loop {
        if let Some(path) = std::fs::read_dir(&registry).unwrap().flatten().map(|entry| entry.path()).find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json")) { break path; }
        assert!(std::time::Instant::now() < deadline, "worker ownership record was not created");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    let group = record["pgid"].as_i64().unwrap() as i32;
    let _guard = GroupGuard(group);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !pid_file.exists() {
        assert!(std::time::Instant::now() < deadline, "fake worker did not start its descendant");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Model a daemon crash: preserve the child group and durable record while
    // intentionally forgetting the provider future that owns the direct child.
    std::mem::forget(response);
    apex_adapters::recover_owned_processes(&registry).unwrap();
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    wait_for_process_to_stop(pid).await;
    assert!(!manifest.exists(), "recovery removes the verified ownership record");
    drop(bot);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stop_hook_terminates_and_reaps_the_process_tree_before_response_finishes() {
    let dir = fake_tool("cli-tree-stop", "unused", "");
    let pid_file = dir.join("descendant.pid");
    let script = format!("sleep 30 & echo $! > '{}' ; wait", pid_file.display());
    let bot = std::sync::Arc::new(CliParticipant::new(config("cli", sh(&script))).with_context(&context_in(&dir)));
    let participant = bot.clone();
    let response = tokio::spawn(async move { participant.respond(request("hi"), &|_| {}).await });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !pid_file.exists() {
        assert!(std::time::Instant::now() < deadline, "fake worker did not start its descendant");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(bot.cancel_active_turn().await.unwrap());
    let result = tokio::time::timeout(Duration::from_secs(1), response).await.unwrap().unwrap();
    assert!(result.is_err(), "cancelled CLI unexpectedly completed successfully: {result:?}");
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let status = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let state = String::from_utf8_lossy(&status.stdout);
    assert!(state.trim().is_empty() || state.trim_start().starts_with('Z'), "descendant {pid} survived Stop (state {})", state.trim());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
async fn wait_for_process_to_stop(pid: i32) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let status = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        if state.trim().is_empty() || state.trim_start().starts_with('Z') { break; }
        assert!(std::time::Instant::now() < deadline, "descendant {pid} survived cleanup (state {})", state.trim());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cli_that_keeps_printing_outlasts_the_timeout() {
    // Each line restarts the clock, so a turn longer than the limit is fine
    // as long as the tool never goes quiet for that long.
    // The gaps sit well under the limit so a slow CI runner can't trip it.
    let script = "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.2; done";
    let bot = CliParticipant::new(config("cli", sh(script))).with_timeout(Duration::from_millis(1000));
    let (result, _) = ask(&bot, "hi").await;
    assert!(result.is_ok(), "{result:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn cli_handles_a_prompt_larger_than_the_pipe_buffer() {
    // `cat` echoes while we are still writing; this would deadlock if the
    // prompt were written before reading began.
    let bot = CliParticipant::new(config("cli", sh("cat")));
    let big = "x".repeat(300_000);
    let (result, _) = ask(&bot, &big).await;
    assert!(result.unwrap().text.contains(&big));
}

#[cfg(unix)]
#[tokio::test]
async fn cli_runs_in_the_workspace_folder() {
    let dir = std::env::temp_dir().join(format!("apex-deck-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let real = std::fs::canonicalize(&dir).unwrap();
    let context = BuildContext { cwd: Some(dir.clone()), path: None, codex_hook: None, temp: None, process_registry: None, cargo_target_dir: None, media_dir: None };
    let bot = CliParticipant::new(config("cli", sh("cat >/dev/null; pwd -P"))).with_context(&context);
    let (result, _) = ask(&bot, "where are you?").await;
    assert_eq!(result.unwrap().text, real.to_string_lossy());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cli_gets_the_threads_temp_folder_as_tmpdir() {
    let dir = std::env::temp_dir().join(format!("apex-deck-tmp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let context = BuildContext { cwd: None, path: None, codex_hook: None, temp: Some(dir.clone()), process_registry: None, cargo_target_dir: None, media_dir: None };
    let bot = CliParticipant::new(config("cli", sh("cat >/dev/null; printf %s \"$TMPDIR\""))).with_context(&context);
    let (result, _) = ask(&bot, "where is scratch?").await;
    assert_eq!(result.unwrap().text, dir.to_string_lossy());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cli_reports_a_workspace_folder_that_no_longer_exists() {
    let context = BuildContext { cwd: Some("/no/such/apex-deck/folder".into()), path: None, codex_hook: None, temp: None, process_registry: None, cargo_target_dir: None, media_dir: None };
    let bot = CliParticipant::new(config("cli", sh("echo hi"))).with_context(&context);
    let (result, _) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("workspace folder"), "{message}");
            assert!(message.contains("/no/such/apex-deck/folder"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cli_finds_the_program_on_the_path_it_is_given() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("apex-deck-path-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tool = dir.join("apex-deck-test-tool");
    std::fs::write(&tool, "#!/bin/sh\ncat >/dev/null\necho found-on-custom-path\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();

    let backend = Backend::Cli { program: "apex-deck-test-tool".into(), args: vec![] };
    // Not on the app's own PATH.
    let (missing, _) = ask(&CliParticipant::new(config("cli", backend.clone())), "hi").await;
    assert!(matches!(missing, Err(ParticipantError::NotConfigured(_))), "{missing:?}");

    let path = format!("{}:/usr/bin:/bin", dir.to_string_lossy());
    let context = BuildContext { cwd: None, path: Some(path), codex_hook: None, temp: None, process_registry: None, cargo_target_dir: None, media_dir: None };
    let bot = CliParticipant::new(config("cli", backend)).with_context(&context);
    let (found, _) = ask(&bot, "hi").await;
    assert_eq!(found.unwrap().text, "found-on-custom-path");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cli_colour_codes_are_removed_from_the_reply_and_the_stream() {
    let bot = CliParticipant::new(config("cli", sh("cat >/dev/null; printf '\\033[1;32mgreen\\033[0m text'")));
    let (result, streamed) = ask(&bot, "hi").await;
    assert_eq!(result.unwrap().text, "green text");
    assert_eq!(streamed, "green text");
}

/// A stand-in for a real agent: a script named like the tool that prints
/// the arguments it was started with. This checks that an `Agent` backend
/// runs the command the preset builds, in the workspace, with the prompt
/// on standard input.
#[cfg(unix)]
#[tokio::test]
async fn codex_agent_refuses_exec_even_when_model_effort_and_access_are_configured() {
    use apex_core::AgentTool;
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("apex-deck-agent-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tool = dir.join("codex");
    std::fs::write(
        &tool,
        "#!/bin/sh\n[ \"$1\" = app-server ] && exit 2\nprintf 'args:%s ' \"$@\"\nprintf 'stdin-bytes:'\nwc -c | tr -d ' '\n",
    )
    .unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: Some("some-model".into()) });
    cfg.access = Access::Edits;
    cfg.effort = Some("high".into());
    let context = BuildContext { cwd: Some(dir.clone()), path: Some(format!("{}:/usr/bin:/bin", dir.to_string_lossy())), codex_hook: None, temp: None, process_registry: None, cargo_target_dir: None, media_dir: None };
    let bot = build(cfg, &context);
    let (result, _) = ask(bot.as_ref(), "hey, testing").await;
    assert!(result.unwrap_err().to_string().contains("MCP approvals require it"));
    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------- HTTP

/// A one-shot HTTP server. It answers the first request with `status` and
/// the given body pieces (sent as separate writes) and returns what it was
/// sent.
async fn serve_once(
    status: &'static str,
    pieces: Vec<&'static [u8]>,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        // Nothing else is served: the bot's model lookup is refused at once.
        drop(listener);
        let mut received = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            received.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&received).into_owned();
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text[..split]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
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

fn api(base_url: String, api_key_env: Option<&str>) -> Backend {
    Backend::OpenAiCompatible {
        base_url,
        model: "test-model".into(),
        api_key_env: api_key_env.map(str::to_string),
    }
}

#[tokio::test]
async fn api_streams_text_even_when_events_are_split_mid_line_and_mid_character() {
    // "café" with the two bytes of 'é' in different writes, and one event
    // cut in the middle of its JSON.
    let (address, server) = serve_once(
        "200 OK",
        vec![
            b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"con",
            b"tent\":\"The caf\xc3",
            b"\xa9 is \"}}]}\n\n",
            b"data: {\"choices\":[{\"delta\":{\"content\":\"open.\"}}]}\n\n",
            b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n",
        ],
    )
    .await;

    let bot = OpenAiCompatParticipant::new(config("api", api(address, None)));
    let (result, streamed) = ask(&bot, "is it open?").await;
    let reply = result.unwrap();

    assert_eq!(reply.text, "The café is open.");
    assert_eq!(streamed, "The café is open.");
    assert_eq!(reply.input_tokens, Some(21));
    assert_eq!(reply.output_tokens, Some(5));

    let sent = server.await.unwrap();
    assert!(sent.starts_with("POST /chat/completions "), "{sent}");
    let body: serde_json::Value =
        serde_json::from_str(sent.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"], "You are a test bot.");
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][1]["content"], "[Human]: is it open?");
    assert!(!sent.to_ascii_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn api_sends_the_key_from_the_named_environment_variable() {
    let (address, server) =
        serve_once("200 OK", vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"]).await;
    std::env::set_var("APEX_DECK_TEST_KEY", "sk-test-123");

    let bot = OpenAiCompatParticipant::new(config("api", api(address, Some("APEX_DECK_TEST_KEY"))));
    let (result, _) = ask(&bot, "hi").await;
    assert_eq!(result.unwrap().text, "ok");

    let sent = server.await.unwrap().to_ascii_lowercase();
    assert!(sent.contains("authorization: bearer sk-test-123"), "{sent}");
}

#[tokio::test]
async fn api_missing_key_is_not_configured_and_sends_nothing() {
    let bot = OpenAiCompatParticipant::new(config(
        "api",
        api("http://127.0.0.1:9".into(), Some("APEX_DECK_KEY_THAT_IS_NOT_SET")),
    ));
    let (result, _) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::NotConfigured(message)) => {
            assert!(message.contains("APEX_DECK_KEY_THAT_IS_NOT_SET"))
        }
        other => panic!("expected not configured, got {other:?}"),
    }
}

#[tokio::test]
async fn api_error_status_is_reported_with_the_servers_message() {
    let (address, _server) =
        serve_once("429 Too Many Requests", vec![b"{\"error\":{\"message\":\"slow down\"}}"]).await;
    let bot = OpenAiCompatParticipant::new(config("api", api(address, None)));
    let (result, streamed) = ask(&bot, "hi").await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("429"), "{message}");
            assert!(message.contains("slow down"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    assert_eq!(streamed, "");
}

#[tokio::test]
async fn api_stream_that_ends_without_done_still_returns_what_arrived() {
    let (address, _server) =
        serve_once("200 OK", vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}"]).await;
    let bot = OpenAiCompatParticipant::new(config("api", api(address, None)));
    let (result, _) = ask(&bot, "hi").await;
    assert_eq!(result.unwrap().text, "partial");
}

#[tokio::test]
async fn model_list_is_read_from_the_models_endpoint_and_sorted() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 4096];
        let read = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
        let body = r#"{"object":"list","data":[{"id":"qwen:7b"},{"id":"llama3"},{"id":"llama3"},{"object":"model"}]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        request
    });

    let models = list_models(&format!("{address}/"), None).await.unwrap();
    let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(ids, ["llama3", "qwen:7b"]);
    assert!(server.await.unwrap().starts_with("GET /v1/models "));
}

#[tokio::test]
async fn api_reply_reports_context_fill_and_the_servers_cost() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0u8; 16384];
                let read = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let (kind, body) = if request.starts_with("GET /v1/models ") {
                    ("application/json", r#"{"data":[{"id":"test-model","context_length":1000,"model_spec":{"name":"Test","pricing":{"input":{"usd":1.0},"output":{"usd":2.0}}}}]}"#)
                } else {
                    ("text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":200,\"completion_tokens\":50},\"cost\":{\"usd\":0.0005}}\n\ndata: [DONE]\n\n")
                };
                let response = format!("HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            });
        }
    });

    let bot = OpenAiCompatParticipant::new(config("api", api(address, None)));
    let context = std::sync::Mutex::new(None);
    let reply = bot
        .respond_with_progress(request("hi"), &|update| {
            if let apex_core::Progress::Context(fill) = update {
                *context.lock().unwrap() = Some((fill.used_tokens, fill.window_tokens));
            }
        })
        .await
        .unwrap();

    assert_eq!(reply.text, "Hi");
    assert_eq!(reply.cost_micros, Some(500));
    assert_eq!(*context.lock().unwrap(), Some((250, 1000)));
}

#[tokio::test]
async fn model_list_reports_a_server_that_is_not_running() {
    // Port 9 (discard) is not listening on a normal machine.
    let error = list_models("http://127.0.0.1:9/v1", None).await.unwrap_err();
    assert!(error.contains("could not reach"), "{error}");
}

// ---------------------------------------------------------------- mixed room

#[cfg(unix)]
#[tokio::test]
async fn one_room_can_mix_an_api_bot_a_cli_bot_and_a_scripted_bot() {
    let (address, _server) = serve_once(
        "200 OK",
        vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"api says hi\"}}]}\n\ndata: [DONE]\n\n"],
    )
    .await;

    let roster = vec![
        build(config("api", api(address, None)), &BuildContext::default()),
        build(config("cli", sh("printf 'cli says hi'")), &BuildContext::default()),
        build(config("fake", Backend::Scripted { lines: vec!["fake says hi".into()] }), &BuildContext::default()),
    ];
    let mut room = Room::new(roster, RoomOptions { policy: TurnPolicy::Everyone, max_bot_hops: 0 });
    room.post_human("roll call", &|_| {}).await;

    let said: Vec<(String, String)> = room
        .transcript()
        .iter()
        .map(|m| {
            let who = match &m.speaker {
                Speaker::Human => "human".to_string(),
                Speaker::Bot(id) => id.to_string(),
            };
            (who, m.text.clone())
        })
        .collect();
    assert_eq!(
        said,
        [
            ("human".to_string(), "roll call".to_string()),
            ("api".to_string(), "api says hi".to_string()),
            ("cli".to_string(), "cli says hi".to_string()),
            ("fake".to_string(), "fake says hi".to_string()),
        ]
    );
}

/// Put an executable called `name` in a fresh folder and return the folder.
#[cfg(unix)]
fn fake_tool(tag: &str, name: &str, script: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("apex-deck-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tool = dir.join(name);
    std::fs::write(&tool, script).unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::canonicalize(&dir).unwrap()
}

#[cfg(unix)]
fn context_in(dir: &std::path::Path) -> BuildContext {
    BuildContext { cwd: Some(dir.to_path_buf()), path: Some(format!("{}:/usr/bin:/bin", dir.to_string_lossy())), codex_hook: None, temp: None, process_registry: None, cargo_target_dir: None, media_dir: None }
}

/// Run one turn the way the room does and collect text and activity.
async fn work(
    participant: &dyn Participant,
) -> (Result<apex_core::Reply, ParticipantError>, String, Vec<String>) {
    use apex_core::Progress;
    let text = Mutex::new(String::new());
    let activity = Mutex::new(Vec::new());
    let result = participant
        .respond_with_progress(request("hi"), &|update| match update {
            Progress::Text(piece) => text.lock().unwrap().push_str(piece),
            Progress::Activity(line) => activity.lock().unwrap().push(line.to_string()),
            _ => {}
        })
        .await;
    (result, text.into_inner().unwrap(), activity.into_inner().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn claude_code_events_become_streamed_text_activity_and_token_counts() {
    use apex_core::AgentTool;
    let script = r#"#!/bin/sh
IFS= read -r prompt
cat <<JSONL
{"type":"system","subtype":"init"}
{"type":"stream_event","event":{"type":"message_start"},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"$PWD/notes.txt"}}]},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"message_start"},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"It says "}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello."}},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"text","text":"It says hello."}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"It says hello.","usage":{"input_tokens":5,"cache_read_input_tokens":95,"output_tokens":9}}
JSONL
"#;
    let dir = fake_tool("claude-events", "claude", script);
    let cfg = config("opus", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    let bot = build(cfg, &context_in(&dir));

    let (result, text, activity) = work(bot.as_ref()).await;
    let reply = result.unwrap();
    assert_eq!(reply.text, "It says hello.");
    assert_eq!((reply.input_tokens, reply.output_tokens), (Some(100), Some(9)));
    assert_eq!(text, "It says hello.");
    assert_eq!(activity, ["Reading notes.txt"]);

    // The plain `respond` entry point gets the same text and no activity.
    let (result, streamed) = ask(bot.as_ref(), "hi").await;
    assert_eq!(result.unwrap().text, "It says hello.");
    assert_eq!(streamed, "It says hello.");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_code_failure_inside_the_run_is_reported_from_its_result_event() {
    use apex_core::AgentTool;
    let script = r#"#!/bin/sh
IFS= read -r prompt
echo '"m" is not in the model catalog' >&2
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]}}'
echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'
exit 1
"#;
    let dir = fake_tool("claude-fails", "claude", script);
    let cfg = config("opus", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    let (result, _, _) = work(build(cfg, &context_in(&dir)).as_ref()).await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("Not logged in · Please run /login"), "{message}");
            assert!(!message.contains("model catalog"), "{message}");
            assert!(message.contains("To fix:"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn without_an_app_server_codex_does_not_run_ungated_exec() {
    use apex_core::AgentTool;
    let script = r#"#!/bin/sh
[ "$1" = app-server ] && exit 2
cat >/dev/null
case "$*" in
*"--model broken"*)
  echo '{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized)"}'
  echo '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}'
  exit 1;;
esac
echo '{"type":"thread.started","thread_id":"t"}'
echo '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Two files here."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":6,"reasoning_output_tokens":0}}'
"#;
    let dir = fake_tool("codex-events", "codex", script);
    let context = context_in(&dir);

    let good = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
    let (result, text, activity) = work(good.as_ref()).await;
    assert!(result.unwrap_err().to_string().contains("MCP approvals require it"));
    assert!(text.is_empty());
    assert!(activity.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stand-in for `codex app-server`: answers the three requests a turn
/// makes and then reports the turn the way the real server does.
#[cfg(unix)]
const FAKE_CODEX_SERVER: &str = r#"#!/bin/sh
if [ "$1" != app-server ]; then
  cat >/dev/null
  echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"from exec"}}'
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
  *'"mcpServerStatus/list"'*) echo '{"id":10,"result":{"data":[],"nextCursor":null}}' ;;
 *'"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
  *'"initialize"'*) echo '{"id":0,"result":{"userAgent":"fake"}}' ;;
  *'"thread/start"'*)
    case "$line" in *'"model":"no-server"'*) echo '{"id":1,"error":{"code":-32600,"message":"threads are switched off"}}'; continue ;; esac
    echo '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}'
    echo '{"id":1,"result":{"thread":{"id":"thread-1"}}}' ;;
  *'"turn/start"'*)
    echo '{"id":2,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
    case "$line" in *'"effort":"high"'*) effort=high ;; *) effort=default ;; esac
    case "$line" in
    *'please fail'*)
      echo '{"method":"error","params":{"error":{"message":"Reconnecting... 2/5","additionalDetails":"401"},"willRetry":true}}'
      echo '{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}}}' ;;
    *)
      echo '{"method":"item/started","params":{"item":{"type":"commandExecution","id":"i1","command":"ls -la","status":"inProgress"}}}'
      echo '{"id":"ask-1","method":"item/commandExecution/requestApproval","params":{"itemId":"i1"}}'
      IFS= read -r answer
      case "$answer" in *'"decline"'*) refused=yes ;; *'"accept"'*) refused=no ;; *) refused=unanswered ;; esac
      echo '{"method":"item/agentMessage/delta","params":{"itemId":"i2","delta":"Two files"}}'
      echo '{"method":"item/agentMessage/delta","params":{"itemId":"i2","delta":" here."}}'
      echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"i2\",\"text\":\"Two files here. effort=$effort refused=$refused\"}}}"
      echo '{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":50,"outputTokens":6}}}}'
      echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
    esac ;;
  esac
done
"#;

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_streams_the_reply_in_pieces_and_declines_when_nobody_can_be_asked() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-server", "codex", FAKE_CODEX_SERVER);
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: Some("some-model".into()) });
    cfg.effort = Some("high".into());
    let bot = build(cfg, &context_in(&dir));

    let (result, text, activity) = work(bot.as_ref()).await;
    let reply = result.unwrap();
    // The streamed pieces are what was shown; the reply is the whole message.
    assert_eq!(text, "Two files here.");
    assert_eq!(reply.text, "Two files here. effort=high refused=yes");
    assert_eq!((reply.input_tokens, reply.output_tokens), (Some(50), Some(6)));
    assert_eq!(activity, ["Checking MCP tool approval policies", "Running: ls -la", "Waiting for approval: Run a command"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stand-in for `codex app-server` that refuses the MCP inventory unless
/// `plugin/list` was already sent, and answers the plugins only after the
/// inventory, the way a slower request can finish second.
#[cfg(unix)]
const FAKE_CODEX_PLUGINS: &str = r#"#!/bin/sh
while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
 *'"plugin/list"'*) asked=yes ;;
 *'"mcpServerStatus/list"'*)
  [ -n "$asked" ] || { echo '{"id":10,"error":{"message":"plugins were not asked alongside the inventory"}}'; continue; }
  echo '{"id":10,"result":{"data":[{"name":"probe","tools":{}}],"nextCursor":null}}'
  echo 'PLUGINS_ANSWER' ;;
 *'"thread/start"'*) echo '{"id":1,"result":{"thread":{"id":"thread-plugins"}}}' ;;
 *'"turn/start"'*)
  echo '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"r","text":"done"}}}'
  echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
 *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
 esac
done
"#;

/// Run one turn and collect its activity and the tool server lists it reported.
async fn work_with_servers(participant: &dyn Participant) -> (Result<apex_core::Reply, ParticipantError>, Vec<String>, Vec<Vec<apex_core::server_request::ToolServer>>) {
    use apex_core::Progress;
    let activity = Mutex::new(Vec::new());
    let servers = Mutex::new(Vec::new());
    let result = participant
        .respond_with_progress(request("hi"), &|update| match update {
            Progress::Activity(line) => activity.lock().unwrap().push(line.to_string()),
            Progress::ToolServers(names) => servers.lock().unwrap().push(names.to_vec()),
            _ => {}
        })
        .await;
    (result, activity.into_inner().unwrap(), servers.into_inner().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn codex_lists_plugins_alongside_the_mcp_inventory_for_the_menu() {
    use apex_core::AgentTool;
    let plugins = r#"{"id":110,"result":{"marketplaces":[{"plugins":[{"name":"design","installed":true,"enabled":true}]}]}}"#;
    let dir = fake_tool("codex-plugins", "codex", &FAKE_CODEX_PLUGINS.replace("PLUGINS_ANSWER", plugins));
    let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context_in(&dir));
    let (result, activity, servers) = work_with_servers(bot.as_ref()).await;
    assert_eq!(result.unwrap().text, "done");
    assert_eq!(servers.iter().map(|list| list.iter().map(|entry| entry.token.as_str()).collect::<Vec<_>>()).collect::<Vec<_>>(), [["design", "probe"]]);
    assert_eq!(activity, ["Checking MCP tool approval policies"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_turn_runs_when_the_plugin_list_fails_and_leaves_the_menu_alone() {
    use apex_core::AgentTool;
    let plugins = r#"{"id":110,"error":{"code":-32603,"message":"marketplace unavailable"}}"#;
    let dir = fake_tool("codex-plugins-fail", "codex", &FAKE_CODEX_PLUGINS.replace("PLUGINS_ANSWER", plugins));
    let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context_in(&dir));
    let (result, _, servers) = work_with_servers(bot.as_ref()).await;
    assert_eq!(result.unwrap().text, "done");
    assert!(servers.is_empty(), "a partial list would hide plugin names: {servers:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_failed_turn_is_reported_and_not_retried_another_way() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-server-fails", "codex", FAKE_CODEX_SERVER);
    let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context_in(&dir));
    let streamed = Mutex::new(String::new());
    let result = bot
        .respond(
            TurnRequest {
                effort_override: None,
                access: None,
                system: "You are a test bot.".into(),
                turns: vec![ViewTurn { role: Role::User, content: "[Human]: please fail".into() }],
                unseen: vec![],
                plan: false,
            },
            &|piece| streamed.lock().unwrap().push_str(piece),
        )
        .await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("401 Unauthorized: Missing bearer"), "{message}");
            assert!(message.contains("codex login"), "{message}");
            assert!(!message.contains("from exec"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_refuses_ungated_exec_when_the_app_server_cannot_start_a_thread() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-server-off", "codex", FAKE_CODEX_SERVER);
    let cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: Some("no-server".into()) });
    let (result, text, _) = work(build(cfg, &context_in(&dir)).as_ref()).await;
    assert!(result.unwrap_err().to_string().contains("MCP approvals require it"));
    assert!(text.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Answers every proposal the same way and keeps what was proposed.
struct Fixed {
    answer: Decision,
    asked: Mutex<Vec<ProposedAction>>,
    /// What the person says to a question; nothing means they skip it.
    said: Mutex<Option<apex_core::Answer>>,
    questions: Mutex<Vec<apex_core::Question>>,
}

impl Fixed {
    fn new(answer: Decision) -> Self {
        Self { answer, asked: Mutex::new(Vec::new()), said: Mutex::new(None), questions: Mutex::new(Vec::new()) }
    }
}

#[async_trait::async_trait]
impl Approver for Fixed {
    async fn decide(&self, action: ProposedAction) -> Decision {
        self.asked.lock().unwrap().push(action);
        self.answer
    }

    async fn ask(&self, questions: Vec<apex_core::Question>) -> apex_core::Answer {
        self.questions.lock().unwrap().extend(questions);
        self.said.lock().unwrap().clone().unwrap_or(apex_core::Answer::Skipped)
    }
}

/// Run one turn with someone to ask, collecting text and file changes.
async fn work_asking(
    participant: &dyn Participant,
    approver: &dyn Approver,
) -> (Result<apex_core::Reply, ParticipantError>, String, Vec<FileChange>) {
    work_asking_with(participant, approver, request("hi")).await
}

async fn work_asking_with(
    participant: &dyn Participant,
    approver: &dyn Approver,
    turn: TurnRequest,
) -> (Result<apex_core::Reply, ParticipantError>, String, Vec<FileChange>) {
    use apex_core::Progress;
    let text = Mutex::new(String::new());
    let changed = Mutex::new(Vec::new());
    let result = participant
        .respond_with_approvals(
            turn,
            &|update| match update {
                Progress::Text(piece) => text.lock().unwrap().push_str(piece),
                Progress::Change(change) => changed.lock().unwrap().push(change.clone()),
                _ => {}
            },
            approver,
        )
        .await;
    (result, text.into_inner().unwrap(), changed.into_inner().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_asks_before_a_command_when_access_is_ask_first() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-server-ask", "codex", FAKE_CODEX_SERVER);
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
    cfg.access = Access::Ask;
    let bot = build(cfg, &context_in(&dir));

    let yes = Fixed::new(Decision::Approve);
    let (result, _, _) = work_asking(bot.as_ref(), &yes).await;
    assert_eq!(result.unwrap().text, "Two files here. effort=default refused=no");
    assert_eq!(
        *yes.asked.lock().unwrap(),
        [ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "(command not given)".into(), expires_at: None, risky: false }]
    );

    let no = Fixed::new(Decision::Reject);
    let (result, _, _) = work_asking(bot.as_ref(), &no).await;
    assert_eq!(result.unwrap().text, "Two files here. effort=default refused=yes");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stand-in for Claude Code in its two-way mode: it reads the prompt,
/// asks permission to write a file, and reports what it was told.
#[cfg(unix)]
const FAKE_CLAUDE_ASKING: &str = r#"#!/bin/sh
case "$*" in
*"--input-format stream-json"*"--permission-prompt-tool stdio"*) ;;
*) echo "error: expected the two-way flags, got: $*" >&2; exit 2 ;;
esac
IFS= read -r prompt
case "$prompt" in *'"type":"user"'*) ;; *) echo "error: no user message" >&2; exit 2 ;; esac
echo '{"type":"system","subtype":"init"}'
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Write\",\"input\":{\"file_path\":\"$PWD/hello.txt\",\"content\":\"hi\"}}]},\"parent_tool_use_id\":null}"
echo "{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Write\",\"input\":{\"file_path\":\"$PWD/hello.txt\",\"content\":\"hi\"},\"tool_use_id\":\"t1\"}}"
IFS= read -r answer
case "$answer" in
*'"request_id":"r1"'*'"behavior":"allow"'*'"updatedInput"'*)
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"File created"}]}}'
  said="Created hello.txt." ;;
*'"request_id":"r1"'*'"behavior":"deny"'*)
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"rejected","is_error":true}]}}'
  said="I did not create the file." ;;
*) echo "error: unexpected answer: $answer" >&2; exit 2 ;;
esac
echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"$said\"}},\"parent_tool_use_id\":null}"
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$said\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}"
# The real program exits once its input is closed.
cat >/dev/null
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_code_asks_before_writing_when_access_is_ask_first() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-ask", "claude", FAKE_CLAUDE_ASKING);
    let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    cfg.access = Access::Ask;
    let bot = build(cfg, &context_in(&dir));

    let yes = Fixed::new(Decision::Approve);
    let (result, text, changed) = work_asking(bot.as_ref(), &yes).await;
    let reply = result.unwrap();
    assert_eq!(reply.text, "Created hello.txt.");
    assert_eq!(text, "Created hello.txt.");
    assert_eq!((reply.input_tokens, reply.output_tokens), (Some(10), Some(4)));
    assert_eq!(
        *yes.asked.lock().unwrap(),
        [ProposedAction { kind: ActionKind::Edit, title: "Write hello.txt".into(), detail: "+hi\n".into(), expires_at: None, risky: false }]
    );
    assert_eq!(changed, [FileChange { path: "hello.txt".into(), diff: "+hi\n".into(), added: 1, removed: 0 }]);

    // Refused: the turn carries on, and nothing is recorded as changed.
    let no = Fixed::new(Decision::Reject);
    let (result, _, changed) = work_asking(bot.as_ref(), &no).await;
    assert_eq!(result.unwrap().text, "I did not create the file.");
    assert_eq!(no.asked.lock().unwrap().len(), 1);
    assert!(changed.is_empty());

    // With nobody to ask, the request is refused rather than left waiting.
    let (result, _, _) = work(bot.as_ref()).await;
    assert_eq!(result.unwrap().text, "I did not create the file.");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn tool_free_claude_monitor_refuses_tool_requests_without_asking() {
    use apex_core::AgentTool;
    let script = r#"#!/bin/sh
case "$*" in
  *"--safe-mode"*"--restricted"*"--tools "*"--strict-mcp-config"*) ;;
  *) echo "monitor launch was not restricted: $*" >&2; exit 2 ;;
esac
case "$*" in *"--settings"*) echo "normal MCP settings were retained" >&2; exit 2 ;; esac
IFS= read -r prompt
echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"mcp__probe__create_file","input":{"path":"outside"}}}'
IFS= read -r answer
case "$answer" in *'"behavior":"deny"'*) ;; *) echo "tool request was not denied: $answer" >&2; exit 3 ;; esac
echo '{"type":"control_request","request_id":"r2","request":{"subtype":"initialize","input":{}}}'
IFS= read -r control_answer
case "$control_answer" in *'"subtype":"error"'*) ;; *) echo "control request was not rejected: $control_answer" >&2; exit 4 ;; esac
case "$control_answer" in *'"request_id":"r2"'*) ;; *) echo "control response was unmatched: $control_answer" >&2; exit 4 ;; esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Observed safely."}'
"#;
    let dir = fake_tool("claude-monitor-tools", "claude", script);
    let bot = CliParticipant::new(config("monitor", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }))
        .with_context(&context_in(&dir))
        .with_tools_disabled();
    let (result, _) = ask(&bot, "inspect only").await;
    assert_eq!(result.unwrap().text, "Observed safely.");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn tool_free_monitor_refuses_custom_cli_before_starting_it() {
    let dir = fake_tool("monitor-custom-cli", "custom-monitor", "#!/bin/sh\necho started > marker\necho unsafe\n");
    let bot = CliParticipant::new(config("monitor", Backend::Cli {
        program: "custom-monitor".into(), args: vec![],
    })).with_context(&context_in(&dir)).with_tools_disabled();
    let (result, _) = ask(&bot, "inspect only").await;
    assert!(matches!(result, Err(ParticipantError::Failed(message)) if message.contains("verified tool-free mode")));
    assert!(!dir.join("marker").exists(), "unsupported backend started despite tool-free mode");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn time_spent_waiting_for_an_answer_does_not_count_against_the_turn() {
    use apex_core::AgentTool;
    struct Slow;
    #[async_trait::async_trait]
    impl Approver for Slow {
        async fn decide(&self, _: ProposedAction) -> Decision {
            tokio::time::sleep(Duration::from_millis(900)).await;
            Decision::Approve
        }
    }
    let dir = fake_tool("claude-slow-ask", "claude", FAKE_CLAUDE_ASKING);
    let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    cfg.access = Access::Ask;
    // The answer takes longer than the whole turn is allowed.
    let bot = CliParticipant::new(cfg).with_context(&context_in(&dir)).with_timeout(Duration::from_millis(500));
    let (result, _, _) = work_asking(&bot, &Slow).await;
    assert_eq!(result.unwrap().text, "Created hello.txt.");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn per_turn_read_access_does_not_allow_ungated_codex_exec() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-turn-access", "codex", "#!/bin/sh\n[ \"$1\" = app-server ] && exit 2\nprintf 'args:%s ' \"$@\"\ncat >/dev/null\n");
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
    cfg.access = Access::Full;
    let bot = build(cfg, &context_in(&dir));
    let mut turn = request("read only"); turn.access = Some(Access::Read);
    let error = bot.respond(turn, &|_| {}).await.unwrap_err();
    assert!(error.to_string().contains("MCP approvals require it"));
    assert_eq!(bot.config().access, Access::Full);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn per_turn_read_access_reaches_codex_app_server_sandbox() {
    use apex_core::AgentTool;
    let script = r#"#!/bin/sh
while IFS= read -r line; do
case "$line" in
*'"mcpServerStatus/list"'*) echo '{"id":10,"result":{"data":[],"nextCursor":null}}' ;;
 *'"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
*'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
*'"method":"thread/start"'*)
 case "$line" in *'"sandbox":"read-only"'*) ;; *) echo 'wrong sandbox' >&2; exit 2 ;; esac
 echo '{"id":1,"result":{"thread":{"id":"thread-access"}}}' ;;
*'"method":"turn/start"'*)
 echo '{"id":2,"result":{}}'
 echo '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"r","text":"read-only confirmed"}}}'
 echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
esac
done
"#;
    let dir = fake_tool("codex-turn-server-access", "codex", script);
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None }); cfg.access = Access::Full;
    let bot = build(cfg, &context_in(&dir));
    let mut turn = request("read only"); turn.access = Some(Access::Read);
    let reply = bot.respond(turn, &|_| {}).await.unwrap();
    assert_eq!(reply.text, "read-only confirmed");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn per_turn_read_access_rebuilds_claude_tool_permissions() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-turn-access", "claude", r#"#!/bin/sh
IFS= read -r prompt
case "$*" in
*"--disallowedTools Edit,Write,NotebookEdit,Bash"*) said=read-only ;;
*) said=wrong-access ;;
esac
case "$*" in *bypassPermissions*) said=wrong-access ;; esac
echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"$said\"}"
"#);
    let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }); cfg.access = Access::Full;
    let bot = build(cfg, &context_in(&dir));
    let mut turn = request("read only"); turn.access = Some(Access::Read);
    let reply = bot.respond(turn, &|_| {}).await.unwrap();
    assert_eq!(reply.text, "read-only");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn custom_cli_is_refused_when_another_editor_requires_a_read_only_turn() {
    let mut cfg = config("custom", Backend::Cli { program: "sh".into(), args: vec!["-c".into(), "printf unsafe".into()] });
    cfg.access = Access::Full;
    let bot = build(cfg, &BuildContext::default());
    let mut turn = request("read only"); turn.access = Some(Access::Read);
    let error = bot.respond(turn, &|_| panic!("custom command must not start")).await.unwrap_err();
    assert!(error.to_string().contains("cannot enforce read-only access"));
}

/// Both providers wait at the tool boundary. The fake tool performs no
/// external action; its transcript exposes whether Deck sent allow/decline.
#[cfg(unix)]
const FAKE_MCP_CLAUDE: &str = r#"#!/bin/sh
IFS= read -r prompt
for tool in get_balance place_order place_order; do
 echo "{\"type\":\"control_request\",\"request_id\":\"$tool\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"mcp__probe__$tool\",\"input\":{\"quantity\":\"0.001\",\"nested\":{\"symbol\":\"ZEC\"}}}}"
 IFS= read -r answer
 case "$answer" in *'"behavior":"deny"'*) denied=$((denied+1)) ;; *'"behavior":"allow"'*) allowed=$((allowed+1)) ;; *) exit 2 ;; esac
done
echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"allowed=${allowed:-0} denied=${denied:-0}\"}"
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_mcp_reads_proceed_but_each_risky_call_asks_at_every_access_level() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-mcp-approval", "claude", FAKE_MCP_CLAUDE);
    for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
        let mut cfg = config("jigga", Backend::Agent {tool:AgentTool::ClaudeCode, model:None}); cfg.access=access;
        let no = Fixed::new(Decision::Reject);
        let (result, _, _) = work_asking(build(cfg, &context_in(&dir)).as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        let asked = no.asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        for action in asked.iter() {
            assert_eq!(action.kind, ActionKind::Tool);
            assert_eq!(action.title, "probe: place_order");
            assert!(action.risky, "place_order can spend money");
            assert_eq!(serde_json::from_str::<serde_json::Value>(&action.detail).unwrap(), serde_json::json!({"quantity":"0.001", "nested":{"symbol":"ZEC"}}));
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
const FAKE_MCP_CODEX: &str = r#"#!/bin/sh
while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
 *'"hooks/list"'*) echo '{"id":120,"error":{"code":-32601,"message":"Method not found"}}' ;;
 *'"mcpServerStatus/list"'*) echo '{"id":10,"result":{"data":[{"name":"probe","tools":{"place_order":{"name":"place_order"},"get_balance":{"name":"get_balance"}}}],"nextCursor":null}}' ;;
 *'"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
 *'"thread/start"'*)
 case "$line" in *'"mcp_servers.probe.tools.place_order.approval_mode":"prompt"'*) ;; *) echo 'missing tool policy' >&2;exit 2 ;; esac
 echo '{"id":1,"result":{"thread":{"id":"thread-mcp"}}}' ;;
 *'"turn/start"'*)
 for tool in get_balance place_order place_order; do
  echo "{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"mcpToolCall\",\"id\":\"call-1\",\"server\":\"probe\",\"tool\":\"$tool\",\"arguments\":{\"quantity\":\"0.001\"}}}}"
  echo '{"method":"mcpServer/elicitation/request","id":"approval-1","params":{"threadId":"thread-mcp","serverName":"probe","mode":"form","_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"quantity":"0.001"}},"requestedSchema":{"type":"object","properties":{}}}}'
  IFS= read -r answer
  case "$answer" in *'"action":"decline"'*) denied=$((denied+1)) ;; *'"action":"accept"'*) allowed=$((allowed+1)) ;; *) echo "bad response $answer" >&2;exit 2 ;; esac
  case "$answer" in *persist*) echo 'unexpected persistent approval' >&2;exit 2 ;; esac
  echo '{"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"call-1"}}}'
 done
 echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"reply\",\"text\":\"allowed=${allowed:-0} denied=${denied:-0}\"}}}"
 echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
 *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
 esac
done
"#;

#[cfg(unix)]
#[tokio::test]
async fn codex_mcp_reads_proceed_but_each_risky_call_asks_at_every_access_level() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-mcp-approval", "codex", FAKE_MCP_CODEX);
    for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
        let mut cfg=config("null", Backend::Agent {tool:AgentTool::Codex, model:None});cfg.access=access;
        let no=Fixed::new(Decision::Reject);
        let (result, _, _) = work_asking(build(cfg, &context_in(&dir)).as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        let asked=no.asked.lock().unwrap();assert_eq!(asked.len(),2);
        assert!(asked.iter().all(|a| a.kind==ActionKind::Tool && a.title=="probe: place_order" && a.risky));
    }
    // No approval transport to the person: risky calls reject, reads proceed.
    let bot=build(config("null",Backend::Agent{tool:AgentTool::Codex,model:None}),&context_in(&dir));
    let (result, _)=ask(bot.as_ref(),"test").await;
    assert_eq!(result.unwrap().text,"allowed=1 denied=2");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn server_discovery_uses_the_supplied_cli_path() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("apex-discovery-path-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cli = dir.join("claude");
    std::fs::write(&cli, "#!/bin/sh\nprintf 'path-test: local - ✔ Connected\\n'\n").unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let result = apex_adapters::claude_tool_servers(None, Some(dir.to_string_lossy().into_owned())).await;
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(result.unwrap().iter().map(|entry| entry.token.as_str()).collect::<Vec<_>>(), ["path-test"]);
}

/// A stand-in for `codex app-server` with Deck's hook. It lists the hook
/// with `trust` until Deck writes the trust, refuses the MCP inventory (the
/// hook makes it unnecessary), and for each MCP call runs the hook command
/// through `sh -c`, the way Codex does, with Deck's socket in its
/// environment. `order` says whether Codex's own approval request comes
/// before the hook, after it, or not at all.
#[cfg(unix)]
const FAKE_CODEX_HOOKED: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "DIR/args"
listed=first
hook() {
 printf '{"session_id":"thread-hook","hook_event_name":"PreToolUse","tool_name":"mcp__probe__%s","tool_input":{"quantity":"0.001"}}' "$1" | sh -c "$(cat "DIR/hook-command")" | grep -q '"deny"' && return 1
 return 0
}
codex_asks() {
 echo "{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"mcpToolCall\",\"id\":\"call-$1\",\"server\":\"probe\",\"tool\":\"$1\",\"arguments\":{\"quantity\":\"0.001\"}}}}"
 echo '{"method":"mcpServer/elicitation/request","id":"approval-1","params":{"threadId":"thread-hook","serverName":"probe","mode":"form","_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"quantity":"0.001"}},"requestedSchema":{"type":"object","properties":{}}}}'
 IFS= read -r answer
 echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"mcpToolCall\",\"id\":\"call-$1\"}}}"
 case "$answer" in *'"action":"accept"'*) return 0 ;; *) return 1 ;; esac
}
while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
 *'"method":"hooks/list"'*)
  if [ "$listed" = first ]; then cat <<'EOF'
LISTED_FIRST
EOF
  else cat <<'EOF'
LISTED_TRUSTED
EOF
  fi ;;
 *'"method":"config/batchWrite"'*) printf '%s\n' "$line" > "DIR/trust"; listed=trusted; echo '{"id":121,"result":{}}' ;;
 *'"mcpServerStatus/list"'*) echo '{"id":10,"error":{"message":"the hook makes the inventory unnecessary"}}' ;;
 *'"method":"thread/start"'*) printf '%s\n' "$line" > "DIR/thread"; echo '{"id":1,"result":{"thread":{"id":"thread-hook"}}}' ;;
 *'"method":"turn/start"'*)
  for tool in get_balance place_order place_order; do
   case ORDER in
   hook-only) hook $tool ;;
   hook-first) hook $tool && codex_asks $tool ;;
   codex-first) codex_asks $tool && hook $tool ;;
   esac && allowed=$((allowed+1)) || denied=$((denied+1))
  done
  echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"reply\",\"text\":\"allowed=${allowed:-0} denied=${denied:-0}\"}}}"
  echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
 *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
 esac
done
"#;

/// A fake Codex that supports the hook, and a context whose helper is the
/// real one, installed under a folder with a space the way
/// `/Applications/Apex Deck.app` is.
#[cfg(unix)]
fn hooked(tag: &str, trust: &str, order: &str) -> (std::path::PathBuf, BuildContext) {
    let dir = fake_tool(tag, "codex", "#!/bin/sh\n");
    let app = dir.join("Apex Deck");
    std::fs::create_dir_all(&app).unwrap();
    let helper = app.join("apex-deck");
    let _ = std::fs::remove_file(&helper);
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_apex-deck-codex-hook"), &helper).unwrap();
    let command = apex_adapters::codex_hook_command(&helper);
    std::fs::write(dir.join("hook-command"), &command).unwrap();
    let listing = |id: u64, trust: &str| serde_json::json!({"id": id, "result": {"data": [{"cwd": "/", "hooks": [{
        "key": "/<session-flags>/config.toml:pre_tool_use:0:0", "source": "sessionFlags", "eventName": "preToolUse",
        "handlerType": "command", "command": command, "matcher": "^mcp__", "timeoutSec": 600, "enabled": true,
        "currentHash": "sha256:fake", "trustStatus": trust}]}]}}).to_string();
    let script = FAKE_CODEX_HOOKED
        .replace("DIR", &dir.to_string_lossy())
        .replace("ORDER", order)
        .replace("LISTED_FIRST", &listing(120, trust))
        .replace("LISTED_TRUSTED", &listing(122, "trusted"));
    std::fs::write(dir.join("codex"), script).unwrap();
    let context = BuildContext { codex_hook: Some(helper), ..context_in(&dir) };
    (dir, context)
}

/// Run one turn with someone to ask, collecting the activity lines.
async fn work_hooked(participant: &dyn Participant, approver: &dyn Approver) -> (Result<apex_core::Reply, ParticipantError>, Vec<String>) {
    use apex_core::Progress;
    let activity = Mutex::new(Vec::new());
    let result = participant
        .respond_with_approvals(request("hi"), &|update| if let Progress::Activity(line) = update { activity.lock().unwrap().push(line.to_string()) }, approver)
        .await;
    (result, activity.into_inner().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn codex_hook_lets_reads_through_and_asks_before_each_risky_call_without_the_inventory() {
    use apex_core::AgentTool;
    let (dir, context) = hooked("codex-hook", "trusted", "hook-only");
    for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
        let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
        cfg.access = access;
        let no = Fixed::new(Decision::Reject);
        let (result, activity) = work_hooked(build(cfg, &context).as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        let asked = no.asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        for action in asked.iter() {
            assert_eq!((action.kind, action.title.as_str()), (ActionKind::Tool, "probe: place_order"));
            assert_eq!(serde_json::from_str::<serde_json::Value>(&action.detail).unwrap(), serde_json::json!({"quantity": "0.001"}));
        }
        assert!(
            !activity.is_empty() && activity.iter().all(|line| line.starts_with("Waiting for approval:")),
            "no inventory wait and no startup line: {activity:?}"
        );
    }
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains(r#"hooks.PreToolUse=[{matcher="^mcp__""#), "{args}");
    let thread = std::fs::read_to_string(dir.join("thread")).unwrap();
    assert!(thread.contains(r#""approvals_reviewer":"user""#) && !thread.contains("mcp_servers."), "{thread}");
    assert!(!dir.join("trust").exists(), "a trusted hook is not written again");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_hook_is_trusted_once_through_codex_settings() {
    use apex_core::AgentTool;
    let (dir, context) = hooked("codex-hook-trust", "untrusted", "hook-only");
    let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
    let (result, activity) = work_hooked(bot.as_ref(), &Fixed::new(Decision::Reject)).await;
    assert_eq!(result.unwrap().text, "allowed=1 denied=2");
    assert_eq!(activity[0], "Turning on Apex Deck's approval hook in Codex");
    assert!(activity[1..].iter().all(|line| line.starts_with("Waiting for approval:")), "{activity:?}");
    let trust: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("trust")).unwrap()).unwrap();
    assert_eq!(trust["params"]["edits"], serde_json::json!([{
        "keyPath": "hooks.state.\"/<session-flags>/config.toml:pre_tool_use:0:0\".trusted_hash",
        "value": "sha256:fake", "mergeStrategy": "replace"
    }]));
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_asks_once_per_risky_call_when_both_the_hook_and_codex_ask() {
    use apex_core::AgentTool;
    for order in ["hook-first", "codex-first"] {
        let (dir, context) = hooked(&format!("codex-hook-{order}"), "trusted", order);
        let yes = Fixed::new(Decision::Approve);
        let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
        let (result, _) = work_hooked(bot.as_ref(), &yes).await;
        assert_eq!(result.unwrap().text, "allowed=3 denied=0", "{order}");
        assert_eq!(yes.asked.lock().unwrap().len(), 2, "{order}: one card per risky call");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn codex_without_the_hook_falls_back_to_the_inventory_policy() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-no-hooks", "codex", FAKE_MCP_CODEX);
    // An older Codex that has no hooks/list, then a helper that has gone.
    for helper in [std::path::PathBuf::from(env!("CARGO_BIN_EXE_apex-deck-codex-hook")), dir.join("no-such-helper")] {
        let context = BuildContext { codex_hook: Some(helper), ..context_in(&dir) };
        let no = Fixed::new(Decision::Reject);
        let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
        let (result, activity) = work_hooked(bot.as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        assert_eq!(activity[0], "Checking MCP tool approval policies");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn computer_use_app_permission_is_separate_from_an_outer_tool_approval() {
    use apex_core::AgentTool;
    let script = FAKE_MCP_CODEX
        .replace(r#""_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"quantity":"0.001"}}"#,
            r#""message":"Allow Computer Use to use Apex Deck?","_meta":{"codex_approval_kind":"mcp_tool_call","connector_id":"computer-use","tool_params":{"app":"dev.apexdeck.app"}}"#)
        .replace(r#""arguments\":{\"quantity\":\"0.001\"}"#,
            r#""arguments\":{\"app\":\"dev.apexdeck.app\"}"#);
    let dir = fake_tool("codex-app-permission", "codex", &script);
    for decision in [Decision::Approve, Decision::Reject] {
        let approver = Fixed::new(decision);
        let bot = build(config("null",Backend::Agent{tool:AgentTool::Codex,model:None}), &context_in(&dir));
        let (result, _, _) = work_asking(bot.as_ref(), &approver).await;
        assert_eq!(result.unwrap().text, if decision.approved() {"allowed=3 denied=0"} else {"allowed=0 denied=3"});
        let asked = approver.asked.lock().unwrap();
        assert_eq!(asked.len(), 3, "even a read call must ask before app access");
        assert!(asked.iter().all(|a| a.kind == ActionKind::Other && a.detail.contains("dev.apexdeck.app")));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A stand-in for Claude Code asking two questions with AskUserQuestion.
#[cfg(unix)]
const FAKE_CLAUDE_QUESTION: &str = r#"#!/bin/sh
IFS= read -r prompt
echo '{"type":"system","subtype":"init"}'
echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which colour?","header":"Colour","options":[{"label":"red"},{"label":"blue"}],"multiSelect":false},{"question":"Which fruit?","header":"Fruit","options":[{"label":"apple"},{"label":"pear"}],"multiSelect":true}]}}}'
IFS= read -r answer
case "$answer" in
*'"behavior":"allow"'*'"Which colour?":"blue"'*'"Which fruit?":"apple, pear"'*) said="blue with apple, pear" ;;
*'"behavior":"deny"'*'skipped this question'*) said="skipped" ;;
*) echo "error: unexpected answer: $answer" >&2; exit 2 ;;
esac
echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"$said\"}},\"parent_tool_use_id\":null}"
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$said\"}"
cat >/dev/null
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_questions_reach_the_person_and_the_answer_goes_back() {
    use apex_core::{AgentTool, Answer};
    let dir = fake_tool("claude-question", "claude", FAKE_CLAUDE_QUESTION);
    for access in [Access::Ask, Access::Full] {
        let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
        cfg.access = access;
        let bot = build(cfg, &context_in(&dir));

        let person = Fixed::new(Decision::Reject);
        *person.said.lock().unwrap() = Some(Answer::Answered(vec![vec!["blue".into()], vec!["apple".into(), "pear".into()]]));
        let (result, _, _) = work_asking(bot.as_ref(), &person).await;
        assert_eq!(result.unwrap().text, "blue with apple, pear");
        let asked = person.questions.lock().unwrap();
        assert_eq!(asked.iter().map(|q| q.question.as_str()).collect::<Vec<_>>(), ["Which colour?", "Which fruit?"]);
        assert!(person.asked.lock().unwrap().is_empty(), "a question is not an approval card");

        let (result, _, _) = work_asking(bot.as_ref(), &Fixed::new(Decision::Approve)).await;
        assert_eq!(result.unwrap().text, "skipped", "nobody answered: the bot hears it was skipped");
    }
    let bot = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &context_in(&dir));
    let (result, _, _) = work(bot.as_ref()).await;
    assert_eq!(result.unwrap().text, "skipped", "with no approver at all");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stand-in for Codex that asks the person a question during its turn.
#[cfg(unix)]
const FAKE_QUESTION_CODEX: &str = r#"#!/bin/sh
while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
 *'"hooks/list"'*) echo '{"id":120,"error":{"code":-32601,"message":"Method not found"}}' ;;
 *'"mcpServerStatus/list"'*) echo '{"id":10,"result":{"data":[],"nextCursor":null}}' ;;
 *'"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
 *'"thread/start"'*) echo '{"id":1,"result":{"thread":{"id":"thread-q"},"model":"gpt-test"}}' ;;
 *'"turn/start"'*)
 case "$line" in *'"collaborationMode":{"mode":"plan","settings":{"model":"gpt-test"}}'*) mode="planning" ;; *) mode="working" ;; esac
 echo '{"method":"item/tool/requestUserInput","id":"q-1","params":{"threadId":"thread-q","turnId":"t","itemId":"i","isBlocking":true,"questions":[{"id":"colour","header":"Colour","question":"Which colour?","isOther":true,"isSecret":false,"options":[{"label":"red","description":""},{"label":"blue","description":""}]}]}}'
 IFS= read -r answer
 case "$answer" in *'"colour":{"answers":["blue"]}'*) said="blue" ;; *'"answers":{}'*) said="skipped" ;; *) echo "bad answer $answer" >&2; exit 2 ;; esac
 echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"reply\",\"text\":\"$mode $said\"}}}"
 echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
 *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
 esac
done
"#;

#[cfg(unix)]
#[tokio::test]
async fn codex_questions_reach_the_person() {
    use apex_core::{AgentTool, Answer};
    let dir = fake_tool("codex-question", "codex", FAKE_QUESTION_CODEX);
    let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
    cfg.access = Access::Ask;
    let bot = build(cfg, &context_in(&dir));
    let person = Fixed::new(Decision::Reject);
    *person.said.lock().unwrap() = Some(Answer::Answered(vec![vec!["blue".into()]]));
    let (result, _, _) = work_asking(bot.as_ref(), &person).await;
    assert_eq!(result.unwrap().text, "working blue");
    assert_eq!(person.questions.lock().unwrap()[0].question, "Which colour?");
    let (result, _, _) = work_asking(bot.as_ref(), &Fixed::new(Decision::Approve)).await;
    assert_eq!(result.unwrap().text, "working skipped");
    let (result, _, _) = work_asking_with(bot.as_ref(), &person, planning("hi")).await;
    assert_eq!(result.unwrap().text, "planning blue", "with Plan on, Codex plans with the model it reported");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A stand-in for Claude Code in planning mode: it asks to start the work
/// and reports what it was told.
#[cfg(unix)]
const FAKE_CLAUDE_PLANNING: &str = r#"#!/bin/sh
case "$*" in
*"--permission-mode plan"*) ;;
*) echo "error: not planning: $*" >&2; exit 2 ;;
esac
IFS= read -r prompt
echo '{"type":"system","subtype":"init"}'
echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"1. Make hello.txt"}}}'
IFS= read -r answer
case "$answer" in
*'"behavior":"allow"'*'"mode":"bypassPermissions"'*) said="working" ;;
*'"behavior":"deny"'*'keep planning'*) said="still planning" ;;
*'"behavior":"deny"'*'can only read'*) said="read only" ;;
*) echo "error: unexpected answer: $answer" >&2; exit 2 ;;
esac
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$said\"}"
cat >/dev/null
"#;

#[cfg(unix)]
#[tokio::test]
async fn a_planning_claude_asks_before_it_starts_the_work() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-planning", "claude", FAKE_CLAUDE_PLANNING);
    let mut cfg = config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    cfg.access = Access::Full;
    let bot = build(cfg, &context_in(&dir));

    let yes = Fixed::new(Decision::Approve);
    let (result, _, _) = work_asking_with(bot.as_ref(), &yes, planning("hi")).await;
    assert_eq!(result.unwrap().text, "working", "approved: Claude goes on with its own Full access");
    let asked = yes.asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].kind, asked[0].title.as_str(), asked[0].detail.as_str()), (ActionKind::Plan, "Start the work?", "1. Make hello.txt"));

    let no = Fixed::new(Decision::Reject);
    let (result, _, _) = work_asking_with(bot.as_ref(), &no, planning("hi")).await;
    assert_eq!(result.unwrap().text, "still planning");

    let reader = build(config("jigga", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }), &context_in(&dir));
    let asked = Fixed::new(Decision::Approve);
    let (result, _, _) = work_asking_with(reader.as_ref(), &asked, planning("hi")).await;
    assert_eq!(result.unwrap().text, "read only");
    assert!(asked.asked.lock().unwrap().is_empty(), "no card for a bot that can't start the work");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn a_custom_command_sits_out_while_planning() {
    let bot = CliParticipant::new(config("aider", sh("echo hi")));
    let result = bot.respond_with_approvals(planning("hi"), &|_| {}, &Fixed::new(Decision::Approve)).await;
    assert_eq!(result.unwrap_err(), ParticipantError::Failed("This custom command can't be held to read-only, so it sits out while Plan is on.".into()));
}

#[cfg(unix)]
const FAKE_ALL_TOOLS_CLAUDE: &str = r#"#!/bin/sh
IFS= read -r prompt
for tool in Read Bash WebSearch Agent mcp__probe__get_balance; do
 echo "{\"type\":\"control_request\",\"request_id\":\"$tool\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"$tool\",\"input\":{}}}"
 IFS= read -r answer
 case "$answer" in *'"behavior":"deny"'*) denied=$((denied+1)) ;; *) echo "tool escaped policy: $tool $answer" >&2; exit 2 ;; esac
done
echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"denied=${denied:-0}\"}"
"#;
#[cfg(unix)]
const FAKE_MONITOR_QUESTION: &str = r#"#!/bin/sh
IFS= read -r prompt
echo '{"type":"system","subtype":"init"}'
echo '{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which colour?","header":"Colour","options":[{"label":"red"},{"label":"blue"}],"multiSelect":false},{"question":"Which fruit?","header":"Fruit","options":[{"label":"apple"},{"label":"pear"}],"multiSelect":true}]}}}'
IFS= read -r answer
case "$answer" in
*'"behavior":"allow"'*'"Which colour?":"blue"'*'"Which fruit?":"apple, pear"'*) said="blue with apple, pear" ;;
*'"behavior":"deny"'*) said="skipped" ;;
*) echo "error: unexpected answer: $answer" >&2; exit 2 ;;
esac
echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"$said\"}},\"parent_tool_use_id\":null}"
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"$said\"}"
cat >/dev/null
"#;
#[cfg(unix)]
#[tokio::test]
async fn tools_disabled_denies_safe_mcp_calls_before_the_read_classifier() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-monitor-tools-disabled", "claude", FAKE_MCP_CLAUDE);
    let mut cfg = config("monitor", Backend::Agent { tool: AgentTool::ClaudeCode, model: None });
    cfg.access = Access::Read;
    let bot = CliParticipant::new(cfg).with_context(&context_in(&dir)).with_tools_disabled();
    let (result, _) = ask(&bot, "inspect evidence").await;
    assert_eq!(result.unwrap().text, "allowed=0 denied=3");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn tools_disabled_denies_reads_commands_network_helpers_and_mcp_at_the_protocol_boundary() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-monitor-all-tools", "claude", FAKE_ALL_TOOLS_CLAUDE);
    let bot = CliParticipant::new(config("monitor", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }))
        .with_context(&context_in(&dir)).with_tools_disabled();
    let approver = Fixed::new(Decision::Approve);
    let (result, _, _) = work_asking(&bot, &approver).await;
    assert_eq!(result.unwrap().text, "denied=5");
    assert!(approver.asked.lock().unwrap().is_empty(), "tool-free turns do not show approval cards");
    assert!(approver.questions.lock().unwrap().is_empty(), "tool-free turns do not ask questions");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn tools_disabled_denies_ask_user_question_without_consulting_the_approver() {
    use apex_core::AgentTool;
    let dir = fake_tool("claude-monitor-no-question", "claude", FAKE_MONITOR_QUESTION);
    let bot = CliParticipant::new(config("monitor", Backend::Agent { tool: AgentTool::ClaudeCode, model: None }))
        .with_context(&context_in(&dir)).with_tools_disabled();
    let person = Fixed::new(Decision::Approve);
    *person.said.lock().unwrap() = Some(apex_core::Answer::Answered(vec![vec!["blue".into()], vec!["apple".into()]]));
    let (result, _, _) = work_asking(&bot, &person).await;
    assert_eq!(result.unwrap().text, "skipped");
    assert!(person.questions.lock().unwrap().is_empty());
    assert!(person.asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn tools_disabled_fails_closed_for_agents_without_a_verified_tool_gate() {
    use apex_core::AgentTool;
    let dir = fake_tool("agent-tools-disabled-unsupported", "codex", "#!/bin/sh\necho ran > invoked\nexit 90\n");
    for tool in [AgentTool::Codex, AgentTool::Grok] {
        let bot = CliParticipant::new(config("monitor", Backend::Agent { tool, model: None }))
            .with_context(&context_in(&dir)).with_tools_disabled();
        let (result, _) = ask(&bot, "inspect evidence").await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("verified tool-free mode"), "{tool:?}: {error}");
        assert!(!dir.join("invoked").exists(), "{tool:?} must fail before process launch");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
