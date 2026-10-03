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
        appearance: None,
    }
}

fn request(text: &str) -> TurnRequest {
    TurnRequest {
        system: "You are a test bot.".into(),
        turns: vec![ViewTurn { role: Role::User, content: format!("[Human]: {text}") }],
        unseen: vec![],
    }
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
async fn cli_that_keeps_printing_outlasts_the_timeout() {
    // Each line restarts the clock, so a turn longer than the limit is fine
    // as long as the tool never goes quiet for that long.
    let script = "for i in 1 2 3 4 5 6; do echo $i; sleep 0.1; done";
    let bot = CliParticipant::new(config("cli", sh(script))).with_timeout(Duration::from_millis(350));
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
    let context = BuildContext { cwd: Some(dir.clone()), path: None };
    let bot = CliParticipant::new(config("cli", sh("cat >/dev/null; pwd -P"))).with_context(&context);
    let (result, _) = ask(&bot, "where are you?").await;
    assert_eq!(result.unwrap().text, real.to_string_lossy());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cli_reports_a_workspace_folder_that_no_longer_exists() {
    let context = BuildContext { cwd: Some("/no/such/apex-deck/folder".into()), path: None };
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
    let context = BuildContext { cwd: None, path: Some(path) };
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
async fn agent_backend_runs_the_preset_command_for_its_tool_model_and_access() {
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
    let context = BuildContext { cwd: Some(dir.clone()), path: Some(format!("{}:/usr/bin:/bin", dir.to_string_lossy())) };
    let bot = build(cfg, &context);
    let (result, _) = ask(bot.as_ref(), "hey, testing").await;
    let text = result.unwrap().text;

    assert!(
        text.starts_with("args:exec args:--skip-git-repo-check args:--json args:--model args:some-model args:-c args:model_reasoning_effort=\"high\" args:--sandbox args:workspace-write args:- "),
        "{text}"
    );
    let bytes: usize = text.rsplit("stdin-bytes:").next().unwrap().trim().parse().unwrap();
    assert!(bytes > "[Human]: hey, testing".len(), "{text}");
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
    assert_eq!(models, ["llama3", "qwen:7b"]);
    assert!(server.await.unwrap().starts_with("GET /v1/models "));
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
    BuildContext { cwd: Some(dir.to_path_buf()), path: Some(format!("{}:/usr/bin:/bin", dir.to_string_lossy())) }
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
cat >/dev/null
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
cat >/dev/null
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
async fn without_an_app_server_codex_exec_events_give_the_reply_and_a_failed_turn_is_an_error() {
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
    let reply = result.unwrap();
    assert_eq!(reply.text, "Two files here.");
    assert_eq!((reply.input_tokens, reply.output_tokens), (Some(50), Some(6)));
    assert_eq!(text, "Two files here.");
    assert_eq!(activity, ["Running: ls"]);

    let bad = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: Some("broken".into()) }), &context);
    let (result, _, _) = work(bad.as_ref()).await;
    match result {
        Err(ParticipantError::Failed(message)) => {
            assert!(message.contains("401 Unauthorized: Missing bearer"), "{message}");
            assert!(!message.contains("Reconnecting"), "{message}");
            assert!(message.contains("codex login"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
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
    assert_eq!(activity, ["Running: ls -la", "Waiting for approval: Run a command"]);
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
                system: "You are a test bot.".into(),
                turns: vec![ViewTurn { role: Role::User, content: "[Human]: please fail".into() }],
                unseen: vec![],
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
async fn codex_falls_back_to_exec_when_the_app_server_cannot_start_a_thread() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-server-off", "codex", FAKE_CODEX_SERVER);
    let cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: Some("no-server".into()) });
    let (result, text, _) = work(build(cfg, &context_in(&dir)).as_ref()).await;
    assert_eq!(result.unwrap().text, "from exec");
    assert_eq!(text, "from exec");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Answers every proposal the same way and keeps what was proposed.
struct Fixed {
    answer: Decision,
    asked: Mutex<Vec<ProposedAction>>,
}

impl Fixed {
    fn new(answer: Decision) -> Self {
        Self { answer, asked: Mutex::new(Vec::new()) }
    }
}

#[async_trait::async_trait]
impl Approver for Fixed {
    async fn decide(&self, action: ProposedAction) -> Decision {
        self.asked.lock().unwrap().push(action);
        self.answer
    }
}

/// Run one turn with someone to ask, collecting text and file changes.
async fn work_asking(
    participant: &dyn Participant,
    approver: &dyn Approver,
) -> (Result<apex_core::Reply, ParticipantError>, String, Vec<FileChange>) {
    use apex_core::Progress;
    let text = Mutex::new(String::new());
    let changed = Mutex::new(Vec::new());
    let result = participant
        .respond_with_approvals(
            request("hi"),
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
        [ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "(command not given)".into() }]
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
        [ProposedAction { kind: ActionKind::Edit, title: "Write hello.txt".into(), detail: "+hi\n".into() }]
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
